// Dialecto Postgres: la única pieza que conoce este motor. Tiene cuatro
// responsabilidades, y ninguna otra pieza puede tener una de ellas:
//
//   1. Sintaxis SQL: lo que varía entre motores y el planificador pregunta
//      (`dateTrunc`, `agregadoFiltrado`), más la tabla de capacidades.
//   2. Introspección del esquema: cómo se descubre el snapshot en este motor.
//   3. Mapa de tipos físicos → tipos semánticos: qué significa `numeric` aquí.
//   4. Traducción de errores nativos → errores semánticos: qué quiere decir
//      un `57014` para quien preguntó.
//
// Agregar un motor es agregar un archivo hermano de éste: ni el catálogo, ni el
// planificador, ni el engine nombran un motor concreto, salvo como **valor por
// defecto inyectable** —`catalog.js` y `engine.js` importan este módulo para
// resolver la fuente por defecto cuando nadie pasa `fuentes`, y ese default se
// reemplaza por parámetro sin tocar una línea de ninguno de los tres—.
import { GRANULARIDADES } from '../vocabulary.js';
import { SemanticError } from '../errors.js';

const SOPORTADAS = new Set(GRANULARIDADES);

// El paso con el que `generate_series` avanza de un bucket al siguiente, por
// granularidad. No se puede derivar del nombre: `DATE_TRUNC` entiende
// `'quarter'` pero `INTERVAL '1 quarter'` no existe en Postgres —lo rechaza con
// `invalid input syntax for type interval`— y hay que escribirlo como tres
// meses. Es una tabla, no lógica, y vive aquí porque es sintaxis del motor.
const PASO_DE_LA_SERIE = {
  day: '1 day',
  week: '1 week',
  month: '1 month',
  quarter: '3 months',
  year: '1 year',
};

const ESQUEMA = 'public';

// --- 2. Introspección -------------------------------------------------------
//
// Forma del snapshot (CONTEXT.md, "Snapshot del esquema"):
//
//   {
//     schema: 'public',
//     tables: {
//       <tabla>: {
//         columns: { <columna>: <tipo físico del motor>, ... },
//         indexes: [{ name, columns: [...], unique }, ...]
//       }
//     }
//   }
//
// Las columnas van en el orden de la tabla y los índices ordenados por nombre:
// dos introspecciones de la misma base producen el mismo snapshot, que es lo
// que permite compararlo con la foto fija del repo y usarlo como parte de la
// versión del catálogo. La forma es del catálogo; cómo se descubre, del motor.
const COLUMNAS = `
  SELECT c.table_name, c.column_name, c.data_type
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
  ORDER BY c.table_name, c.ordinal_position
`;

const INDICES = `
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = $1
  ORDER BY tablename, indexname
`;

// `pg_indexes` entrega la definición del índice como texto; las columnas son la
// lista entre paréntesis que sigue al método de acceso. Alcanza para índices
// sobre columnas —los que el catálogo necesita reconocer para saber si una
// dimensión temporal está cubierta—; un índice sobre una expresión queda
// registrado con el texto de la expresión y simplemente no coincide con
// ninguna columna, que es la respuesta conservadora.
function columnasDelIndice(indexdef) {
  const lista = indexdef.match(/USING\s+\w+\s+\((.*)\)/i)?.[1];
  if (!lista) return [];
  return lista.split(',').map((parte) => parte.trim().split(/\s+/)[0]);
}

// --- 3. Mapa de tipos -------------------------------------------------------
//
// Del tipo físico que devuelve el motor al tipo semántico con el que una
// dimensión declara sus operadores (`vocabulary.js`). Un tipo físico que no
// está en la tabla no tiene traducción: el catálogo no puede juzgar la
// compatibilidad y no la juzga, que es la respuesta conservadora.
const TIPOS_SEMANTICOS = new Map(
  Object.entries({
    smallint: 'number',
    integer: 'number',
    bigint: 'number',
    numeric: 'number',
    real: 'number',
    'double precision': 'number',
    text: 'string',
    'character varying': 'string',
    character: 'string',
    date: 'date',
    boolean: 'boolean',
  }),
);

// Los dos `timestamp` NO están en el mapa a propósito (hallazgo 6 del abogado
// del diablo): mapearlos a `date` los aceptaba en silencio, y el supuesto v1 es
// que una columna temporal es un día calendario ya resuelto a la zona local de
// la empresa (README, "Fechas y zonas horarias"). Un instante no es un día, y
// convertirlo a uno es una decisión que necesita saber en qué zona vive la
// empresa: eso todavía no está en el catálogo.
//
// La reserva es del dialecto porque estos nombres de tipo son de este motor. El
// catálogo sólo pregunta y aplica el nivel que reciba: `error` corta el
// registro, `advertencia` lo deja pasar diciéndolo.
const RESERVAS_DE_DIMENSION_TEMPORAL = new Map([
  [
    'timestamp without time zone',
    {
      nivel: 'error',
      detalle:
        'es un instante sin zona y la dimensión se declara date, que en v1 es un día calendario ya resuelto a la zona local de la empresa. Convertirlo a día exige saber esa zona, y el catálogo todavía no la tiene: usa una columna date, o migra a timestamptz y espera a la evolución de zonas (zona por empresa en el catálogo y AT TIME ZONE en el dialecto).',
    },
  ],
  [
    'timestamp with time zone',
    {
      nivel: 'advertencia',
      detalle:
        'es un timestamptz y la dimensión se declara date: el rango de una consulta es cerrado en los dos extremos (>= desde AND <= hasta), así que comparar un instante contra el día `hasta` deja fuera todo lo que ocurrió después de su medianoche —el último día del rango se pierde casi entero—. Mientras no exista la evolución de zonas, usa una columna date.',
    },
  ],
]);

// La base que no está: el error no viene del SQL sino de no haber podido
// hablarle al motor. Se reconoce por el `code` —los de socket que pone Node, y
// la clase 08 de SQLSTATE, que es "excepción de conexión" en cualquier
// Postgres, más el `57P01` con el que el servidor avisa que se está apagando— o,
// cuando node-postgres no pone ninguno, por el texto de su propio timeout de
// conexión. Ese texto es un detalle de esta librería y por eso vive aquí: el
// engine no puede conocerlo sin volver a saber de Postgres.
const ERRORES_DE_SOCKET = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);

function fuenteInalcanzable(error) {
  const codigo = error?.code;
  if (typeof codigo === 'string') {
    if (ERRORES_DE_SOCKET.has(codigo)) return true;
    if (codigo.startsWith('08') || codigo === '57P01') return true;
  }
  return /timeout exceeded when trying to connect/i.test(error?.message ?? '');
}

export const postgres = {
  name: 'postgres',

  capabilities: {
    dateTrunc: true,
    agregadoFiltrado: true,
    // El motor declara y hace cumplir el tipo de cada columna: si el snapshot
    // dice `text`, ninguna fila de esa columna es un número. Por eso una
    // incompatibilidad entre el tipo declarado y el físico es un error y no una
    // advertencia. Un motor de tipos laxos (SQLite) declarará `false`.
    tiposGarantizados: true,
    // El motor puede cortar una sentencia por tiempo (`statement_timeout`), y
    // por eso el presupuesto de tiempo de la clase de consumidor se hace
    // cumplir de verdad en esta fuente.
    timeoutDeSentencia: true,
    // El motor sabe generar la serie de buckets de un rango (`generate_series`),
    // que es lo que necesita el relleno de series densas (ADR 0012). Un motor
    // que no pueda prometerlo declara `false` y el planificador rechaza
    // `fillMissing` sobre esa fuente en vez de emitir un SQL a medias.
    serieDeFechas: true,
  },

  // --- 1. Sintaxis SQL ------------------------------------------------------

  // La granularidad se interpola en el SQL, así que sale de una lista cerrada.
  // Desde una consulta este throw es inalcanzable: la puerta de forma del
  // planificador ya la rechazó con `INVALID_QUERY`. Queda como cerradura del
  // dialecto para quien lo use directamente.
  // El resultado se devuelve como texto ISO y no como fecha: node-postgres
  // convierte DATE a un Date de JavaScript corrido a la zona del proceso, y el
  // valor de una dimensión temporal debe ser el mismo en cualquier máquina.
  dateTrunc(granularidad, expresion) {
    if (!SOPORTADAS.has(granularidad)) {
      throw new Error(`Granularidad no soportada por el dialecto: ${granularidad}`);
    }
    return `TO_CHAR(DATE_TRUNC('${granularidad}', ${expresion}), 'YYYY-MM-DD')`;
  },

  agregadoFiltrado(agregado, condicion) {
    return `${agregado} FILTER (WHERE ${condicion})`;
  },

  // Todos los buckets de un rango, uno por fila, en una sola columna `bucket`.
  // El contrato es que salga **exactamente con el mismo formato que
  // `dateTrunc`**: el relleno une la serie con la etapa agregada por igualdad de
  // texto, y un formato distinto no falla —devuelve todos los buckets vacíos—,
  // que es la peor forma de fallar. Por eso el mismo `TO_CHAR` de arriba.
  //
  // El inicio se trunca antes de generar: `generate_series` avanza desde donde
  // se le diga, así que un rango que parte el 15 de enero con granularidad `month`
  // produciría 15/01, 15/02, 15/03 —fechas que `dateTrunc` nunca emite— y
  // ningún bucket calzaría. El fin no necesita truncarse: `generate_series` corta
  // en el último valor que no lo pasa.
  //
  // `desdeSql` y `hastaSql` llegan como marcadores (`$2`, `$3`), nunca como
  // valores: los literales de la consulta viajan como parámetros, aquí también.
  // La granularidad sí se interpola, como en `dateTrunc`, y por eso sale de la
  // misma lista cerrada.
  serieDeFechas(granularidad, desdeSql, hastaSql) {
    if (!SOPORTADAS.has(granularidad)) {
      throw new Error(`Granularidad no soportada por el dialecto: ${granularidad}`);
    }
    return (
      `SELECT TO_CHAR(g.bucket, 'YYYY-MM-DD') AS bucket\n` +
      `FROM generate_series(\n` +
      `  DATE_TRUNC('${granularidad}', ${desdeSql}::date),\n` +
      `  ${hastaSql}::date,\n` +
      `  INTERVAL '${PASO_DE_LA_SERIE[granularidad]}'\n` +
      `) AS g(bucket)`
    );
  },

  // Forzar aritmética no entera en una razón: dos COUNT son enteros y 3/4 daría
  // 0. Cómo se pide eso es del motor —aquí un cast de Postgres, en SQLite un
  // CAST estándar—, así que el planificador lo pregunta en vez de escribirlo.
  aNumerico(expresion) {
    return `${expresion}::numeric`;
  },

  // Cómo se nombra la tabla física dentro de la CTE que lleva el nombre de la
  // entidad. En Postgres va pelada: una CTE no recursiva no puede referirse a sí
  // misma, así que `FROM employees` dentro de `WITH employees AS (...)` resuelve
  // la tabla base sin ambigüedad. No todos los motores resuelven así —SQLite le
  // da precedencia a la CTE y lo llama referencia circular—, y por eso la
  // pregunta es del dialecto y no una constante del planificador.
  tablaFisica(tabla) {
    return tabla;
  },

  // Sentencias que abren la sesión de una consulta, dentro de su transacción.
  // El presupuesto de tiempo se hace cumplir con `SET LOCAL statement_timeout`:
  // fuera de una transacción Postgres lo ignora, y dentro se deshace al
  // cerrarla, así que la conexión vuelve al pool sin el estado de esta
  // petición. `SET` no admite parámetros, así que el valor se interpola y por
  // eso se valida aquí como entero del presupuesto. El engine no nombra esta
  // sentencia: se la pide al dialecto, y un motor que no puede hacer cumplir un
  // timeout —SQLite— simplemente no ofrece este método y no se emite nada.
  sentenciasDeSesion(presupuesto) {
    if (!Number.isInteger(presupuesto?.timeoutMs) || presupuesto.timeoutMs <= 0) {
      throw new Error(`Timeout de presupuesto inválido: ${presupuesto?.timeoutMs}`);
    }
    return [`SET LOCAL statement_timeout = ${presupuesto.timeoutMs}`];
  },

  // Identidad del clúster: el `system_identifier` que Postgres crea en `initdb`
  // y que las réplicas físicas heredan byte a byte. Es la identidad de los
  // DATOS, no de la máquina: dos réplicas del mismo primario dan el mismo, y una
  // base restaurada en otro ambiente da otro. Si el rol no puede ejecutar
  // `pg_control_system()`, el engine cae a la huella de la conexión.
  async identificador(pool) {
    const { rows } = await pool.query('SELECT system_identifier::text AS id FROM pg_control_system()');
    return `postgres:${rows[0].id}`;
  },

  // --- 2. Introspección -----------------------------------------------------
  async introspect(pool, esquema = ESQUEMA) {
    const [columnas, indices] = await Promise.all([
      pool.query(COLUMNAS, [esquema]),
      pool.query(INDICES, [esquema]),
    ]);

    const tables = {};
    const tabla = (nombre) => (tables[nombre] ??= { columns: {}, indexes: [] });

    for (const fila of columnas.rows) tabla(fila.table_name).columns[fila.column_name] = fila.data_type;

    for (const fila of indices.rows) {
      // Un índice sobre una tabla que no devolvió columnas no pertenece al
      // esquema de datos que el catálogo puede validar (vista materializada, por
      // ejemplo): se ignora en vez de inventar una tabla vacía.
      if (!Object.hasOwn(tables, fila.tablename)) continue;
      tables[fila.tablename].indexes.push({
        name: fila.indexname,
        columns: columnasDelIndice(fila.indexdef),
        unique: /^CREATE UNIQUE INDEX/i.test(fila.indexdef),
      });
    }

    return { schema: esquema, tables };
  },

  // --- 3. Mapa de tipos -----------------------------------------------------
  tipoSemantico(tipoFisico) {
    return TIPOS_SEMANTICOS.get(tipoFisico);
  },

  // Lo que el motor sí sabe traducir pero no puede sostener bajo el contrato de
  // la dimensión que lo declara. Devuelve `{ nivel, detalle }` o nada; el
  // catálogo decide qué hacer con el nivel.
  reservaDeTipo(tipoFisico, tipoDeclarado) {
    if (tipoDeclarado !== 'date') return undefined;
    return RESERVAS_DE_DIMENSION_TEMPORAL.get(tipoFisico);
  },

  // --- 4. Errores nativos ---------------------------------------------------
  //
  // Un código de error de Postgres no significa nada fuera de Postgres: quien
  // sabe traducirlo es el dialecto, y el engine sólo propaga lo que recibe. Lo
  // que no está aquí no es un error semántico y sale tal cual: inventarle un
  // código al consumidor sería peor que decir "error del servidor".
  //
  //   * 57014 (query_canceled): el `statement_timeout` cortó. Para el
  //     consumidor no es un fallo de la base, es su presupuesto agotado.
  //   * 42703 (undefined_column) y 42P01 (undefined_table): el SQL nombra algo
  //     que la base ya no tiene. El catálogo se registró contra un esquema que
  //     cambió debajo, y ninguna consulta de esa entidad va a funcionar hasta
  //     que se vuelva a registrar: es un problema del servidor, no de quien
  //     preguntó.
  //   * La conexión que no se pudo abrir (`ECONNREFUSED`, `ETIMEDOUT`,
  //     `ENOTFOUND`, la clase 08 de SQLSTATE, `57P01` y el timeout de conexión
  //     de node-postgres): `SOURCE_UNAVAILABLE`. Se traduce aquí y no en el
  //     engine porque cuáles son esos errores depende del motor y de su
  //     driver.
  traducirError(error, presupuesto) {
    if (fuenteInalcanzable(error)) {
      return new SemanticError({
        code: 'SOURCE_UNAVAILABLE',
        suggestion:
          'La base de esta fuente no está respondiendo: la conexión se perdió o no se pudo abrir. No es un problema de la consulta; reintenta más tarde.',
      });
    }
    if (error?.code === '57014') {
      return new SemanticError({
        code: 'QUERY_TIMEOUT',
        suggestion: `La consulta superó los ${presupuesto?.timeoutMs} ms de presupuesto de tu clase de consumidor: acota el rango temporal, sube la granularidad o pide menos dimensiones.`,
      });
    }
    if (error?.code === '42703' || error?.code === '42P01') {
      return new SemanticError({
        code: 'SCHEMA_DRIFT',
        suggestion:
          'El esquema de la base ya no calza con el catálogo: la consulta nombra una tabla o una columna que la base no tiene. Hay que volver a introspectar y re-registrar las definiciones contra el esquema actual.',
      });
    }
    return error;
  },
};

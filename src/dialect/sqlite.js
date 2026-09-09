// Dialecto SQLite: el segundo motor, y la prueba de que el seam del dialecto
// aguanta. Tiene exactamente las mismas cuatro responsabilidades que
// `postgres.js` y ninguna otra pieza cambió para que existiera:
//
//   1. Sintaxis SQL y capacidades.
//   2. Introspección del esquema.
//   3. Mapa de tipos físicos → semánticos.
//   4. Traducción de errores nativos.
//
// Se eligió SQLite justamente por ser el motor más distinto que se puede meter
// sin agregar una dependencia: `node:sqlite` viene con Node 24. Lo que no
// aguantó el molde quedó documentado como capacidad (`tiposGarantizados`,
// `timeoutDeSentencia`) en vez de escondido en un `if` del engine.
import { GRANULARIDADES } from '../vocabulary.js';
import { SemanticError } from '../errors.js';

const SOPORTADAS = new Set(GRANULARIDADES);

// SQLite llama `main` a la base principal. Es el equivalente del `public` de
// Postgres para la forma del snapshot: un nombre, no una consulta.
const ESQUEMA = 'main';

// --- 2. Introspección -------------------------------------------------------
//
// SQLite no tiene `information_schema`: el catálogo de un archivo se lee con
// `sqlite_master` y con los PRAGMA. La *forma* del snapshot es la misma que
// produce el dialecto de Postgres —`{ schema, tables: { <t>: { columns,
// indexes } } }`—, porque esa forma es del catálogo y no del motor.
const TABLAS = `
  SELECT name
  FROM sqlite_master
  WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
  ORDER BY name
`;

// Los PRAGMA no aceptan parámetros, así que el nombre de la tabla se interpola.
// No es una puerta de inyección: los nombres salen de `sqlite_master`, es decir
// de la propia base, y van entre comillas dobles con las comillas escapadas.
function identificador(nombre) {
  return `"${nombre.replaceAll('"', '""')}"`;
}

// --- 3. Mapa de tipos -------------------------------------------------------
//
// SQLite no tiene tipos de columna: tiene **afinidades**, y las deduce del
// texto del tipo declarado con reglas de subcadena (por eso `VARCHAR(80)`,
// `NATIVE CHARACTER` y `CLOB` son todos texto). El mapa se escribe igual: en el
// orden en que SQLite las evalúa, y sobre el tipo declarado en mayúsculas.
// Lo que no cae en ninguna regla no tiene traducción, y el catálogo entonces no
// juzga la compatibilidad: la misma respuesta conservadora que da Postgres ante
// un tipo que no conoce.
const AFINIDADES = [
  { contiene: ['INT'], tipo: 'number' },
  { contiene: ['CHAR', 'CLOB', 'TEXT'], tipo: 'string' },
  { contiene: ['DATE'], tipo: 'date' },
  { contiene: ['BOOL'], tipo: 'boolean' },
  { contiene: ['REAL', 'FLOA', 'DOUB', 'NUMERIC', 'DECIMAL'], tipo: 'number' },
];

export const sqlite = {
  name: 'sqlite',

  capabilities: {
    dateTrunc: true,
    agregadoFiltrado: true,
    // SQLite guarda lo que le den: el tipo declarado de una columna es una
    // afinidad, no una restricción, y nada impide que una columna `NUMERIC`
    // tenga un texto en una fila. Por eso una incompatibilidad entre el tipo
    // declarado en la definición y el físico es una **advertencia** de registro
    // y no un error: es una sospecha bien fundada, no un hecho.
    tiposGarantizados: false,
    // SQLite no tiene `statement_timeout` ni equivalente por sentencia: no hay
    // forma de decirle "corta esta consulta a los 5000 ms". El presupuesto de
    // tiempo de la clase de consumidor **no se puede hacer cumplir** en esta
    // fuente; el resto del presupuesto (límite de filas, TTL de caché, rango
    // obligatorio) sí, porque lo aplica el planificador. La capacidad está para
    // que eso se pueda leer en un catálogo y no se descubra midiendo.
    timeoutDeSentencia: false,
  },

  // --- 1. Sintaxis SQL ------------------------------------------------------

  // Mismo contrato que Postgres: texto ISO `YYYY-MM-DD`, para que el valor de
  // una dimensión temporal sea el mismo en cualquier motor y en cualquier
  // máquina. Aquí sale de `strftime`, que trabaja sobre el texto ISO tal como
  // está guardado; el trimestre no tiene función propia y se calcula con
  // aritmética de enteros sobre el mes: (m - 1) / 3 * 3 + 1 da 1, 4, 7 o 10.
  dateTrunc(granularidad, expresion) {
    if (!SOPORTADAS.has(granularidad)) {
      throw new Error(`Granularidad no soportada por el dialecto: ${granularidad}`);
    }
    if (granularidad === 'day') return `STRFTIME('%Y-%m-%d', ${expresion})`;
    if (granularidad === 'month') return `STRFTIME('%Y-%m-01', ${expresion})`;
    if (granularidad === 'year') return `STRFTIME('%Y-01-01', ${expresion})`;
    // La semana de Postgres empieza el lunes; `weekday 1` de SQLite avanza al
    // lunes siguiente, así que se retrocede una semana antes de avanzar.
    if (granularidad === 'week') return `DATE(${expresion}, '-6 days', 'weekday 1')`;
    return (
      `PRINTF('%s-%02d-01', STRFTIME('%Y', ${expresion}), ` +
      `(CAST(STRFTIME('%m', ${expresion}) AS INTEGER) - 1) / 3 * 3 + 1)`
    );
  },

  // `FILTER` es estándar y SQLite lo soporta desde 3.30; Node 24 trae una
  // versión muy posterior. Se escribe igual que en Postgres, y que se escriba
  // igual no significa que el planificador pueda darlo por sentado: se lo
  // sigue preguntando al dialecto.
  agregadoFiltrado(agregado, condicion) {
    return `${agregado} FILTER (WHERE ${condicion})`;
  },

  // Forzar aritmética real. En Postgres es `::numeric`; aquí, un CAST estándar.
  // Sin esto, la división de dos COUNT es entera y 3/4 da 0: el mismo error que
  // el `::numeric` evita del otro lado.
  aNumerico(expresion) {
    return `CAST(${expresion} AS REAL)`;
  },

  // SQLite le da precedencia a la CTE por sobre la tabla del mismo nombre: en
  // `WITH employees AS (SELECT ... FROM employees ...)` la referencia de adentro
  // apunta a la propia CTE y el motor corta con "circular reference: employees".
  // Postgres resuelve la tabla base en ese mismo SQL, así que el planificador
  // había dado por sentado que un alias de CTE puede repetir el nombre de la
  // tabla. Calificar con el esquema (`main.employees`) le dice a SQLite que se
  // trata de la tabla y no de la CTE, y es lo mínimo que arregla el caso sin
  // cambiar el nombre de ninguna CTE ni el SQL del otro motor.
  tablaFisica(tabla) {
    return `${ESQUEMA}.${tabla}`;
  },

  // No hay `sentenciasDeSesion`: SQLite no tiene ninguna sentencia con la que
  // fijar el presupuesto de tiempo, y el engine no emite lo que el dialecto no
  // le ofrece. Inventar aquí un `SET` que el motor ignora sería peor que no
  // tenerlo: parecería que el timeout se aplica.

  // Identidad de la base: SQLite no tiene identificador propio; lo más cercano
  // es el archivo. Una base en memoria no tiene ninguno, y el engine cae al
  // nombre de la fuente.
  async identificador(pool) {
    return pool.archivo && pool.archivo !== ':memory:' ? `sqlite:${pool.archivo}` : undefined;
  },

  // --- 2. Introspección -----------------------------------------------------
  async introspect(pool, esquema = ESQUEMA) {
    const { rows: tablas } = await pool.query(TABLAS);

    const tables = {};
    for (const { name } of tablas) {
      const { rows: columnas } = await pool.query(`PRAGMA table_info(${identificador(name)})`);
      const { rows: indices } = await pool.query(`PRAGMA index_list(${identificador(name)})`);

      const columns = {};
      // `table_info` viene en el orden de la tabla y `index_list` se ordena por
      // nombre: dos introspecciones de la misma base dan el mismo snapshot, que
      // es lo que permite usarlo dentro de la versión del catálogo.
      for (const columna of columnas) columns[columna.name] = columna.type;

      const indexes = [];
      for (const indice of [...indices].sort((a, b) => a.name.localeCompare(b.name))) {
        const { rows: partes } = await pool.query(`PRAGMA index_info(${identificador(indice.name)})`);
        indexes.push({
          name: indice.name,
          // Una parte de índice sobre una expresión no tiene nombre de columna
          // (`name` es null): se descarta, y el índice simplemente no coincide
          // con ninguna columna. Es la misma respuesta conservadora que da el
          // dialecto de Postgres ante un índice sobre expresión.
          columns: partes.map((parte) => parte.name).filter((nombre) => nombre !== null),
          unique: indice.unique === 1,
        });
      }

      tables[name] = { columns, indexes };
    }

    return { schema: esquema, tables };
  },

  // --- 3. Mapa de tipos -----------------------------------------------------
  tipoSemantico(tipoFisico) {
    const declarado = String(tipoFisico ?? '').toUpperCase();
    return AFINIDADES.find(({ contiene }) => contiene.some((parte) => declarado.includes(parte)))?.tipo;
  },

  // --- 4. Errores nativos ---------------------------------------------------
  //
  // SQLite no tiene SQLSTATE: sus errores se distinguen por el texto. Ese texto
  // es un detalle de este motor y por eso vive aquí; el engine no conoce ni una
  // palabra de SQLite.
  //
  //   * "no such column" / "no such table": el SQL nombra algo que la base ya no
  //     tiene, igual que el 42703/42P01 de Postgres → `SCHEMA_DRIFT`.
  //   * "interrupted": alguien cortó la sentencia en curso. Es lo más parecido
  //     a un timeout que SQLite ofrece, y no lo produce ningún presupuesto
  //     nuestro —`timeoutDeSentencia: false`—, así que se traduce a
  //     `QUERY_TIMEOUT` para que el consumidor reciba el mismo código que
  //     recibiría de la otra fuente si la consulta se corta.
  traducirError(error, presupuesto) {
    const mensaje = error?.message ?? '';
    if (/no such (column|table)/i.test(mensaje)) {
      return new SemanticError({
        code: 'SCHEMA_DRIFT',
        suggestion:
          'El esquema de la base ya no calza con el catálogo: la consulta nombra una tabla o una columna que la base no tiene. Hay que volver a introspectar y re-registrar las definiciones contra el esquema actual.',
      });
    }
    if (/interrupted/i.test(mensaje)) {
      return new SemanticError({
        code: 'QUERY_TIMEOUT',
        suggestion: `La consulta se interrumpió antes de terminar; el presupuesto de tu clase de consumidor es de ${presupuesto?.timeoutMs} ms: acota el rango temporal, sube la granularidad o pide menos dimensiones.`,
      });
    }
    return error;
  },
};

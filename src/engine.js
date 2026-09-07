// Engine: recibe una consulta declarativa más el contexto de sesión, resuelve
// contra el catálogo y genera el SQL. No conoce módulos concretos (ADR 0001).
import { createHash } from 'node:crypto';

import { presupuestos as presupuestosPorDefecto, presupuestoDe } from './budgets.js';
import { postgres } from './dialect/postgres.js';
import { SemanticError } from './errors.js';
import { OPERADORES_EN_SQL, operadoresDe } from './vocabulary.js';

const PARAMETRO_EMPRESA = '$1';

// El contexto de sesión viaja aparte de la consulta y nunca se lee de una
// variable global ni del cuerpo de la petición (ADR 0002).
function exigirEmpresa(ctx) {
  if (ctx?.companyId === undefined || ctx?.companyId === null) {
    throw new SemanticError({
      code: 'MISSING_TENANT',
      member: 'companyId',
      suggestion:
        'La aplicación debe pasar el contexto de sesión { companyId, consumer } como segundo argumento; no se acepta dentro de la consulta.',
    });
  }
}

// El contexto de sesión no tiene forma de expresarse en la consulta: si el JSON
// trae uno de sus campos, es un intento de elegir empresa o presupuesto propio.
const CAMPOS_PROHIBIDOS = ['companyId', 'consumer'];

function rechazarCamposDeContexto(query) {
  for (const campo of CAMPOS_PROHIBIDOS) {
    if (query?.[campo] === undefined) continue;
    throw new SemanticError({
      code: 'FORBIDDEN_FIELD',
      member: campo,
      suggestion: 'El contexto lo construye el servidor desde el token; quita este campo de la consulta.',
    });
  }
}

function sqlDeMedida(medida, entidad) {
  if (medida.type === 'count') return 'COUNT(*)';
  if (medida.type === 'avg') return `AVG(${entidad}.${medida.column})`;
  throw new Error(`Tipo de medida no soportado: ${medida.type}`);
}

// Nombre de la etapa agregada cuando la consulta lleva derivadas.
const ALIAS_AGREGADA = 'agregada';

function indentar(texto) {
  return texto
    .split('\n')
    .map((linea) => `  ${linea}`)
    .join('\n');
}

// Dos filtros son el mismo cuando comparan el mismo miembro con el mismo
// operador y los mismos valores. Es la comparación que permite reconocer que un
// filtro global repite el filtro propio de una medida.
function claveDeFiltro(filtro) {
  return `${filtro.member}|${filtro.operator}|${JSON.stringify(filtro.values ?? [])}`;
}

// Un filtro dicho en palabras, para que la advertencia nombre al culpable.
function describirFiltros(filtros) {
  return filtros
    .map((filtro) => `${filtro.member} ${filtro.operator} ${(filtro.values ?? []).join(', ')}`)
    .join(' y ');
}

// Operadores cuyo valor es una lista: sin elementos no hay SQL que emitir.
const OPERADORES_DE_LISTA = new Set(['in', 'notIn']);

// El operador de un filtro sale de la tabla del vocabulario según el tipo de la
// dimensión: la misma tabla que el catálogo publica en `describe()`, para que
// nunca prometa un operador que el engine rechaza.
function exigirOperador(filtro, tipo) {
  const validos = operadoresDe(tipo);
  if (!validos.includes(filtro.operator)) {
    throw new SemanticError({
      code: 'INVALID_OPERATOR',
      member: filtro.member,
      suggestion: `El operador ${filtro.operator} no aplica a una dimensión de tipo ${tipo}; usa uno de: ${validos.join(', ')}.`,
    });
  }
  // Un operador de lista sin valores produciría `IN ()`, que no es SQL válido:
  // el error aparecería recién en la base y sin decir qué miembro lo causó. Se
  // comprueba antes de saber si el operador ya tiene SQL, porque una lista
  // vacía es un error del consumidor en cualquiera de los dos.
  if (OPERADORES_DE_LISTA.has(filtro.operator) && (filtro.values ?? []).length === 0) {
    throw new SemanticError({
      code: 'INVALID_OPERATOR',
      member: filtro.member,
      suggestion: `El operador ${filtro.operator} requiere al menos un valor: declara values con los valores a comparar.`,
    });
  }
  if (!OPERADORES_EN_SQL.has(filtro.operator)) {
    const emitibles = validos.filter((operador) => OPERADORES_EN_SQL.has(operador));
    throw new SemanticError({
      code: 'UNSUPPORTED_OPERATOR',
      member: filtro.member,
      suggestion: `El operador ${filtro.operator} es válido para el tipo ${tipo} pero el planificador todavía no lo emite; por ahora usa: ${emitibles.join(', ')}.`,
    });
  }
}

// Camino de joins: BFS sobre relaciones `many_to_one` desde la entidad de
// hechos. Solo se recorren aristas que no multiplican filas (ADR 0006), así que
// agregar una dimensión de otra entidad nunca cambia el valor de las medidas.
function caminoDeJoins(catalog, raiz, destinos) {
  const previa = new Map([[raiz, null]]);
  const pendientes = [raiz];

  while (pendientes.length > 0) {
    const actual = pendientes.shift();
    const relaciones = catalog.entity(actual).relationships ?? {};
    for (const relacion of Object.values(relaciones)) {
      if (relacion.type !== 'many_to_one' || previa.has(relacion.target)) continue;
      previa.set(relacion.target, { desde: actual, relacion });
      pendientes.push(relacion.target);
    }
  }

  // De cada destino se vuelve hacia la raíz; el orden final deja siempre la
  // entidad de origen de un join antes que su destino.
  const aristas = [];
  const vistas = new Set([raiz]);
  for (const destino of destinos) {
    if (!previa.has(destino)) {
      throw new SemanticError({
        code: 'NO_JOIN_PATH',
        member: destino,
        suggestion: `No hay relaciones declaradas que lleven de ${raiz} a ${destino}.`,
      });
    }
    const rama = [];
    for (let entidad = destino; entidad !== raiz; entidad = previa.get(entidad).desde) {
      rama.unshift({ hacia: entidad, ...previa.get(entidad) });
    }
    for (const arista of rama) {
      if (vistas.has(arista.hacia)) continue;
      vistas.add(arista.hacia);
      aristas.push(arista);
    }
  }
  return aristas;
}

// `presupuestos` se inyecta para poder probar el comportamiento bajo un
// presupuesto extremo (por ejemplo un timeout de 1 ms) sin tocar la tabla real.
export function createEngine({
  catalog,
  pool,
  dialect = postgres,
  presupuestos = presupuestosPorDefecto,
}) {
  function planificar(query, ctx) {
    rechazarCamposDeContexto(query);
    exigirEmpresa(ctx);
    const presupuesto = presupuestoDe(ctx.consumer, presupuestos);

    // Los valores literales de la consulta viajan como parámetros: dos
    // consultas con la misma forma generan exactamente el mismo SQL.
    const params = [ctx.companyId];
    const parametro = (valor) => `$${params.push(valor)}`;

    // Un filtro se declara como { member, operator, values } y el engine es el
    // único que lo traduce a SQL (ADR 0005). Dentro de una CTE la columna va
    // sola; en el FILTER de una medida va calificada por el alias de la CTE.
    const condicionDeFiltro = (filtro, { calificada } = {}) => {
      const { entidad, columna, tipo } = catalog.dimension(filtro.member);
      exigirOperador(filtro, tipo);
      const izquierda = calificada ? `${entidad}.${columna}` : columna;
      const valores = filtro.values ?? [];
      if (filtro.operator === 'in') {
        return `${izquierda} IN (${valores.map((valor) => parametro(valor)).join(', ')})`;
      }
      const comparador = filtro.operator === 'notEquals' ? '<>' : '=';
      return `${izquierda} ${comparador} ${parametro(valores[0])}`;
    };

    // Los miembros los resuelve el catálogo: es quien sabe qué existe y quién
    // corta con UNKNOWN_MEMBER y una sugerencia cuando el nombre está mal.
    const medidas = (query.measures ?? []).map((miembro) => catalog.measure(miembro));

    // Una derivada no se agrega: combina medidas que sí se agregan.
    const derivadas = medidas.filter((medida) => medida.definicion.type === 'ratio');

    const dimensiones = (query.dimensions ?? []).map((miembro) => {
      const { entidad, columna } = catalog.dimension(miembro);
      return { miembro, entidad, columna, expresion: `${entidad}.${columna}` };
    });

    // Una dimensión temporal es una dimensión más, agrupada por granularidad;
    // su rango acota la CTE de su entidad y no el resultado ya agregado.
    const condiciones = new Map();
    for (const temporal of query.timeDimensions ?? []) {
      const { entidad, columna } = catalog.dimension(temporal.dimension);
      dimensiones.push({
        miembro: temporal.dimension,
        entidad,
        columna,
        expresion: dialect.dateTrunc(temporal.granularity, `${entidad}.${columna}`),
      });
      if (!temporal.dateRange) continue;
      const [desde, hasta] = temporal.dateRange;
      // Rango cerrado en ambos extremos, como el dateRange de Cube.
      condiciones.set(entidad, [
        ...(condiciones.get(entidad) ?? []),
        `${columna} >= ${parametro(desde)}`,
        `${columna} <= ${parametro(hasta)}`,
      ]);
    }

    // Los filtros de la consulta viven en la CTE de la entidad de su dimensión,
    // junto al filtro de empresa: se aplican antes de agregar y la entidad
    // filtrada entra al camino de joins aunque no sea una dimensión pedida.
    const filtrados = new Set();
    // Un segmento de la consulta aporta los filtros que su dueño declaró: para
    // el planificador no hay diferencia entre esos y los filtros del JSON.
    const declarados = [
      ...(query.filters ?? []),
      ...(query.segments ?? []).flatMap((miembro) => catalog.segment(miembro).definicion.filters),
    ];
    for (const filtro of declarados) {
      const { entidad } = catalog.dimension(filtro.member);
      filtrados.add(entidad);
      condiciones.set(entidad, [...(condiciones.get(entidad) ?? []), condicionDeFiltro(filtro)]);
    }

    // El presupuesto del agente exige acotar el tiempo: una consulta sin rango
    // sobre toda la historia es la forma más fácil de fabricar una consulta que
    // no termina.
    if (presupuesto.rangoObligatorio) {
      const temporales = query.timeDimensions ?? [];
      if (!temporales.some((temporal) => temporal.dateRange)) {
        throw new SemanticError({
          code: 'MISSING_TIME_RANGE',
          member: temporales[0]?.dimension ?? 'timeDimensions',
          suggestion:
            'Tu clase de consumidor exige acotar el tiempo: agrega timeDimensions con dateRange [desde, hasta].',
        });
      }
    }

    // Una sola entidad de hechos en v1: medidas de dos entidades en el mismo
    // SELECT multiplican filas y devuelven números incorrectos en silencio
    // (ADR 0006).
    const raiz = medidas[0].entidad;
    const intrusa = medidas.find((m) => m.entidad !== raiz);
    if (intrusa) {
      throw new SemanticError({
        code: 'MULTI_ENTITY_MEASURES',
        member: intrusa.miembro,
        suggestion: `Las medidas de una consulta deben salir de una sola entidad; ${intrusa.miembro} no es de ${raiz}. Pide ${intrusa.miembro} en una segunda consulta.`,
      });
    }
    const aristas = caminoDeJoins(
      catalog,
      raiz,
      [...dimensiones.map((d) => d.entidad), ...filtrados],
    );

    // Las medidas base de la consulta: las que el consumidor pidió, más las que
    // necesitan sus derivadas aunque no las haya pedido.
    const bases = new Map();
    for (const medida of medidas) {
      if (medida.definicion.type !== 'ratio') bases.set(medida.miembro, medida);
    }

    // El catálogo entrega las derivadas de la entidad en orden de dependencia
    // (ADR 0004): recorrerlo una vez basta para escribir cada fórmula con las
    // que necesita ya resueltas. Primero, hacia atrás, se marca cuáles hacen
    // falta; una razón que nadie pidió no se calcula.
    const declaracionesDeMedida = catalog.entity(raiz).measures;
    const ordenDeCalculo = catalog.derivedOrder(raiz);
    const necesarias = new Set(derivadas.map((medida) => medida.nombre));
    for (const nombre of [...ordenDeCalculo].reverse()) {
      if (!necesarias.has(nombre)) continue;
      const { numerator, denominator } = declaracionesDeMedida[nombre];
      for (const parte of [numerator, denominator]) {
        if (declaracionesDeMedida[parte]?.type === 'ratio') necesarias.add(parte);
      }
    }

    // `::numeric` evita la división entera —dos COUNT son enteros y 3/4 da 0— y
    // `NULLIF` convierte el denominador cero en NULL, que es la respuesta
    // honesta: sin evaluaciones no hay porcentaje que informar. La escala la
    // valida el catálogo como número, y por eso puede interpolarse.
    const formulas = new Map();
    for (const nombre of ordenDeCalculo) {
      if (!necesarias.has(nombre)) continue;
      const { numerator, denominator, scale } = declaracionesDeMedida[nombre];
      const parte = (dependencia) => {
        if (formulas.has(dependencia)) return `(${formulas.get(dependencia)})`;
        const base = catalog.measure(`${raiz}.${dependencia}`);
        bases.set(base.miembro, base);
        return `"${base.miembro}"`;
      };
      const razon = `${parte(numerator)}::numeric / NULLIF(${parte(denominator)}, 0)`;
      formulas.set(nombre, scale === undefined ? razon : `${razon} * ${scale}`);
    }
    const medidasBase = [...bases.values()];

    // El filtro de una medida se declara una sola vez, como segmento.
    const filtrosDeMedida = (medida) =>
      medida.definicion.segment
        ? catalog.entity(medida.entidad).segments[medida.definicion.segment].filters
        : [];

    // Semántica de filtros: los filtros de la consulta y sus segmentos son
    // globales —afectan a todas las medidas— y el filtro propio de una medida
    // se suma al global. De ahí sale el caso engañoso de la historia 18: si un
    // filtro global repite justamente lo que distingue al numerador de una
    // razón, numerador y denominador terminan contando las mismas filas y la
    // razón vale su escala en todas las filas. El número está bien calculado y
    // mal pedido; se devuelve con una advertencia que lo explica.
    const globales = new Set(declarados.map(claveDeFiltro));
    const advertencias = [];
    for (const derivada of derivadas) {
      const propios = (nombre) =>
        filtrosDeMedida({ entidad: raiz, definicion: declaracionesDeMedida[nombre] ?? {} });
      const delDenominador = new Set(propios(derivada.definicion.denominator).map(claveDeFiltro));
      const distintivos = propios(derivada.definicion.numerator).filter(
        (filtro) => !delDenominador.has(claveDeFiltro(filtro)),
      );
      if (distintivos.length === 0) continue;
      if (!distintivos.every((filtro) => globales.has(claveDeFiltro(filtro)))) continue;

      const escala = derivada.definicion.scale ?? 1;
      advertencias.push({
        member: derivada.miembro,
        warning: `El filtro global ${describirFiltros(distintivos)} es el mismo que distingue al numerador de ${derivada.miembro}: aplicado a toda la consulta, numerador y denominador cuentan las mismas filas y la razón vale ${escala} en cada fila. Quita ese filtro de la consulta para ver la tasa real.`,
      });
    }

    // Cada entidad solo lleva a su CTE las columnas que la consulta necesita.
    const columnas = new Map([[raiz, new Set()]]);
    const pedir = (entidad, columna) => {
      if (!columnas.has(entidad)) columnas.set(entidad, new Set());
      columnas.get(entidad).add(columna);
    };
    for (const dimension of dimensiones) pedir(dimension.entidad, dimension.columna);
    for (const medida of medidasBase) {
      if (medida.definicion.column) pedir(medida.entidad, medida.definicion.column);
      for (const filtro of filtrosDeMedida(medida)) {
        const { entidad, columna } = catalog.dimension(filtro.member);
        pedir(entidad, columna);
      }
    }
    for (const { desde, hacia, relacion } of aristas) {
      pedir(desde, relacion.foreignKey);
      pedir(hacia, catalog.entity(hacia).primaryKey);
    }

    // El filtro de empresa vive dentro de la CTE, en el único lugar donde se
    // nombra la tabla física (ADR 0003).
    const cte = [raiz, ...aristas.map((a) => a.hacia)].map((nombre) => {
      const entidad = catalog.entity(nombre);
      const filtrosDeLaCte = [
        `${entidad.companyColumn} = ${PARAMETRO_EMPRESA}`,
        ...(condiciones.get(nombre) ?? []),
      ];
      return (
        `${nombre} AS (\n` +
        `  SELECT ${[...columnas.get(nombre)].join(', ')}\n` +
        `  FROM ${entidad.table}\n` +
        `  WHERE ${filtrosDeLaCte.join('\n    AND ')}\n` +
        `)`
      );
    });

    // Etapa agregada: dimensiones y medidas base. Una medida base sale de su
    // agregado, filtrado por el segmento que su dueño le declaró.
    const seleccion = [
      ...dimensiones.map((d) => `${d.expresion} AS "${d.miembro}"`),
      ...medidasBase.map((m) => {
        const agregado = sqlDeMedida(m.definicion, m.entidad);
        const filtros = filtrosDeMedida(m);
        const expresion = filtros.length
          ? dialect.agregadoFiltrado(
              agregado,
              filtros.map((filtro) => condicionDeFiltro(filtro, { calificada: true })).join(' AND '),
            )
          : agregado;
        return `${expresion} AS "${m.miembro}"`;
      }),
    ];
    const agrupacion = dimensiones.map((d) => d.expresion);
    const joins = aristas.map(
      ({ desde, hacia, relacion }) =>
        `\nJOIN ${hacia} ON ${desde}.${relacion.foreignKey} = ${hacia}.${catalog.entity(hacia).primaryKey}`,
    );

    // Se ordena por el nombre semántico de la columna de salida: el consumidor
    // ordena por lo que pidió, no por la expresión con la que se calculó. La
    // llave termina como identificador entre comillas, así que solo puede ser
    // un miembro que la consulta devuelve: cualquier otro texto se rechaza
    // antes de tocar el SQL.
    const salida = new Set([...dimensiones, ...medidas].map((m) => m.miembro));
    const orden = Object.entries(query.order ?? {}).map(([miembro, direccion]) => {
      if (!salida.has(miembro)) {
        throw new SemanticError({
          code: 'UNKNOWN_MEMBER',
          member: miembro,
          suggestion:
            'Ordena por un miembro presente en measures, dimensions o timeDimensions de la misma consulta.',
        });
      }
      if (direccion !== 'asc' && direccion !== 'desc') {
        throw new Error(`Dirección de orden no soportada: ${direccion}`);
      }
      return `"${miembro}" ${direccion.toUpperCase()}`;
    });

    // Una consulta sin derivadas es la consulta agregada y nada más. Con
    // derivadas, la agregación pasa a ser la etapa de adentro y la fórmula se
    // escribe afuera, sobre sus alias: así solo puede ver valores ya agregados
    // y las bases que el consumidor no pidió no llegan a las filas (ADR 0004).
    const agregada = [
      `SELECT ${seleccion.join(', ')}`,
      `FROM ${raiz}${joins.join('')}`,
      ...(agrupacion.length ? [`GROUP BY ${agrupacion.join(', ')}`] : []),
    ];
    const cuerpo = derivadas.length
      ? [
          `SELECT ${[
            ...dimensiones.map((d) => `"${d.miembro}"`),
            ...medidas.map((m) =>
              m.definicion.type === 'ratio'
                ? `${formulas.get(m.nombre)} AS "${m.miembro}"`
                : `"${m.miembro}"`,
            ),
          ].join(', ')}`,
          `FROM (\n${indentar(agregada.join('\n'))}\n) AS ${ALIAS_AGREGADA}`,
        ]
      : agregada;

    const sql = [
      `WITH ${cte.join(',\n')}`,
      ...cuerpo,
      ...(orden.length ? [`ORDER BY ${orden.join(', ')}`] : []),
      // Ninguna consulta sale sin LIMIT: el pedido nunca supera el máximo de
      // la clase de consumidor, y si no pide, manda ese máximo.
      `LIMIT ${parametro(Math.min(query.limit ?? presupuesto.maxFilas, presupuesto.maxFilas))}`,
    ].join('\n');

    return { sql, params, medidas, presupuesto, advertencias };
  }

  // Dry-run: el plan sin tocar la base.
  function plan(query, ctx) {
    const { sql, params } = planificar(query, ctx);
    return { sql, params };
  }

  // El timeout se fija con SET LOCAL dentro de la transacción: fuera de una
  // transacción Postgres lo ignora, y dentro se deshace al cerrarla, así que la
  // conexión vuelve al pool sin el estado de esta petición. El cliente se
  // libera siempre, y ante un error se hace ROLLBACK antes de soltarlo para que
  // la siguiente petición no herede una transacción abierta.
  async function ejecutar(sql, params, presupuesto) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      // SET no admite parámetros: el valor se interpola y por eso solo puede
      // venir de la tabla de presupuestos, ya validado como entero.
      await cliente.query(`SET LOCAL statement_timeout = ${milisegundos(presupuesto)}`);
      const resultado = await cliente.query(sql, params);
      await cliente.query('COMMIT');
      return resultado.rows;
    } catch (error) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw traducirErrorDeBase(error, presupuesto);
    } finally {
      cliente.release();
    }
  }

  async function run(query, ctx) {
    const { sql, params, medidas, presupuesto, advertencias } = planificar(query, ctx);

    // Instante en que se ejecutó la consulta que produjo el resultado; cuando
    // haya caché, la entrada guardada conserva su propio asOf.
    const asOf = new Date().toISOString();
    const filas = await ejecutar(sql, params, presupuesto);

    return {
      rows: aNumeros(filas, medidas),
      meta: {
        servedFrom: 'live',
        asOf,
        queryId: identificarConsulta(query, ctx),
        // Siempre presente, aunque esté vacía: quien la lee no tiene que
        // preguntarse si el campo existe.
        warnings: advertencias,
      },
    };
  }

  return { plan, run };
}

function milisegundos(presupuesto) {
  if (!Number.isInteger(presupuesto.timeoutMs) || presupuesto.timeoutMs <= 0) {
    throw new Error(`Timeout de presupuesto inválido: ${presupuesto.timeoutMs}`);
  }
  return presupuesto.timeoutMs;
}

// Postgres cancela la consulta que pasa el statement_timeout con el código
// 57014 (query_canceled). Para el consumidor no es un fallo de la base: es su
// presupuesto agotado, y como tal vuelve con sugerencia de qué reducir.
function traducirErrorDeBase(error, presupuesto) {
  if (error?.code !== '57014') return error;
  return new SemanticError({
    code: 'QUERY_TIMEOUT',
    suggestion: `La consulta superó los ${presupuesto.timeoutMs} ms de presupuesto de tu clase de consumidor: acota el rango temporal, sube la granularidad o pide menos dimensiones.`,
  });
}

// Postgres devuelve int8 y numeric como texto para no perder precisión; las
// medidas vuelven al consumidor como números.
function aNumeros(filas, medidas) {
  const miembrosNumericos = new Set(medidas.map((m) => m.miembro));
  return filas.map((fila) =>
    Object.fromEntries(
      Object.entries(fila).map(([miembro, valor]) => [
        miembro,
        miembrosNumericos.has(miembro) && valor !== null ? Number(valor) : valor,
      ]),
    ),
  );
}

// Identidad de la consulta: su forma más la empresa. La empresa entra al hash
// para que una entrada de caché nunca pueda servir a otra empresa.
function identificarConsulta(query, ctx) {
  return createHash('sha256')
    .update(JSON.stringify({ companyId: ctx.companyId, query }))
    .digest('hex')
    .slice(0, 16);
}

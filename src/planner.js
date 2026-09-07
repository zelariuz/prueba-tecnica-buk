// Planificador: traduce una consulta declarativa al SQL que la responde. Es la
// única pieza que emite SQL (ADR 0005) y no conoce módulos concretos: todo lo
// que sabe del dominio se lo pregunta al catálogo.
//
// Está escrito como el pipeline de puertas del PRD: cada puerta recibe el paso
// —la consulta, el contexto y lo que las anteriores resolvieron— y lo devuelve
// enriquecido, o corta con un error estructurado. El orden importa por dos
// razones: los filtros aportan entidades al camino de joins, y los parámetros
// `$n` se numeran en el orden en que se piden, así que mover una puerta cambia
// el SQL.
import { presupuestoDe } from './budgets.js';
import { SemanticError } from './errors.js';
import { OPERADORES_EN_SQL, operadoresDe } from './vocabulary.js';

const PARAMETRO_EMPRESA = '$1';

// Nombre de la etapa agregada cuando la consulta lleva derivadas.
const ALIAS_AGREGADA = 'agregada';

// Operadores cuyo valor es una lista: sin elementos no hay SQL que emitir.
const OPERADORES_DE_LISTA = new Set(['in', 'notIn']);

export function crearPlanificador({ catalog, dialect, presupuestos }) {
  const puertas = [
    validar,
    resolverMiembros,
    aplicarFiltros,
    resolverCaminoDeJoins,
    resolverAgregacion,
    emitirSql,
    describirPlan,
  ];

  return function planificar(query, ctx) {
    let paso = { catalog, dialect, presupuestos, query, ctx };
    for (const puerta of puertas) paso = anotandoLaPuerta(puerta, paso);
    const { sql, params, medidas, presupuesto, advertencias, logico } = paso;
    return { sql, params, medidas, presupuesto, advertencias, logico };
  };
}

// Qué puerta cortó es la señal que le sirve a plataforma para saber si los
// rechazos vienen del vocabulario o del presupuesto (historia 31). Se anota en
// el error sin hacerla enumerable: no forma parte del error estructurado que ve
// el consumidor, así que no cambia ninguna respuesta.
function anotandoLaPuerta(puerta, paso) {
  try {
    return puerta(paso);
  } catch (error) {
    if (error && error.gate === undefined) {
      Object.defineProperty(error, 'gate', { value: puerta.name, enumerable: false });
    }
    throw error;
  }
}

// Puerta 1 · Validar: lo que se puede rechazar sin mirar el catálogo. El
// contexto de sesión viaja aparte de la consulta y nunca se lee de una variable
// global ni del cuerpo de la petición (ADR 0002); si el JSON trae uno de sus
// campos, es un intento de elegir empresa o presupuesto propio.
function validar(paso) {
  const { query, ctx, presupuestos } = paso;

  for (const campo of ['companyId', 'consumer']) {
    if (query?.[campo] === undefined) continue;
    throw new SemanticError({
      code: 'FORBIDDEN_FIELD',
      member: campo,
      suggestion: 'El contexto lo construye el servidor desde el token; quita este campo de la consulta.',
    });
  }

  if (ctx?.companyId === undefined || ctx?.companyId === null) {
    throw new SemanticError({
      code: 'MISSING_TENANT',
      member: 'companyId',
      suggestion:
        'La aplicación debe pasar el contexto de sesión { companyId, consumer } como segundo argumento; no se acepta dentro de la consulta.',
    });
  }

  // Los valores literales de la consulta viajan como parámetros: dos consultas
  // con la misma forma generan exactamente el mismo SQL.
  const params = [ctx.companyId];
  return {
    ...paso,
    presupuesto: presupuestoDe(ctx.consumer, presupuestos),
    params,
    parametro: (valor) => `$${params.push(valor)}`,
  };
}

// Puerta 2 · Resolver miembros: los nombres de negocio de la consulta pasan a
// ser lo que la entidad declaró. Los resuelve el catálogo, que es quien sabe
// qué existe y quién corta con UNKNOWN_MEMBER y una sugerencia.
function resolverMiembros(paso) {
  const { catalog, dialect, query, parametro } = paso;

  const medidas = (query.measures ?? []).map((miembro) => catalog.measure(miembro));
  // Una derivada no se agrega: combina medidas que sí se agregan.
  const derivadas = medidas.filter((medida) => medida.definicion.type === 'ratio');

  const dimensiones = (query.dimensions ?? []).map((miembro) => {
    const { entidad, columna } = catalog.dimension(miembro);
    return { miembro, entidad, columna, expresion: `${entidad}.${columna}` };
  });

  // Una dimensión temporal es una dimensión más, agrupada por granularidad; su
  // rango acota la CTE de su entidad y no el resultado ya agregado.
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

  return { ...paso, medidas, derivadas, dimensiones, condiciones };
}

// Puerta 3 · Filtros: los de la consulta y los de sus segmentos son globales
// —afectan a todas las medidas— y viven en la CTE de la entidad de su
// dimensión, junto al filtro de empresa. Se aplican antes de agregar, y la
// entidad filtrada entra al camino de joins aunque no sea una dimensión pedida.
function aplicarFiltros(paso) {
  const { catalog, query, condiciones, presupuesto } = paso;

  const filtrados = new Set();
  // Un segmento de la consulta aporta los filtros que su dueño declaró: para el
  // planificador no hay diferencia entre esos y los filtros del JSON.
  const declarados = [
    ...(query.filters ?? []),
    ...(query.segments ?? []).flatMap((miembro) => catalog.segment(miembro).definicion.filters),
  ];
  for (const filtro of declarados) {
    const { entidad } = catalog.dimension(filtro.member);
    filtrados.add(entidad);
    condiciones.set(entidad, [...(condiciones.get(entidad) ?? []), condicionDeFiltro(paso, filtro)]);
  }

  // El presupuesto del agente exige acotar el tiempo: una consulta sin rango
  // sobre toda la historia es la forma más fácil de fabricar una consulta que no
  // termina.
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

  return { ...paso, declarados, filtrados };
}

// Puerta 4 · Joins: de qué entidad salen las medidas y por dónde se llega al
// resto. Una sola entidad de hechos en v1: medidas de dos entidades en el mismo
// SELECT multiplican filas y devuelven números incorrectos en silencio (ADR
// 0006).
function resolverCaminoDeJoins(paso) {
  const { catalog, medidas, dimensiones, filtrados } = paso;

  const raiz = medidas[0].entidad;
  const intrusa = medidas.find((m) => m.entidad !== raiz);
  if (intrusa) {
    throw new SemanticError({
      code: 'MULTI_ENTITY_MEASURES',
      member: intrusa.miembro,
      suggestion: `Las medidas de una consulta deben salir de una sola entidad; ${intrusa.miembro} no es de ${raiz}. Pide ${intrusa.miembro} en una segunda consulta.`,
    });
  }

  const aristas = caminoDeJoins(catalog, raiz, [
    ...dimensiones.map((d) => d.entidad),
    ...filtrados,
  ]);
  return { ...paso, raiz, aristas };
}

// Puerta 5 · Agregación y derivadas: qué se agrega, con qué fórmula se combina
// lo agregado y qué hay que advertirle al consumidor sobre lo que pidió.
function resolverAgregacion(paso) {
  const { catalog, raiz, medidas, derivadas, declarados } = paso;

  // Las medidas base de la consulta: las que el consumidor pidió, más las que
  // necesitan sus derivadas aunque no las haya pedido.
  const bases = new Map();
  for (const medida of medidas) {
    if (medida.definicion.type !== 'ratio') bases.set(medida.miembro, medida);
  }

  // El catálogo entrega las derivadas de la entidad en orden de dependencia (ADR
  // 0004): recorrerlo una vez basta para escribir cada fórmula con las que
  // necesita ya resueltas. Primero, hacia atrás, se marca cuáles hacen falta;
  // una razón que nadie pidió no se calcula.
  const declaraciones = catalog.entity(raiz).measures;
  const ordenDeCalculo = catalog.derivedOrder(raiz);
  const necesarias = new Set(derivadas.map((medida) => medida.nombre));
  for (const nombre of [...ordenDeCalculo].reverse()) {
    if (!necesarias.has(nombre)) continue;
    const { numerator, denominator } = declaraciones[nombre];
    for (const parte of [numerator, denominator]) {
      if (declaraciones[parte]?.type === 'ratio') necesarias.add(parte);
    }
  }

  // `::numeric` evita la división entera —dos COUNT son enteros y 3/4 da 0— y
  // `NULLIF` convierte el denominador cero en NULL, que es la respuesta honesta:
  // sin evaluaciones no hay porcentaje que informar. La escala la valida el
  // catálogo como número, y por eso puede interpolarse.
  const formulas = new Map();
  for (const nombre of ordenDeCalculo) {
    if (!necesarias.has(nombre)) continue;
    const { numerator, denominator, scale } = declaraciones[nombre];
    const parte = (dependencia) => {
      if (formulas.has(dependencia)) return `(${formulas.get(dependencia)})`;
      const base = catalog.measure(`${raiz}.${dependencia}`);
      bases.set(base.miembro, base);
      return `"${base.miembro}"`;
    };
    const razon = `${parte(numerator)}::numeric / NULLIF(${parte(denominator)}, 0)`;
    formulas.set(nombre, scale === undefined ? razon : `${razon} * ${scale}`);
  }

  return {
    ...paso,
    medidasBase: [...bases.values()],
    formulas,
    advertencias: advertirRazonesAnuladas(paso, declaraciones, derivadas, declarados),
  };
}

// El filtro propio de una medida —el que su dueño le declaró como segmento— se
// suma al filtro global. De ahí sale el caso engañoso de la historia 18: si un
// filtro global repite justamente lo que distingue al numerador de una razón,
// numerador y denominador terminan contando las mismas filas y la razón vale su
// escala en todas las filas. El número está bien calculado y mal pedido; se
// devuelve con una advertencia que lo explica.
function advertirRazonesAnuladas(paso, declaraciones, derivadas, declarados) {
  const globales = new Set(declarados.map(claveDeFiltro));
  const advertencias = [];

  for (const derivada of derivadas) {
    const propios = (nombre) =>
      filtrosDeMedida(paso, { entidad: paso.raiz, definicion: declaraciones[nombre] ?? {} });
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
  return advertencias;
}

// Puerta 6 · Emitir: las CTE por entidad, la consulta agregada, la etapa de las
// derivadas, el orden y el límite. Es el único lugar donde se escribe SQL.
function emitirSql(paso) {
  const { query, presupuesto, parametro, dimensiones, medidas, derivadas, medidasBase, formulas, raiz, aristas } = paso;

  const cte = ctesPorEntidad(paso);

  // Etapa agregada: dimensiones y medidas base. Una medida base sale de su
  // agregado, filtrado por el segmento que su dueño le declaró.
  const seleccion = [
    ...dimensiones.map((d) => `${d.expresion} AS "${d.miembro}"`),
    ...medidasBase.map((m) => `${expresionDeMedida(paso, m)} AS "${m.miembro}"`),
  ];
  const agrupacion = dimensiones.map((d) => d.expresion);
  const joins = aristas.map(
    ({ desde, hacia, relacion }) =>
      `\nJOIN ${hacia} ON ${desde}.${relacion.foreignKey} = ${hacia}.${paso.catalog.entity(hacia).primaryKey}`,
  );
  const agregada = [
    `SELECT ${seleccion.join(', ')}`,
    `FROM ${raiz}${joins.join('')}`,
    ...(agrupacion.length ? [`GROUP BY ${agrupacion.join(', ')}`] : []),
  ];

  // Una consulta sin derivadas es la consulta agregada y nada más. Con
  // derivadas, la agregación pasa a ser la etapa de adentro y la fórmula se
  // escribe afuera, sobre sus alias: así solo puede ver valores ya agregados y
  // las bases que el consumidor no pidió no llegan a las filas (ADR 0004).
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

  const orden = ordenDeSalida(query, dimensiones, medidas);
  // Ninguna consulta sale sin LIMIT: el pedido nunca supera el máximo de la
  // clase de consumidor, y si no pide, manda ese máximo.
  const filas = Math.min(query.limit ?? presupuesto.maxFilas, presupuesto.maxFilas);

  const sql = [
    `WITH ${cte.join(',\n')}`,
    ...cuerpo,
    ...(orden.length ? [`ORDER BY ${orden.join(', ')}`] : []),
    `LIMIT ${parametro(filas)}`,
  ].join('\n');

  return { ...paso, sql, filas };
}

// El filtro de empresa vive dentro de la CTE, en el único lugar donde se nombra
// la tabla física (ADR 0003). Cada entidad se lleva solo las columnas que la
// consulta necesita.
function ctesPorEntidad(paso) {
  const { catalog, raiz, aristas, dimensiones, medidasBase, condiciones } = paso;

  const columnas = new Map([[raiz, new Set()]]);
  const pedir = (entidad, columna) => {
    if (!columnas.has(entidad)) columnas.set(entidad, new Set());
    columnas.get(entidad).add(columna);
  };
  for (const dimension of dimensiones) pedir(dimension.entidad, dimension.columna);
  for (const medida of medidasBase) {
    if (medida.definicion.column) pedir(medida.entidad, medida.definicion.column);
    for (const filtro of filtrosDeMedida(paso, medida)) {
      const { entidad, columna } = catalog.dimension(filtro.member);
      pedir(entidad, columna);
    }
  }
  for (const { desde, hacia, relacion } of aristas) {
    pedir(desde, relacion.foreignKey);
    pedir(hacia, catalog.entity(hacia).primaryKey);
  }

  return [raiz, ...aristas.map((a) => a.hacia)].map((nombre) => {
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
}

// Se ordena por el nombre semántico de la columna de salida: el consumidor
// ordena por lo que pidió, no por la expresión con la que se calculó. La llave
// termina como identificador entre comillas, así que solo puede ser un miembro
// que la consulta devuelve: cualquier otro texto se rechaza antes de tocar el
// SQL.
function ordenDeSalida(query, dimensiones, medidas) {
  const salida = new Set([...dimensiones, ...medidas].map((m) => m.miembro));
  return Object.entries(query.order ?? {}).map(([miembro, direccion]) => {
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
}

// Puerta 7 · Describir: lo que el planificador decidió, dicho en el vocabulario
// del consumidor y sin una sola tabla física (historia 25). Es lo que el
// dry-run devuelve para poder revisar una consulta antes de gastar la base.
function describirPlan(paso) {
  const { catalog, ctx, presupuesto, raiz, aristas, dimensiones, medidas, medidasBase } = paso;

  const logico = {
    entity: raiz,
    joins: aristas.map(({ desde, hacia, relacion }) => ({
      from: desde,
      to: hacia,
      foreignKey: relacion.foreignKey,
      primaryKey: catalog.entity(hacia).primaryKey,
    })),
    // Las dimensiones temporales entran aquí como una dimensión más.
    dimensions: dimensiones.map((d) => d.miembro),
    measures: medidas.map((m) => m.miembro),
    baseMeasures: medidasBase.map((m) => m.miembro),
    derived: paso.derivadas.map((m) => ({
      name: m.miembro,
      numerator: `${m.entidad}.${m.definicion.numerator}`,
      denominator: `${m.entidad}.${m.definicion.denominator}`,
      scale: m.definicion.scale,
    })),
    // Los filtros que afectan a todas las medidas, y aparte los que cada medida
    // trae puestos por su segmento: la semántica de filtros, legible.
    globalFilters: paso.declarados.map(copiaDeFiltro),
    filtersByMeasure: Object.fromEntries(
      medidasBase
        .filter((m) => filtrosDeMedida(paso, m).length > 0)
        .map((m) => [m.miembro, filtrosDeMedida(paso, m).map(copiaDeFiltro)]),
    ),
    budget: { consumer: ctx.consumer, ...presupuesto, rowLimit: paso.filas },
    warnings: paso.advertencias,
  };

  return { ...paso, logico };
}

// El agregado de una medida base, con el filtro de su segmento si lo tiene.
function expresionDeMedida(paso, medida) {
  const agregado = sqlDeAgregado(medida.definicion, medida.entidad);
  const filtros = filtrosDeMedida(paso, medida);
  if (filtros.length === 0) return agregado;
  return paso.dialect.agregadoFiltrado(
    agregado,
    filtros
      .map((filtro) => condicionDeFiltro(paso, filtro, { calificada: true }))
      .join(' AND '),
  );
}

function sqlDeAgregado(medida, entidad) {
  if (medida.type === 'count') return 'COUNT(*)';
  if (medida.type === 'avg') return `AVG(${entidad}.${medida.column})`;
  throw new Error(`Tipo de medida no soportado: ${medida.type}`);
}

// El filtro de una medida se declara una sola vez, como segmento.
function filtrosDeMedida(paso, medida) {
  return medida.definicion.segment
    ? paso.catalog.entity(medida.entidad).segments[medida.definicion.segment].filters
    : [];
}

// Un filtro se declara como { member, operator, values } y el planificador es el
// único que lo traduce a SQL (ADR 0005). Dentro de una CTE la columna va sola;
// en el FILTER de una medida va calificada por el alias de la CTE.
function condicionDeFiltro(paso, filtro, { calificada } = {}) {
  const { entidad, columna, tipo } = paso.catalog.dimension(filtro.member);
  exigirOperador(filtro, tipo);
  const izquierda = calificada ? `${entidad}.${columna}` : columna;
  const valores = filtro.values ?? [];
  if (filtro.operator === 'in') {
    return `${izquierda} IN (${valores.map((valor) => paso.parametro(valor)).join(', ')})`;
  }
  const comparador = filtro.operator === 'notEquals' ? '<>' : '=';
  return `${izquierda} ${comparador} ${paso.parametro(valores[0])}`;
}

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
  // comprueba antes de saber si el operador ya tiene SQL, porque una lista vacía
  // es un error del consumidor en cualquiera de los dos.
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

// El plan lógico sale con filtros propios: los del segmento pertenecen a la
// definición del módulo y quien lee un plan no puede modificarlos sin querer.
function copiaDeFiltro(filtro) {
  return { member: filtro.member, operator: filtro.operator, values: [...(filtro.values ?? [])] };
}

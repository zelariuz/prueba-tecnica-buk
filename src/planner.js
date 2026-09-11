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
import { GRANULARIDADES, OPERADORES_EN_SQL, operadoresDe } from './vocabulary.js';

const PARAMETRO_EMPRESA = '$1';

// Nombre de la etapa agregada cuando la consulta lleva derivadas.
const ALIAS_AGREGADA = 'agregada';

// Operadores cuyo valor es una lista: sin elementos no hay SQL que emitir.
const OPERADORES_DE_LISTA = new Set(['in', 'notIn']);

// Operadores que comparan con UN valor. Tomar `values[0]` y descartar el resto
// devuelve un número que no es el que se pidió, y sin `values` compara contra
// `NULL`, que en SQL no es falso sino desconocido: cero filas y un 200 (hallazgo
// 3 del abogado del diablo). Se rechaza en vez de adivinar.
const OPERADORES_DE_UN_VALOR = new Set(['equals', 'notEquals']);

// Las listas de la consulta declarativa (ADR 0007). Se nombran juntas porque la
// comprobación es la misma: si vienen, vienen como arreglo. Ninguna es
// obligatoria por sí sola desde el ADR 0010; lo obligatorio es que la consulta
// pida algo, y eso se comprueba aparte.
const LISTAS_DE_LA_CONSULTA = ['measures', 'dimensions', 'segments', 'filters', 'timeDimensions'];

// Las tres listas que producen columnas de salida. Una consulta que no llena
// ninguna no pide nada: no hay SQL que responda a eso.
const LISTAS_QUE_PIDEN = ['measures', 'dimensions', 'timeDimensions'];

// Direcciones de orden. Se interpolan en el SQL en mayúsculas, así que salen de
// una lista cerrada y se escriben exactamente así: `ASC` no es `asc`.
const DIRECCIONES = new Set(['asc', 'desc']);

const GRANULARIDADES_VALIDAS = new Set(GRANULARIDADES);

// Qué se rellena con cero y qué queda nulo cuando un bucket no tiene filas lo
// decide el TIPO de la medida, que el catálogo ya conoce, y nunca la consulta.
// Un bucket sin filas tuvo cero eventos: un `count`, un `count_distinct` y un
// `sum` valen 0 de verdad ahí. Un `avg` sobre cero filas no vale 0: no existe.
// Rellenar un promedio con cero inventa un número y hunde la línea del gráfico
// justo donde no hubo datos, que es exactamente el error que esta capa evita
// (ADR 0012). Las razones tampoco se rellenan: se calculan afuera sobre el
// resultado ya denso, y su denominador en 0 las anula solo por `NULLIF`.
const AGREGADOS_QUE_VALEN_CERO_SIN_FILAS = new Set(['count', 'count_distinct', 'sum']);

// Nombres de las dos etapas que sólo existen cuando hay relleno: la serie de
// buckets del rango y los valores distintos de las dimensiones no temporales.
const ALIAS_SERIE = 'serie';
const ALIAS_EJES = 'ejes';

// Para contar los buckets de un rango sin tocar la base: un día en milisegundos
// y la forma exacta que tiene que tener un extremo del `dateRange` para que se
// pueda contar. Ver `bucketsDelRango`.
const DIA_EN_MS = 86_400_000;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

// Desde el ADR 0011 una dimensión temporal puede venir sin `granularity`: con
// `dateRange` sola, la fecha únicamente filtra. La que agrupa es la que trae
// granularidad, y sólo esa produce una columna de salida.
function agrupaPorTiempo(temporal) {
  return temporal?.granularity !== undefined;
}

// Lo que la consulta pide en cada una de las tres listas que producen columnas.
// Una dimensión temporal que sólo filtra no produce ninguna, así que no cuenta:
// una consulta que no trae más que ella no pide nada.
function loQuePide(query, campo) {
  const lista = query[campo] ?? [];
  return campo === 'timeDimensions' ? lista.filter(agrupaPorTiempo) : lista;
}

// La forma de la consulta es un error del consumidor, no del servidor: sale con
// código propio, `member` y sugerencia, como cualquier otro (hallazgo 4 del
// abogado del diablo).
function formaInvalida(member, suggestion) {
  return new SemanticError({ code: 'INVALID_QUERY', member, suggestion });
}

// Puerta 1a · Forma de la consulta: lo que se puede rechazar sin catálogo, sin
// esquema y sin base. Va antes de resolver miembros porque una consulta que no
// tiene forma de consulta no tiene miembros que resolver: sin esta puerta, una
// consulta que no pide nada terminaba preguntándole al catálogo por la fuente de
// `undefined` y salía como error de configuración del servidor.
function validarForma(query) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw formaInvalida(
      'query',
      'Una consulta declarativa es un objeto JSON con measures y, opcionalmente, dimensions, timeDimensions, filters, segments, order y limit.',
    );
  }

  for (const campo of LISTAS_DE_LA_CONSULTA) {
    if (query[campo] === undefined || Array.isArray(query[campo])) continue;
    throw formaInvalida(campo, `${campo} se declara como una lista; recibí ${typeof query[campo]}.`);
  }

  // Una consulta sin medidas es válida si pide dimensiones: es el GROUP BY sin
  // agregados, o sea los valores distintos de esas dimensiones (ADR 0010). Lo
  // que no existe es la consulta que no pide nada: sin medidas, sin dimensiones
  // y sin dimensiones temporales no hay columna de salida que emitir.
  if (LISTAS_QUE_PIDEN.every((campo) => loQuePide(query, campo).length === 0)) {
    throw formaInvalida(
      'measures',
      'Una consulta necesita al menos una medida o una dimensión: declara measures con los nombres de las medidas que quieres, por ejemplo ["reviews.count"], o dimensions con los valores que quieres listar, por ejemplo ["departments.name"].',
    );
  }

  // La granularidad se interpola en el SQL, así que sale de una lista cerrada y
  // se comprueba aquí y no en el dialecto, donde el rechazo sería un error del
  // servidor. Desde el ADR 0011 es opcional: una dimensión temporal con
  // `dateRange` y sin granularidad sólo filtra por fecha. Lo que no existe es la
  // que no trae ninguna de las dos, porque no filtra ni agrupa: no dice nada.
  (query.timeDimensions ?? []).forEach((temporal, indice) => {
    if (GRANULARIDADES_VALIDAS.has(temporal?.granularity)) return;
    if (!agrupaPorTiempo(temporal) && temporal?.dateRange !== undefined) return;
    throw formaInvalida(
      `timeDimensions[${indice}].granularity`,
      `Una dimensión temporal se agrupa por una granularidad de la lista: ${GRANULARIDADES.join(', ')}, o lleva dateRange sin granularity para sólo filtrar por fecha.`,
    );
  });

  // `fillMissing` es una necesidad del consumidor —un gráfico que no debe saltar
  // días— y no una propiedad de la entidad, así que viaja en la dimensión
  // temporal de la consulta y no en la definición del módulo (ADR 0012). Se
  // valida en un recorrido aparte del de arriba, porque aquél corta antes con
  // `return` en los casos que a éste sí le importan.
  (query.timeDimensions ?? []).forEach((temporal, indice) => {
    if (temporal?.fillMissing === undefined) return;
    if (typeof temporal.fillMissing !== 'boolean') {
      throw formaInvalida(
        `timeDimensions[${indice}].fillMissing`,
        `fillMissing es true o false; recibí ${JSON.stringify(temporal.fillMissing)}.`,
      );
    }
    if (temporal.fillMissing === false) return;
    // Sin granularidad no hay bucket que repetir y sin rango no hay desde dónde
    // ni hasta dónde: en cualquiera de los dos casos no existe la serie que
    // rellenar. Se rechaza en vez de ignorar la bandera en silencio, que dejaría
    // al consumidor creyendo que su gráfico ya viene denso.
    if (GRANULARIDADES_VALIDAS.has(temporal.granularity) && temporal.dateRange !== undefined) return;
    throw formaInvalida(
      `timeDimensions[${indice}].fillMissing`,
      `fillMissing necesita granularity y dateRange en la misma dimensión temporal: sin los dos no hay serie de buckets que generar. Declara granularity con una de ${GRANULARIDADES.join(', ')} y dateRange con el rango cerrado a rellenar.`,
    );
  });

  for (const [miembro, direccion] of Object.entries(query.order ?? {})) {
    if (DIRECCIONES.has(direccion)) continue;
    throw formaInvalida(
      `order.${miembro}`,
      `La dirección de orden se escribe exactamente asc o desc, en minúsculas; recibí ${JSON.stringify(direccion)}.`,
    );
  }

  if (query.limit !== undefined && !(Number.isInteger(query.limit) && query.limit >= 1)) {
    throw formaInvalida(
      'limit',
      `limit es un entero mayor o igual a 1 —el techo real lo pone tu clase de consumidor—; recibí ${JSON.stringify(query.limit)}.`,
    );
  }
}

// `fuentes` es el mapa nombre → { dialecto, pool } que el engine recibió. El
// planificador sólo usa el dialecto, y lo toma de la fuente de la entidad de
// hechos: qué motor traduce esta consulta lo decide el dato que se consulta, no
// una constante del planificador.
export function crearPlanificador({ catalog, fuentes, presupuestos }) {
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
    let paso = { catalog, fuentes, presupuestos, query, ctx };
    for (const puerta of puertas) paso = anotandoLaPuerta(puerta, paso);
    const { sql, params, medidas, presupuesto, advertencias, logico, fuente, filas } = paso;
    // `filas` —el LIMIT efectivo que se emitió— sale del planificador porque el
    // engine no puede recalcularlo sin repetir la regla: quien lo decide es
    // quien lo escribió en el SQL. Lo necesita para saber si la respuesta llegó
    // al tope y puede venir cortada.
    return { sql, params, medidas, presupuesto, advertencias, logico, fuente, filas };
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

  validarForma(query);

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
  const { catalog, fuentes, query, parametro } = paso;

  const medidas = (query.measures ?? []).map((miembro) => catalog.measure(miembro));
  const raiz = entidadDeHechos(catalog, query, medidas);
  // La entidad de hechos manda: su fuente es la fuente de la consulta, y el
  // dialecto de esa fuente es el que escribe el SQL. El planificador no nombra
  // ningún motor.
  const fuente = catalog.source(raiz);
  const dialect = exigirFuenteConfigurada(fuentes, fuente, raiz);
  // Una derivada no se agrega: combina medidas que sí se agregan.
  const derivadas = medidas.filter((medida) => medida.definicion.type === 'ratio');

  const dimensiones = (query.dimensions ?? []).map((miembro) => {
    const { entidad, columna } = catalog.dimension(miembro);
    return { miembro, entidad, columna, expresion: `${entidad}.${columna}` };
  });

  // Una dimensión temporal con granularidad es una dimensión más, agrupada por
  // ella; su rango acota la CTE de su entidad y no el resultado ya agregado.
  // Sin granularidad (ADR 0011) queda sólo el rango: la fecha filtra dentro de
  // la CTE y no produce columna, así que no se suma a las dimensiones.
  const condiciones = new Map();
  // La dimensión temporal que pidió relleno, si alguna lo pidió, con los
  // marcadores de sus extremos: la serie se genera con LOS MISMOS parámetros que
  // ya filtran la CTE, así que rellenar no agrega ni un `$n` más ni reordena
  // ninguno (ADR 0012).
  let relleno;
  for (const temporal of query.timeDimensions ?? []) {
    const { entidad, columna } = catalog.dimension(temporal.dimension);
    if (agrupaPorTiempo(temporal)) {
      dimensiones.push({
        miembro: temporal.dimension,
        entidad,
        columna,
        expresion: dialect.dateTrunc(temporal.granularity, `${entidad}.${columna}`),
      });
    }
    let desdeSql;
    let hastaSql;
    if (temporal.dateRange) {
      const [desde, hasta] = temporal.dateRange;
      desdeSql = parametro(desde);
      hastaSql = parametro(hasta);
      // Rango cerrado en ambos extremos, como el dateRange de Cube.
      condiciones.set(entidad, [
        ...(condiciones.get(entidad) ?? []),
        `${columna} >= ${desdeSql}`,
        `${columna} <= ${hastaSql}`,
      ]);
    }
    if (temporal.fillMissing !== true) continue;
    exigirSerieDeFechas(dialect, fuente, temporal.dimension);
    exigirSerieQueQuepa(paso, temporal);
    relleno = { miembro: temporal.dimension, granularidad: temporal.granularity, desdeSql, hastaSql };
  }

  return { ...paso, raiz, fuente, dialect, medidas, derivadas, dimensiones, condiciones, relleno };
}

// Si la fuente no sabe generar la serie de buckets, no hay relleno que emitir.
// El código es `UNSUPPORTED_OPERATOR`, el mismo que ya usa el vocabulario para
// "esto es parte del contrato, pero esta fuente no lo sabe escribir": es un 400
// porque el consumidor sí puede arreglarlo —quitando la bandera—, y no un 500
// porque el servidor no está roto. No se inventa un código nuevo; el que hay
// está mapeado en `src/http/codigos.js` y significa exactamente esto.
//
// La comprobación no vive en la puerta `validar` a propósito: esa puerta es la
// que rechaza sin mirar el catálogo, y qué dialecto traduce la consulta recién
// se sabe aquí, cuando la entidad de hechos ya nombró su fuente.
function exigirSerieDeFechas(dialect, fuente, miembro) {
  if (dialect.capabilities?.serieDeFechas === true) return;
  throw new SemanticError({
    code: 'UNSUPPORTED_OPERATOR',
    member: miembro,
    suggestion: `La fuente ${fuente} no sabe generar la serie de fechas que necesita fillMissing: quita fillMissing de la dimensión temporal y rellena los buckets vacíos en el consumidor.`,
  });
}

// Con relleno el resultado tiene exactamente `buckets × ejes` filas, y los
// buckets se pueden contar **sin tocar la base**: salen del rango y de la
// granularidad, que ya están en la consulta. Si los buckets solos ya pasan el
// techo de filas de la clase, entonces ni con un único valor de las demás
// dimensiones cabría la serie: la respuesta saldría cortada a mitad de camino y,
// densificada, se vería entera. Eso es peor que el hueco que el relleno vino a
// tapar (ADR 0012), así que se rechaza **antes** de gastar la base en una
// consulta que ya se sabe que no sirve.
//
// No se estiman los ejes: cuántos departamentos tiene la empresa sólo lo sabe la
// base, y preguntárselo sería gastar una consulta para decidir si vale la pena
// hacer la otra. El rechazo se queda con lo que se sabe con certeza y gratis; lo
// que pasa por debajo de ese umbral lo cubre el aviso de truncado del engine,
// que sí cuenta filas de verdad.
//
// El código es `INVALID_QUERY` (400), el que ya usa la puerta de forma: la
// consulta es legítima como vocabulario, pero tal como está pedida no tiene
// respuesta posible bajo el presupuesto de quien la pide, y quien la pide sí
// puede arreglarla. Es el código que `docs/riesgos.md` dejó anotado para esto;
// no se inventa uno nuevo.
function exigirSerieQueQuepa(paso, temporal) {
  const [desde, hasta] = temporal.dateRange;
  const buckets = bucketsDelRango(temporal.granularity, desde, hasta);
  const limite = limiteEfectivo(paso.query, paso.presupuesto);
  // Una fecha que este contador no sabe leer no se convierte en un rechazo: el
  // guardarraíl falla abierto y deja que la base opine, que es quien de verdad
  // interpreta el literal. Rechazar por no saber contar sería inventar un error.
  if (buckets === undefined || buckets <= limite) return;
  throw new SemanticError({
    code: 'INVALID_QUERY',
    member: temporal.dimension,
    suggestion: `La serie que pide fillMissing tiene ${buckets} buckets (granularity ${temporal.granularity} entre ${desde} y ${hasta}) y tu clase de consumidor sólo puede devolver ${limite} filas: ni con un solo valor de las demás dimensiones cabría, y el resultado saldría cortado a mitad de la serie sin que se note. Sube la granularidad (day → week → month → quarter → year), acorta el dateRange a lo más ${limite} buckets, o pide la serie por tramos.`,
  });
}

// Cuántas filas devuelve la serie de un rango, contadas como las genera el
// dialecto: desde el inicio **truncado** a la granularidad y avanzando un bucket
// por vez hasta el último que no pasa el fin (ver `serieDeFechas`).
//
// Vive en el planificador y no en el dialecto porque contar cuántos lunes o
// cuántos trimestres hay entre dos fechas es calendario, no sintaxis de motor:
// da lo mismo en cualquier base. Lo que sí es del dialecto —cómo se **escribe**
// esa serie— sigue en `serieDeFechas`. La semana se cuenta desde el lunes, que
// es el `DATE_TRUNC('week', …)` de Postgres, hoy el único motor que declara la
// capacidad; un motor que empezara la semana en domingo haría variar esta cuenta
// en a lo más un bucket, y como el número sólo se usa para rechazar lo que ya
// está muy por encima del techo, esa diferencia no cambia ninguna decisión.
//
// `undefined` significa "no sé contarlo": una fecha que no viene en YYYY-MM-DD.
function bucketsDelRango(granularidad, desde, hasta) {
  const inicio = diaUtc(desde);
  const fin = diaUtc(hasta);
  if (inicio === undefined || fin === undefined) return undefined;
  const meses = (fin.getUTCFullYear() - inicio.getUTCFullYear()) * 12 + (fin.getUTCMonth() - inicio.getUTCMonth());
  const pasos = {
    day: () => Math.round((fin - inicio) / DIA_EN_MS),
    week: () => Math.floor((fin - lunesDe(inicio)) / (7 * DIA_EN_MS)),
    month: () => meses,
    // El trimestre arranca en el mes truncado, así que el inicio aporta lo que
    // le falte para llegar al comienzo de su propio trimestre.
    quarter: () => Math.floor((meses + (inicio.getUTCMonth() % 3)) / 3),
    year: () => fin.getUTCFullYear() - inicio.getUTCFullYear(),
  }[granularidad];
  if (!pasos) return undefined;
  // Un rango al revés puede seguir dando un bucket, porque el inicio se trunca
  // hacia atrás: del 31/12 al 01/01 del mismo año, `generate_series` arranca en
  // el 01/01 y devuelve ese único año. Por eso el piso se pone en cero aquí y no
  // comparando las dos fechas antes de contar.
  return Math.max(0, pasos() + 1);
}

// El literal del rango, leído como día calendario en UTC y nunca en la zona del
// proceso: la capa trata las columnas temporales como días ya resueltos
// (`docs/riesgos.md`, fechas y zonas), y contar buckets no puede depender de en
// qué máquina corre el servicio.
function diaUtc(texto) {
  if (typeof texto !== 'string' || !FECHA_ISO.test(texto)) return undefined;
  const fecha = new Date(`${texto}T00:00:00Z`);
  return Number.isNaN(fecha.getTime()) ? undefined : fecha;
}

function lunesDe(fecha) {
  return new Date(fecha.getTime() - (((fecha.getUTCDay() + 6) % 7) * DIA_EN_MS));
}

// El techo real de filas de una consulta: lo que pidió, nunca por encima del
// máximo de su clase de consumidor. Vive aparte porque lo usan dos puertas —la
// que rechaza la serie que no cabe y la que escribe el `LIMIT`— y tienen que
// estar hablando exactamente del mismo número.
function limiteEfectivo(query, presupuesto) {
  return Math.min(query.limit ?? presupuesto.maxFilas, presupuesto.maxFilas);
}

// De qué entidad sale el SQL. Con medidas es la entidad de la primera, y las
// demás tienen que ser de esa misma (ADR 0006). Sin medidas —la consulta de
// valores distintos del ADR 0010— es la entidad de la primera dimensión, o la
// de la primera dimensión temporal si no hay dimensiones: el resto del pedido
// se alcanza por joins desde ella, así que el orden en que se piden decide
// cuál es la raíz del BFS. La puerta de forma ya garantizó que alguna de las
// tres listas trae algo.
function entidadDeHechos(catalog, query, medidas) {
  if (medidas.length > 0) return medidas[0].entidad;
  const primera = query.dimensions?.[0] ?? query.timeDimensions?.[0]?.dimension;
  return catalog.dimension(primera).entidad;
}

// El catálogo y el engine reciben el mismo mapa de fuentes, pero no tienen por
// qué haberlo recibido igual: el catálogo sólo necesita el dialecto para validar
// tipos y el engine necesita además el pool contra el que ejecutar. Si una
// entidad quedó registrada con una fuente que el engine no tiene, sin esta
// guardia `fuentes[fuente]?.dialecto` es `undefined` y la primera dimensión
// temporal revienta con un `TypeError` que no nombra ni la fuente ni la entidad.
// No es un `SemanticError`: el consumidor no puede arreglarlo cambiando lo que
// pidió, está mal armado el servidor.
function exigirFuenteConfigurada(fuentes, fuente, entidad) {
  const dialecto = fuentes[fuente]?.dialecto;
  if (dialecto) return dialecto;
  throw new Error(
    `La entidad ${entidad} está registrada en el catálogo con la fuente ${fuente}, que este engine no tiene configurada. Fuentes del engine: ${Object.keys(fuentes).join(', ') || '(ninguna)'}.`,
  );
}

// Puerta 3 · Filtros: los de la consulta y los de sus segmentos son globales
// —afectan a todas las medidas— y viven en la CTE de la entidad de su
// dimensión, junto al filtro de empresa. Se aplican antes de agregar, y la
// entidad filtrada entra al camino de joins aunque no sea una dimensión pedida.
function aplicarFiltros(paso) {
  const { catalog, query, condiciones, presupuesto } = paso;

  // Un segmento de la consulta aporta los filtros que su dueño declaró: para el
  // planificador no hay diferencia entre esos y los filtros del JSON.
  const declarados = [
    ...(query.filters ?? []),
    ...(query.segments ?? []).flatMap((miembro) => catalog.segment(miembro).definicion.filters),
  ];
  for (const filtro of declarados) {
    const { entidad } = catalog.dimension(filtro.member);
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

  return { ...paso, declarados };
}

// Puerta 4 · Joins: de qué entidad salen las medidas y por dónde se llega al
// resto. Una sola entidad de hechos en v1: medidas de dos entidades en el mismo
// SELECT multiplican filas y devuelven números incorrectos en silencio (ADR
// 0006). Sin medidas la raíz la puso la primera dimensión (ADR 0010) y el resto
// del camino se busca igual: una dimensión inalcanzable desde ella sale con
// `NO_JOIN_PATH` como cualquier otra.
function resolverCaminoDeJoins(paso) {
  const { catalog, fuente, raiz, medidas, dimensiones, condiciones } = paso;

  const intrusa = medidas.find((m) => m.entidad !== raiz);
  if (intrusa) {
    throw new SemanticError({
      code: 'MULTI_ENTITY_MEASURES',
      member: intrusa.miembro,
      suggestion: `Las medidas de una consulta deben salir de una sola entidad; ${intrusa.miembro} no es de ${raiz}. Pide ${intrusa.miembro} en una segunda consulta.`,
    });
  }

  // Dos fuentes son dos bases: no hay JOIN que las cruce ni SQL que las alcance
  // en una sola consulta. Se comprueba antes de buscar el camino —si no, el
  // error diría que falta una relación, que es un diagnóstico falso— y otra vez
  // sobre el camino encontrado, porque una entidad intermedia puede ser de otra
  // fuente aunque el destino sea de la misma.
  // Toda entidad con condiciones necesita su CTE, la haya traído una dimensión
  // pedida, un filtro o el rango de una dimensión temporal que sólo filtra (ADR
  // 0011): sin CTE, la condición se pierde en silencio y el número sale mal.
  const destinos = [...dimensiones.map((d) => d.entidad), ...condiciones.keys()];
  for (const destino of destinos) exigirMismaFuente(catalog, fuente, raiz, destino);

  const aristas = caminoDeJoins(catalog, raiz, destinos);
  for (const arista of aristas) exigirMismaFuente(catalog, fuente, raiz, arista.hacia);

  return { ...paso, aristas };
}

// Una consulta vive entera dentro de una fuente. Cruzar dos bases no es un
// JOIN más caro: es una consulta que no existe, y la federación —traer las dos
// mitades y unirlas en memoria— es otra pieza con otro presupuesto. La
// sugerencia nombra las dos fuentes para que quede claro que lo que falta no es
// una relación.
function exigirMismaFuente(catalog, fuente, raiz, entidad) {
  const otra = catalog.source(entidad);
  if (otra === undefined || otra === fuente) return;
  throw new SemanticError({
    code: 'NO_JOIN_PATH',
    member: entidad,
    suggestion: `${entidad} vive en la fuente ${otra} y ${raiz} en la fuente ${fuente}: una consulta no puede cruzar dos fuentes. Pide ${entidad} en una segunda consulta.`,
  });
}

// Puerta 5 · Agregación y derivadas: qué se agrega, con qué fórmula se combina
// lo agregado y qué hay que advertirle al consumidor sobre lo que pidió. Una
// consulta sin medidas la atraviesa sin producir nada: no hay base que agregar
// ni derivada que calcular, y el SELECT queda con las dimensiones solas.
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

  // La conversión a numérico evita la división entera —dos COUNT son enteros y
  // 3/4 da 0— y cómo se pide se la pregunta al dialecto: es lo que más cambia
  // entre motores (`::numeric` en Postgres, `CAST(... AS REAL)` en SQLite).
  // `NULLIF` sí es estándar y lo entienden los dos, así que se escribe aquí; el
  // día que aparezca un motor que no lo tenga, se muda igual que el cast. La
  // escala la valida el catálogo como número, y por eso puede interpolarse.
  const formulas = new Map();
  for (const nombre of ordenDeCalculo) {
    if (!necesarias.has(nombre)) continue;
    const { numerator, denominator, scale } = declaraciones[nombre];
    const parte = (dependencia) => {
      if (formulas.has(dependencia)) return `(${formulas.get(dependencia)})`;
      const base = catalog.measure(`${raiz}.${dependencia}`);
      bases.set(base.miembro, base);
      return referenciaDeBase(paso, base);
    };
    const razon = `${paso.dialect.aNumerico(parte(numerator))} / NULLIF(${parte(denominator)}, 0)`;
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
  //
  // Con relleno la agregación también pasa a ser una etapa de adentro, pero con
  // nombre propio y dos hermanas, porque afuera hay que unirla con la serie de
  // buckets. Sin `fillMissing` no se toca nada de esto: el SQL emitido es el
  // mismo de siempre, byte por byte.
  const { ctesDelRelleno, cuerpo } = paso.relleno
    ? etapasDelRelleno(paso, agregada, joins)
    : {
        ctesDelRelleno: [],
        cuerpo: derivadas.length
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
          : agregada,
      };

  const orden = ordenDeSalida(query, dimensiones, medidas);
  // Ninguna consulta sale sin LIMIT: el pedido nunca supera el máximo de la
  // clase de consumidor, y si no pide, manda ese máximo.
  const filas = limiteEfectivo(query, presupuesto);

  const sql = [
    `WITH ${[...cte, ...ctesDelRelleno].join(',\n')}`,
    ...cuerpo,
    ...(orden.length ? [`ORDER BY ${orden.join(', ')}`] : []),
    `LIMIT ${parametro(filas)}`,
  ].join('\n');

  return { ...paso, sql, filas };
}

// Relleno de serie densa (ADR 0012): las tres etapas que convierten el
// resultado disperso de siempre en uno con TODOS los buckets del rango.
//
//   serie    los buckets del rango, uno por fila, en el mismo formato de texto
//            que `dateTrunc`, para que el JOIN calce por igualdad.
//   ejes     los valores distintos de las dimensiones NO temporales, tomados de
//            los mismos datos filtrados: se rellena el tiempo de los ejes que
//            existen, no se inventan departamentos que nadie tiene.
//   agregada exactamente la etapa que emite el camino normal, sin un cambio.
//
// Afuera, el producto `serie × ejes` es la rejilla completa y el `LEFT JOIN`
// trae lo que haya. Sin dimensiones no temporales no hay rejilla que armar: no
// se emite `ejes` ni el `CROSS JOIN`, y la serie sola es el esqueleto.
function etapasDelRelleno(paso, agregada, joins) {
  const { dialect, dimensiones, medidas, formulas, raiz, relleno } = paso;

  const ejes = dimensiones.filter((d) => d.miembro !== relleno.miembro);

  const ctesDelRelleno = [
    `${ALIAS_SERIE} AS (\n${indentar(
      dialect.serieDeFechas(relleno.granularidad, relleno.desdeSql, relleno.hastaSql),
    )}\n)`,
  ];
  if (ejes.length) {
    ctesDelRelleno.push(
      `${ALIAS_EJES} AS (\n${indentar(
        [
          `SELECT DISTINCT ${ejes.map((d) => `${d.expresion} AS "${d.miembro}"`).join(', ')}`,
          `FROM ${raiz}${joins.join('')}`,
        ].join('\n'),
      )}\n)`,
    );
  }
  ctesDelRelleno.push(`${ALIAS_AGREGADA} AS (\n${indentar(agregada.join('\n'))}\n)`);

  // Las columnas salen en el mismo orden en que la consulta las pidió: la
  // temporal rellenada viene de la serie y las demás del eje, para que un bucket
  // sin filas igual traiga el nombre del departamento y no un nulo.
  const columnas = [
    ...dimensiones.map((d) =>
      d.miembro === relleno.miembro
        ? `${ALIAS_SERIE}.bucket AS "${d.miembro}"`
        : `${ALIAS_EJES}."${d.miembro}" AS "${d.miembro}"`,
    ),
    ...medidas.map((m) =>
      m.definicion.type === 'ratio'
        ? `${formulas.get(m.nombre)} AS "${m.miembro}"`
        : `${rellenoDeMedida(m, `${ALIAS_AGREGADA}."${m.miembro}"`)} AS "${m.miembro}"`,
    ),
  ];

  const condicion = [
    `${ALIAS_AGREGADA}."${relleno.miembro}" = ${ALIAS_SERIE}.bucket`,
    ...ejes.map((d) => `${ALIAS_AGREGADA}."${d.miembro}" = ${ALIAS_EJES}."${d.miembro}"`),
  ];

  return {
    ctesDelRelleno,
    cuerpo: [
      `SELECT ${columnas.join(', ')}`,
      `FROM ${ALIAS_SERIE}${ejes.length ? `\nCROSS JOIN ${ALIAS_EJES}` : ''}`,
      `LEFT JOIN ${ALIAS_AGREGADA} ON ${condicion.join('\n  AND ')}`,
    ],
  };
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
      `  FROM ${paso.dialect.tablaFisica(entidad.table)}\n` +
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
    // Segunda cerradura: la puerta `validar` ya rechazó cualquier otra
    // dirección, y desde una consulta esto es inalcanzable. Se deja porque el
    // valor termina interpolado en el SQL y un cambio en la puerta de forma no
    // debería poder convertirse en una inyección.
    if (!DIRECCIONES.has(direccion)) {
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
    // Los joins se describen por la relación declarada (`via`) y su tipo, nunca
    // por las columnas que los resuelven: el plan lógico sale por HTTP a
    // cualquier token y el esquema físico es interno (ADR 0008). Hallazgo del
    // QA del 08-09: el plan traía `employee_id` y `department_id`.
    joins: aristas.map(({ desde, hacia, relacion, via }) => ({
      from: desde,
      to: hacia,
      via,
      type: relacion.type,
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

// Cómo nombra una fórmula derivada a la medida base que ya se agregó. Sin
// relleno es el alias de la etapa de adentro. Con relleno es la columna de la
// CTE `agregada` **ya rellenada**, porque la razón se sigue calculando afuera,
// sobre el resultado denso: en un bucket vacío el denominador queda en 0, el
// `NULLIF` que ya estaba lo vuelve nulo y la razón sale vacía sola, sin una
// sola regla nueva (ADR 0012).
function referenciaDeBase(paso, base) {
  if (!paso.relleno) return `"${base.miembro}"`;
  return rellenoDeMedida(base, `${ALIAS_AGREGADA}."${base.miembro}"`);
}

// Una medida base leída desde la etapa agregada en un bucket que puede no
// existir. El `COALESCE` lo decide el tipo, nunca la consulta: ver
// `AGREGADOS_QUE_VALEN_CERO_SIN_FILAS`.
function rellenoDeMedida(medida, expresion) {
  return AGREGADOS_QUE_VALEN_CERO_SIN_FILAS.has(medida.definicion.type)
    ? `COALESCE(${expresion}, 0)`
    : expresion;
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

// Cada tipo de medida base que el catálogo acepta tiene aquí su agregado, y
// sólo aquí: si el catálogo admitiera un tipo que esta tabla no conoce, la
// definición registraría bien y la consulta moriría con un error del servidor
// (hallazgo 2 del abogado del diablo, que es exactamente lo que pasaba con
// `sum`). `count` no nombra columna: cuenta filas.
function sqlDeAgregado(medida, entidad) {
  if (medida.type === 'count') return 'COUNT(*)';
  if (medida.type === 'count_distinct') return `COUNT(DISTINCT ${entidad}.${medida.column})`;
  if (medida.type === 'avg') return `AVG(${entidad}.${medida.column})`;
  if (medida.type === 'sum') return `SUM(${entidad}.${medida.column})`;
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
  // Un valor exacto, ni cero ni dos: comparar con el primero de una lista es
  // responder otra pregunta sin decirlo.
  if (OPERADORES_DE_UN_VALOR.has(filtro.operator) && !(Array.isArray(filtro.values) && filtro.values.length === 1)) {
    throw new SemanticError({
      code: 'INVALID_OPERATOR',
      member: filtro.member,
      suggestion: `El operador ${filtro.operator} lleva exactamente un valor: declara values como un arreglo de un elemento. Para comparar contra varios valores usa in o notIn.`,
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
//
// Una relación puede apuntar a una entidad que no está registrada: el módulo
// dueño no se instaló, o todavía no se registró cuando el que la nombra sí. No
// se valida al registrar porque el orden importa —`reviews` nombra a
// `employees` antes de que exista— y una validación diferida sería un segundo
// momento de verdad para el mismo contrato. La respuesta es más simple: esa
// relación no produce arista. Si el destino que el consumidor pidió era
// alcanzable sólo por ahí, el camino no existe y sale `NO_JOIN_PATH` nombrando
// la entidad que falta; el diagnóstico queda donde se nota el problema.
function caminoDeJoins(catalog, raiz, destinos) {
  const previa = new Map([[raiz, null]]);
  const pendientes = [raiz];
  const ausentes = new Set();

  while (pendientes.length > 0) {
    const actual = pendientes.shift();
    const relaciones = catalog.entity(actual).relationships ?? {};
    for (const [via, relacion] of Object.entries(relaciones)) {
      if (relacion.type !== 'many_to_one' || previa.has(relacion.target)) continue;
      if (catalog.entity(relacion.target) === undefined) {
        ausentes.add(relacion.target);
        continue;
      }
      // `via` es el nombre de la relación en la definición: es lo único del
      // join que puede salir en el plan lógico, porque es un nombre de negocio.
      previa.set(relacion.target, { desde: actual, relacion, via });
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
        suggestion:
          ausentes.size > 0
            ? `No hay relaciones declaradas que lleven de ${raiz} a ${destino}: el camino pasa por ${[...ausentes].join(', ')}, que no está registrada en el catálogo.`
            : `No hay relaciones declaradas que lleven de ${raiz} a ${destino}. Las relaciones van de la entidad de hechos hacia sus dimensiones: pide una medida de ${destino} para que sea la entidad de hechos, o declara la relación en la definición de ${raiz}.`,
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

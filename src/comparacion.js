// Comparación de períodos (ADR 0015): `compareDateRange` en una dimensión
// temporal pide la misma consulta sobre VARIOS rangos —"este mes contra el mes
// pasado"— en una sola petición. Ocupa el lugar de `dateRange`, como en Cube.
//
// Esta pieza no planifica, no ejecuta y no escribe SQL: recibe la consulta
// declarativa y devuelve las N consultas **normales** en que se descompone,
// cada una con su `dateRange` donde venía el arreglo. De ahí en adelante nadie
// más sabe que existe la comparación: cada rango es una consulta de las de
// siempre, con su plan, su SQL, su `queryId`, su entrada de caché y su `meta`.
// No hay un segundo motor; hay N vueltas por el mismo.
//
// Se resuelve en el engine y no en el planificador porque lo que decide no es
// cómo se traduce una consulta sino **cuántas consultas hay**, y eso es una
// pregunta anterior a planificar.
import { SemanticError } from './errors.js';

// Tope de rangos por comparación. N rangos son N consultas contra la base, cada
// una con el timeout completo de su clase (ADR 0015): el tope es la única cosa
// que acota lo que una petición puede gastar cuando compara. Cuatro cubre las
// comparaciones que la gente pide de verdad —un período contra el anterior (2),
// los cuatro trimestres de un año, un mes contra el mismo mes de los tres años
// anteriores— y deja el peor caso del tablero en 4 × 5 s, todavía debajo del
// medio minuto que tolera cualquier proxy. Pedir más que eso ya no es comparar:
// es una serie, y una serie se pide con `granularity` sobre el rango entero.
export const MAXIMO_DE_RANGOS = 4;

// ¿Esta consulta es una comparación? Devuelve `undefined` si no lo es —y
// entonces el engine sigue por el camino de siempre, sin una sola diferencia— o
// las consultas en que se descompone, en el orden en que se pidieron los rangos.
//
// Lo que esta función NO hace es opinar sobre la forma de la consulta, igual que
// la puerta 0 del planificador: una consulta que no es un objeto, o cuyas
// `timeDimensions` no son una lista, pasa de largo y la rechaza `validar` con su
// mensaje de siempre. Aquí sólo se mira lo que sólo aquí se puede mirar.
export function expandirComparacion(query) {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return undefined;
  const temporales = query.timeDimensions;
  if (!Array.isArray(temporales)) return undefined;

  const comparan = temporales
    .map((temporal, indice) => ({ temporal, indice }))
    .filter(({ temporal }) => temporal?.compareDateRange !== undefined);
  if (comparan.length === 0) return undefined;

  // Dos dimensiones temporales comparando serían el producto de las dos listas
  // —N × M consultas— y ninguna forma de respuesta diría a qué par corresponde
  // cada resultado. Se rechaza en vez de elegir una.
  if (comparan.length > 1) {
    const [, segunda] = comparan;
    throw invalido(
      `timeDimensions[${segunda.indice}].compareDateRange`,
      'Sólo una dimensión temporal puede comparar rangos por consulta: dos listas de rangos pedirían el producto de las dos y ningún resultado podría decir a qué combinación corresponde. Deja compareDateRange en una sola dimensión temporal.',
    );
  }

  const { temporal, indice } = comparan[0];
  const member = `timeDimensions[${indice}].compareDateRange`;

  // `dateRange` y `compareDateRange` dicen la misma cosa —qué ventana de tiempo
  // mirar— y pedir las dos deja ambiguo cuál manda.
  if (temporal.dateRange !== undefined) {
    throw invalido(
      member,
      'dateRange y compareDateRange declaran lo mismo —qué ventana de tiempo mirar— y traer los dos en la misma dimensión temporal deja ambiguo cuál manda. Usa compareDateRange con la lista de rangos a comparar, o dateRange con uno solo.',
    );
  }

  const rangos = temporal.compareDateRange;
  if (!Array.isArray(rangos)) {
    throw invalido(
      member,
      `compareDateRange se declara como una lista de rangos —cada uno un par de fechas o una frase relativa—, por ejemplo ["this month", "last month"]; recibí ${typeof rangos}.`,
    );
  }

  // Una lista vacía no pide ninguna ventana: la respuesta sería un `results` sin
  // un solo resultado, con un 200 al lado, que es la peor manera de decir que no
  // se entendió la pregunta.
  if (rangos.length === 0) {
    throw invalido(
      member,
      'compareDateRange necesita al menos un rango: una lista vacía no pide ninguna ventana de tiempo. Declara los rangos a comparar, por ejemplo ["this month", "last month"].',
    );
  }

  if (rangos.length > MAXIMO_DE_RANGOS) {
    throw invalido(
      member,
      `compareDateRange compara hasta ${MAXIMO_DE_RANGOS} rangos y pediste ${rangos.length}: cada rango es una consulta entera contra la base, con el timeout completo de tu clase de consumidor. Compara menos rangos, o pide una sola consulta con granularity sobre el rango que los cubre a todos.`,
    );
  }

  return { indice, consultas: rangos.map((rango) => consultaDelRango(query, temporales, indice, rango)) };
}

// La consulta de UN rango: la misma de siempre, con `dateRange` donde venía la
// lista. El resto de la consulta viaja intacto —medidas, dimensiones, filtros,
// orden, límite, `total`, `fillMissing`, la zona— porque comparar períodos es
// hacer la misma pregunta sobre otra ventana, no otra pregunta.
function consultaDelRango(query, temporales, indice, dateRange) {
  const { compareDateRange, ...resto } = temporales[indice];
  return {
    ...query,
    timeDimensions: temporales.map((temporal, posicion) => (posicion === indice ? { ...resto, dateRange } : temporal)),
  };
}

// Un rechazo de un rango tiene que señalar dónde lo escribió el consumidor. El
// resto del sistema ve una consulta con `dateRange` —para eso se expandió— así
// que su error señala `timeDimensions[i].dateRange`, una propiedad que quien
// preguntó no escribió en ninguna parte. Se reescribe sólo ese miembro: un
// `UNKNOWN_MEMBER` o un rechazo de presupuesto no tienen nada que ver con el
// rango y salen tal cual.
export function apuntandoAlRango(error, indice, posicion) {
  if (!(error instanceof SemanticError)) return error;
  if (error.member !== `timeDimensions[${indice}].dateRange`) return error;
  const reescrito = new SemanticError({
    code: error.code,
    member: `timeDimensions[${indice}].compareDateRange[${posicion}]`,
    suggestion: error.suggestion,
  });
  // La puerta que cortó se conserva: es lo que separa en la telemetría un
  // rechazo de vocabulario de uno de presupuesto, y no cambia por reescribir el
  // miembro. No enumerable, como en el planificador.
  if (error.gate !== undefined) Object.defineProperty(reescrito, 'gate', { value: error.gate, enumerable: false });
  return reescrito;
}

// Los rechazos de esta pieza son errores del consumidor, como los de la puerta
// de forma, y llevan la misma anotación de puerta no enumerable que el
// planificador le pone a los suyos: sin ella, el único rechazo que no se vería
// en la telemetría por puerta sería justo el de la propiedad nueva.
function invalido(member, suggestion) {
  const error = new SemanticError({ code: 'INVALID_QUERY', member, suggestion });
  Object.defineProperty(error, 'gate', { value: 'expandirComparacion', enumerable: false });
  return error;
}

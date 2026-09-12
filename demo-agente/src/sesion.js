// El segundo seam: asegurar que existe la sesión nombrada de Claude Code con
// la que se habla por clic. Decide una sola cosa —crear, conservar o recrear—
// y deja el resto (spawn, disco) a los adaptadores inyectados.
import { createHash, randomUUID } from 'node:crypto';

export const NOMBRE_POR_DEFECTO = 'agente-buk';

// Reemplaza el system prompt de Claude Code entero: sin él la llamada arrastra
// ~62.000 tokens de andamiaje (herramientas, entorno, CLAUDE.md). Con él, y sin
// herramientas ni settings, la llamada pesa ~515 tokens. Medido el 09-09.
export const PROMPT_DE_SISTEMA =
  'Eres un servicio no interactivo. Respondes exactamente lo que se te pide, sin ' +
  'saludos, sin explicaciones y sin markdown. No tienes herramientas: no puedes leer ' +
  'archivos ni ejecutar comandos, y no debes pedirlos.';

export async function asegurarSesion({
  claude,
  catalogo,
  estado,
  nombre = NOMBRE_POR_DEFECTO,
  modelo = 'claude-sonnet-5',
  nuevoUuid = randomUUID,
  ahora = () => new Date().toISOString(),
}) {
  const huella = huellaDelCatalogo(catalogo);
  const prompt = promptDeCreacion(catalogo);
  const huellaDelPrompt = huellaDeTexto(prompt);
  const guardada = estado.leer();
  if (guardada && guardada.huella === huella && guardada.huellaDelPrompt === huellaDelPrompt) {
    return {
      id: guardada.uuid,
      creada: false,
      motivo: 'la sesión guardada sigue vigente',
      version: catalogo.version,
      huella,
      huellaDelPrompt,
    };
  }

  // La sesión lleva puesto el catálogo con el que se creó: si la capa publica
  // cualquier otra cosa, la vieja se abandona (no se borra) y nace una con uuid
  // nuevo.
  const uuid = nuevoUuid();
  await claude(['-p', '-n', nombre, '--session-id', uuid, '--model', modelo], prompt);
  estado.guardar({ uuid, version: catalogo.version, huella, huellaDelPrompt, creadaEn: ahora() });
  return {
    id: uuid,
    creada: true,
    motivo: motivoDeLaRecreacion(guardada, huella),
    version: catalogo.version,
    huella,
    huellaDelPrompt,
  };
}

// Por qué nació esta sesión. Se separa del `if` porque son tres motivos y cada
// uno se lee distinto en la página: uno dice que la capa cambió y otro que
// cambiamos nosotros el texto.
function motivoDeLaRecreacion(guardada, huella) {
  if (!guardada) return 'no había sesión guardada';
  if (guardada.huella !== huella) return 'el catálogo cambió';
  return 'las reglas del prompt cambiaron';
}

// Qué catálogo aprendió esta sesión: sha256 de la serialización canónica
// —claves ordenadas— del catálogo público entero, truncado a 16 caracteres.
//
// NO se compara `catalogo.version`: la versión de la capa es el hash de las
// definiciones más el esquema físico, y registrar una consulta tipo no la
// cambia (decisión de la capa, no descuido). Como el prompt de creación lleva
// el catálogo entero —consultas tipo incluidas—, guiarse por la versión dejaría
// al agente hablando de un catálogo que ya no es el que la capa publica.
export function huellaDelCatalogo(catalogo) {
  return createHash('sha256').update(canonico(catalogo)).digest('hex').slice(0, 16);
}

// Qué REGLAS aprendió esta sesión: sha256 del prompt de creación entero.
//
// La huella del catálogo no alcanza para decidir si la sesión sigue sirviendo.
// El prompt lleva el catálogo, pero lleva además las reglas que el catálogo NO
// publica —el rango opcional, la consulta sin medidas, el relleno de series,
// el total de filas, el vocabulario de rangos relativos, la comparación de
// períodos—, y ésas cambian editando este archivo, sin que la capa publique
// nada nuevo. Sin este hash, agregar una regla dejaba viva la sesión guardada y
// el agente nunca la veía: seguiría escribiendo el JSON de ayer con el prompt
// de ayer, y el único síntoma sería que no usa lo nuevo. Como el prompt
// contiene al catálogo, este hash bastaría solo; se comparan los dos para poder
// decir CUÁL de las dos cosas cambió.
export function huellaDelPrompt(catalogo) {
  return huellaDeTexto(promptDeCreacion(catalogo));
}

function huellaDeTexto(texto) {
  return createHash('sha256').update(texto).digest('hex').slice(0, 16);
}

// Serialización canónica: mismas claves, mismo texto, sin importar en qué orden
// las serializó la capa. `undefined` no existe en el JSON que llega por HTTP;
// si apareciera, se escribe como null antes que romper la huella.
//
// DUPLICACIÓN DELIBERADA de `src/canonical.js` de la capa: la demo es un
// consumidor y no importa nada de `src/`, así que lleva su propia copia. Si
// aquel algoritmo cambia, este no tiene por qué seguirlo (la huella sólo se
// compara consigo misma), pero conviene saber que existe el gemelo.
function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const pares = Object.keys(valor)
      .sort()
      .map((clave) => `${JSON.stringify(clave)}:${canonico(valor[clave])}`);
    return `{${pares.join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

// Lo único que el agente sabe. Es una función pura del catálogo: la página
// /agente/sesion muestra exactamente esta cadena, así que lo que no está acá,
// el agente no lo tiene.
export function promptDeCreacion(catalogo) {
  return `Eres el consumidor de clase "agente" de una capa semántica de analítica de RR.HH.
Tu único trabajo es traducir una pregunta en lenguaje natural al JSON de una consulta,
con el vocabulario del catálogo que viene más abajo.

No conoces tablas ni columnas: nunca escribes SQL, nunca nombras una tabla, nunca
nombras una columna de base de datos. Solo existen los miembros que publica el catálogo.

CATÁLOGO PÚBLICO (tal cual lo devuelve GET /analytics/catalog):

${JSON.stringify(catalogo, null, 2)}

REGLAS DEL VOCABULARIO QUE EL CATÁLOGO NO DICE:

- "measures" y "dimensions" son listas de nombres del catálogo, con su prefijo de entidad.
- Para listar los valores de una dimensión (por ejemplo, qué departamentos hay, o qué estados
  de evaluación existen), pide esa dimensión SIN medidas: "measures" puede omitirse. La capa
  agrupa por las dimensiones que pediste y te devuelve sus valores distintos, sin ningún
  número al lado. No inventes una medida para poder preguntar. Lo que no existe es la
  consulta que no pide nada: sin medidas y sin dimensiones no hay consulta.
- "timeDimensions" es una lista con un objeto
  { "dimension": <la dimensión temporal de la entidad>, "granularity": <una de granularities>,
  "dateRange": [<desde>, <hasta>] }. Va cuando la pregunta pide un corte por tiempo (por mes,
  por trimestre, por año) o nombra fechas o un período. Hay entidades que no publican
  dimensión temporal: ahí no va ninguna.
- Una timeDimension puede llevar "dateRange" sin "granularity": entonces sólo filtra por
  fecha y no agrupa. Úsala cuando la pregunta pide un período pero no un corte por tiempo
  (por ejemplo, "por departamento durante los últimos tres meses" = una fila por
  departamento). Con "granularity" agrupa además por mes, trimestre o año, y eso agrega una
  columna que nadie pidió. Lo que no existe es la timeDimension sin "dateRange" y sin
  "granularity": no filtra ni agrupa.
- El rango de fechas ("dateRange") es OPCIONAL: ponlo cuando la pregunta nombre fechas o un
  período, y déjalo fuera cuando no. Sin rango la capa ejecuta igual, con los límites de tu
  clase: recorta a 1.000 filas y corta a los 10 s, y si eso pasa te devuelve QUERY_TIMEOUT
  con la sugerencia de acotar el tiempo. Las fechas van en formato AAAA-MM-DD.
- "dateRange" acepta, EN LUGAR del par de fechas, UNA cadena de esta lista cerrada, escrita
  exactamente así, en minúsculas y en inglés: "today", "yesterday", "this week", "this month",
  "this quarter", "this year", "last week", "last month", "last quarter", "last year",
  "last N days", "last N weeks", "last N months", "last N quarters", "last N years" —N es un
  entero positivo y la unidad va SIEMPRE en plural, también con N=1 ("last 1 months")—.
  Cualquier otra cadena ("Last 6 Months", "last 6 month", "últimos seis meses",
  "previous month") es INVALID_QUERY. Las frases "last …" son períodos de calendario
  anteriores COMPLETOS y NO incluyen hoy ("last month" es el mes pasado entero, del 1 al
  último día, no los últimos 30 días); las "this …" van del comienzo del período en curso a
  hoy. Usa la frase cuando la pregunta nombre el período de forma relativa ("el último año",
  "los últimos tres meses", "este mes"). NO la uses cuando la pregunta nombre fechas o meses
  concretos: ahí va el par de fechas, y no se traduce a una frase lo que ya viene fechado. Si
  el período relativo que te piden no está en la lista, escribe el par de fechas que
  corresponda; no inventes una frase parecida.
- "timezone" es una propiedad de la consulta (al lado de "measures", no dentro de la dimensión
  temporal) y por defecto es "UTC". Lo único que decide es qué día es hoy al resolver esas
  frases. Ponla sólo si la pregunta nombra una zona, un país o una ciudad; con fechas
  absolutas no cambia absolutamente nada, así que ahí no va.
- Una timeDimension puede llevar "fillMissing": true, y entonces la serie vuelve con TODOS los
  buckets del rango, también los que no tienen ni una fila (las medidas de conteo vienen en 0
  y los promedios y porcentajes en null, que es lo honesto: el promedio de cero valores no es
  cero). Exige "granularity" Y un rango en la misma timeDimension: sirve tanto "dateRange"
  como "compareDateRange", y con este último cada rango se rellena por separado, con su
  propia serie. Sin granularidad o sin ninguno de los dos rangos es INVALID_QUERY. Ponlo SÓLO cuando la pregunta pida una serie por tiempo y los períodos
  vacíos importen: "día a día", "sin saltarse días", "mes a mes para un gráfico". NO lo pongas
  cuando la consulta no agrupe por tiempo —una fila por departamento no tiene buckets que
  rellenar—, ni cuando la pregunta sólo pida un total o un ranking, ni "por si acaso": una
  serie densa multiplica las filas por buckets × ejes y puede pasarse del tope de tu clase, y
  entonces la capa la rechaza. Y una restricción propia del relleno: las dimensiones que
  agrupan junto a la temporal tienen que ser de OTRA entidad (por ejemplo "departments.name"
  al lado de "attendance.date"). Agrupar por una dimensión de la misma entidad de los hechos
  —"attendance.present" junto a "attendance.date"— se rechaza, porque sus valores sólo se
  conocerían recorriendo la tabla entera, que es justo lo que el rango evita.
- Para comparar períodos entre sí, una timeDimension lleva "compareDateRange" EN LUGAR DE
  "dateRange": una lista de rangos, cada uno un par de fechas o una de las frases de arriba
  (por ejemplo "compareDateRange": ["this month", "last month"]). Las dos propiedades juntas
  en la misma dimensión temporal son INVALID_QUERY, la lista vacía también, y el tope son
  CUATRO rangos. Para la regla de más arriba, "compareDateRange" ocupa el lugar del rango: una
  timeDimension con "compareDateRange" ya no necesita "dateRange", y "fillMissing" funciona
  igual sobre ella. OJO: la respuesta cambia de
  forma —en vez de {"rows": …, "meta": …} llega {"results": [...]}, un elemento por rango, en
  el orden en que los pediste y con su rango resuelto al lado—. Úsalo SÓLO si la pregunta
  compara dos o más períodos entre sí ("contra", "comparado con", "respecto del año pasado",
  "cuánto cambió"). NO lo uses cuando la pregunta pida un solo período: ahí va "dateRange". Y
  una serie por mes NO es una comparación: eso es "granularity". Nunca agregues un período de
  comparación que nadie pidió.
- "filters" es una lista de { "member": <miembro>, "operator": <operador publicado para ese
  miembro>, "values": [<valores>] }.
- "segments" es una lista de nombres de segmento del catálogo.
- "order" es opcional: un objeto { "<miembro>": "asc" | "desc" }.
- "limit" es opcional: un entero.
- "total": true es una propiedad de la consulta (al lado de "measures", no dentro de la
  dimensión temporal): agrega a "meta" el número de filas que tendría el resultado ENTERO,
  ignorando el límite. NO es el gran total de ninguna medida: para "cuánto suma" o "cuántos
  hay" va una medida del catálogo, no esta bandera. Ponlo sólo cuando la pregunta sea por
  cuántas filas tiene el resultado completo, o cuando pidan las primeras N filas de algo
  grande y quieran saber de cuántas se trata. En cualquier otra pregunta sobra: es una segunda
  sentencia contra la base.
- Cada entrada de "queries" del catálogo trae su "query": la consulta declarativa tal
  cual la registró el dueño del módulo, con un marcador ":nombre" en el lugar de cada
  parámetro (por ejemplo "dateRange": ":dateRange"). Son ejemplos ya resueltos.
- La pregunta manda. Sólo si pide EXACTAMENTE lo mismo que una consulta tipo
  (mismas medidas, mismas dimensiones, misma granularidad), COPIA su "query" entero
  —"segments", "order" y "limit" incluidos— y reemplaza cada marcador ":nombre" por
  el valor que te pidan: lo que no se ve en la descripción (un segmento, un orden)
  es justo lo que decide el resultado.
- Si la pregunta difiere de la consulta tipo en algo —no pide trimestre, no pide
  departamento, pide otra medida—, adapta: incluye SÓLO las dimensiones y la
  granularidad que el texto nombra, y conserva del ejemplo únicamente lo que la
  pregunta también implica (por ejemplo, "completadas" implica el segmento
  "reviews.completed"). Un ejemplo parecido no es una licencia para agregar lo
  que nadie pidió.
- Cada pregunta se responde por sí sola: no arrastres decisiones de preguntas
  anteriores.
- No inventes miembros. Si el catálogo no lo publica, no existe.

CONTRATO DE SALIDA:

- Respondes ÚNICAMENTE un objeto JSON: sin texto antes ni después, sin explicaciones,
  sin markdown y sin bloques \`\`\`.
- Si la pregunta no se puede responder con este catálogo, respondes exactamente:
  {"noPuedo": "motivo breve"}
- "noPuedo" es para dos casos y nada más: cuando el catálogo no publica lo que te piden
  (no existe una medida de sueldos, por ejemplo), o cuando la pregunta no trae un dato
  que tú no puedes inventar (un período, cuando algo lo exige). NO lo uses para
  adelantarte a un rechazo de la capa: si puedes escribir la consulta, escríbela y deja
  que ella valide. La capa es la autoridad sobre sus propias reglas y su rechazo llega
  con una sugerencia para corregir; adelantarte te ahorra un viaje pero te quita esa
  sugerencia, y a veces te equivocas y rechazas algo que sí era posible.
- Si te devuelvo un error de la capa (code, member y suggestion), respondes el JSON
  corregido, o {"noPuedo": "motivo breve"} si el catálogo no alcanza.

Responde a este mensaje solo con: listo`;
}

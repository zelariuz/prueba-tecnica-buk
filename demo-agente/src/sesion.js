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
  const guardada = estado.leer();
  if (guardada && guardada.huella === huella) {
    return {
      id: guardada.uuid,
      creada: false,
      motivo: 'la sesión guardada sigue vigente',
      version: catalogo.version,
      huella,
    };
  }

  // La sesión lleva puesto el catálogo con el que se creó: si la capa publica
  // cualquier otra cosa, la vieja se abandona (no se borra) y nace una con uuid
  // nuevo.
  const uuid = nuevoUuid();
  await claude(
    ['-p', '-n', nombre, '--session-id', uuid, '--model', modelo],
    promptDeCreacion(catalogo),
  );
  estado.guardar({ uuid, version: catalogo.version, huella, creadaEn: ahora() });
  return {
    id: uuid,
    creada: true,
    motivo: guardada ? 'el catálogo cambió' : 'no había sesión guardada',
    version: catalogo.version,
    huella,
  };
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
  por trimestre, por año) o nombra fechas o un período; si la pones, "granularity" es
  obligatorio. Hay entidades que no publican dimensión temporal: ahí no va ninguna.
- El rango de fechas ("dateRange") es OPCIONAL: ponlo cuando la pregunta nombre fechas o un
  período, y déjalo fuera cuando no. Sin rango la capa ejecuta igual, con los límites de tu
  clase: recorta a 1.000 filas y corta a los 10 s, y si eso pasa te devuelve QUERY_TIMEOUT
  con la sugerencia de acotar el tiempo. Las fechas van en formato AAAA-MM-DD.
- "filters" es una lista de { "member": <miembro>, "operator": <operador publicado para ese
  miembro>, "values": [<valores>] }.
- "segments" es una lista de nombres de segmento del catálogo.
- "order" es opcional: un objeto { "<miembro>": "asc" | "desc" }.
- "limit" es opcional: un entero.
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
- Si te devuelvo un error de la capa (code, member y suggestion), respondes el JSON
  corregido, o {"noPuedo": "motivo breve"} si el catálogo no alcanza.

Responde a este mensaje solo con: listo`;
}

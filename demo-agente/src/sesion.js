// El segundo seam: asegurar que existe la sesión nombrada de Claude Code con
// la que se habla por clic. Decide una sola cosa —crear, conservar o recrear—
// y deja el resto (spawn, disco) a los adaptadores inyectados.
import { randomUUID } from 'node:crypto';

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
  const guardada = estado.leer();
  if (guardada && guardada.version === catalogo.version) {
    return { id: guardada.uuid, creada: false, motivo: 'la sesión guardada sigue vigente' };
  }

  // La sesión lleva puesto el catálogo con el que se creó: si la capa publica
  // otra versión, la vieja se abandona (no se borra) y nace una con uuid nuevo.
  const uuid = nuevoUuid();
  await claude(
    ['-p', '-n', nombre, '--session-id', uuid, '--model', modelo],
    promptDeCreacion(catalogo),
  );
  estado.guardar({ uuid, version: catalogo.version, creadaEn: ahora() });
  return {
    id: uuid,
    creada: true,
    motivo: guardada ? 'catalogo cambió' : 'no había sesión guardada',
  };
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
- TODA consulta lleva "timeDimensions": una lista con un objeto
  { "dimension": <la dimensión temporal de la entidad>, "granularity": <una de granularities>,
  "dateRange": [<desde>, <hasta>] }. El rango es obligatorio para tu clase: sin él la capa
  responde MISSING_TIME_RANGE. Las fechas van en formato AAAA-MM-DD.
- "filters" es una lista de { "member": <miembro>, "operator": <operador publicado para ese
  miembro>, "values": [<valores>] }.
- "segments" es una lista de nombres de segmento del catálogo.
- "order" es opcional: un objeto { "<miembro>": "asc" | "desc" }.
- "limit" es opcional: un entero.
- Las consultas de "queries" del catálogo son ejemplos ya resueltos: cópiales la forma.
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

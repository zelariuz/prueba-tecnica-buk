// El seam de la demo: dada la petición ya parseada y los colaboradores
// inyectados (agente, capa y reloj), devuelve el rastro de saltos. No sabe de
// HTTP ni de HTML: eso vive en los adaptadores.
import { preguntas, preguntaPorId, prepararConsulta, prepararTexto } from './preguntas.js';

const RUTA_CONSULTA = '/analytics/query';
const RUTA_DRY_RUN = '/analytics/query?dryRun=true';

export async function ejecutar(peticion, { agente, capa, reloj }) {
  const pregunta = preguntaPorId(peticion.pregunta);
  if (!pregunta) {
    throw new Error(
      `No existe la pregunta preparada "${peticion.pregunta}". Preparadas: ${preguntas
        .map((preparada) => preparada.id)
        .join(', ')}.`,
    );
  }
  const rastro = [];

  // Con agente, el JSON que sigue al resto del rastro lo escribe él; sin
  // agente, sale del preparado. De ahí para abajo, el camino es el mismo.
  let consulta = prepararConsulta(pregunta, peticion);
  if (peticion.agente) {
    const primero = await saltoAlAgente(promptDelClic(pregunta, peticion), { agente, reloj });
    rastro.push(primero.salto);
    if (!primero.consulta) return rastro;
    consulta = primero.consulta;
  }

  rastro.push(
    await saltoALaCapa(
      {
        destino: 'capa semántica — dry-run (params, plan y SQL)',
        ruta: RUTA_DRY_RUN,
        token: 'interno',
        cuerpo: consulta,
      },
      { capa, reloj },
    ),
  );
  const laConsulta = await saltoALaCapa(
    { destino: 'capa semántica — consulta', ruta: RUTA_CONSULTA, token: 'agente', cuerpo: consulta },
    { capa, reloj },
  );
  rastro.push(laConsulta);

  // Un solo reintento, y solo con agente: la capa rechazó lo que él escribió,
  // así que se le devuelve el error con su sugerencia y se repite el salto 3.
  // Si eso también se rechaza, el rastro termina: nunca hay un tercer intento.
  if (!peticion.agente || laConsulta.estado !== 'rechazo') return rastro;

  const correccion = await saltoAlAgente(
    promptDeCorreccion(laConsulta.recibido),
    { agente, reloj },
    'agente — corrección',
  );
  rastro.push(correccion.salto);
  if (!correccion.consulta) return rastro;

  rastro.push(
    await saltoALaCapa(
      {
        destino: 'capa semántica — consulta (corregida)',
        ruta: RUTA_CONSULTA,
        token: 'agente',
        cuerpo: correccion.consulta,
      },
      { capa, reloj },
    ),
  );
  return rastro;
}

// Un salto siempre sale: la capa que rechaza es `rechazo` con su error en
// `recibido`, y la capa que ni contesta es `fallo` con el motivo. La demo no
// tira 500 ni se queda a medias — el rastro es el producto.
async function saltoALaCapa({ destino, ruta, token, cuerpo }, { capa, reloj }) {
  const inicio = reloj();
  const salto = { destino, via: `POST ${ruta}`, token, enviado: cuerpo };
  try {
    const { status, json, ms } = await capa({ ruta, token, cuerpo });
    return {
      ...salto,
      recibido: json,
      ms: Number.isFinite(ms) ? ms : reloj() - inicio,
      estado: estadoDelStatus(status),
    };
  } catch (error) {
    return { ...salto, recibido: { error: error.message }, ms: reloj() - inicio, estado: 'fallo' };
  }
}

// El prompt del clic: el texto de la pregunta —el editado si lo hay— más la
// frase fija de filtros. El agente traduce esa frase a `timeDimensions` y
// `filters`; la demo no le pasa el JSON preparado nunca.
function promptDelClic(pregunta, peticion) {
  const texto = peticion.texto || prepararTexto(pregunta.texto, peticion);
  const departamento = peticion.departamento ? `, departamento ${peticion.departamento}` : '';
  return `${texto}\n\nFiltros: desde ${peticion.desde}, hasta ${peticion.hasta}${departamento}.`;
}

// El salto al agente devuelve el salto para el rastro y, si el texto era el
// JSON de una consulta, esa consulta. `noPuedo` y el texto que no parsea
// cortan el rastro: no hay consulta que mandarle a la capa.
async function saltoAlAgente(enviado, { agente, reloj }, destino = 'agente') {
  const inicio = reloj();
  const salto = { destino, via: agente?.via ?? 'claude -p --resume', token: null, enviado };
  let respuesta;
  try {
    respuesta = await agente(enviado);
  } catch (error) {
    return {
      salto: { ...salto, recibido: String(error.message), ms: reloj() - inicio, estado: 'fallo' },
      consulta: null,
    };
  }
  const { texto, ms, meta, fallo } = respuesta;
  const completo = {
    ...salto,
    recibido: fallo ? `(sin respuesta del agente: ${fallo})` : texto,
    ms: Number.isFinite(ms) ? ms : reloj() - inicio,
    ...(meta ? { meta } : {}),
  };
  const escrito = fallo ? null : comoJson(texto);
  if (!escrito) return { salto: { ...completo, estado: 'fallo' }, consulta: null };
  // `noPuedo` sale como `estado: rechazo`, igual que un 4xx de la capa, pero no
  // es lo mismo y la página lo deja ver: el `destino` del salto dice quién
  // rechazó. El del agente es "no sé traducir esto con este catálogo" y corta el
  // rastro sin tocar la capa; el de la capa es "este JSON está mal" y abre la
  // corrección. Un solo estado para los dos porque los dos son lo mismo para
  // quien mira: alguien dijo que no, y nadie se cayó.
  if (escrito.noPuedo) return { salto: { ...completo, estado: 'rechazo' }, consulta: null };
  return { salto: { ...completo, estado: 'ok' }, consulta: escrito };
}

// El rechazo (4xx) es el consumidor pidiendo mal: hay JSON que corregir. El
// 5xx es la capa que no está bien, y ahí no hay nada que el agente pueda
// arreglar — por eso cuenta como fallo, igual que no contestar.
function estadoDelStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  return status >= 400 && status < 500 ? 'rechazo' : 'fallo';
}

// El prompt de corrección: el error tal cual lo publica la capa. La sugerencia
// es la que hace posible el reintento, y por eso se manda entera.
function promptDeCorreccion(error) {
  return `La capa rechazó tu consulta.

code: ${error?.code ?? '(sin código)'}
member: ${error?.member ?? '(no lo dice)'}
suggestion: ${error?.suggestion ?? '(no la dice)'}

Devuelve el JSON corregido, o {"noPuedo": "motivo breve"} si el catálogo no alcanza.`;
}

// El contrato dice "solo JSON", pero un modelo puede envolverlo en un bloque de
// código igual. La leniencia es deliberada: se le tolera la envoltura ``` y no
// la prosa. Un modelo que agrega markdown sigue habiendo entendido la pregunta,
// y castigar eso convertiría un detalle de formato en un salto fallido; un
// modelo que explica en vez de responder no entendió el contrato, y ese sí
// tiene que verse roto en la página.
function comoJson(texto) {
  const limpio = String(texto ?? '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const valor = JSON.parse(limpio);
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

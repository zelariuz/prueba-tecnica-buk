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
  rastro.push(
    await saltoALaCapa(
      { destino: 'capa semántica — consulta', ruta: RUTA_CONSULTA, token: 'agente', cuerpo: consulta },
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
      estado: status >= 200 && status < 300 ? 'ok' : 'rechazo',
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
async function saltoAlAgente(enviado, { agente, reloj }) {
  const inicio = reloj();
  const salto = { destino: 'agente', via: agente?.via ?? 'claude -p --resume', token: null, enviado };
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
  if (escrito.noPuedo) return { salto: { ...completo, estado: 'rechazo' }, consulta: null };
  return { salto: { ...completo, estado: 'ok' }, consulta: escrito };
}

// El contrato dice "solo JSON", pero un modelo puede envolverlo en un bloque de
// código igual: se le tolera la envoltura, no la prosa.
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

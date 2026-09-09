// El seam de la demo: dada la petición ya parseada y los colaboradores
// inyectados (agente, capa y reloj), devuelve el rastro de saltos. No sabe de
// HTTP ni de HTML: eso vive en los adaptadores.
import { preguntaPorId, prepararConsulta } from './preguntas.js';

const RUTA_CONSULTA = '/analytics/query';
const RUTA_DRY_RUN = '/analytics/query?dryRun=true';

export async function ejecutar(peticion, { agente, capa, reloj }) {
  const pregunta = preguntaPorId(peticion.pregunta);
  const consulta = prepararConsulta(pregunta, peticion);

  const rastro = [];
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

async function saltoALaCapa({ destino, ruta, token, cuerpo }, { capa, reloj }) {
  const inicio = reloj();
  const { status, json, ms } = await capa({ ruta, token, cuerpo });
  return {
    destino,
    via: `POST ${ruta}`,
    token,
    enviado: cuerpo,
    recibido: json,
    ms: Number.isFinite(ms) ? ms : reloj() - inicio,
    estado: status >= 200 && status < 300 ? 'ok' : 'rechazo',
  };
}

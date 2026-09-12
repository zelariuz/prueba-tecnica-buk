// Las preguntas preparadas son datos, no código: viven en `preguntas.json`.
// Este módulo las busca por id. La sustitución de marcadores vive en
// `public/preparar.js`, compartido con el front (una sola implementación).
//
// Los CASOS RAROS viven en otro archivo, `preguntas-raras.json`, y no como una
// marca dentro del primero: tienen otra forma —no traen `consulta`, porque su
// gracia es el JSON que el agente decide escribir— y otro selector en la
// página. Mezclarlos habría obligado a preguntar "¿éste trae consulta?" en cada
// sitio que lee una preparada, y habría metido seis preguntas sin JSON en el
// selector de las dieciséis. Se buscan por id en las dos listas porque el
// rastro no necesita saber de cuál salió la pregunta.
import preguntas from '../preguntas.json' with { type: 'json' };
import preguntasRaras from '../preguntas-raras.json' with { type: 'json' };

export { preguntas, preguntasRaras };
export { prepararConsulta, prepararTexto } from '../public/preparar.js';

export function preguntaPorId(id) {
  return (
    preguntas.find((pregunta) => pregunta.id === id) ??
    preguntasRaras.find((pregunta) => pregunta.id === id)
  );
}

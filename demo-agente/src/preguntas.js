// Las preguntas preparadas son datos, no código: viven en `preguntas.json`.
// Este módulo las busca por id. La sustitución de marcadores vive en
// `public/preparar.js`, compartido con el front (una sola implementación).
import preguntas from '../preguntas.json' with { type: 'json' };

export { preguntas };
export { prepararConsulta, prepararTexto } from '../public/preparar.js';

export function preguntaPorId(id) {
  return preguntas.find((pregunta) => pregunta.id === id);
}

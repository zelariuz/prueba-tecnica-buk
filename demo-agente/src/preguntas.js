// Las preguntas preparadas son datos, no código: viven en `preguntas.json` y
// este módulo solo las busca por id.
import preguntas from '../preguntas.json' with { type: 'json' };

export { preguntas };

export function preguntaPorId(id) {
  return preguntas.find((pregunta) => pregunta.id === id);
}

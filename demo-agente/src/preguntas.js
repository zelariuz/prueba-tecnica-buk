// Las preguntas preparadas son datos, no código: viven en `preguntas.json`.
// Este módulo las busca por id y sustituye los marcadores por los filtros
// manuales. Es una función pura: misma pregunta y mismos filtros, misma
// consulta.
import preguntas from '../preguntas.json' with { type: 'json' };

export { preguntas };

const MARCADOR_DEPARTAMENTO = ':departamento';

export function preguntaPorId(id) {
  return preguntas.find((pregunta) => pregunta.id === id);
}

// `departamento` vacío no manda un filtro vacío: le saca el filtro a la
// consulta. Un filtro con el marcador sin sustituir sería un departamento
// llamado ":departamento", que no existe y devolvería cero filas — justo lo
// que no queremos mostrar.
export function prepararConsulta(pregunta, { desde, hasta, departamento }) {
  const consulta = estructuraSinFiltroVacio(pregunta.consulta, departamento);
  return sustituir(consulta, { ':desde': desde, ':hasta': hasta, [MARCADOR_DEPARTAMENTO]: departamento });
}

// El texto en lenguaje natural lleva los mismos marcadores; sin departamento
// la frase dice "todos los departamentos" en vez de dejar el marcador crudo.
export function prepararTexto(texto, { desde, hasta, departamento }) {
  return texto
    .replaceAll(':desde', desde ?? '')
    .replaceAll(':hasta', hasta ?? '')
    .replaceAll(MARCADOR_DEPARTAMENTO, departamento || 'todos los departamentos');
}

function estructuraSinFiltroVacio(consulta, departamento) {
  if (departamento) return consulta;
  if (!Array.isArray(consulta.filters)) return consulta;
  const filters = consulta.filters.filter(
    (filtro) => !(filtro.values ?? []).includes(MARCADOR_DEPARTAMENTO),
  );
  const { filters: _fuera, ...resto } = consulta;
  return filters.length > 0 ? { ...resto, filters } : resto;
}

function sustituir(valor, reemplazos) {
  if (typeof valor === 'string') return valor in reemplazos ? reemplazos[valor] : valor;
  if (Array.isArray(valor)) return valor.map((elemento) => sustituir(elemento, reemplazos));
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([clave, dentro]) => [clave, sustituir(dentro, reemplazos)]),
    );
  }
  return valor;
}

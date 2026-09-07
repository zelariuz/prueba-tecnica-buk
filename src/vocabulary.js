// Vocabulario del lenguaje de consulta: qué operadores admite cada tipo de
// dimensión y qué granularidades existen. Vive en un solo lugar porque lo usan
// dos piezas que no se conocen: el catálogo lo publica en `describe()` y el
// engine lo aplica al validar. Si estuviera duplicado, el catálogo podría
// prometer un operador que el engine rechaza.

// Operadores válidos por tipo de dimensión (ADR 0007, vocabulario de Cube).
export const OPERADORES_POR_TIPO = {
  string: ['equals', 'notEquals', 'in', 'notIn', 'contains'],
  number: ['equals', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['inDateRange', 'beforeDate', 'afterDate'],
  boolean: ['equals'],
};

// De los operadores declarados, los que el planificador ya sabe emitir. El
// resto se publica en el catálogo y se rechaza con `UNSUPPORTED_OPERATOR`
// mientras no exista su SQL: prometer menos de lo declarado es preferible a
// que un filtro se ignore en silencio.
export const OPERADORES_EN_SQL = new Set(['equals', 'notEquals', 'in']);

// La granularidad se interpola en el SQL, así que sale de una lista cerrada.
export const GRANULARIDADES = ['day', 'week', 'month', 'quarter', 'year'];

export function operadoresDe(tipo) {
  return OPERADORES_POR_TIPO[tipo] ?? [];
}

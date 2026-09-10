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
// resto sigue siendo válido para su tipo —pedirlo da `UNSUPPORTED_OPERATOR` y
// no `INVALID_OPERATOR`, que es lo que le dice a quien pregunta si el operador
// no aplica o si todavía no está— pero **no se publica**: un catálogo que
// ofrece un operador que el planificador rechaza deja a un agente fallando en
// bucle contra algo que leyó ahí (hallazgo 14 del abogado del diablo).
export const OPERADORES_EN_SQL = new Set(['equals', 'notEquals', 'in']);

// La granularidad se interpola en el SQL, así que sale de una lista cerrada.
export const GRANULARIDADES = ['day', 'week', 'month', 'quarter', 'year'];

// Los operadores del tipo: los que tienen sentido sobre una dimensión así. Es
// la lista contra la que el engine decide si un operador aplica.
export function operadoresDe(tipo) {
  return OPERADORES_POR_TIPO[tipo] ?? [];
}

// Los operadores del tipo que además tienen SQL: es lo que el catálogo publica.
// Sale de la misma tabla que la de arriba —una sola fuente— para que la promesa
// del catálogo no pueda separarse de lo que el planificador hace.
export function operadoresEmitidos(tipo) {
  return operadoresDe(tipo).filter((operador) => OPERADORES_EN_SQL.has(operador));
}

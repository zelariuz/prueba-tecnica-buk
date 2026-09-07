// Definición semántica del módulo de Evaluaciones de Desempeño.
// Declara qué expone el módulo bajo nombres de negocio; no sabe nada del
// engine ni genera SQL (ADR 0001). Ningún campo acepta SQL (ADR 0005).
export const reviews = {
  name: 'reviews',
  table: 'performance_reviews',
  primaryKey: 'id',
  companyColumn: 'company_id',
  description: 'Evaluaciones de desempeño: una fila por evaluación de un empleado en un período.',
  dimensions: {
    status: {
      column: 'status',
      type: 'string',
      description: 'Estado de la evaluación: pending, completed o calibrated.',
    },
  },
  measures: {
    count: {
      type: 'count',
      description: 'Cantidad de evaluaciones.',
    },
  },
};

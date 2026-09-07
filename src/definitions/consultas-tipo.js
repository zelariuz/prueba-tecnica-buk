// Consultas tipo del caso: consultas declarativas con nombre y parámetros que
// el dueño del módulo registra como plantillas probadas (CONTEXT.md, "Consulta
// tipo"). Sirven de tres cosas a la vez: plantilla para un dashboard fijo,
// ejemplo para quien lee el catálogo y test de regresión.
//
// Un parámetro se escribe en la plantilla como `:nombre` en el lugar exacto
// donde va su valor. La plantilla sigue siendo una consulta declarativa —datos,
// no código— y por eso puede publicarse tal cual en el catálogo.
export const consultasTipo = [
  {
    name: 'evaluaciones-por-departamento-y-trimestre',
    description:
      'Score promedio y evaluaciones completadas por departamento y trimestre dentro del rango pedido.',
    params: ['dateRange'],
    query: {
      measures: ['reviews.avg_score', 'reviews.completed_count'],
      dimensions: ['departments.name'],
      timeDimensions: [
        { dimension: 'reviews.period', granularity: 'quarter', dateRange: ':dateRange' },
      ],
      order: { 'reviews.period': 'asc' },
      limit: 500,
    },
  },
  {
    name: 'conteo-de-evaluaciones-por-estado',
    description: 'Cuántas evaluaciones hay en cada estado: pending, completed o calibrated.',
    params: [],
    query: {
      measures: ['reviews.count'],
      dimensions: ['reviews.status'],
      order: { 'reviews.count': 'desc' },
    },
  },
  {
    name: 'headcount-por-departamento',
    description: 'Cantidad de empleados por departamento.',
    params: [],
    query: {
      measures: ['employees.headcount'],
      dimensions: ['departments.name'],
      order: { 'employees.headcount': 'desc' },
    },
  },
];

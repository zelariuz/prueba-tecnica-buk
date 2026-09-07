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
    name: 'completitud-por-departamento',
    description:
      'Porcentaje de evaluaciones completadas por departamento dentro del rango pedido.',
    params: ['dateRange'],
    query: {
      measures: ['reviews.completion_rate'],
      dimensions: ['departments.name'],
      timeDimensions: [
        { dimension: 'reviews.period', granularity: 'year', dateRange: ':dateRange' },
      ],
      order: { 'departments.name': 'asc' },
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
    // La pregunta del caso es "tasa de asistencia por departamento de los
    // últimos tres meses": los tres meses son el `dateRange` que pone quien
    // llama. La granularidad mensual es obligatoria —v1 no admite un rango sin
    // granularidad— y de paso deja ver la tendencia mes a mes en vez de un solo
    // número por departamento.
    name: 'asistencia-por-departamento',
    description:
      'Tasa de asistencia por departamento y mes dentro del rango pedido (por ejemplo, los últimos tres meses).',
    params: ['dateRange'],
    query: {
      measures: ['attendance.attendance_rate'],
      dimensions: ['departments.name'],
      timeDimensions: [
        { dimension: 'attendance.date', granularity: 'month', dateRange: ':dateRange' },
      ],
      order: { 'departments.name': 'asc' },
      limit: 500,
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

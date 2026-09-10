// Definición semántica del módulo de Evaluaciones de Desempeño.
// Declara qué expone el módulo bajo nombres de negocio; no sabe nada del
// engine ni genera SQL (ADR 0001). Ningún campo acepta SQL (ADR 0005).
export const reviews = {
  name: 'reviews',
  table: 'performance_reviews',
  primaryKey: 'id',
  companyColumn: 'company_id',
  description: 'Evaluaciones de desempeño: una fila por evaluación de un empleado en un período.',
  timeDimension: 'period',
  dimensions: {
    status: {
      column: 'status',
      type: 'string',
      description: 'Estado de la evaluación: pending, completed o calibrated.',
    },
    period: {
      column: 'period',
      type: 'date',
      description: 'Período evaluado; se agrupa por día, mes, trimestre o año.',
    },
  },
  measures: {
    count: {
      type: 'count',
      description: 'Cantidad de evaluaciones.',
    },
    avg_score: {
      type: 'avg',
      column: 'score',
      // 10-09 (decisión del usuario, ADR implícito en la descripción): el
      // "score de desempeño" se lee sobre evaluaciones completadas. La regla va
      // en la descripción porque es lo que un agente lee del catálogo.
      description:
        'Score promedio de las evaluaciones, en la escala de 1 a 5 del módulo. Como medida de ' +
        'desempeño se lee sobre evaluaciones completadas: combinar con el segmento `completed` ' +
        '(una evaluación pendiente o calibrada todavía no es desempeño).',
    },
    completed_count: {
      type: 'count',
      segment: 'completed',
      description: 'Cantidad de evaluaciones completadas, según la regla del segmento `completed`.',
    },
    // "Cuántos EMPLEADOS completaron su evaluación" no es "cuántas
    // evaluaciones se completaron": un empleado puede tener más de una en el
    // período (el 100 tiene dos en 2025). La pregunta del enunciado se responde
    // contando empleados distintos, y eso es una medida declarada una vez, no
    // un post-proceso del consumidor.
    completed_employees: {
      type: 'count_distinct',
      column: 'employee_id',
      segment: 'completed',
      description: 'Empleados con al menos una evaluación completada en el período.',
    },
    // Medida derivada: se calcula a partir de otras medidas ya agregadas y no
    // toca ninguna columna. El módulo declara la razón, no la división: quien
    // emite el SQL se encarga de la conversión a numérico y del denominador
    // cero (ADR 0004).
    completion_rate: {
      type: 'ratio',
      numerator: 'completed_count',
      denominator: 'count',
      scale: 100,
      description: 'Porcentaje de evaluaciones completadas sobre el total de evaluaciones.',
    },
  },
  // La regla de negocio "evaluación completada" se declara una sola vez y
  // ningún consumidor puede escribirla distinto (ADR 0005).
  segments: {
    completed: {
      description: 'Evaluaciones cerradas por el evaluador.',
      filters: [{ member: 'reviews.status', operator: 'equals', values: ['completed'] }],
    },
  },
  relationships: {
    employee: {
      type: 'many_to_one',
      target: 'employees',
      foreignKey: 'employee_id',
      description: 'Empleado evaluado; por él se llega al departamento.',
    },
  },
};

// Definición semántica del módulo de Empleados.
// Existe para que las evaluaciones puedan agruparse por departamento: el engine
// llega a `departments` recorriendo relaciones, no con JOIN escritos a mano.
export const employees = {
  name: 'employees',
  table: 'employees',
  primaryKey: 'id',
  companyColumn: 'company_id',
  description: 'Empleados de la empresa: una fila por persona contratada.',
  dimensions: {
    active: {
      column: 'active',
      type: 'boolean',
      description: 'Si el empleado sigue vigente en la empresa.',
    },
  },
  measures: {
    headcount: {
      type: 'count',
      description: 'Cantidad de empleados, activos e inactivos.',
    },
    active_headcount: {
      type: 'count',
      segment: 'active',
      description: 'Cantidad de empleados activos, según la regla del segmento `active`.',
    },
  },
  // "Empleado activo" es un ejemplo del enunciado: una regla de negocio que
  // tiene que estar escrita una sola vez, y no en cada consulta de cada
  // consumidor (ADR 0005).
  segments: {
    active: {
      description: 'Empleados vigentes en la empresa.',
      filters: [{ member: 'employees.active', operator: 'equals', values: [true] }],
    },
  },
  relationships: {
    department: {
      type: 'many_to_one',
      target: 'departments',
      foreignKey: 'department_id',
      description: 'Departamento al que pertenece el empleado.',
    },
  },
};

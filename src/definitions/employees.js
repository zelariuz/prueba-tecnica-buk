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
      description: 'Cantidad de empleados.',
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

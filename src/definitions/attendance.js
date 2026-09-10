// Definición semántica del módulo de Asistencia (historia 9).
//
// Es el módulo que prueba que la capa es extensible: se agrega este archivo, se
// nombra en `src/definitions/index.js` y ya responde preguntas. El engine, el
// planificador y el catálogo no cambiaron ni una línea para recibirlo.
//
// La columna del esquema es `present BOOLEAN` (no un estado de texto), así que
// la dimensión se llama igual que lo que hay: `present`. El nombre de negocio
// nunca inventa un valor que la base no tiene.
export const attendance = {
  name: 'attendance',
  table: 'attendance',
  primaryKey: 'id',
  companyColumn: 'company_id',
  description: 'Asistencia diaria: una fila por empleado y día registrado.',
  timeDimension: 'date',
  dimensions: {
    date: {
      column: 'date',
      type: 'date',
      description: 'Día registrado; se agrupa por día, mes, trimestre o año.',
    },
    present: {
      column: 'present',
      type: 'boolean',
      description: 'Si el empleado estuvo presente ese día.',
    },
  },
  measures: {
    count: {
      type: 'count',
      // El denominador de la tasa son los días registrados, no los días
      // corridos del calendario: un día sin registro no cuenta como ausencia.
      description: 'Cantidad de días registrados de asistencia.',
    },
    present_count: {
      type: 'count',
      segment: 'present',
      description: 'Cantidad de días con el empleado presente, según el segmento `present`.',
    },
    attendance_rate: {
      type: 'ratio',
      numerator: 'present_count',
      denominator: 'count',
      scale: 100,
      description:
        'Porcentaje de días presentes sobre los días registrados. Se calcula sobre los agregados, nunca fila a fila.',
    },
  },
  segments: {
    present: {
      description: 'Días en que el empleado estuvo presente.',
      filters: [{ member: 'attendance.present', operator: 'equals', values: [true] }],
    },
  },
  relationships: {
    employee: {
      type: 'many_to_one',
      target: 'employees',
      foreignKey: 'employee_id',
      description: 'Empleado del registro; por él se llega al departamento.',
    },
  },
};

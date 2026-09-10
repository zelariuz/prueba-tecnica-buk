// Definición semántica del módulo de Departamentos.
export const departments = {
  name: 'departments',
  table: 'departments',
  primaryKey: 'id',
  companyColumn: 'company_id',
  description: 'Departamentos de la empresa: la unidad por la que se agrupan los indicadores de personas.',
  dimensions: {
    name: {
      column: 'name',
      type: 'string',
      description: 'Nombre del departamento tal como lo nombra la empresa.',
    },
  },
  measures: {
    // Agregada el 09-09: era la única entidad sin medida de conteo, y "cuántos
    // departamentos hay" no tenía traducción (el agente respondía noPuedo).
    count: {
      type: 'count',
      description: 'Cantidad de departamentos.',
    },
  },
};

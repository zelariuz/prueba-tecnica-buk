// Dialecto Postgres: tabla de capacidades del motor que consulta el
// planificador para elegir la sintaxis (CONTEXT.md, "Dialecto"). Es la única
// pieza que conoce sintaxis específica de PostgreSQL; el engine emite SQL
// estándar y le pide a esta tabla lo que varía entre motores.
const GRANULARIDADES = new Set(['day', 'week', 'month', 'quarter', 'year']);

export const postgres = {
  name: 'postgres',

  capabilities: {
    dateTrunc: true,
    agregadoFiltrado: true,
  },

  // La granularidad se interpola en el SQL, así que sale de una lista cerrada.
  // El resultado se devuelve como texto ISO y no como fecha: node-postgres
  // convierte DATE a un Date de JavaScript corrido a la zona del proceso, y el
  // valor de una dimensión temporal debe ser el mismo en cualquier máquina.
  dateTrunc(granularidad, expresion) {
    if (!GRANULARIDADES.has(granularidad)) {
      throw new Error(`Granularidad no soportada por el dialecto: ${granularidad}`);
    }
    return `TO_CHAR(DATE_TRUNC('${granularidad}', ${expresion}), 'YYYY-MM-DD')`;
  },

  agregadoFiltrado(agregado, condicion) {
    return `${agregado} FILTER (WHERE ${condicion})`;
  },
};

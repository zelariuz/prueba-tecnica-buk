// Introspector: produce el snapshot del esquema físico. Es la única parte del
// catálogo que toca la base (PRD, "Catálogo"); todo lo demás trabaja sobre el
// snapshot, y por eso el catálogo se puede probar entero sin Postgres.
//
// Forma del snapshot:
//
//   {
//     schema: 'public',
//     tables: {
//       <tabla>: {
//         columns: { <columna>: <tipo de information_schema>, ... },
//         indexes: [{ name, columns: [...], unique }, ...]
//       }
//     }
//   }
//
// Las columnas van en el orden de la tabla y los índices ordenados por nombre:
// dos introspecciones de la misma base producen el mismo snapshot, que es lo
// que permite compararlo con la foto fija del repo y usarlo como parte de la
// versión del catálogo.
const ESQUEMA = 'public';

const COLUMNAS = `
  SELECT c.table_name, c.column_name, c.data_type
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
  ORDER BY c.table_name, c.ordinal_position
`;

const INDICES = `
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = $1
  ORDER BY tablename, indexname
`;

// `pg_indexes` entrega la definición del índice como texto; las columnas son la
// lista entre paréntesis que sigue al método de acceso. Alcanza para índices
// sobre columnas —los que el catálogo necesita reconocer para saber si una
// dimensión temporal está cubierta—; un índice sobre una expresión queda
// registrado con el texto de la expresión y simplemente no coincide con
// ninguna columna, que es la respuesta conservadora.
function columnasDelIndice(indexdef) {
  const lista = indexdef.match(/USING\s+\w+\s+\((.*)\)/i)?.[1];
  if (!lista) return [];
  return lista.split(',').map((parte) => parte.trim().split(/\s+/)[0]);
}

export async function introspect(pool, esquema = ESQUEMA) {
  const [columnas, indices] = await Promise.all([
    pool.query(COLUMNAS, [esquema]),
    pool.query(INDICES, [esquema]),
  ]);

  const tables = {};
  const tabla = (nombre) => (tables[nombre] ??= { columns: {}, indexes: [] });

  for (const fila of columnas.rows) tabla(fila.table_name).columns[fila.column_name] = fila.data_type;

  for (const fila of indices.rows) {
    // Un índice sobre una tabla que no devolvió columnas no pertenece al
    // esquema de datos que el catálogo puede validar (vista materializada, por
    // ejemplo): se ignora en vez de inventar una tabla vacía.
    if (!Object.hasOwn(tables, fila.tablename)) continue;
    tables[fila.tablename].indexes.push({
      name: fila.indexname,
      columns: columnasDelIndice(fila.indexdef),
      unique: /^CREATE UNIQUE INDEX/i.test(fila.indexdef),
    });
  }

  return { schema: esquema, tables };
}

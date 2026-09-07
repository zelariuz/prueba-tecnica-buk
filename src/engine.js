// Engine: recibe una consulta declarativa más el contexto de sesión, resuelve
// contra el catálogo y genera el SQL. No conoce módulos concretos (ADR 0001).
import { createHash } from 'node:crypto';

import { SemanticError } from './errors.js';

const PARAMETRO_EMPRESA = '$1';

// El contexto de sesión viaja aparte de la consulta y nunca se lee de una
// variable global ni del cuerpo de la petición (ADR 0002).
function exigirEmpresa(ctx) {
  if (ctx?.companyId === undefined || ctx?.companyId === null) {
    throw new SemanticError({
      code: 'MISSING_TENANT',
      member: 'companyId',
      suggestion:
        'La aplicación debe pasar el contexto de sesión { companyId, consumer } como segundo argumento; no se acepta dentro de la consulta.',
    });
  }
}

function partirMiembro(miembro) {
  const [entidad, nombre] = miembro.split('.');
  return { entidad, nombre };
}

function sqlDeMedida(medida) {
  if (medida.type === 'count') return 'COUNT(*)';
  throw new Error(`Tipo de medida no soportado: ${medida.type}`);
}

export function createEngine({ catalog, pool }) {
  function planificar(query, ctx) {
    exigirEmpresa(ctx);

    const medidas = (query.measures ?? []).map((miembro) => {
      const { entidad, nombre } = partirMiembro(miembro);
      return { miembro, entidad, definicion: catalog.entity(entidad).measures[nombre] };
    });

    const dimensiones = (query.dimensions ?? []).map((miembro) => {
      const { entidad, nombre } = partirMiembro(miembro);
      return { miembro, entidad, columna: catalog.entity(entidad).dimensions[nombre].column };
    });

    // Una sola entidad de hechos en v1 (ADR 0006).
    const entidad = catalog.entity(medidas[0].entidad);

    // El filtro de empresa vive dentro de la CTE, en el único lugar donde se
    // nombra la tabla física (ADR 0003).
    const columnasCte = [...new Set(dimensiones.map((d) => d.columna))];
    const cte =
      `WITH ${entidad.name} AS (\n` +
      `  SELECT ${columnasCte.join(', ')}\n` +
      `  FROM ${entidad.table}\n` +
      `  WHERE ${entidad.companyColumn} = ${PARAMETRO_EMPRESA}\n` +
      `)`;

    const seleccion = [
      ...dimensiones.map((d) => `${d.columna} AS "${d.miembro}"`),
      ...medidas.map((m) => `${sqlDeMedida(m.definicion)} AS "${m.miembro}"`),
    ];
    const agrupacion = dimensiones.map((d) => d.columna);

    const sql =
      `${cte}\n` +
      `SELECT ${seleccion.join(', ')}\n` +
      `FROM ${entidad.name}` +
      (agrupacion.length ? `\nGROUP BY ${agrupacion.join(', ')}` : '');

    return { sql, params: [ctx.companyId], medidas };
  }

  // Dry-run: el plan sin tocar la base.
  function plan(query, ctx) {
    const { sql, params } = planificar(query, ctx);
    return { sql, params };
  }

  async function run(query, ctx) {
    const { sql, params, medidas } = planificar(query, ctx);

    // Instante en que se ejecutó la consulta que produjo el resultado; cuando
    // haya caché, la entrada guardada conserva su propio asOf.
    const asOf = new Date().toISOString();
    const resultado = await pool.query(sql, params);

    return {
      rows: aNumeros(resultado.rows, medidas),
      meta: { servedFrom: 'live', asOf, queryId: identificarConsulta(query, ctx) },
    };
  }

  return { plan, run };
}

// Postgres devuelve int8 y numeric como texto para no perder precisión; las
// medidas vuelven al consumidor como números.
function aNumeros(filas, medidas) {
  const miembrosNumericos = new Set(medidas.map((m) => m.miembro));
  return filas.map((fila) =>
    Object.fromEntries(
      Object.entries(fila).map(([miembro, valor]) => [
        miembro,
        miembrosNumericos.has(miembro) && valor !== null ? Number(valor) : valor,
      ]),
    ),
  );
}

// Identidad de la consulta: su forma más la empresa. La empresa entra al hash
// para que una entrada de caché nunca pueda servir a otra empresa.
function identificarConsulta(query, ctx) {
  return createHash('sha256')
    .update(JSON.stringify({ companyId: ctx.companyId, query }))
    .digest('hex')
    .slice(0, 16);
}

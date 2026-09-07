// Engine: recibe una consulta declarativa más el contexto de sesión, resuelve
// contra el catálogo y genera el SQL. No conoce módulos concretos (ADR 0001).
import { createHash } from 'node:crypto';

import { postgres } from './dialect/postgres.js';
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

// Un miembro se nombra `entidad.miembro`; resolverlo es traducir ese nombre de
// negocio a la columna física de su entidad (ADR 0007).
function dimensionDe(catalog, miembro) {
  const { entidad, nombre } = partirMiembro(miembro);
  return { entidad, columna: catalog.entity(entidad).dimensions[nombre].column };
}

function sqlDeMedida(medida, entidad) {
  if (medida.type === 'count') return 'COUNT(*)';
  if (medida.type === 'avg') return `AVG(${entidad}.${medida.column})`;
  throw new Error(`Tipo de medida no soportado: ${medida.type}`);
}

// Camino de joins: BFS sobre relaciones `many_to_one` desde la entidad de
// hechos. Solo se recorren aristas que no multiplican filas (ADR 0006), así que
// agregar una dimensión de otra entidad nunca cambia el valor de las medidas.
function caminoDeJoins(catalog, raiz, destinos) {
  const previa = new Map([[raiz, null]]);
  const pendientes = [raiz];

  while (pendientes.length > 0) {
    const actual = pendientes.shift();
    const relaciones = catalog.entity(actual).relationships ?? {};
    for (const relacion of Object.values(relaciones)) {
      if (relacion.type !== 'many_to_one' || previa.has(relacion.target)) continue;
      previa.set(relacion.target, { desde: actual, relacion });
      pendientes.push(relacion.target);
    }
  }

  // De cada destino se vuelve hacia la raíz; el orden final deja siempre la
  // entidad de origen de un join antes que su destino.
  const aristas = [];
  const vistas = new Set([raiz]);
  for (const destino of destinos) {
    if (!previa.has(destino)) {
      throw new SemanticError({
        code: 'NO_JOIN_PATH',
        member: destino,
        suggestion: `No hay relaciones declaradas que lleven de ${raiz} a ${destino}.`,
      });
    }
    const rama = [];
    for (let entidad = destino; entidad !== raiz; entidad = previa.get(entidad).desde) {
      rama.unshift({ hacia: entidad, ...previa.get(entidad) });
    }
    for (const arista of rama) {
      if (vistas.has(arista.hacia)) continue;
      vistas.add(arista.hacia);
      aristas.push(arista);
    }
  }
  return aristas;
}

export function createEngine({ catalog, pool, dialect = postgres }) {
  function planificar(query, ctx) {
    exigirEmpresa(ctx);

    // Los valores literales de la consulta viajan como parámetros: dos
    // consultas con la misma forma generan exactamente el mismo SQL.
    const params = [ctx.companyId];
    const parametro = (valor) => `$${params.push(valor)}`;

    const medidas = (query.measures ?? []).map((miembro) => {
      const { entidad, nombre } = partirMiembro(miembro);
      return { miembro, entidad, definicion: catalog.entity(entidad).measures[nombre] };
    });

    const dimensiones = (query.dimensions ?? []).map((miembro) => {
      const { entidad, columna } = dimensionDe(catalog, miembro);
      return { miembro, entidad, columna, expresion: `${entidad}.${columna}` };
    });

    // Una dimensión temporal es una dimensión más, agrupada por granularidad;
    // su rango acota la CTE de su entidad y no el resultado ya agregado.
    const rangos = new Map();
    for (const temporal of query.timeDimensions ?? []) {
      const { entidad, columna } = dimensionDe(catalog, temporal.dimension);
      dimensiones.push({
        miembro: temporal.dimension,
        entidad,
        columna,
        expresion: dialect.dateTrunc(temporal.granularity, `${entidad}.${columna}`),
      });
      if (!temporal.dateRange) continue;
      const [desde, hasta] = temporal.dateRange;
      // Rango cerrado en ambos extremos, como el dateRange de Cube.
      rangos.set(entidad, [
        ...(rangos.get(entidad) ?? []),
        `${columna} >= ${parametro(desde)}`,
        `${columna} <= ${parametro(hasta)}`,
      ]);
    }

    // Una sola entidad de hechos en v1: medidas de dos entidades en el mismo
    // SELECT multiplican filas y devuelven números incorrectos en silencio
    // (ADR 0006).
    const raiz = medidas[0].entidad;
    const intrusa = medidas.find((m) => m.entidad !== raiz);
    if (intrusa) {
      throw new SemanticError({
        code: 'MULTI_ENTITY_MEASURES',
        member: intrusa.miembro,
        suggestion: `Las medidas de una consulta deben salir de una sola entidad; ${intrusa.miembro} no es de ${raiz}. Pide ${intrusa.miembro} en una segunda consulta.`,
      });
    }
    const aristas = caminoDeJoins(
      catalog,
      raiz,
      dimensiones.map((d) => d.entidad),
    );

    // Un filtro se declara como { member, operator, values } y el engine es el
    // único que lo traduce a SQL (ADR 0005).
    const condicionDeFiltro = (filtro) => {
      const { entidad, columna } = dimensionDe(catalog, filtro.member);
      if (filtro.operator !== 'equals') {
        throw new Error(`Operador no soportado: ${filtro.operator}`);
      }
      return `${entidad}.${columna} = ${parametro(filtro.values[0])}`;
    };

    // El filtro de una medida se declara una sola vez, como segmento.
    const filtrosDeMedida = (medida) =>
      medida.definicion.segment
        ? catalog.entity(medida.entidad).segments[medida.definicion.segment].filters
        : [];

    // Cada entidad solo lleva a su CTE las columnas que la consulta necesita.
    const columnas = new Map([[raiz, new Set()]]);
    const pedir = (entidad, columna) => {
      if (!columnas.has(entidad)) columnas.set(entidad, new Set());
      columnas.get(entidad).add(columna);
    };
    for (const dimension of dimensiones) pedir(dimension.entidad, dimension.columna);
    for (const medida of medidas) {
      if (medida.definicion.column) pedir(medida.entidad, medida.definicion.column);
      for (const filtro of filtrosDeMedida(medida)) {
        const { entidad, columna } = dimensionDe(catalog, filtro.member);
        pedir(entidad, columna);
      }
    }
    for (const { desde, hacia, relacion } of aristas) {
      pedir(desde, relacion.foreignKey);
      pedir(hacia, catalog.entity(hacia).primaryKey);
    }

    // El filtro de empresa vive dentro de la CTE, en el único lugar donde se
    // nombra la tabla física (ADR 0003).
    const cte = [raiz, ...aristas.map((a) => a.hacia)].map((nombre) => {
      const entidad = catalog.entity(nombre);
      const condiciones = [
        `${entidad.companyColumn} = ${PARAMETRO_EMPRESA}`,
        ...(rangos.get(nombre) ?? []),
      ];
      return (
        `${nombre} AS (\n` +
        `  SELECT ${[...columnas.get(nombre)].join(', ')}\n` +
        `  FROM ${entidad.table}\n` +
        `  WHERE ${condiciones.join('\n    AND ')}\n` +
        `)`
      );
    });

    const seleccion = [
      ...dimensiones.map((d) => `${d.expresion} AS "${d.miembro}"`),
      ...medidas.map((m) => {
        const agregado = sqlDeMedida(m.definicion, m.entidad);
        const filtros = filtrosDeMedida(m);
        const expresion = filtros.length
          ? dialect.agregadoFiltrado(agregado, filtros.map(condicionDeFiltro).join(' AND '))
          : agregado;
        return `${expresion} AS "${m.miembro}"`;
      }),
    ];
    const agrupacion = dimensiones.map((d) => d.expresion);
    const joins = aristas.map(
      ({ desde, hacia, relacion }) =>
        `\nJOIN ${hacia} ON ${desde}.${relacion.foreignKey} = ${hacia}.${catalog.entity(hacia).primaryKey}`,
    );

    // Se ordena por el nombre semántico de la columna de salida: el consumidor
    // ordena por lo que pidió, no por la expresión con la que se calculó.
    const orden = Object.entries(query.order ?? {}).map(([miembro, direccion]) => {
      if (direccion !== 'asc' && direccion !== 'desc') {
        throw new Error(`Dirección de orden no soportada: ${direccion}`);
      }
      return `"${miembro}" ${direccion.toUpperCase()}`;
    });

    const sql = [
      `WITH ${cte.join(',\n')}`,
      `SELECT ${seleccion.join(', ')}`,
      `FROM ${raiz}${joins.join('')}`,
      ...(agrupacion.length ? [`GROUP BY ${agrupacion.join(', ')}`] : []),
      ...(orden.length ? [`ORDER BY ${orden.join(', ')}`] : []),
      ...(query.limit == null ? [] : [`LIMIT ${parametro(query.limit)}`]),
    ].join('\n');

    return { sql, params, medidas };
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

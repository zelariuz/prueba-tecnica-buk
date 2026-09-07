import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { introspect } from '../src/introspect.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

function errorDe(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('se esperaba un error estructurado y la llamada no falló');
}

test('la definición sin descripción o sin columna de empresa se rechaza al registrar', () => {
  const catalog = createCatalog();

  const sinDescripcion = errorDe(() =>
    catalog.register({ ...reviews, description: undefined }),
  );
  assert.equal(sinDescripcion.code, 'INVALID_DEFINITION');
  assert.equal(sinDescripcion.member, 'reviews.description');
  assert.ok(sinDescripcion.suggestion.length > 0, 'el error estructurado trae sugerencia');

  const sinEmpresa = errorDe(() => catalog.register({ ...reviews, companyColumn: undefined }));
  assert.equal(sinEmpresa.code, 'INVALID_DEFINITION');
  assert.equal(sinEmpresa.member, 'reviews.companyColumn');

  // La descripción es obligatoria también en cada dimensión y cada medida: es
  // lo que un agente lee para traducir una pregunta en una consulta.
  const dimensionMuda = errorDe(() =>
    catalog.register({
      ...reviews,
      dimensions: { ...reviews.dimensions, status: { column: 'status', type: 'string' } },
    }),
  );
  assert.equal(dimensionMuda.code, 'INVALID_DEFINITION');
  assert.equal(dimensionMuda.member, 'reviews.status.description');

  const medidaMuda = errorDe(() =>
    catalog.register({ ...reviews, measures: { ...reviews.measures, count: { type: 'count' } } }),
  );
  assert.equal(medidaMuda.code, 'INVALID_DEFINITION');
  assert.equal(medidaMuda.member, 'reviews.count.description');
});

test('las definiciones del caso registran sin error', () => {
  const catalog = createCatalog();

  for (const definicion of [reviews, employees, departments]) {
    assert.equal(catalog.register(definicion).ok, true, `${definicion.name} registra`);
  }
});

// Snapshot del esquema físico: tablas → columnas con su tipo, más los índices
// con las columnas que cubren. Se descubre con `introspect(pool)`, nunca se
// declara. La foto fija del repo se generó desde la base del caso y se inyecta
// aquí para que todos los tests del catálogo corran sin Postgres.
const esquema = JSON.parse(
  readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'),
);

test('la definición con una columna que no existe en el esquema falla al registrar', () => {
  const catalog = createCatalog();

  const error = errorDe(() =>
    catalog.register(
      {
        ...reviews,
        dimensions: {
          ...reviews.dimensions,
          status: { ...reviews.dimensions.status, column: 'statu' },
        },
      },
      esquema,
    ),
  );

  // Falla al registrar, no al consultar: un cambio de esquema se detecta al
  // arrancar y no cuando el dashboard ya está roto en producción.
  assert.equal(error.code, 'INVALID_DEFINITION');
  assert.equal(error.member, 'reviews.status.column');
  assert.match(error.suggestion, /status/);
});

test('la definición sobre una tabla que no existe en el esquema falla al registrar', () => {
  const catalog = createCatalog();

  const error = errorDe(() =>
    catalog.register({ ...reviews, table: 'performance_review' }, esquema),
  );

  assert.equal(error.code, 'INVALID_DEFINITION');
  assert.equal(error.member, 'reviews.table');
  assert.match(error.suggestion, /performance_reviews/);
});

test('registrar una dimensión temporal sin índice devuelve una advertencia, no un error', () => {
  const catalog = createCatalog();

  // El esquema del caso solo trae el índice de la llave primaria: agrupar por
  // `period` recorre la tabla entera, y eso hay que saberlo antes de producción.
  const { ok, warnings } = catalog.register(reviews, esquema);

  assert.equal(ok, true, 'la advertencia no impide registrar');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].member, 'reviews.period');
  assert.match(warnings[0].warning, /índice/);
});

test('la dimensión temporal cubierta por un índice no genera advertencia', () => {
  const conIndice = {
    ...esquema,
    tables: {
      ...esquema.tables,
      performance_reviews: {
        ...esquema.tables.performance_reviews,
        indexes: [
          ...esquema.tables.performance_reviews.indexes,
          { name: 'performance_reviews_company_period', columns: ['company_id', 'period'], unique: false },
        ],
      },
    },
  };

  assert.deepEqual(createCatalog().register(reviews, conIndice).warnings, []);
});

function catalogoDelCaso(snapshot) {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion, snapshot);
  return catalog;
}

test('la versión del catálogo es un hash estable de las definiciones y el esquema', () => {
  // Misma entrada, misma versión: el orden de las claves de un objeto no puede
  // cambiar la versión, porque la versión invalida la caché (fase 8).
  assert.equal(
    catalogoDelCaso(esquema).version(),
    catalogoDelCaso(esquema).version(),
  );

  // Cambiar una definición cambia la versión.
  const conMedidaNueva = createCatalog();
  for (const definicion of [reviews, employees, departments]) {
    conMedidaNueva.register(definicion, esquema);
  }
  conMedidaNueva.register(
    {
      ...departments,
      measures: { total: { type: 'count', description: 'Cantidad de departamentos.' } },
    },
    esquema,
  );
  assert.notEqual(conMedidaNueva.version(), catalogoDelCaso(esquema).version());

  // Cambiar el esquema físico bajo las mismas definiciones también.
  const otroEsquema = {
    ...esquema,
    tables: {
      ...esquema.tables,
      performance_reviews: {
        ...esquema.tables.performance_reviews,
        columns: { ...esquema.tables.performance_reviews.columns, notes: 'text' },
      },
    },
  };
  assert.notEqual(catalogoDelCaso(otroEsquema).version(), catalogoDelCaso(esquema).version());

  // `register` devuelve la versión vigente tras registrar.
  const catalog = createCatalog();
  assert.equal(catalog.register(reviews, esquema).version, catalog.version());
});

const { DATABASE_URL } = process.env;

// El introspector es la única parte del catálogo que toca la base; el resto de
// los tests corre con el snapshot inyectado y sin Postgres.
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

test('el snapshot descubierto de la base registra las definiciones del caso', conBase, async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const snapshot = await introspect(pool);
    const catalog = createCatalog();

    for (const definicion of [reviews, employees, departments]) {
      assert.equal(catalog.register(definicion, snapshot).ok, true, `${definicion.name} registra`);
    }

    // El esquema del caso no trae índice sobre `period`: el introspector lo
    // descubre y el registro lo advierte.
    assert.deepEqual(
      createCatalog().register(reviews, snapshot).warnings.map((a) => a.member),
      ['reviews.period'],
    );

    // La foto guardada en el repo es la misma que produce la base del caso: es
    // lo que permite correr todos los tests del catálogo sin Postgres.
    assert.deepEqual(snapshot, esquema);
  } finally {
    await pool.end();
  }
});

test('describe entrega la vista pública: nombres semánticos, tipos y operadores', () => {
  const catalog = catalogoDelCaso(esquema);
  const vista = catalog.describe({ companyId: 1, consumer: 'dashboard' });

  assert.equal(vista.version, catalog.version());
  assert.deepEqual(vista.granularities, ['day', 'week', 'month', 'quarter', 'year']);

  const entidad = vista.entities.find((e) => e.name === 'reviews');
  assert.equal(entidad.description, reviews.description);
  assert.equal(entidad.timeDimension, 'reviews.period');
  // Las relaciones se exponen por nombre de entidad: el consumidor sabe con qué
  // se puede cruzar, nunca por qué columna se une (ADR 0008).
  assert.deepEqual(entidad.relatedEntities, ['employees']);

  const status = entidad.dimensions.find((d) => d.name === 'reviews.status');
  assert.equal(status.type, 'string');
  assert.deepEqual(status.operators, ['equals', 'notEquals', 'in', 'notIn', 'contains']);
  assert.ok(status.description.length > 0, 'la dimensión llega con su descripción');

  const periodo = entidad.dimensions.find((d) => d.name === 'reviews.period');
  assert.deepEqual(periodo.operators, ['inDateRange', 'beforeDate', 'afterDate']);

  assert.deepEqual(
    entidad.measures.map((m) => m.name).sort(),
    ['reviews.avg_score', 'reviews.completed_count', 'reviews.count'],
  );
  assert.deepEqual(entidad.segments.map((s) => s.name), ['reviews.completed']);
  assert.ok(entidad.segments[0].description.length > 0, 'el segmento llega con su descripción');
});

test('la vista interna trae el mapeo físico y solo se obtiene pidiéndola', () => {
  const catalog = catalogoDelCaso(esquema);
  const interna = catalog.describe({ companyId: 1, consumer: 'api', internal: true });

  // La vista interna es la pública más el mapeo físico: quien la pide ya tiene
  // todo lo que ve un consumidor.
  assert.deepEqual(
    interna.entities.map((e) => e.name),
    catalog.describe({ companyId: 1 }).entities.map((e) => e.name),
  );

  assert.deepEqual(interna.tables.reviews, {
    table: 'performance_reviews',
    primaryKey: 'id',
    companyColumn: 'company_id',
    columns: { 'reviews.status': 'status', 'reviews.period': 'period', 'reviews.avg_score': 'score' },
    joins: [{ to: 'employees', foreignKey: 'employee_id' }],
  });

  // El mapeo físico no existe en la vista pública ni por descuido.
  assert.equal(catalog.describe({ companyId: 1, consumer: 'api' }).tables, undefined);
});

test('la vista pública no contiene ningún nombre de tabla ni de columna física', () => {
  const catalog = catalogoDelCaso(esquema);
  const vista = catalog.describe({ companyId: 1, consumer: 'agent' });
  const serializada = JSON.stringify(vista);

  // Vocabulario que la vista pública sí puede nombrar: entidades, miembros,
  // granularidades, tipos y operadores. Un nombre físico que coincide con uno
  // semántico (la dimensión `status` se llama igual que su columna) no es una
  // fuga: es el nombre de negocio.
  const semanticos = new Set(vista.granularities);
  for (const entidad of vista.entities) {
    semanticos.add(entidad.name);
    for (const miembro of [...entidad.dimensions, ...entidad.measures, ...entidad.segments]) {
      semanticos.add(miembro.name.split('.')[1]);
      if (miembro.type) semanticos.add(miembro.type);
      for (const operador of miembro.operators ?? []) semanticos.add(operador);
    }
  }

  const fisicos = new Set();
  for (const [tabla, definicion] of Object.entries(esquema.tables)) {
    fisicos.add(tabla);
    for (const columna of Object.keys(definicion.columns)) fisicos.add(columna);
  }
  const aVerificar = [...fisicos].filter((nombre) => !semanticos.has(nombre));

  // Si el filtro dejara la lista vacía, el test pasaría sin comprobar nada.
  assert.ok(aVerificar.length >= 10, `quedan nombres físicos que verificar: ${aVerificar}`);
  assert.ok(aVerificar.includes('performance_reviews'), 'la tabla del caso está en la lista');
  for (const nombre of aVerificar) {
    // Límites de palabra: `score` no debe confundirse con la medida `avg_score`.
    assert.doesNotMatch(
      serializada,
      new RegExp(`\\b${nombre}\\b`),
      `la vista pública deja escapar el nombre físico ${nombre}`,
    );
  }

  // Contraste: la vista interna sí los trae, y por eso no sale del servidor.
  assert.match(
    JSON.stringify(catalog.describe({ companyId: 1, internal: true })),
    /performance_reviews/,
  );
});

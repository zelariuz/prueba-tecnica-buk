// La segunda fuente. Existe para probar el seam del dialecto: las mismas
// definiciones, el mismo engine y los mismos literales del caso, contra el
// motor más distinto que se puede meter sin agregar dependencias —SQLite, que
// Node 24 trae incorporado en `node:sqlite`—.
//
// Estos tests no necesitan variables de entorno: la base vive en memoria y se
// arma con el fixture del repo, así que corren siempre.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { sqlite } from '../src/dialect/sqlite.js';
import { crearPoolSqlite } from '../src/dialect/sqlite-pool.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

const EMPRESA_A = 1;
const EMPRESA_B = 2;

// Las definiciones son las mismas de siempre; lo único que cambia es en qué
// fuente vive la entidad. Ni una dimensión, ni una medida, ni un segmento se
// escribe distinto porque abajo haya otro motor.
const definicionesEnSqlite = [reviews, employees, departments].map((definicion) => ({
  ...definicion,
  source: 'sqlite',
}));

const CASO_SQL = readFileSync(new URL('./fixtures/caso-sqlite.sql', import.meta.url), 'utf8');

function baseDelCaso() {
  const pool = crearPoolSqlite();
  pool.ejecutarGuion(CASO_SQL);
  return pool;
}

async function armar(pool) {
  const fuentes = { sqlite: { dialecto: sqlite, pool } };
  const snapshot = await sqlite.introspect(pool);
  const catalog = createCatalog({ fuentes });
  const advertencias = definicionesEnSqlite.map((definicion) => ({
    entidad: definicion.name,
    ...catalog.register(definicion, snapshot),
  }));
  return { catalog, snapshot, advertencias, engine: createEngine({ catalog, fuentes }) };
}

// La misma consulta del caso obligatorio de `run.test.js`, copiada tal cual:
// nombres de negocio, sin tablas, sin joins y sin filtro de empresa.
const casoObligatorio = {
  measures: ['reviews.avg_score', 'reviews.completed_count'],
  dimensions: ['departments.name'],
  segments: ['reviews.completed'],
  timeDimensions: [
    {
      dimension: 'reviews.period',
      granularity: 'quarter',
      dateRange: ['2025-01-01', '2025-12-31'],
    },
  ],
  order: { 'reviews.period': 'asc' },
  limit: 500,
};

function porDepartamentoYTrimestre(rows) {
  return [...rows].sort((a, b) =>
    `${a['reviews.period']}${a['departments.name']}`.localeCompare(
      `${b['reviews.period']}${b['departments.name']}`,
    ),
  );
}

describe('el esquema de SQLite visto por el catálogo', () => {
  let pool;
  before(() => {
    pool = baseDelCaso();
  });
  after(() => pool.cerrar());

  it('la introspección devuelve la misma forma de snapshot que Postgres', async () => {
    const snapshot = await sqlite.introspect(pool);

    assert.equal(snapshot.schema, 'main');
    assert.deepEqual(snapshot.tables.performance_reviews.columns, {
      id: 'BIGINT',
      employee_id: 'BIGINT',
      company_id: 'BIGINT',
      period: 'DATE',
      score: 'NUMERIC(4,2)',
      status: 'TEXT',
    });
    // Un índice por clave primaria, como el `_pkey` de Postgres: la clave es
    // BIGINT y no INTEGER, así que SQLite le crea su propio índice único.
    assert.deepEqual(snapshot.tables.performance_reviews.indexes, [
      { name: 'sqlite_autoindex_performance_reviews_1', columns: ['id'], unique: true },
    ]);
  });

  it('las mismas definiciones registran contra la fuente sqlite', async () => {
    const { advertencias, catalog } = await armar(pool);

    for (const { entidad, ok } of advertencias) assert.equal(ok, true, `${entidad} registró`);
    assert.equal(catalog.source('reviews'), 'sqlite');

    // Lo único que el catálogo tiene que advertir es lo de siempre: la
    // dimensión temporal no tiene índice que la cubra. Ninguna incompatibilidad
    // de tipos, porque los tipos declarados calzan con la afinidad de SQLite.
    const avisos = advertencias.flatMap(({ entidad, warnings }) =>
      warnings.map((aviso) => `${entidad}:${aviso.member}`),
    );
    assert.deepEqual(avisos, ['reviews:reviews.period']);
  });

  it('sin tipos garantizados, un tipo que no calza es advertencia y no error', async () => {
    const fuentes = { sqlite: { dialecto: sqlite, pool } };
    const snapshot = await sqlite.introspect(pool);
    const catalog = createCatalog({ fuentes });

    // `status` es TEXT; declararla `number` sería un error de definición contra
    // Postgres. SQLite no hace cumplir el tipo de una columna, así que la
    // sospecha se informa y el registro sigue: negarse a hablar con el motor
    // sería peor.
    const { ok, warnings } = catalog.register(
      {
        ...reviews,
        source: 'sqlite',
        dimensions: { ...reviews.dimensions, status: { ...reviews.dimensions.status, type: 'number' } },
      },
      snapshot,
    );

    assert.equal(ok, true);
    const deTipo = warnings.find((aviso) => aviso.member === 'reviews.status');
    assert.ok(deTipo, 'la incompatibilidad de tipo sale como advertencia');
    assert.match(deTipo.warning, /sqlite/);
  });
});

describe('el caso obligatorio contra SQLite', () => {
  let pool;
  let engine;

  before(async () => {
    pool = baseDelCaso();
    ({ engine } = await armar(pool));
  });
  after(() => pool.cerrar());

  it('devuelve para la empresa A exactamente las filas del test contra Postgres', async () => {
    const { rows, meta } = await engine.run(casoObligatorio, {
      companyId: EMPRESA_A,
      consumer: 'api',
    });

    assert.deepEqual(porDepartamentoYTrimestre(rows), [
      {
        'departments.name': 'Ingeniería',
        'reviews.period': '2025-01-01',
        'reviews.avg_score': 4.35,
        'reviews.completed_count': 2,
      },
      {
        'departments.name': 'Ingeniería',
        'reviews.period': '2025-04-01',
        'reviews.avg_score': 3.8,
        'reviews.completed_count': 1,
      },
    ]);
    assert.equal(meta.servedFrom, 'live');
  });

  it('la empresa B, con departamentos del mismo nombre, obtiene sus propios números', async () => {
    const { rows } = await engine.run(casoObligatorio, { companyId: EMPRESA_B, consumer: 'api' });

    assert.deepEqual(porDepartamentoYTrimestre(rows), [
      {
        'departments.name': 'Ingeniería',
        'reviews.period': '2025-01-01',
        'reviews.avg_score': 4.1,
        'reviews.completed_count': 1,
      },
      {
        'departments.name': 'Ingeniería',
        'reviews.period': '2025-04-01',
        'reviews.avg_score': 3.3,
        'reviews.completed_count': 1,
      },
    ]);
  });

  it('las medidas llegan como número, no como texto', async () => {
    const { rows } = await engine.run(casoObligatorio, { companyId: EMPRESA_A, consumer: 'api' });

    for (const fila of rows) {
      assert.equal(typeof fila['reviews.avg_score'], 'number');
      assert.equal(typeof fila['reviews.completed_count'], 'number');
    }
  });

  it('la derivada completion_rate da los mismos 75 que contra Postgres', async () => {
    const { rows } = await engine.run(
      {
        measures: ['reviews.completion_rate'],
        dimensions: ['departments.name'],
        timeDimensions: [
          {
            dimension: 'reviews.period',
            granularity: 'year',
            dateRange: ['2025-01-01', '2025-12-31'],
          },
        ],
      },
      { companyId: EMPRESA_A, consumer: 'api' },
    );

    // Literales del fixture: Ingeniería tiene 4 evaluaciones de 2025 y 3
    // completadas; Ventas, 2 y ninguna. Sin la conversión a numérico del
    // dialecto, dos COUNT enteros darían 0 y 0.
    assert.deepEqual(
      Object.fromEntries(rows.map((f) => [f['departments.name'], f['reviews.completion_rate']])),
      { Ingeniería: 75, Ventas: 0 },
    );
  });
});

describe('el SQL que emite el dialecto SQLite', () => {
  let pool;
  let engine;

  before(async () => {
    pool = baseDelCaso();
    ({ engine } = await armar(pool));
  });
  after(() => pool.cerrar());

  it('es el del snapshot del repo, letra por letra', async () => {
    const { sql } = engine.plan(casoObligatorio, { companyId: EMPRESA_A, consumer: 'api' });
    const esperado = readFileSync(
      new URL('./snapshots/caso-obligatorio-sqlite.sql', import.meta.url),
      'utf8',
    );

    assert.equal(`${sql}\n`, esperado);
  });

  it('cada CTE lleva el filtro de empresa, igual que en Postgres', async () => {
    const { sql, params } = engine.plan(casoObligatorio, { companyId: EMPRESA_A, consumer: 'api' });

    const cte = sql.match(/^(?:WITH )?\w+ AS \($/gm) ?? [];
    assert.equal(cte.length, 3, 'una CTE por entidad: reviews, employees y departments');
    assert.equal(
      (sql.match(/company_id = \$1/g) ?? []).length,
      3,
      'el aislamiento vive dentro de cada CTE, no en el WHERE de afuera',
    );
    assert.equal(params[0], EMPRESA_A);
    assert.ok(!sql.includes(`= ${EMPRESA_A}`), 'la empresa viaja como parámetro');
  });
});

describe('lo que SQLite no puede prometer', () => {
  let pool;
  let sentencias;
  let engine;

  before(async () => {
    pool = baseDelCaso();
    sentencias = [];
    // Espía delgado sobre el adaptador: registra el texto de cada sentencia y
    // deja pasar todo. Lo que se observa es lo que el engine decidió emitir.
    const espiado = {
      ...pool,
      async connect() {
        const cliente = await pool.connect();
        return {
          query: (texto, params) => {
            sentencias.push(texto);
            return cliente.query(texto, params);
          },
          release: () => cliente.release(),
        };
      },
    };
    const fuentes = { sqlite: { dialecto: sqlite, pool: espiado } };
    const snapshot = await sqlite.introspect(pool);
    const catalog = createCatalog({ fuentes });
    for (const definicion of definicionesEnSqlite) catalog.register(definicion, snapshot);
    engine = createEngine({ catalog, fuentes });
  });
  after(() => pool.cerrar());

  it('el engine no emite ninguna sentencia de timeout: el dialecto no ofrece ninguna', async () => {
    await engine.run(casoObligatorio, { companyId: EMPRESA_A, consumer: 'api' });

    // La transacción sí es real; lo que no existe es el presupuesto de tiempo.
    assert.ok(sentencias.includes('BEGIN'), 'la consulta corre dentro de una transacción');
    assert.ok(sentencias.includes('COMMIT'));
    assert.deepEqual(
      sentencias.filter((texto) => /statement_timeout|^SET /i.test(texto)),
      [],
      'el engine no nombra una sentencia que este motor no tiene',
    );
    // Y la capacidad lo dice, para que no haya que deducirlo mirando el SQL.
    assert.equal(sqlite.capabilities.timeoutDeSentencia, false);
  });
});

describe('los errores nativos de SQLite los traduce el dialecto', () => {
  let pool;
  let engine;

  before(async () => {
    pool = baseDelCaso();
    // Mismo patrón que `run.test.js` contra Postgres: la consulta principal —la
    // única que viaja con parámetros— se cambia por una que nombra algo que la
    // base no tiene.
    const desfasado = {
      ...pool,
      async connect() {
        const cliente = await pool.connect();
        return {
          query: (texto, params) =>
            params === undefined
              ? cliente.query(texto)
              : cliente.query('SELECT columna_fantasma FROM performance_reviews'),
          release: () => cliente.release(),
        };
      },
    };
    const fuentes = { sqlite: { dialecto: sqlite, pool: desfasado } };
    const snapshot = await sqlite.introspect(pool);
    const catalog = createCatalog({ fuentes });
    for (const definicion of definicionesEnSqlite) catalog.register(definicion, snapshot);
    engine = createEngine({ catalog, fuentes });
  });
  after(() => pool.cerrar());

  it('"no such column" vuelve como SCHEMA_DRIFT, el mismo código que da Postgres', async () => {
    let error;
    try {
      await engine.run(casoObligatorio, { companyId: EMPRESA_A, consumer: 'api' });
    } catch (fallo) {
      error = fallo;
    }

    assert.equal(error?.code, 'SCHEMA_DRIFT');
    assert.match(error.suggestion, /registrar/);
  });
});

describe('las granularidades del dialecto SQLite', () => {
  let pool;
  let engine;

  before(async () => {
    pool = baseDelCaso();
    ({ engine } = await armar(pool));
  });
  after(() => pool.cerrar());

  // Un solo empleado (100) y sus dos evaluaciones de 2025: 2025-03-31 y
  // 2025-06-30. Los primeros días esperados están escritos a mano, como
  // cualquier otro literal de la suite.
  const esperado = {
    day: ['2025-03-31', '2025-06-30'],
    week: ['2025-03-31', '2025-06-30'],
    month: ['2025-03-01', '2025-06-01'],
    quarter: ['2025-01-01', '2025-04-01'],
    year: ['2025-01-01', '2025-01-01'],
  };

  for (const [granularity, dias] of Object.entries(esperado)) {
    it(`agrupa por ${granularity} devolviendo texto ISO, como Postgres`, async () => {
      const { rows } = await engine.run(
        {
          measures: ['reviews.count'],
          timeDimensions: [
            { dimension: 'reviews.period', granularity, dateRange: ['2025-01-01', '2025-08-31'] },
          ],
          filters: [{ member: 'reviews.status', operator: 'in', values: ['completed'] }],
          order: { 'reviews.period': 'asc' },
        },
        { companyId: EMPRESA_A, consumer: 'api' },
      );

      // Las tres completadas de 2025 de la empresa A: 1000 y 1002 (2025-03-31)
      // y 1001 (2025-06-30). El 2025-03-31 es lunes, así que su semana empieza
      // ese mismo día; el 2025-06-30 también.
      assert.deepEqual(
        rows.map((fila) => fila['reviews.period']),
        [...new Set(dias)],
      );
    });
  }
});

// --- Hallazgo 2: `count_distinct` no necesitó nada del dialecto. `COUNT(DISTINCT
// col) FILTER (WHERE …)` es estándar y los dos motores lo entienden, así que la
// misma medida devuelve el mismo número contra las dos fuentes.
describe('count_distinct contra la segunda fuente', () => {
  let pool;
  let engine;

  before(async () => {
    pool = baseDelCaso();
    ({ engine } = await armar(pool));
  });

  after(() => pool.cerrar());

  it('cuenta los mismos empleados distintos que Postgres', async () => {
    const { rows } = await engine.run(
      {
        measures: ['reviews.completed_count', 'reviews.completed_employees'],
        timeDimensions: [
          {
            dimension: 'reviews.period',
            granularity: 'quarter',
            dateRange: ['2025-01-01', '2025-12-31'],
          },
        ],
        order: { 'reviews.period': 'asc' },
      },
      { companyId: EMPRESA_A, consumer: 'api' },
    );

    // Los mismos literales del seed: 1000 y 1002 en el primer trimestre (dos
    // empleados, 100 y 101) y 1001 en el segundo (el empleado 100). El tercer
    // trimestre existe como grupo porque la evaluación 1010 cae ahí; está
    // pendiente, así que las dos medidas valen 0.
    assert.deepEqual(rows, [
      {
        'reviews.period': '2025-01-01',
        'reviews.completed_count': 2,
        'reviews.completed_employees': 2,
      },
      {
        'reviews.period': '2025-04-01',
        'reviews.completed_count': 1,
        'reviews.completed_employees': 1,
      },
      {
        'reviews.period': '2025-07-01',
        'reviews.completed_count': 0,
        'reviews.completed_employees': 0,
      },
    ]);
  });
});

describe('identidad de la fuente SQLite', () => {
  it('una base en archivo se identifica por su archivo; una en memoria, por el nombre', async () => {
    const archivo = join(tmpdir(), `capa-identidad-${process.pid}.sqlite`);
    const enArchivo = crearPoolSqlite({ archivo });
    const enMemoria = crearPoolSqlite();
    try {
      const engine = createEngine({
        catalog: createCatalog({ fuentes: { archivo: { dialecto: sqlite }, memoria: { dialecto: sqlite } } }),
        fuentes: { archivo: { dialecto: sqlite, pool: enArchivo }, memoria: { dialecto: sqlite, pool: enMemoria } },
      });
      const [deArchivo, deMemoria] = await Promise.all([engine.identidadDeFuente('archivo'), engine.identidadDeFuente('memoria')]);
      assert.equal(deArchivo.origen, 'motor');
      assert.equal(deMemoria.origen, 'nombre');
      assert.notEqual(deArchivo.huella, deMemoria.huella);
    } finally {
      enArchivo.cerrar();
      enMemoria.cerrar();
    }
  });
});

// ADR 0010: la consulta sin medidas es del planificador, no del motor. El
// segundo dialecto la responde con las mismas filas, que es lo que prueba que
// el GROUP BY sin agregados no se apoyó en nada propio de Postgres.
describe('valores distintos de una dimensión contra SQLite', () => {
  let pool;

  before(() => {
    pool = baseDelCaso();
  });

  after(() => {
    pool.cerrar();
  });

  it('devuelve los mismos departamentos de la empresa A que Postgres', async () => {
    const { engine } = await armar(pool);

    const { rows } = await engine.run(
      { dimensions: ['departments.name'], order: { 'departments.name': 'asc' } },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    assert.deepEqual(rows, [{ 'departments.name': 'Ingeniería' }, { 'departments.name': 'Ventas' }]);
  });

  it('el SQL no lleva ninguna función de agregación y sí el GROUP BY', async () => {
    const { engine } = await armar(pool);

    const { sql } = engine.plan(
      { dimensions: ['departments.name'] },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    assert.match(sql, /GROUP BY departments\.name/);
    assert.ok(!/COUNT|AVG|SUM/.test(sql), 'sin medidas no hay nada que agregar');
  });
});

// ADR 0011: el rango sin granularidad no es sintaxis de un motor —no hay
// `dateTrunc` que emitir— así que tiene que dar lo mismo contra los dos. La
// asistencia no se puede usar acá (el fixture la tiene sin filas: SQLite no
// tiene `generate_series`), así que la prueba es la otra pregunta del
// enunciado, la del score promedio del último año.
describe('rango sin granularidad contra SQLite', () => {
  let pool;

  before(() => {
    pool = baseDelCaso();
  });

  after(() => {
    pool.cerrar();
  });

  const scorePromedioDe2025 = {
    measures: ['reviews.avg_score'],
    dimensions: ['departments.name'],
    segments: ['reviews.completed'],
    timeDimensions: [{ dimension: 'reviews.period', dateRange: ['2025-01-01', '2025-12-31'] }],
    order: { 'departments.name': 'asc' },
  };

  it('devuelve las mismas filas que Postgres, sin la fecha y sin agrupar por ella', async () => {
    const { engine } = await armar(pool);

    const { rows } = await engine.run(scorePromedioDe2025, {
      companyId: EMPRESA_A,
      consumer: 'dashboard',
    });

    // Los mismos literales del test contra Postgres: Ingeniería con sus tres
    // completadas de 2025 (4.20, 3.80 y 4.50) y Ventas sin ninguna.
    assert.deepEqual(rows, [
      { 'departments.name': 'Ingeniería', 'reviews.avg_score': 4.166666666666667 },
    ]);
  });

  it('el SQL no trunca ninguna fecha y agrupa sólo por el departamento', async () => {
    const { engine } = await armar(pool);

    const { sql } = engine.plan(scorePromedioDe2025, { companyId: EMPRESA_A, consumer: 'dashboard' });

    assert.match(sql, /GROUP BY departments\.name\n/);
    assert.ok(!/STRFTIME|PRINTF/.test(sql), 'sin granularidad no hay fecha que truncar');
    assert.match(sql, /AND period >= \$2\n {4}AND period <= \$3/);
  });
});

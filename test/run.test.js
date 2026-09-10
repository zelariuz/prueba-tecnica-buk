import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearTelemetria } from '../src/telemetry.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';
import { attendance } from '../src/definitions/attendance.js';
import { registrarModulos } from '../src/definitions/index.js';
import { consultasTipo } from '../src/definitions/consultas-tipo.js';

// La misma foto fija del esquema que usa el resto de los tests del catálogo.
const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/snapshot.json', import.meta.url), 'utf8'));

const { DATABASE_URL } = process.env;

// Los tests que necesitan base se saltan con aviso si no está configurada.
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

const conteoPorEstado = {
  measures: ['reviews.count'],
  dimensions: ['reviews.status'],
};

// Empresas del seed determinista de docker/init/02-seed.sql.
const EMPRESA_A = 1;
const EMPRESA_B = 2;

function porEstado(rows) {
  return Object.fromEntries(rows.map((row) => [row['reviews.status'], row['reviews.count']]));
}

describe('conteo de evaluaciones por estado', conBase, () => {
  let pool;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  it('devuelve los conteos del seed para la empresa A, con nombres semánticos', async () => {
    const { rows, meta } = await engine.run(conteoPorEstado, {
      companyId: EMPRESA_A,
      consumer: 'api',
    });

    assert.deepEqual(porEstado(rows), { completed: 5, pending: 4, calibrated: 2 });
    assert.equal(meta.servedFrom, 'live');
    assert.ok(!Number.isNaN(Date.parse(meta.asOf)), 'meta.asOf es un instante válido');
    assert.ok(meta.queryId.length > 0, 'meta.queryId identifica la forma de la consulta');
  });

  // 09-09: `departments` era la única entidad sin medida de conteo, y "cuántos
  // departamentos hay" no tenía traducción. Literales del seed: 2 y 2.
  it('departments.count cuenta los departamentos de la empresa del contexto', async () => {
    const consulta = { measures: ['departments.count'] };
    const a = await engine.run(consulta, { companyId: EMPRESA_A, consumer: 'api' });
    const b = await engine.run(consulta, { companyId: 2, consumer: 'api' });

    assert.deepEqual(a.rows, [{ 'departments.count': 2 }]);
    assert.deepEqual(b.rows, [{ 'departments.count': 2 }]);
  });

  it('la misma consulta para la empresa B devuelve los números de la empresa B', async () => {
    const { rows } = await engine.run(conteoPorEstado, {
      companyId: EMPRESA_B,
      consumer: 'api',
    });

    assert.deepEqual(porEstado(rows), { completed: 3, pending: 1, calibrated: 1 });
  });
});

// La consulta del caso, tal cual la escribiría un dashboard: nombres de
// negocio, sin tablas, sin joins y sin filtro de empresa.
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

// Dentro de un mismo trimestre la consulta no pide un orden entre
// departamentos: se compara el conjunto de filas, y el orden por trimestre se
// verifica aparte.
function conteoPorTrimestre(rows) {
  const total = {};
  for (const fila of rows) {
    total[fila['reviews.period']] = (total[fila['reviews.period']] ?? 0) + fila['reviews.count'];
  }
  return total;
}

function porDepartamentoYTrimestre(rows) {
  return [...rows].sort((a, b) =>
    `${a['reviews.period']}${a['departments.name']}`.localeCompare(
      `${b['reviews.period']}${b['departments.name']}`,
    ),
  );
}

describe('score promedio y evaluaciones completadas por departamento y trimestre', conBase, () => {
  let pool;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  it('devuelve para la empresa A los valores calculados a mano desde el seed', async () => {
    const { rows } = await engine.run(casoObligatorio, { companyId: EMPRESA_A, consumer: 'api' });

    const periodos = rows.map((fila) => fila['reviews.period']);
    assert.deepEqual(periodos, [...periodos].sort(), 'las filas vienen por trimestre ascendente');

    // Solo evaluaciones completadas, como el SQL de referencia del caso: Ventas
    // no tiene ninguna en 2025 (una calibrada y una pendiente) y no aparece.
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
      assert.equal(typeof fila['reviews.avg_score'], 'number', 'AVG llega como numeric');
      assert.equal(typeof fila['reviews.completed_count'], 'number', 'COUNT llega como int8');
    }
  });

  it('la evaluación cuya empresa no coincide con la de su empleado queda fuera del join', async () => {
    const porTrimestre = {
      measures: ['reviews.count'],
      timeDimensions: casoObligatorio.timeDimensions,
    };
    const ctx = { companyId: EMPRESA_A, consumer: 'api' };

    // Sin joins, la evaluación 1010 pertenece a la empresa A y se cuenta.
    const { rows: sinJoin } = await engine.run(porTrimestre, ctx);
    assert.deepEqual(conteoPorTrimestre(sinJoin), {
      '2025-01-01': 3,
      '2025-04-01': 3,
      '2025-07-01': 1,
    });

    // Al agrupar por departamento hay que pasar por empleados, y el empleado de
    // esa evaluación es de la empresa B: la fila desaparece (ADR 0003).
    const { rows: conJoin } = await engine.run(
      { ...porTrimestre, dimensions: ['departments.name'] },
      ctx,
    );
    assert.deepEqual(conteoPorTrimestre(conJoin), { '2025-01-01': 3, '2025-04-01': 3 });
  });
});

// Completitud de 2025 por departamento: la razón que el caso pide y la que
// muestra que se calcula sobre agregados y no fila por fila.
const completitudDe2025 = {
  measures: ['reviews.completion_rate'],
  dimensions: ['departments.name'],
  timeDimensions: [
    {
      dimension: 'reviews.period',
      granularity: 'year',
      dateRange: ['2025-01-01', '2025-12-31'],
    },
  ],
};

function porDepartamento(rows) {
  return Object.fromEntries(
    rows.map((fila) => [fila['departments.name'], fila['reviews.completion_rate']]),
  );
}

describe('completitud como medida derivada', conBase, () => {
  let pool;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  const ctx = { companyId: EMPRESA_A, consumer: 'api' };

  it('el departamento con tres completadas de cuatro llega con 75, no con 0', async () => {
    const { rows, meta } = await engine.run(completitudDe2025, ctx);

    // Literales del seed (docker/init/02-seed.sql): Ingeniería tiene en 2025
    // cuatro evaluaciones y tres completadas; Ventas, dos y ninguna. Con dos
    // COUNT enteros la división daría 0 y 0.
    assert.deepEqual(porDepartamento(rows), { Ingeniería: 75, Ventas: 0 });
    assert.deepEqual(meta.warnings, [], 'sin filtro global no hay nada que advertir');
  });

  it('un filtro global que anula el denominador deja la razón en 100 y lo advierte', async () => {
    const { rows, meta } = await engine.run(
      {
        ...completitudDe2025,
        filters: [{ member: 'reviews.status', operator: 'equals', values: ['completed'] }],
      },
      ctx,
    );

    // El filtro global es el mismo que distingue al numerador: numerador y
    // denominador cuentan las mismas filas. El número no está mal calculado,
    // está mal pedido, y el dashboard tiene que poder decirlo (historia 18).
    assert.deepEqual(porDepartamento(rows), { Ingeniería: 100 });
    assert.equal(meta.warnings.length, 1);
    assert.equal(meta.warnings[0].member, 'reviews.completion_rate');
    assert.match(meta.warnings[0].warning, /100/);
    assert.match(meta.warnings[0].warning, /reviews\.status/);
  });

  it('el mismo filtro puesto como segmento global advierte igual', async () => {
    const { meta } = await engine.run(
      { ...completitudDe2025, segments: ['reviews.completed'] },
      ctx,
    );

    // Para el planificador un segmento son los filtros que su dueño declaró:
    // nombrar la regla en vez de escribirla no cambia lo que hace.
    assert.equal(meta.warnings.length, 1);
    assert.equal(meta.warnings[0].member, 'reviews.completion_rate');
  });
});

// Doble delgado del pool: entrega clientes reales y solo reemplaza el texto de
// la consulta principal —la única que viaja con parámetros— por una que duerme.
// Es la forma de provocar un timeout real sin meter SQL en una definición ni
// cambiar el seed; todo lo demás (BEGIN, SET LOCAL, COMMIT, ROLLBACK) es el que
// emite el engine.
function poolQueDuerme(pool, segundos) {
  return {
    async connect() {
      const cliente = await pool.connect();
      return {
        query: (texto, params) =>
          params === undefined ? cliente.query(texto) : cliente.query(`SELECT pg_sleep(${segundos})`),
        release: (destruir) => cliente.release(destruir),
      };
    },
  };
}

async function errorAlEsperar(promesa) {
  try {
    await promesa;
  } catch (error) {
    return error;
  }
  assert.fail('se esperaba un error estructurado y la llamada no falló');
}

describe('guardarraíles del consumidor', conBase, () => {
  let pool;
  let catalog;
  let engine;

  before(() => {
    // Tamaño 1 a propósito: si una petición dejara la conexión sucia o sin
    // liberar, la siguiente lo nota de inmediato.
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  it('la consulta que excede el timeout corta y devuelve la conexión limpia al pool', async () => {
    const impaciente = createEngine({
      catalog,
      pool: poolQueDuerme(pool, 1),
      presupuestos: { api: { timeoutMs: 50, maxFilas: 10_000, rangoObligatorio: false } },
    });

    const error = await errorAlEsperar(
      impaciente.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'api' }),
    );
    assert.equal(error.code, 'QUERY_TIMEOUT');
    assert.ok(error.suggestion.length > 0, 'el error estructurado trae sugerencia');

    // Con el pool en tamaño 1, esto solo funciona si la conexión volvió con su
    // transacción cerrada y disponible.
    const { rows } = await engine.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'api' });
    assert.deepEqual(porEstado(rows), { completed: 5, pending: 4, calibrated: 2 });
  });

  // Desde el 09-09 ninguna clase de la tabla real exige rango (ADR 0009), así
  // que la clase con rango obligatorio entra por la costura `presupuestos`: el
  // mecanismo sigue siendo del engine, no de una clase en particular.
  it('el consumidor con rango obligatorio no ejecuta sin rango; otro con la misma consulta sí', async () => {
    const estricto = createEngine({
      catalog,
      pool,
      presupuestos: { estricta: { timeoutMs: 5_000, maxFilas: 1_000, rangoObligatorio: true } },
    });

    const error = await errorAlEsperar(
      estricto.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'estricta' }),
    );
    assert.equal(error.code, 'MISSING_TIME_RANGE');

    const { rows } = await engine.run(conteoPorEstado, {
      companyId: EMPRESA_A,
      consumer: 'dashboard',
    });
    assert.deepEqual(porEstado(rows), { completed: 5, pending: 4, calibrated: 2 });
  });

  // El caso que el rango obligatorio dejaba fuera: `employees` no tiene
  // dimensión temporal, así que con la regla vieja la clase `agent` no podía
  // preguntar cuántos empleados hay. Ahora ejecuta.
  it('la clase agent ejecuta una consulta sin dimensión temporal', async () => {
    const { rows } = await engine.run(
      { measures: ['employees.headcount'], dimensions: ['departments.name'] },
      { companyId: EMPRESA_A, consumer: 'agent' },
    );

    // Literales del seed: Ingeniería 2, Ventas 2.
    assert.deepEqual(
      Object.fromEntries(
        rows.map((fila) => [fila['departments.name'], fila['employees.headcount']]),
      ),
      { 'Ingeniería': 2, Ventas: 2 },
    );
  });

  it('cien consultas alternando empresas sobre una sola conexión no cruzan datos', async () => {
    // Los valores son los literales del seed, no recalculados desde los datos.
    const esperado = {
      [EMPRESA_A]: { completed: 5, pending: 4, calibrated: 2 },
      [EMPRESA_B]: { completed: 3, pending: 1, calibrated: 1 },
    };

    for (let vuelta = 0; vuelta < 100; vuelta += 1) {
      const companyId = vuelta % 2 === 0 ? EMPRESA_A : EMPRESA_B;
      const { rows } = await engine.run(conteoPorEstado, { companyId, consumer: 'api' });

      assert.deepEqual(porEstado(rows), esperado[companyId], `vuelta ${vuelta}`);
    }
  });

  it('el máximo de filas del consumidor recorta lo que llega desde la base', async () => {
    const acotado = createEngine({
      catalog,
      pool,
      presupuestos: { dashboard: { timeoutMs: 5_000, maxFilas: 2, rangoObligatorio: false } },
    });
    const ctx = { companyId: EMPRESA_A, consumer: 'dashboard' };

    // La consulta pide 100 filas; su clase de consumidor solo le permite 2.
    const { rows } = await acotado.run({ ...conteoPorEstado, limit: 100 }, ctx);
    assert.equal(rows.length, 2);

    // Con el presupuesto real de dashboard (5000 filas) vuelven los tres estados.
    const { rows: completas } = await engine.run(conteoPorEstado, ctx);
    assert.equal(completas.length, 3);
  });

  it('el timeout de una petición no contamina la siguiente que usa la misma conexión', async () => {
    const ctx = { companyId: EMPRESA_A, consumer: 'api' };

    // El test se provoca su propio timeout: sin esta primera petición cortada
    // no hay estado que pudiera quedar pegado a la conexión y el test pasaría
    // sin comprobar nada, dependiendo del orden de la suite.
    const impaciente = createEngine({
      catalog,
      pool: poolQueDuerme(pool, 1),
      presupuestos: { api: { timeoutMs: 50, maxFilas: 10_000, rangoObligatorio: false } },
    });
    const error = await errorAlEsperar(impaciente.run(conteoPorEstado, ctx));
    assert.equal(error.code, 'QUERY_TIMEOUT');

    // Con el pool en tamaño 1, la siguiente petición reusa esa misma conexión.
    // Un segundo durmiendo sobre el presupuesto real de `api` (15 s) pasa; si
    // el SET LOCAL de la petición anterior hubiera quedado pegado a la
    // conexión, esta consulta moriría a los 50 ms.
    const dormilon = createEngine({ catalog, pool: poolQueDuerme(pool, 1) });
    await dormilon.run(conteoPorEstado, ctx);
  });
});

describe('consultas tipo como regresión', conBase, () => {
  let pool;
  let catalog;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    catalog = createCatalog();
    // La composición real: todos los módulos y todas sus consultas tipo. Así
    // agregar un módulo no deja este test de regresión desactualizado.
    registrarModulos(catalog);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  it('cada consulta tipo registrada se ejecuta y devuelve filas', async () => {
    const params = { dateRange: ['2025-01-01', '2025-12-31'] };

    for (const { name } of consultasTipo) {
      const { rows, meta } = await engine.run(catalog.query(name, params), {
        companyId: EMPRESA_A,
        consumer: 'api',
      });

      assert.ok(rows.length > 0, `${name} devuelve filas`);
      assert.equal(meta.servedFrom, 'live', name);
    }
  });

  it('la consulta tipo de conteo por estado devuelve los números del seed', async () => {
    // Valores literales del seed: la consulta tipo es también el test de
    // regresión de la plantilla que usan los dashboards.
    const { rows } = await engine.run(catalog.query('conteo-de-evaluaciones-por-estado'), {
      companyId: EMPRESA_A,
      consumer: 'api',
    });

    assert.deepEqual(porEstado(rows), { completed: 5, pending: 4, calibrated: 2 });
  });
});

// `queryId` identifica la consulta: es lo que un dashboard reporta cuando algo
// se ve raro y lo que la caché usará de llave (historia 17). Por eso depende de
// tres cosas y de ninguna más: la forma de la consulta con sus parámetros, la
// empresa y la versión del catálogo.
describe('identidad de la consulta (queryId)', conBase, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  function engineCon(snapshot) {
    const catalog = createCatalog();
    for (const def of [reviews, employees, departments]) catalog.register(def, snapshot);
    return createEngine({ catalog, pool });
  }

  it('es el mismo para la misma forma y empresa, y distinto para otra empresa', async () => {
    const engine = engineCon();
    const comoLoEscribeUnDashboard = { measures: ['reviews.count'], dimensions: ['reviews.status'] };
    // La misma consulta con las claves en otro orden: misma forma, mismo id.
    const comoLoEscribeOtro = { dimensions: ['reviews.status'], measures: ['reviews.count'] };

    const primera = await engine.run(comoLoEscribeUnDashboard, { companyId: EMPRESA_A, consumer: 'api' });
    const segunda = await engine.run(comoLoEscribeOtro, { companyId: EMPRESA_A, consumer: 'api' });
    const otraEmpresa = await engine.run(comoLoEscribeUnDashboard, { companyId: EMPRESA_B, consumer: 'api' });

    assert.equal(primera.meta.queryId, segunda.meta.queryId);
    assert.notEqual(primera.meta.queryId, otraEmpresa.meta.queryId);
  });

  it('cambia si cambia la versión del catálogo: el mismo JSON sobre otro contrato no es la misma consulta', async () => {
    const consulta = { measures: ['reviews.count'], dimensions: ['reviews.status'] };
    const ctx = { companyId: EMPRESA_A, consumer: 'api' };

    // Las mismas definiciones sobre otro esquema físico son otro contrato de
    // datos, y la versión del catálogo lo refleja.
    const sinEsquema = await engineCon().run(consulta, ctx);
    const conEsquema = await engineCon(SNAPSHOT).run(consulta, ctx);

    assert.notEqual(sinEsquema.meta.queryId, conEsquema.meta.queryId);
  });
});

// Segundo módulo (historia 9): asistencia se registra como una definición más y
// responde su pregunta del caso sin que el engine ni el planificador cambien.
describe('módulo de asistencia', conBase, () => {
  let pool;
  let engine;
  let catalog;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    catalog = createCatalog();
    for (const def of [reviews, employees, departments, attendance]) catalog.register(def);
    for (const consulta of consultasTipo) catalog.registerQuery(consulta);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  // Agosto de 2025 en el seed: Ingeniería 16 presentes de 20 días, Ventas 5 de 10.
  const AGOSTO = ['2025-08-01', '2025-08-31'];

  it('la tasa de asistencia por departamento devuelve los valores del seed', async () => {
    const { rows } = await engine.run(
      {
        measures: ['attendance.attendance_rate', 'attendance.count'],
        dimensions: ['departments.name'],
        timeDimensions: [
          { dimension: 'attendance.date', granularity: 'month', dateRange: AGOSTO },
        ],
        order: { 'departments.name': 'asc' },
      },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    assert.deepEqual(rows, [
      {
        'departments.name': 'Ingeniería',
        'attendance.date': '2025-08-01',
        'attendance.attendance_rate': 80,
        'attendance.count': 20,
      },
      {
        'departments.name': 'Ventas',
        'attendance.date': '2025-08-01',
        'attendance.attendance_rate': 50,
        'attendance.count': 10,
      },
    ]);
  });

  it('la consulta tipo de asistencia responde por su nombre y aísla a la otra empresa', async () => {
    const consulta = catalog.query('asistencia-por-departamento', { dateRange: AGOSTO });

    const empresaA = await engine.run(consulta, { companyId: EMPRESA_A, consumer: 'dashboard' });
    const empresaB = await engine.run(consulta, { companyId: EMPRESA_B, consumer: 'dashboard' });

    assert.deepEqual(
      empresaA.rows.map((fila) => [fila['departments.name'], fila['attendance.attendance_rate']]),
      [['Ingeniería', 80], ['Ventas', 50]],
    );
    // La empresa 2 tiene su propio bloque de agosto: 3 presentes de 4 días.
    assert.deepEqual(
      empresaB.rows.map((fila) => [fila['departments.name'], fila['attendance.attendance_rate']]),
      [['Ingeniería', 75]],
    );
  });
});

// Doble delgado del pool, el mismo patrón del timeout: clientes reales y sólo
// el texto de la consulta principal —la única que viaja con parámetros—
// reemplazado. Aquí por una que nombra algo que la base no tiene, que es lo que
// pasa cuando el esquema cambia debajo de un catálogo ya registrado.
function poolQueNombraLoQueNoExiste(pool, consulta) {
  return {
    async connect() {
      const cliente = await pool.connect();
      return {
        query: (texto, params) => (params === undefined ? cliente.query(texto) : cliente.query(consulta)),
        release: (destruir) => cliente.release(destruir),
      };
    },
  };
}

describe('el esquema que cambió debajo del catálogo', conBase, () => {
  let pool;
  let catalog;
  let engine;

  before(() => {
    // Tamaño 1 a propósito: si una petición dejara la conexión sucia o sin
    // liberar, la siguiente lo nota de inmediato.
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  it('una columna que la base ya no tiene vuelve como SCHEMA_DRIFT', async () => {
    const desfasado = createEngine({
      catalog,
      pool: poolQueNombraLoQueNoExiste(pool, 'SELECT columna_fantasma FROM performance_reviews'),
    });

    const error = await errorAlEsperar(
      desfasado.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'api' }),
    );

    // El código nativo del motor lo traduce el dialecto: el engine no conoce
    // ningún código de Postgres.
    assert.equal(error.code, 'SCHEMA_DRIFT');
    assert.match(error.suggestion, /esquema/);
    assert.match(error.suggestion, /registrar/);
  });

  it('una tabla que la base ya no tiene vuelve como SCHEMA_DRIFT', async () => {
    const desfasado = createEngine({
      catalog,
      pool: poolQueNombraLoQueNoExiste(pool, 'SELECT 1 FROM tabla_fantasma'),
    });

    const error = await errorAlEsperar(
      desfasado.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'api' }),
    );

    assert.equal(error.code, 'SCHEMA_DRIFT');
  });

  it('tras el SCHEMA_DRIFT la conexión vuelve limpia al pool', async () => {
    const desfasado = createEngine({
      catalog,
      pool: poolQueNombraLoQueNoExiste(pool, 'SELECT columna_fantasma FROM performance_reviews'),
    });
    const error = await errorAlEsperar(
      desfasado.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'api' }),
    );
    assert.equal(error.code, 'SCHEMA_DRIFT');

    // Con el pool en tamaño 1, esto sólo funciona si la conexión volvió con su
    // transacción cerrada y disponible: un error del motor aborta la
    // transacción, y sin el ROLLBACK la siguiente consulta moriría con
    // "current transaction is aborted".
    const { rows } = await engine.run(conteoPorEstado, { companyId: EMPRESA_A, consumer: 'api' });
    assert.deepEqual(porEstado(rows), { completed: 5, pending: 4, calibrated: 2 });
  });
});

// Doble del pool que ni siquiera llega a entregar un cliente: es lo que pasa
// cuando la base no está. No necesita Postgres, así que corre siempre.
function poolQueNoConecta(error) {
  return {
    async connect() {
      throw error;
    },
  };
}

function errorDeRed(code, message = 'connect ECONNREFUSED 127.0.0.1:5433') {
  const error = new Error(message);
  error.code = code;
  return error;
}

describe('el origen que se murió', () => {
  function engineCon(pool, telemetria) {
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    return createEngine({ catalog, pool, telemetria });
  }

  const ctx = { companyId: EMPRESA_A, consumer: 'api' };

  it('una conexión rechazada vuelve como SOURCE_UNAVAILABLE y no como error crudo', async () => {
    const engine = engineCon(poolQueNoConecta(errorDeRed('ECONNREFUSED')));

    const error = await errorAlEsperar(engine.run(conteoPorEstado, ctx));

    assert.equal(error.code, 'SOURCE_UNAVAILABLE');
    assert.match(error.suggestion, /más tarde/);
  });

  it('los demás errores de conexión del motor traducen igual', async () => {
    for (const code of ['ETIMEDOUT', 'ENOTFOUND', '08006', '08001', '57P01']) {
      const engine = engineCon(poolQueNoConecta(errorDeRed(code)));
      const error = await errorAlEsperar(engine.run(conteoPorEstado, ctx));
      assert.equal(error.code, 'SOURCE_UNAVAILABLE', `código nativo ${code}`);
    }
  });

  it('el timeout de conexión de node-postgres también es la fuente que no está', async () => {
    // node-postgres no le pone `code` a este error: lo distingue el mensaje, y
    // conocerlo es trabajo del dialecto y de nadie más.
    const engine = engineCon(poolQueNoConecta(new Error('timeout exceeded when trying to connect')));

    const error = await errorAlEsperar(engine.run(conteoPorEstado, ctx));

    assert.equal(error.code, 'SOURCE_UNAVAILABLE');
  });

  it('la telemetría lo cuenta por su código', async () => {
    const telemetria = crearTelemetria();
    const engine = engineCon(poolQueNoConecta(errorDeRed('ECONNREFUSED')), telemetria);

    await errorAlEsperar(engine.run(conteoPorEstado, ctx));

    const contadores = telemetria.snapshot();
    assert.equal(contadores.byResult.error, 1);
    assert.equal(contadores.byErrorCode.SOURCE_UNAVAILABLE, 1);
    assert.equal(contadores.byGate.ejecutar, 1);
  });
});

// --- Hallazgo 2 del abogado del diablo. La pregunta 2 del enunciado es
// "cuántos EMPLEADOS completaron su evaluación", no cuántas evaluaciones se
// completaron: el empleado 100 tiene dos completadas en 2025 (1000 y 1001), así
// que `completed_count` y `completed_employees` tienen que dar distinto.
describe('medidas sum y count_distinct', conBase, () => {
  let pool;
  let catalog;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    catalog = createCatalog();
    registrarModulos(catalog);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  const DE_2025 = ['2025-01-01', '2025-12-31'];

  it('cuenta empleados distintos y evaluaciones por separado en el año', async () => {
    const { rows } = await engine.run(
      {
        measures: ['reviews.completed_count', 'reviews.completed_employees'],
        timeDimensions: [
          { dimension: 'reviews.period', granularity: 'year', dateRange: DE_2025 },
        ],
      },
      { companyId: EMPRESA_A, consumer: 'api' },
    );

    // Literales del seed: en 2025 la empresa 1 tiene tres evaluaciones
    // completadas (1000 y 1001 del empleado 100, 1002 del 101) y por lo tanto
    // dos empleados distintos que completaron.
    assert.deepEqual(rows, [
      {
        'reviews.period': '2025-01-01',
        'reviews.completed_count': 3,
        'reviews.completed_employees': 2,
      },
    ]);
  });

  it('la consulta tipo de empleados que completaron da los literales por trimestre', async () => {
    const { rows } = await engine.run(
      catalog.query('empleados-que-completaron-por-trimestre', { dateRange: DE_2025 }),
      { companyId: EMPRESA_A, consumer: 'api' },
    );

    // 2025-01-01: 1000 (empleado 100) y 1002 (empleado 101) → 2.
    // 2025-04-01: 1001 (empleado 100) → 1.
    // 2025-07-01: la evaluación 1010 cae en ese trimestre y está pendiente, así
    // que el grupo existe con 0 empleados que completaron. La medida trae su
    // propio filtro y no recorta la consulta: eso es exactamente lo que la
    // distingue de poner `completed` como segmento global.
    assert.deepEqual(rows, [
      { 'reviews.period': '2025-01-01', 'reviews.completed_employees': 2 },
      { 'reviews.period': '2025-04-01', 'reviews.completed_employees': 1 },
      { 'reviews.period': '2025-07-01', 'reviews.completed_employees': 0 },
    ]);
  });

  it('una medida sum devuelve la suma de la columna como número', async () => {
    // Definición de prueba: la suma de los scores de las evaluaciones
    // completadas. Ninguna pregunta del caso la pide; existe para que el tipo
    // `sum` que el catálogo acepta tenga una ejecución que lo respalde.
    const conSuma = createCatalog();
    conSuma.register({
      ...reviews,
      measures: {
        ...reviews.measures,
        score_total: {
          type: 'sum',
          column: 'score',
          segment: 'completed',
          description: 'Suma de los scores de las evaluaciones completadas.',
        },
      },
    });

    const { rows } = await createEngine({ catalog: conSuma, pool }).run(
      {
        measures: ['reviews.score_total'],
        timeDimensions: [
          { dimension: 'reviews.period', granularity: 'year', dateRange: DE_2025 },
        ],
      },
      { companyId: EMPRESA_A, consumer: 'api' },
    );

    // Literales del seed: 4.20 (1000) + 3.80 (1001) + 4.50 (1002) = 12.50.
    assert.deepEqual(rows, [{ 'reviews.period': '2025-01-01', 'reviews.score_total': 12.5 }]);
  });
});

// --- Hallazgo 7 del abogado del diablo: "empleado activo" es un ejemplo
// literal del enunciado y no estaba definido en ninguna parte. La consulta tipo
// de headcount contaba también al inactivo 103, y cada consumidor tenía que
// acordarse de escribir el filtro. Es exactamente lo que un segmento existe
// para evitar (ADR 0005).
describe('empleado activo', conBase, () => {
  let pool;
  let catalog;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    catalog = createCatalog();
    registrarModulos(catalog);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  it('la consulta tipo de headcount trae el total y los activos por departamento', async () => {
    const { rows } = await engine.run(catalog.query('headcount-por-departamento'), {
      companyId: EMPRESA_A,
      consumer: 'api',
    });

    // Literales del seed: Ingeniería tiene a 100 y 101, los dos activos;
    // Ventas tiene a 102 (activo) y 103 (inactivo).
    assert.deepEqual(
      [...rows].sort((a, b) => a['departments.name'].localeCompare(b['departments.name'])),
      [
        {
          'departments.name': 'Ingeniería',
          'employees.headcount': 2,
          'employees.active_headcount': 2,
        },
        {
          'departments.name': 'Ventas',
          'employees.headcount': 2,
          'employees.active_headcount': 1,
        },
      ],
    );
  });

  // La consulta tipo no lleva rango y `employees` no tiene dimensión temporal:
  // hasta el 09-09 la clase `agent` chocaba con MISSING_TIME_RANGE y la demo
  // tenía que anotar la pregunta como "solo con token de otra clase" (ADR 0009).
  it('la consulta tipo de headcount también la ejecuta la clase agent', async () => {
    const { rows } = await engine.run(catalog.query('headcount-por-departamento'), {
      companyId: EMPRESA_A,
      consumer: 'agent',
    });

    // Los mismos literales del seed, ahora por el camino del agente.
    assert.deepEqual(
      [...rows].sort((a, b) => a['departments.name'].localeCompare(b['departments.name'])),
      [
        {
          'departments.name': 'Ingeniería',
          'employees.headcount': 2,
          'employees.active_headcount': 2,
        },
        {
          'departments.name': 'Ventas',
          'employees.headcount': 2,
          'employees.active_headcount': 1,
        },
      ],
    );
  });
});

// --- ADR 0010: consultas sin medidas. Una consulta que sólo pide dimensiones
// es un GROUP BY sin agregados: los valores distintos de esas dimensiones,
// aislados por empresa y con el LIMIT de la clase como cualquier otra.
describe('valores distintos de una dimensión (consulta sin medidas)', conBase, () => {
  let pool;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  const nombres = (rows) => rows.map((fila) => fila['departments.name']);

  const departamentos = {
    dimensions: ['departments.name'],
    order: { 'departments.name': 'asc' },
  };

  it('devuelve los departamentos del seed de la empresa A, sin ninguna medida', async () => {
    const { rows, meta } = await engine.run(departamentos, {
      companyId: EMPRESA_A,
      consumer: 'dashboard',
    });

    // Literales del seed: la empresa 1 tiene dos departamentos.
    assert.deepEqual(nombres(rows), ['Ingeniería', 'Ventas']);
    assert.deepEqual(Object.keys(rows[0]), ['departments.name'], 'la fila no trae más columnas');
    assert.equal(meta.servedFrom, 'live');
  });

  it('el limit de la consulta recorta los valores como en cualquier otra', async () => {
    const { rows } = await engine.run(
      { ...departamentos, limit: 1 },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    assert.deepEqual(nombres(rows), ['Ingeniería']);
  });

  it('los estados de evaluación del seed salen sin pedir reviews.count', async () => {
    const { rows } = await engine.run(
      { dimensions: ['reviews.status'], order: { 'reviews.status': 'asc' } },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    // Los tres estados del caso, en orden alfabético.
    assert.deepEqual(
      rows.map((fila) => fila['reviews.status']),
      ['calibrated', 'completed', 'pending'],
    );
  });

  it('dos dimensiones de entidades distintas se cruzan por el camino de joins', async () => {
    const { rows } = await engine.run(
      {
        dimensions: ['employees.active', 'departments.name'],
        order: { 'departments.name': 'asc', 'employees.active': 'desc' },
      },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    // Calculado a mano sobre el seed de la empresa 1: los empleados 100 y 101
    // son de Ingeniería y están activos; el 102 es de Ventas y está activo; el
    // 103 es de Ventas y está inactivo. Tres combinaciones distintas.
    assert.deepEqual(
      rows.map((fila) => [fila['departments.name'], fila['employees.active']]),
      [
        ['Ingeniería', true],
        ['Ventas', true],
        ['Ventas', false],
      ],
    );
  });

  it('una dimensión temporal sola devuelve los períodos con datos, agrupados por su granularidad', async () => {
    const { rows } = await engine.run(
      {
        timeDimensions: [
          {
            dimension: 'reviews.period',
            granularity: 'year',
            dateRange: ['2024-01-01', '2025-12-31'],
          },
        ],
        order: { 'reviews.period': 'asc' },
      },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    // El seed de la empresa 1 tiene evaluaciones en 2024 y en 2025.
    assert.deepEqual(
      rows.map((fila) => fila['reviews.period']),
      ['2024-01-01', '2025-01-01'],
    );
  });

  it('sin medidas ni dimensiones la consulta se rechaza con INVALID_QUERY', async () => {
    await assert.rejects(
      () => engine.run({}, { companyId: EMPRESA_A, consumer: 'dashboard' }),
      (error) => {
        assert.equal(error.code, 'INVALID_QUERY');
        assert.equal(error.member, 'measures');
        assert.match(error.suggestion, /al menos una medida o una dimensión/);
        return true;
      },
    );
  });

  it('la empresa B no ve nada de la empresa A: el filtro de empresa está en la CTE', async () => {
    // Las dos empresas tienen departamentos que se llaman igual, así que la
    // prueba del aislamiento no puede ser el nombre: es el parámetro de empresa
    // dentro de la CTE, y el cruce con empleados, que sí da distinto.
    const { sql, params } = engine.plan(departamentos, {
      companyId: EMPRESA_B,
      consumer: 'dashboard',
    });
    assert.match(sql, /WHERE company_id = \$1/);
    assert.equal(params[0], EMPRESA_B);

    const conEmpleados = {
      dimensions: ['employees.active', 'departments.name'],
      order: { 'departments.name': 'asc' },
    };
    const { rows } = await engine.run(conEmpleados, { companyId: EMPRESA_B, consumer: 'dashboard' });

    // El seed de la empresa 2: el empleado 200 en Ingeniería y el 201 en
    // Ventas, los dos activos. Ninguno inactivo, al revés que la empresa 1.
    assert.deepEqual(
      rows.map((fila) => [fila['departments.name'], fila['employees.active']]),
      [
        ['Ingeniería', true],
        ['Ventas', true],
      ],
    );
  });
});

// --- ADR 0011: una dimensión temporal con `dateRange` y sin `granularity`
// filtra por fecha y no agrupa. Es la forma de las dos preguntas literales del
// enunciado que piden un período pero no un corte por tiempo: "el score
// promedio por departamento durante el último año" y "la tasa de asistencia por
// departamento durante los últimos tres meses" son una fila por departamento.
describe('rango sin granularidad', conBase, () => {
  let pool;
  let engine;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    registrarModulos(catalog);
    engine = createEngine({ catalog, pool });
  });

  after(async () => {
    await pool.end();
  });

  // Literales del seed, asistencia de la empresa 1 entre junio y agosto de 2025
  // (el bloque de junio y julio más el de agosto, contados a mano):
  //   Ingeniería (empleado 100): 29/30 + 30/31 + 16/20 = 75 presentes de 81 días
  //   Ventas     (empleado 102): 29/30 + 31/31 +  5/10 = 65 presentes de 71 días
  // La división la hace Postgres en `numeric` y el engine la convierte a número.
  const TRES_MESES = ['2025-06-01', '2025-08-31'];

  it('la tasa de asistencia por departamento sale sin la fecha en las filas', async () => {
    const { rows } = await engine.run(
      {
        measures: ['attendance.attendance_rate'],
        dimensions: ['departments.name'],
        timeDimensions: [{ dimension: 'attendance.date', dateRange: TRES_MESES }],
        order: { 'departments.name': 'asc' },
      },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    assert.deepEqual(rows, [
      { 'departments.name': 'Ingeniería', 'attendance.attendance_rate': 92.5925925925926 },
      { 'departments.name': 'Ventas', 'attendance.attendance_rate': 91.54929577464789 },
    ]);
  });

  it('el score promedio del último año es un número por departamento', async () => {
    const { rows } = await engine.run(
      {
        measures: ['reviews.avg_score'],
        dimensions: ['departments.name'],
        segments: ['reviews.completed'],
        timeDimensions: [
          { dimension: 'reviews.period', dateRange: ['2025-01-01', '2025-12-31'] },
        ],
        order: { 'departments.name': 'asc' },
      },
      { companyId: EMPRESA_A, consumer: 'dashboard' },
    );

    // Literales del seed: en 2025 Ingeniería tiene tres completadas (4.20, 3.80
    // y 4.50) y Ventas ninguna, así que Ventas no trae fila.
    assert.deepEqual(rows, [
      { 'departments.name': 'Ingeniería', 'reviews.avg_score': 4.166666666666667 },
    ]);
  });
});

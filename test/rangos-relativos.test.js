// Rangos relativos (ADR 0014): el `dateRange` de una dimensión temporal acepta,
// además del par de fechas absolutas, una frase de un vocabulario CERRADO
// —`last 6 months`, `this quarter`— que la capa resuelve a ese mismo par antes
// de planificar.
//
// Se prueba por los seams de siempre: `engine.plan` para ver a qué fechas
// resolvió cada frase (salen como parámetros del SQL y en el plan lógico) y
// `engine.run` para lo único que necesita la base: que dos "hoy" distintos den
// identidades distintas y no compartan caché.
//
// El reloj entra por la costura que ya existía para el TTL de la caché
// (`createEngine({ reloj })`): sin un "hoy" fijo, estos tests dirían cosas
// distintas cada día.
import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';
import { attendance } from '../src/definitions/attendance.js';

const EMPRESA = 424242;
const CTX = { companyId: EMPRESA, consumer: 'api' };

// Un "hoy" elegido a propósito para que los bordes duelan: 2020-09-11 es
// viernes, está a mitad de mes, a mitad del tercer trimestre y a mitad de año.
// Y está lejos del día real: si el reloj inyectado dejara de usarse, estos
// valores no coincidirían por casualidad con los de hoy.
const VIERNES = Date.parse('2020-09-11T12:00:00Z');

function engineDePrueba({ reloj = () => VIERNES, ...resto } = {}) {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments, attendance]) catalog.register(definicion);
  return createEngine({ catalog, reloj, ...resto });
}

// Los dos extremos del rango, leídos de los parámetros del SQL. La consulta
// pide una sola dimensión temporal, así que el rango son los dos parámetros que
// siguen a la empresa; el último es siempre el LIMIT.
function rangoDe(dateRange, opciones = {}) {
  const { params } = engineDePrueba(opciones.engine).plan(
    {
      measures: ['attendance.count'],
      timeDimensions: [{ dimension: 'attendance.date', dateRange }],
      ...opciones.query,
    },
    opciones.ctx ?? CTX,
  );
  return params.slice(1, 3);
}

function errorDe(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('se esperaba un error estructurado y la llamada no falló');
}

// --- El vocabulario, forma por forma ---------------------------------------
// Los valores esperados están escritos a mano contra el calendario, no
// calculados con la misma aritmética que el código: un test que repite la
// cuenta que prueba no prueba nada.

test('las frases del día resuelven al día que les toca', () => {
  assert.deepEqual(rangoDe('today'), ['2020-09-11', '2020-09-11']);
  assert.deepEqual(rangoDe('yesterday'), ['2020-09-10', '2020-09-10']);
});

test('las frases `this …` van del comienzo del período en curso a hoy', () => {
  // La semana empieza el lunes, como el DATE_TRUNC('week') de Postgres: el
  // viernes 11 de septiembre de 2020 pertenece a la semana del lunes 7.
  assert.deepEqual(rangoDe('this week'), ['2020-09-07', '2020-09-11']);
  assert.deepEqual(rangoDe('this month'), ['2020-09-01', '2020-09-11']);
  assert.deepEqual(rangoDe('this quarter'), ['2020-07-01', '2020-09-11']);
  assert.deepEqual(rangoDe('this year'), ['2020-01-01', '2020-09-11']);
});

test('las frases `last …` son el período calendario anterior COMPLETO y nunca incluyen hoy', () => {
  assert.deepEqual(rangoDe('last week'), ['2020-08-31', '2020-09-06']);
  assert.deepEqual(rangoDe('last month'), ['2020-08-01', '2020-08-31']);
  assert.deepEqual(rangoDe('last quarter'), ['2020-04-01', '2020-06-30']);
  assert.deepEqual(rangoDe('last year'), ['2019-01-01', '2019-12-31']);
});

test('`last N …` son los N períodos anteriores completos, y con N=1 es la frase corta', () => {
  // La invariante que hace consistente al vocabulario: `last month` es
  // exactamente `last 1 months`, y `last 1 days` es `yesterday`. La unidad va
  // siempre en plural, incluso con N=1: una sola escritura por rango.
  assert.deepEqual(rangoDe('last 1 days'), rangoDe('yesterday'));
  assert.deepEqual(rangoDe('last 1 weeks'), rangoDe('last week'));
  assert.deepEqual(rangoDe('last 1 months'), rangoDe('last month'));
  assert.deepEqual(rangoDe('last 1 quarters'), rangoDe('last quarter'));
  assert.deepEqual(rangoDe('last 1 years'), rangoDe('last year'));

  // Siete días completos que terminan ayer: hoy, que va por la mitad, queda fuera.
  assert.deepEqual(rangoDe('last 7 days'), ['2020-09-04', '2020-09-10']);
  assert.deepEqual(rangoDe('last 2 weeks'), ['2020-08-24', '2020-09-06']);
  assert.deepEqual(rangoDe('last 6 months'), ['2020-03-01', '2020-08-31']);
  assert.deepEqual(rangoDe('last 3 quarters'), ['2019-10-01', '2020-06-30']);
  assert.deepEqual(rangoDe('last 2 years'), ['2018-01-01', '2019-12-31']);
});

// --- Los bordes -------------------------------------------------------------

test('los rangos relativos cruzan bien el borde de mes, de trimestre y de año', () => {
  // 1 de enero de 2027, un viernes: todo lo anterior está en otro año.
  const enAnioNuevo = { engine: { reloj: () => Date.parse('2027-01-01T00:30:00Z') } };
  const rango = (frase) => rangoDe(frase, enAnioNuevo);

  assert.deepEqual(rango('yesterday'), ['2026-12-31', '2026-12-31']);
  assert.deepEqual(rango('this month'), ['2027-01-01', '2027-01-01']);
  assert.deepEqual(rango('this quarter'), ['2027-01-01', '2027-01-01']);
  assert.deepEqual(rango('this year'), ['2027-01-01', '2027-01-01']);
  // La semana en curso arranca el lunes 28 de diciembre, del año anterior.
  assert.deepEqual(rango('this week'), ['2026-12-28', '2027-01-01']);
  assert.deepEqual(rango('last month'), ['2026-12-01', '2026-12-31']);
  assert.deepEqual(rango('last quarter'), ['2026-10-01', '2026-12-31']);
  assert.deepEqual(rango('last year'), ['2026-01-01', '2026-12-31']);
  assert.deepEqual(rango('last 3 days'), ['2026-12-29', '2026-12-31']);

  // El 1 de marzo de un año bisiesto: el mes anterior completo tiene 29 días, y
  // contar meses hacia atrás desde el día 1 no puede caerse en un mes corto.
  const enMarzo = { engine: { reloj: () => Date.parse('2028-03-01T09:00:00Z') } };
  assert.deepEqual(rangoDe('last month', enMarzo), ['2028-02-01', '2028-02-29']);
  assert.deepEqual(rangoDe('yesterday', enMarzo), ['2028-02-29', '2028-02-29']);
  assert.deepEqual(rangoDe('last 12 months', enMarzo), ['2027-03-01', '2028-02-29']);

  // El 31 de mayo, un día que no existe en el mes anterior: `last 3 months`
  // cuenta meses calendario completos, así que el día 31 no participa.
  const a31DeMayo = { engine: { reloj: () => Date.parse('2026-05-31T23:59:59Z') } };
  assert.deepEqual(rangoDe('last 3 months', a31DeMayo), ['2026-02-01', '2026-04-30']);
  assert.deepEqual(rangoDe('this month', a31DeMayo), ['2026-05-01', '2026-05-31']);
});

// --- Lo que no está en la lista --------------------------------------------

test('una frase fuera del vocabulario se rechaza con INVALID_QUERY y la lista de lo que sí acepta', () => {
  for (const frase of [
    'últimos seis meses',
    'last 6 month',
    'last 1 day',
    'Last 6 Months',
    'last 6 months ',
    'previous month',
    'last 0 days',
    'last -3 days',
    'last 2.5 months',
    'last 007 days',
    'yesterdayish',
    '',
  ]) {
    const error = errorDe(() => rangoDe(frase));
    assert.equal(error.code, 'INVALID_QUERY', frase);
    assert.equal(error.member, 'timeDimensions[0].dateRange', frase);
    // La sugerencia trae el vocabulario entero: quien se equivocó se corrige sin
    // ir a buscar la documentación, igual que con las granularidades.
    assert.match(error.suggestion, /today, yesterday/, frase);
    assert.match(error.suggestion, /this week, this month, this quarter, this year/, frase);
    assert.match(error.suggestion, /last N days/, frase);
  }
});

test('un par de fechas absolutas sigue pasando sin tocarse', () => {
  assert.deepEqual(rangoDe(['2025-06-01', '2025-08-31']), ['2025-06-01', '2025-08-31']);
});

// --- Zona horaria -----------------------------------------------------------

test('la misma frase con dos zonas distintas puede dar ventanas distintas', () => {
  // 2020-09-11T23:30Z: en UTC todavía es el 11; en Auckland (UTC+12) ya es el
  // 12, y en Santiago de Chile (UTC-4) todavía es el 11 por la tarde.
  const alFilo = { engine: { reloj: () => Date.parse('2020-09-11T23:30:00Z') } };
  const conZona = (timezone) => rangoDe('today', { ...alFilo, query: { timezone } });

  assert.deepEqual(conZona(undefined), ['2020-09-11', '2020-09-11'], 'por defecto UTC');
  assert.deepEqual(conZona('UTC'), ['2020-09-11', '2020-09-11']);
  assert.deepEqual(conZona('Pacific/Auckland'), ['2020-09-12', '2020-09-12']);
  assert.deepEqual(conZona('America/Santiago'), ['2020-09-11', '2020-09-11']);

  // Y con la frase del mes: en Auckland el 1 de octubre ya empezó el mes
  // siguiente mientras en UTC sigue siendo septiembre.
  const finDeMes = { engine: { reloj: () => Date.parse('2020-09-30T23:30:00Z') } };
  assert.deepEqual(rangoDe('this month', finDeMes), ['2020-09-01', '2020-09-30']);
  assert.deepEqual(rangoDe('this month', { ...finDeMes, query: { timezone: 'Pacific/Auckland' } }), [
    '2020-10-01',
    '2020-10-01',
  ]);
});

test('una zona horaria que el runtime no conoce se rechaza con INVALID_QUERY', () => {
  for (const timezone of ['Marte/Olympus', 'UTC+3', '', 7, null]) {
    const error = errorDe(() => rangoDe('today', { query: { timezone } }));
    assert.equal(error.code, 'INVALID_QUERY', JSON.stringify(timezone));
    assert.equal(error.member, 'timezone');
    assert.match(error.suggestion, /IANA/);
  }
});

test('la zona se valida aunque la consulta no traiga ninguna frase que resolver', () => {
  const error = errorDe(() => rangoDe(['2025-06-01', '2025-08-31'], { query: { timezone: 'Marte/Olympus' } }));
  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timezone');
});

// --- El plan lógico muestra lo resuelto ------------------------------------

test('el plan lógico del dry-run muestra el rango ya resuelto, la frase original y la zona', () => {
  const { plan } = engineDePrueba().plan(
    {
      measures: ['attendance.count'],
      timeDimensions: [{ dimension: 'attendance.date', granularity: 'month', dateRange: 'last 6 months' }],
      timezone: 'America/Santiago',
    },
    CTX,
  );

  assert.deepEqual(plan.timeDimensions, [
    {
      dimension: 'attendance.date',
      granularity: 'month',
      dateRange: ['2020-03-01', '2020-08-31'],
      dateRangeExpression: 'last 6 months',
    },
  ]);
  assert.equal(plan.timezone, 'America/Santiago');
});

test('sin frase el plan lógico muestra el rango tal cual y la zona por defecto', () => {
  const { plan } = engineDePrueba().plan(
    {
      measures: ['attendance.count'],
      timeDimensions: [{ dimension: 'attendance.date', dateRange: ['2025-06-01', '2025-08-31'] }],
    },
    CTX,
  );

  assert.deepEqual(plan.timeDimensions, [
    { dimension: 'attendance.date', dateRange: ['2025-06-01', '2025-08-31'] },
  ]);
  assert.equal(plan.timezone, 'UTC');
});

// --- Interacción con fillMissing -------------------------------------------

test('el chequeo de buckets de fillMissing cuenta sobre las fechas ya resueltas', () => {
  // El tope del agente son 1.000 filas: dos años de buckets diarios caben y
  // cinco no, así que el rechazo se prueba estirando el rango.
  const conRelleno = (dateRange) =>
    engineDePrueba().plan(
      {
        measures: ['attendance.count'],
        timeDimensions: [{ dimension: 'attendance.date', granularity: 'day', dateRange, fillMissing: true }],
      },
      { companyId: EMPRESA, consumer: 'agent' },
    );

  // 2018-01-01 a 2019-12-31: 730 buckets, caben en las 1.000 filas del agente.
  assert.ok(conRelleno('last 2 years').sql.includes('generate_series'));

  // 2015-01-01 a 2019-12-31: 1.826 buckets, no caben. El rechazo nombra el
  // número de buckets, que sólo se puede contar si la frase ya se resolvió.
  const error = errorDe(() => conRelleno('last 5 years'));
  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'attendance.date');
  assert.match(error.suggestion, /1826 buckets/);
});

// --- Lo que más importa: la identidad de la consulta ------------------------

const { DATABASE_URL } = process.env;
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

describe('la frase se resuelve antes de que exista la identidad de la consulta', { ...conBase, timeout: 15_000 }, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  // TTL inmenso a propósito: si la segunda ejecución no se sirve de la caché,
  // la única explicación posible es que la llave sea otra. Sin esto, una
  // entrada vencida por la distancia entre los dos "hoy" explicaría el fallo
  // igual de bien y el test no probaría nada.
  const SIN_VENCIMIENTO = {
    dashboard: { timeoutMs: 5_000, maxFilas: 5_000, rangoObligatorio: false, cacheTtlMs: Number.MAX_SAFE_INTEGER },
  };
  const TABLERO = { companyId: 1, consumer: 'dashboard' };
  const ULTIMA_SEMANA = {
    measures: ['attendance.count'],
    timeDimensions: [{ dimension: 'attendance.date', granularity: 'day', dateRange: 'last 7 days' }],
  };

  function engineConReloj(cache, cuando) {
    const catalog = createCatalog();
    for (const definicion of [attendance, employees, departments]) catalog.register(definicion);
    return createEngine({
      catalog,
      pool,
      cache,
      presupuestos: SIN_VENCIMIENTO,
      reloj: () => Date.parse(cuando),
    });
  }

  it('la misma frase con dos "hoy" distintos da queryId distintos y no comparte caché', async () => {
    const cache = crearMemoryStore();
    const enAgosto = engineConReloj(cache, '2025-08-15T10:00:00Z');
    const enSeptiembre = engineConReloj(cache, '2025-09-15T10:00:00Z');

    const primera = await enAgosto.run(ULTIMA_SEMANA, TABLERO);
    // Control: con el MISMO reloj la caché sí sirve. Si esto fuera `live`, el
    // test de abajo no diría nada sobre la identidad.
    const repetida = await enAgosto.run(ULTIMA_SEMANA, TABLERO);
    const otraVentana = await enSeptiembre.run(ULTIMA_SEMANA, TABLERO);

    assert.equal(primera.meta.servedFrom, 'live');
    assert.equal(repetida.meta.servedFrom, 'cache-l1');
    assert.equal(repetida.meta.queryId, primera.meta.queryId);

    assert.notEqual(
      otraVentana.meta.queryId,
      primera.meta.queryId,
      'la identidad nace del SQL y sus parámetros, y las fechas resueltas son parámetros',
    );
    assert.equal(
      otraVentana.meta.servedFrom,
      'live',
      'otra ventana es otra consulta: si compartiera entrada, el gráfico se quedaría congelado en agosto',
    );
  });

  it('la ventana que se ejecuta es la resuelta, no la frase', async () => {
    // Literal del seed: la empresa 1 registra asistencia del 1 al 10 de agosto
    // de 2025, así que una semana de agosto trae filas y la misma frase un mes
    // después no trae ninguna.
    const enAgosto = engineConReloj(undefined, '2025-08-08T10:00:00Z');
    const enSeptiembre = engineConReloj(undefined, '2025-10-08T10:00:00Z');

    const conDatos = await enAgosto.run(ULTIMA_SEMANA, TABLERO);
    const vacia = await enSeptiembre.run(ULTIMA_SEMANA, TABLERO);

    assert.ok(conDatos.rows.length > 0, 'la semana del 1 al 7 de agosto tiene registros en el seed');
    assert.equal(vacia.rows.length, 0, 'la primera semana de octubre no tiene ninguno');
  });
});

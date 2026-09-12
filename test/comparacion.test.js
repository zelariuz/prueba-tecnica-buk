// Comparación de períodos (ADR 0015): `compareDateRange` en una dimensión
// temporal pide la misma consulta sobre varios rangos —"este mes contra el mes
// pasado"— en una sola petición, y la respuesta trae un resultado por rango.
//
// Es la única consulta de la capa que cambia la FORMA de la respuesta, así que
// lo primero que se fija aquí es la otra mitad: una consulta sin
// `compareDateRange` devuelve exactamente lo de siempre.
//
// Se prueba por los seams de siempre: `engine.plan` para lo que se puede
// rechazar y describir sin base, y `engine.run` para lo que sólo se puede
// comprobar ejecutando —las filas de cada rango y, sobre todo, que dos rangos
// son dos entradas de caché—. El reloj entra por la costura que ya existía
// (`createEngine({ reloj })`): sin un "hoy" fijo, una frase relativa diría algo
// distinto cada día.
import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { attendance } from '../src/definitions/attendance.js';

const EMPRESA = 1;
const TABLERO = { companyId: EMPRESA, consumer: 'dashboard' };
const AGENTE = { companyId: EMPRESA, consumer: 'agent' };

// Un "hoy" a mitad de agosto de 2025: el seed registra asistencia en junio,
// julio y agosto de 2025, así que "este mes" y "el mes pasado" caen los dos
// sobre datos que se pueden contar a mano.
const MEDIADOS_DE_AGOSTO = Date.parse('2025-08-15T12:00:00Z');

function engineDePrueba({ reloj = () => MEDIADOS_DE_AGOSTO, ...resto } = {}) {
  const catalog = createCatalog();
  for (const definicion of [attendance, employees, departments]) catalog.register(definicion);
  return createEngine({ catalog, reloj, ...resto });
}

function errorDe(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('se esperaba un error estructurado y la llamada no falló');
}

// La consulta del caso de uso real, con los rangos que se le pidan.
function comparando(compareDateRange, extra = {}) {
  return {
    measures: ['attendance.count'],
    dimensions: ['departments.name'],
    timeDimensions: [{ dimension: 'attendance.date', granularity: 'month', compareDateRange }],
    ...extra,
  };
}

// --- Las validaciones -------------------------------------------------------

test('dateRange y compareDateRange en la misma dimensión temporal se rechazan', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        measures: ['attendance.count'],
        timeDimensions: [
          {
            dimension: 'attendance.date',
            granularity: 'month',
            dateRange: ['2025-08-01', '2025-08-31'],
            compareDateRange: ['this month', 'last month'],
          },
        ],
      },
      TABLERO,
    ),
  );

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timeDimensions[0].compareDateRange');
  assert.match(error.suggestion, /ambiguo/);
  // La puerta que cortó, como cualquier otro rechazo: es lo que separa en la
  // telemetría un rechazo de vocabulario de uno de presupuesto.
  assert.equal(error.gate, 'expandirComparacion');
});

test('una lista de rangos vacía se rechaza: no pide ninguna ventana', () => {
  const error = errorDe(() => engineDePrueba().plan(comparando([]), TABLERO));

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timeDimensions[0].compareDateRange');
  assert.match(error.suggestion, /al menos un rango/);
});

test('un solo rango se acepta: la forma de la respuesta la decide la propiedad, no cuántos rangos trae', () => {
  const { results } = engineDePrueba().plan(comparando(['last month']), TABLERO);

  assert.equal(results.length, 1);
  assert.deepEqual(results[0].dateRange, ['2025-07-01', '2025-07-31']);
});

test('más rangos que el tope se rechazan con la salida al lado', () => {
  const cinco = ['this month', 'last month', 'last 2 months', 'last 3 months', 'last 4 months'];
  const error = errorDe(() => engineDePrueba().plan(comparando(cinco), TABLERO));

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timeDimensions[0].compareDateRange');
  assert.match(error.suggestion, /hasta 4 rangos y pediste 5/);
  assert.match(error.suggestion, /granularity/, 'la sugerencia dice cómo pedir una serie en vez de una comparación');
  // Cuatro sí pasan: el tope es tope, no una aproximación.
  assert.equal(engineDePrueba().plan(comparando(cinco.slice(0, 4)), TABLERO).results.length, 4);
});

test('sólo una dimensión temporal por consulta puede comparar rangos', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        measures: ['attendance.count'],
        timeDimensions: [
          { dimension: 'attendance.date', granularity: 'month', compareDateRange: ['this month', 'last month'] },
          { dimension: 'attendance.date', granularity: 'day', compareDateRange: ['today', 'yesterday'] },
        ],
      },
      TABLERO,
    ),
  );

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timeDimensions[1].compareDateRange');
  assert.match(error.suggestion, /producto/);
});

test('compareDateRange que no es una lista se rechaza diciendo qué llegó', () => {
  const error = errorDe(() => engineDePrueba().plan(comparando('this month'), TABLERO));

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timeDimensions[0].compareDateRange');
  assert.match(error.suggestion, /recibí string/);
});

// --- Cada rango se valida como se valida hoy un dateRange -------------------

test('un rango inválido se rechaza señalando la posición que el consumidor escribió', () => {
  const error = errorDe(() => engineDePrueba().plan(comparando(['this month', 'previous month']), TABLERO));

  assert.equal(error.code, 'INVALID_QUERY');
  // No `timeDimensions[0].dateRange`: esa propiedad la escribió la capa al
  // expandir la comparación, no quien preguntó.
  assert.equal(error.member, 'timeDimensions[0].compareDateRange[1]');
  assert.match(error.suggestion, /last N months/, 'la sugerencia sigue siendo el vocabulario entero (ADR 0014)');
});

test('el chequeo de buckets de fillMissing del ADR 0013 se aplica a cada rango', () => {
  // El tope del agente son 1.000 filas. Dos años de buckets diarios caben; cinco
  // no. El rechazo del segundo rango tiene que llegar igual que si ese rango
  // fuera la consulta entera, contando sus propios buckets.
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        measures: ['attendance.count'],
        timeDimensions: [
          {
            dimension: 'attendance.date',
            granularity: 'day',
            fillMissing: true,
            compareDateRange: ['last 2 years', 'last 5 years'],
          },
        ],
      },
      AGENTE,
    ),
  );

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'attendance.date');
  assert.match(error.suggestion, /1827 buckets/, 'los buckets se cuentan por rango, no sobre la unión de todos');
});

// --- El plan: uno por rango, con el rango ya resuelto -----------------------

test('el dry-run de una comparación devuelve un plan por rango, en el orden pedido', () => {
  const { results } = engineDePrueba().plan(comparando(['last month', 'this month']), TABLERO);

  assert.equal(results.length, 2);
  // El orden es el de los rangos pedidos, siempre: aquí van al revés del caso
  // de uso a propósito.
  assert.deepEqual(
    results.map((resultado) => resultado.dateRangeExpression),
    ['last month', 'this month'],
  );
  assert.deepEqual(results[0].dateRange, ['2025-07-01', '2025-07-31']);
  // `this month` va del comienzo del mes en curso a hoy, no al fin de mes.
  assert.deepEqual(results[1].dateRange, ['2025-08-01', '2025-08-15']);

  for (const resultado of results) {
    assert.match(resultado.sql, /^WITH/, 'cada rango trae su propia sentencia');
    assert.equal(resultado.plan.entity, 'attendance');
    // El presupuesto NO se reparte entre los rangos: cada consulta recibe el de
    // su clase entero, y lo que acota la comparación es el tope de rangos.
    assert.equal(resultado.plan.budget.rowLimit, 5000);
    assert.equal(resultado.plan.budget.timeoutMs, 5000);
  }
});

test('el SQL de un rango es, byte por byte, el de la misma consulta con ese dateRange', () => {
  // La comparación no estrena un segundo motor ni una sintaxis propia: expande
  // a N consultas normales. Si esto dejara de cumplirse, lo primero que se
  // movería serían los SQL de referencia de `test/snapshots/`.
  const rango = ['2025-08-01', '2025-08-31'];
  const engine = engineDePrueba();

  const comparada = engine.plan(comparando([rango, ['2025-07-01', '2025-07-31']]), TABLERO).results[0];
  const sola = engine.plan(
    {
      measures: ['attendance.count'],
      dimensions: ['departments.name'],
      timeDimensions: [{ dimension: 'attendance.date', granularity: 'month', dateRange: rango }],
    },
    TABLERO,
  );

  assert.equal(comparada.sql, sola.sql);
  assert.deepEqual(comparada.params, sola.params);
});

test('toda la comparación se resuelve con un solo "hoy"', () => {
  // Un reloj que cruza la medianoche del último día de agosto entre una llamada
  // y la siguiente. Si cada rango leyera el reloj por su cuenta, `this month`
  // saldría agosto (resuelto el día 31) y `last month` TAMBIÉN agosto (resuelto
  // ya en septiembre): la comparación sería contra sí misma y nadie lo notaría.
  const tics = [Date.parse('2025-08-31T23:59:00Z'), Date.parse('2025-09-01T00:01:00Z')];
  const reloj = () => tics.shift() ?? Date.parse('2025-09-01T00:01:00Z');

  const { results } = engineDePrueba({ reloj }).plan(comparando(['this month', 'last month']), TABLERO);

  assert.deepEqual(results[0].dateRange, ['2025-08-01', '2025-08-31']);
  assert.deepEqual(results[1].dateRange, ['2025-07-01', '2025-07-31']);
});

// --- Lo que sólo se puede comprobar ejecutando ------------------------------

const { DATABASE_URL } = process.env;
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

describe('la comparación contra la base', { ...conBase, timeout: 20_000 }, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  function engineConBase(extra = {}) {
    return engineDePrueba({ pool, ...extra });
  }

  it('la respuesta trae un resultado por rango, rotulado y en el orden pedido', async () => {
    const respuesta = await engineConBase().run(comparando(['this month', 'last month']), TABLERO);

    // La forma nueva vive entera dentro de `results`: no hay `rows` ni `meta` de
    // primer nivel que obliguen a elegir cuál de los rangos es "el" resultado.
    assert.deepEqual(Object.keys(respuesta), ['results']);
    assert.equal(respuesta.results.length, 2);

    const [esteMes, mesPasado] = respuesta.results;
    assert.deepEqual(Object.keys(esteMes), ['dateRange', 'dateRangeExpression', 'rows', 'meta']);
    // Cada elemento dice a qué rango corresponde, ya resuelto, y con la frase al
    // lado: sin eso el consumidor no puede rotular su gráfico.
    assert.deepEqual(esteMes.dateRange, ['2025-08-01', '2025-08-15']);
    assert.equal(esteMes.dateRangeExpression, 'this month');
    assert.deepEqual(mesPasado.dateRange, ['2025-07-01', '2025-07-31']);
    assert.equal(mesPasado.dateRangeExpression, 'last month');

    // Literales del seed: en agosto el empleado 100 (Ingeniería) tiene los días
    // 1 al 20 y el 102 (Ventas) sólo del 1 al 10, así que hasta el 15 van 15 y
    // 10; julio está completo para los dos, 31 días cada uno.
    assert.deepEqual(esteMes.rows.map((fila) => fila['attendance.count']).sort(), [10, 15]);
    assert.deepEqual(mesPasado.rows.map((fila) => fila['attendance.count']), [31, 31]);

    // Cada rango trae su propio meta entero, con su propia identidad.
    for (const resultado of respuesta.results) {
      assert.deepEqual(Object.keys(resultado.meta), ['servedFrom', 'asOf', 'queryId', 'warnings']);
      assert.equal(resultado.meta.servedFrom, 'live');
    }
    assert.notEqual(
      esteMes.meta.queryId,
      mesPasado.meta.queryId,
      'dos ventanas distintas son dos consultas distintas',
    );
  });

  it('una consulta sin compareDateRange devuelve exactamente la respuesta de siempre', async () => {
    const respuesta = await engineConBase().run(
      {
        measures: ['attendance.count'],
        dimensions: ['departments.name'],
        timeDimensions: [{ dimension: 'attendance.date', granularity: 'month', dateRange: ['2025-08-01', '2025-08-31'] }],
      },
      TABLERO,
    );

    // Ni `results` ni un rótulo de rango: la forma nueva la estrena sólo quien
    // pide la comparación.
    assert.deepEqual(Object.keys(respuesta), ['rows', 'meta']);
    assert.deepEqual(Object.keys(respuesta.meta), ['servedFrom', 'asOf', 'queryId', 'warnings']);
    assert.equal(respuesta.rows.length, 2);
  });

  it('cada rango es su propia entrada de caché', async () => {
    const engine = engineConBase({ cache: crearMemoryStore() });
    const agosto = ['2025-08-01', '2025-08-20'];
    const julio = ['2025-07-01', '2025-07-10'];

    const primera = await engine.run(comparando([agosto, julio]), TABLERO);
    const repetida = await engine.run(comparando([agosto, julio]), TABLERO);
    // Se mueve UN solo rango: el otro tiene que seguir saliendo de la caché. Es
    // lo que `UNION ALL` no podría hacer, porque los dos rangos compartirían una
    // sola llave y la mitad estable se recalcularía en cada consulta.
    const soloUnoNuevo = await engine.run(comparando([['2025-06-01', '2025-06-10'], julio]), TABLERO);

    assert.deepEqual(
      primera.results.map((resultado) => resultado.meta.servedFrom),
      ['live', 'live'],
    );
    assert.deepEqual(
      repetida.results.map((resultado) => resultado.meta.servedFrom),
      ['cache-l1', 'cache-l1'],
    );
    assert.deepEqual(
      repetida.results.map((resultado) => resultado.meta.queryId),
      primera.results.map((resultado) => resultado.meta.queryId),
    );
    assert.deepEqual(
      soloUnoNuevo.results.map((resultado) => resultado.meta.servedFrom),
      ['live', 'cache-l1'],
    );
    assert.equal(
      soloUnoNuevo.results[1].meta.queryId,
      primera.results[1].meta.queryId,
      'el rango que no se movió es la misma consulta de antes',
    );
  });

  it('con fillMissing cada rango se rellena con su propia serie', async () => {
    const respuesta = await engineConBase().run(
      {
        measures: ['attendance.count'],
        dimensions: ['departments.name'],
        timeDimensions: [
          {
            dimension: 'attendance.date',
            granularity: 'day',
            fillMissing: true,
            compareDateRange: [
              ['2025-08-08', '2025-08-14'],
              ['2025-07-01', '2025-07-03'],
            ],
          },
        ],
      },
      TABLERO,
    );

    // Literales del seed: del 8 al 14 de agosto hay 10 filas con datos —Ventas
    // sólo registra hasta el 10—, y densas son 7 días × 2 departamentos = 14.
    // Del 1 al 3 de julio los dos departamentos registran todos los días: 3 × 2.
    assert.equal(respuesta.results[0].rows.length, 14);
    assert.equal(respuesta.results[1].rows.length, 6);
    // El relleno es por rango: los días vacíos de agosto salen en 0 y ninguno de
    // ellos aparece en la serie de julio.
    const vacios = respuesta.results[0].rows.filter((fila) => fila['attendance.count'] === 0);
    assert.equal(vacios.length, 4, 'los cuatro días sin registro de Ventas entre el 11 y el 14');
    assert.ok(
      respuesta.results[1].rows.every((fila) => fila['attendance.date'].startsWith('2025-07')),
      'la serie de un rango no se mete en la del otro',
    );
  });

  it('con total: true cada resultado trae el suyo', async () => {
    const respuesta = await engineConBase().run(
      {
        measures: ['attendance.count'],
        timeDimensions: [
          {
            dimension: 'attendance.date',
            granularity: 'day',
            compareDateRange: [
              ['2025-08-01', '2025-08-20'],
              ['2025-07-01', '2025-07-10'],
            ],
          },
        ],
        total: true,
        limit: 5,
      },
      TABLERO,
    );

    // El total cuenta las filas del resultado ignorando el límite (ADR 0013), y
    // cada rango cuenta las suyas: 20 días de agosto con registros contra 10 de
    // julio.
    assert.deepEqual(
      respuesta.results.map((resultado) => resultado.rows.length),
      [5, 5],
    );
    assert.deepEqual(
      respuesta.results.map((resultado) => resultado.meta.total),
      [20, 10],
    );
  });
});

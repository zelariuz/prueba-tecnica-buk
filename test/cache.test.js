// Caché L1 en memoria (historia 34). Se prueba por el seam `engine.run`: lo que
// importa no es cómo guarda el store, sino qué ve el consumidor —`servedFrom`,
// las mismas filas, el `asOf` de la ejecución original— y que la base deje de
// recibir consultas. El reloj del store es inyectable para poder probar la
// expiración sin esperarla.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { crearTelemetria } from '../src/telemetry.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';
import { attendance } from '../src/definitions/attendance.js';

const { DATABASE_URL } = process.env;
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

const CONTEO_POR_ESTADO = { measures: ['reviews.count'], dimensions: ['reviews.status'] };
const DASHBOARD_A = { companyId: 1, consumer: 'dashboard' };
const DASHBOARD_B = { companyId: 2, consumer: 'dashboard' };

// Literales del seed, no recalculados: la empresa 1 tiene 5 evaluaciones
// completadas, 4 pendientes y 2 calibradas.
const ESTADOS_EMPRESA_A = { completed: 5, pending: 4, calibrated: 2 };

function porEstado(rows) {
  return Object.fromEntries(rows.map((fila) => [fila['reviews.status'], fila['reviews.count']]));
}

describe('caché L1 en memoria', { ...conBase, timeout: 15_000 }, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  function armar({ cache, telemetria = crearTelemetria(), definiciones, reloj } = {}) {
    const catalog = createCatalog();
    for (const definicion of definiciones ?? [reviews, employees, departments]) {
      catalog.register(definicion);
    }
    return {
      catalog,
      engine: createEngine({ catalog, pool, cache, telemetria, reloj }),
      telemetria,
    };
  }

  it('la segunda ejecución de la misma consulta se sirve desde cache-l1 con las mismas filas', async () => {
    const { engine } = armar({ cache: crearMemoryStore() });

    const primera = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const segunda = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(primera.meta.servedFrom, 'live');
    assert.equal(segunda.meta.servedFrom, 'cache-l1');
    assert.deepEqual(porEstado(segunda.rows), ESTADOS_EMPRESA_A);
    assert.deepEqual(segunda.rows, primera.rows);
  });

  it('el hit no consulta la base y la telemetría lo cuenta con su hit ratio', async () => {
    const { engine, telemetria } = armar({ cache: crearMemoryStore() });

    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const consultasALaBase = telemetria.snapshot().database.count;
    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    const contadores = engine.telemetry();
    assert.equal(consultasALaBase, 1);
    assert.equal(contadores.database.count, 1, 'la segunda respuesta no tocó la base');
    assert.deepEqual(contadores.cache, {
      hits: 1,
      misses: 1,
      // Una caché de un solo nivel es, para el engine, el primero que consulta.
      porNivel: { 'cache-l1': 1 },
      hitRatio: 0.5,
    });
    assert.deepEqual(contadores.byConsumer.dashboard, {
      ok: 2,
      error: 0,
      cacheHits: 1,
      cacheMisses: 1,
    });
  });

  // Literales del seed: la empresa 2 tiene sus propias evaluaciones. Si la
  // entrada de la empresa 1 le sirviera, estos números serían los de la otra.
  const ESTADOS_EMPRESA_B = { completed: 3, pending: 1, calibrated: 1 };

  it('la empresa B con la misma forma no recibe la entrada de la A', async () => {
    const { engine } = armar({ cache: crearMemoryStore() });

    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const b = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_B);

    assert.equal(b.meta.servedFrom, 'live', 'la empresa B no puede tener un hit de la A');
    assert.deepEqual(porEstado(b.rows), ESTADOS_EMPRESA_B);
  });

  // La versión del catálogo entra al hash de la llave, así que un contrato de
  // datos distinto no puede reusar las respuestas del anterior: registrar una
  // definición nueva deja las entradas viejas inalcanzables, sin recorrerlas.
  it('cambiar la versión del catálogo invalida las entradas', async () => {
    const { engine, catalog } = armar({ cache: crearMemoryStore() });

    const primera = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const versionPrevia = catalog.version();
    catalog.register(attendance);
    const segunda = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.notEqual(catalog.version(), versionPrevia, 'registrar cambió la versión');
    assert.equal(segunda.meta.servedFrom, 'live');
    assert.notEqual(segunda.meta.queryId, primera.meta.queryId);
    assert.deepEqual(porEstado(segunda.rows), ESTADOS_EMPRESA_A);
  });

  // El TTL lo fija la clase de consumidor, como el resto del presupuesto: el
  // tablero (60 s) es el que repite la misma consulta muchas veces. El reloj
  // del store se inyecta para no tener que esperar un minuto real.
  const TTL_DASHBOARD_MS = 60_000;

  it('la entrada expira cuando pasa el TTL de la clase de consumidor', async () => {
    let ahora = 1_700_000_000_000;
    const { engine } = armar({ cache: crearMemoryStore({ now: () => ahora }) });

    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    ahora += TTL_DASHBOARD_MS - 1;
    const dentro = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    ahora += 2;
    const fuera = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(dentro.meta.servedFrom, 'cache-l1', 'antes del TTL la entrada sirve');
    assert.equal(fuera.meta.servedFrom, 'live', 'pasado el TTL la entrada ya no está');
    assert.deepEqual(porEstado(fuera.rows), ESTADOS_EMPRESA_A);
  });

  // La cota es lo que impide que la caché sea una fuga de memoria. Con tres
  // consultas y sitio para dos, el desalojo tiene que caer sobre la que lleva
  // más tiempo sin usarse —no sobre la que se guardó primero—: por eso entre
  // medio se vuelve a pedir la primera, que con un desalojo por antigüedad de
  // inserción sería justamente la sacrificada.
  // Servir desde la caché no puede maquillar la antigüedad del dato: `asOf` es
  // el instante de la ejecución que produjo estas filas, no el de ahora, y las
  // advertencias son las que esa ejecución levantó. Un consumidor que muestra
  // "actualizado hace X" depende de eso.
  it('el hit conserva el asOf y las advertencias de la ejecución original', async () => {
    const { engine } = armar({ cache: crearMemoryStore() });
    // El filtro global repite lo que distingue al numerador: la razón queda en
    // 100 y la respuesta lo advierte (docs/semantica-de-filtros.md).
    const razonAnulada = {
      measures: ['reviews.completion_rate'],
      dimensions: ['departments.name'],
      filters: [{ member: 'reviews.status', operator: 'equals', values: ['completed'] }],
    };

    const primera = await engine.run(razonAnulada, DASHBOARD_A);
    const segunda = await engine.run(razonAnulada, DASHBOARD_A);

    assert.equal(primera.meta.warnings.length, 1, 'la ejecución original advirtió');
    assert.equal(segunda.meta.servedFrom, 'cache-l1');
    assert.equal(segunda.meta.asOf, primera.meta.asOf);
    assert.deepEqual(segunda.meta.warnings, primera.meta.warnings);
    assert.equal(segunda.meta.queryId, primera.meta.queryId);
  });

  // El consumidor recibe filas que son suyas: si las ordena, las recorta o les
  // agrega un total, la entrada guardada no puede enterarse. Una caché que
  // entrega el mismo objeto que guardó convierte cualquier post-proceso del
  // consumidor en un dato corrupto para el siguiente.
  it('mutar las filas de una respuesta no corrompe la entrada de la caché', async () => {
    const { engine } = armar({ cache: crearMemoryStore() });

    const primera = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    primera.rows[0]['reviews.count'] = -1;
    primera.rows.push({ 'reviews.status': 'inventado', 'reviews.count': 999 });

    const segunda = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    segunda.rows.length = 0;
    const tercera = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(segunda.meta.servedFrom, 'cache-l1');
    assert.equal(tercera.meta.servedFrom, 'cache-l1');
    assert.deepEqual(porEstado(tercera.rows), ESTADOS_EMPRESA_A);
  });

  // La llave nace del SQL que se va a ejecutar y de sus parámetros, no del JSON
  // de la consulta: el LIMIT efectivo lo pone el presupuesto de la clase de
  // consumidor y viaja en los parámetros. Si la llave no lo mirara, el tablero
  // (5000 filas como techo) le dejaría servida a la API (10000) una entrada
  // recortada, y la API recibiría menos filas de las que su presupuesto permite
  // sin que nada lo delate.
  const API_A = { companyId: 1, consumer: 'api' };

  it('dos consumidores con distinto límite efectivo no comparten la entrada', async () => {
    const { engine } = armar({ cache: crearMemoryStore() });

    const delTablero = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const deLaApi = await engine.run(CONTEO_POR_ESTADO, API_A);

    assert.notEqual(deLaApi.meta.queryId, delTablero.meta.queryId, 'otro LIMIT es otra consulta');
    assert.equal(deLaApi.meta.servedFrom, 'live', 'la API no puede recibir la entrada recortada del tablero');
    assert.deepEqual(porEstado(deLaApi.rows), ESTADOS_EMPRESA_A);
  });

  // La otra cara: si lo que se ejecuta es idéntico, la entrada se comparte. La
  // llave no separa por consumidor —eso multiplicaría las entradas sin motivo—,
  // separa por lo que cambia el resultado.
  it('con el mismo límite pedido, los dos consumidores comparten la entrada', async () => {
    const { engine } = armar({ cache: crearMemoryStore() });
    const conLimitePropio = { ...CONTEO_POR_ESTADO, limit: 10 };

    const delTablero = await engine.run(conLimitePropio, DASHBOARD_A);
    const deLaApi = await engine.run(conLimitePropio, API_A);

    assert.equal(deLaApi.meta.queryId, delTablero.meta.queryId);
    assert.equal(deLaApi.meta.servedFrom, 'cache-l1');
    assert.deepEqual(deLaApi.rows, delTablero.rows);
  });

  // Compartir la entrada no puede significar heredar la tolerancia del otro. El
  // TTL lo evalúa quien lee, contra el `asOf` que la entrada trae: el tablero
  // tolera 60 s y la API 30 s, así que una entrada que el tablero dejó hace 50 s
  // le sirve a él y no a la API. Si el TTL se decidiera al escribir, el primero
  // en llegar le impondría su frescura a todos los demás.
  it('un lector con TTL más corto que la edad de la entrada la trata como miss', async () => {
    let ahora = 1_700_000_000_000;
    const { engine } = armar({ cache: crearMemoryStore(), reloj: () => ahora });
    const conLimitePropio = { ...CONTEO_POR_ESTADO, limit: 10 };

    await engine.run(conLimitePropio, DASHBOARD_A);
    ahora += 20_000;
    const fresca = await engine.run(conLimitePropio, API_A);
    ahora += 30_000;
    const vieja = await engine.run(conLimitePropio, API_A);

    assert.equal(fresca.meta.servedFrom, 'cache-l1', 'a los 20 s la API todavía la acepta');
    assert.equal(vieja.meta.servedFrom, 'live', 'a los 50 s pasó el TTL de la API');
    assert.deepEqual(porEstado(vieja.rows), ESTADOS_EMPRESA_A);
  });

  it('acotada a dos entradas, desaloja la menos usada recientemente', async () => {
    const { engine } = armar({ cache: crearMemoryStore({ maximo: 2 }) });
    const soloConteo = { measures: ['reviews.count'] };
    const promedio = { measures: ['reviews.avg_score'] };

    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    await engine.run(soloConteo, DASHBOARD_A);
    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    await engine.run(promedio, DASHBOARD_A);

    const laUsada = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const laDesalojada = await engine.run(soloConteo, DASHBOARD_A);

    assert.equal(laUsada.meta.servedFrom, 'cache-l1', 'la que se volvió a usar sigue en la caché');
    assert.equal(laDesalojada.meta.servedFrom, 'live', 'la que no se usó fue desalojada');
  });
});

// El dry-run no toca la caché ni para leer ni para escribir: no ejecutó nada,
// así que no tiene resultado que guardar, y devolver el de otra ejecución sería
// mentir sobre lo que se pidió —el plan que muestra es el de esta consulta—.
// Este bloque no necesita base: `plan()` tampoco la toca.
const cacheQueNadieDebeTocar = {
  async get() {
    throw new Error('el dry-run no puede leer la caché');
  },
  async set() {
    throw new Error('el dry-run no puede escribir en la caché');
  },
  async delete() {
    throw new Error('el dry-run no puede borrar de la caché');
  },
};

const poolQueNadieDebeTocar = {
  connect() {
    throw new Error('el dry-run no puede abrir conexión');
  },
};

describe('el dry-run nunca toca la caché', () => {
  it('planifica con un store que falla si alguien lo llama', () => {
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    const engine = createEngine({
      catalog,
      pool: poolQueNadieDebeTocar,
      cache: cacheQueNadieDebeTocar,
    });

    const { sql, plan } = engine.plan(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.match(sql, /^WITH/);
    assert.equal(plan.entity, 'reviews');
  });
});

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

  function armar({ cache, telemetria = crearTelemetria(), definiciones } = {}) {
    const catalog = createCatalog();
    for (const definicion of definiciones ?? [reviews, employees, departments]) {
      catalog.register(definicion);
    }
    return { catalog, engine: createEngine({ catalog, pool, cache, telemetria }), telemetria };
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
    assert.deepEqual(contadores.cache, { hits: 1, misses: 1, hitRatio: 0.5 });
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
});

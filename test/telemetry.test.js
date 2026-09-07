// Telemetría del engine (historia 31): cuántas consultas se respondieron,
// cuántas se rechazaron, con qué código, en qué puerta y de qué consumidor.
// Se prueba por el seam `engine.run`, contando lo que pasó por él.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearTelemetria } from '../src/telemetry.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

// Una consulta rechazada no llega a la base: el pool avisa si alguien la toca.
const poolQueNadieDebeTocar = {
  connect() {
    throw new Error('una consulta rechazada no debe abrir conexión');
  },
};

function engineCon(telemetria, pool = poolQueNadieDebeTocar) {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  return createEngine({ catalog, pool, telemetria });
}

async function rechazada(promesa) {
  await assert.rejects(promesa);
}

describe('telemetría de consultas rechazadas', () => {
  it('cuenta cada rechazo por resultado, código, puerta y consumidor', async () => {
    const telemetria = crearTelemetria();
    const engine = engineCon(telemetria);
    const dashboard = { companyId: 1, consumer: 'dashboard' };

    await rechazada(engine.run({ measures: ['reviews.avg_scor'] }, dashboard));
    await rechazada(engine.run({ measures: ['reviews.count'], companyId: 2 }, dashboard));
    await rechazada(engine.run({ measures: ['reviews.count'] }, { companyId: 1, consumer: 'nadie' }));

    assert.deepEqual(telemetria.snapshot(), {
      total: 3,
      byResult: { ok: 0, error: 3 },
      byErrorCode: { UNKNOWN_MEMBER: 1, FORBIDDEN_FIELD: 1, INVALID_CONSUMER: 1 },
      byGate: { resolverMiembros: 1, validar: 2 },
      byConsumer: {
        dashboard: { ok: 0, error: 2 },
        nadie: { ok: 0, error: 1 },
      },
      database: { count: 0, totalMs: 0 },
    });
  });

  it('vuelve a cero cuando se reinicia', async () => {
    const telemetria = crearTelemetria();
    const engine = engineCon(telemetria);

    await rechazada(engine.run({ measures: ['reviews.avg_scor'] }, { companyId: 1, consumer: 'api' }));
    telemetria.reset();

    assert.deepEqual(telemetria.snapshot(), {
      total: 0,
      byResult: { ok: 0, error: 0 },
      byErrorCode: {},
      byGate: {},
      byConsumer: {},
      database: { count: 0, totalMs: 0 },
    });
  });
});

const { DATABASE_URL } = process.env;
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

describe('telemetría de consultas servidas', conBase, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  it('cuenta las respondidas por consumidor y acumula el tiempo de base', async () => {
    const telemetria = crearTelemetria();
    const engine = engineCon(telemetria, pool);
    const consulta = { measures: ['reviews.count'], dimensions: ['reviews.status'] };

    await engine.run(consulta, { companyId: 1, consumer: 'api' });
    await engine.run(consulta, { companyId: 2, consumer: 'api' });
    await rechazada(engine.run({ measures: ['reviews.avg_scor'] }, { companyId: 1, consumer: 'agent' }));

    const contadores = engine.telemetry();
    assert.equal(contadores.total, 3);
    assert.deepEqual(contadores.byResult, { ok: 2, error: 1 });
    assert.deepEqual(contadores.byConsumer, {
      api: { ok: 2, error: 0 },
      agent: { ok: 0, error: 1 },
    });
    assert.equal(contadores.database.count, 2, 'sólo las servidas tocaron la base');
    assert.ok(contadores.database.totalMs > 0, 'el tiempo de base se acumuló');
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { reviews } from '../src/definitions/reviews.js';

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
    catalog.register(reviews);
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

  it('la misma consulta para la empresa B devuelve los números de la empresa B', async () => {
    const { rows } = await engine.run(conteoPorEstado, {
      companyId: EMPRESA_B,
      consumer: 'api',
    });

    assert.deepEqual(porEstado(rows), { completed: 3, pending: 1, calibrated: 1 });
  });
});

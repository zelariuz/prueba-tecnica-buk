// Prueba de humo de la capa HTTP (PRD, Decisiones de Testing: "la capa HTTP
// solo tiene una prueba de humo"). Entra por el contrato real —un servidor
// escuchando en un puerto efímero— y no por funciones internas: lo que se
// verifica es el código de estado y el cuerpo que ve un consumidor.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { crearServidor } from '../src/http/server.js';
import { tokensDeDemo } from '../src/http/tokens.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

const { DATABASE_URL } = process.env;

const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

// Tokens de demo: valores obviamente falsos, en el repo a propósito. La
// autenticación real está fuera de alcance (PRD, Fuera de Alcance).
// La tabla se arma como en producción: desde la variable de entorno, no a mano.
const TOKEN_A = 'token-demo-empresa-a';
const tokens = tokensDeDemo({
  DEMO_TOKENS: JSON.stringify({ [TOKEN_A]: { companyId: 1, consumer: 'dashboard' } }),
});

// Timeout por test: una petición que el servidor no contesta debe fallar el
// test, no colgar la suite.
describe('capa HTTP', { ...conBase, timeout: 10_000 }, () => {
  let pool;
  let servidor;
  let base;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    // Como en producción (`src/server.js`): el servicio arma su engine con la
    // caché L1 del proceso.
    const engine = createEngine({ catalog, pool, cache: crearMemoryStore() });
    servidor = crearServidor({ engine, catalog, tokens });
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    await new Promise((listo) => servidor.close(listo));
    await pool.end();
  });

  it('responde 200 con las filas del seed a una consulta válida', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], dimensions: ['reviews.status'] }),
    });

    assert.equal(respuesta.status, 200);
    const { rows, meta } = await respuesta.json();
    assert.deepEqual(
      Object.fromEntries(rows.map((fila) => [fila['reviews.status'], fila['reviews.count']])),
      { completed: 5, pending: 4, calibrated: 2 },
    );
    assert.equal(meta.servedFrom, 'live');
  });
  it('dos peticiones iguales: la segunda vuelve servida desde cache-l1', async () => {
    const peticion = () =>
      fetch(`${base}/analytics/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
        body: JSON.stringify({ measures: ['reviews.avg_score'], dimensions: ['reviews.period'] }),
      });

    const primera = await (await peticion()).json();
    const segunda = await (await peticion()).json();

    assert.equal(primera.meta.servedFrom, 'live');
    assert.equal(segunda.meta.servedFrom, 'cache-l1');
    assert.deepEqual(segunda.rows, primera.rows);
  });
  it('rechaza con 401 la petición sin token y la de un token desconocido', async () => {
    const sinToken = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'] }),
    });

    assert.equal(sinToken.status, 401);
    assert.equal((await sinToken.json()).code, 'MISSING_TENANT');

    const tokenDesconocido = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: 'Bearer no-existe', 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'] }),
    });

    assert.equal(tokenDesconocido.status, 401);
    assert.equal((await tokenDesconocido.json()).code, 'MISSING_TENANT');
  });
  it('traduce un miembro mal escrito a 400 con el error estructurado', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.avg_scor'], dimensions: ['reviews.status'] }),
    });

    assert.equal(respuesta.status, 400);
    const error = await respuesta.json();
    assert.equal(error.code, 'UNKNOWN_MEMBER');
    assert.equal(error.member, 'reviews.avg_scor');
    assert.match(error.suggestion, /avg_score/);
  });
  it('rechaza con 400 el cuerpo que trae companyId: la empresa no se pide, se deriva del token', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], companyId: 2 }),
    });

    assert.equal(respuesta.status, 400);
    const error = await respuesta.json();
    assert.equal(error.code, 'FORBIDDEN_FIELD');
    assert.equal(error.member, 'companyId');
  });
  it('publica el catálogo público en GET /analytics/catalog, sin nombres físicos', async () => {
    const respuesta = await fetch(`${base}/analytics/catalog`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });

    assert.equal(respuesta.status, 200);
    const catalogo = await respuesta.json();
    const evaluaciones = catalogo.entities.find((entidad) => entidad.name === 'reviews');
    assert.ok(
      evaluaciones.measures.some((medida) => medida.name === 'reviews.avg_score'),
      'el catálogo publica las medidas con su nombre semántico',
    );

    // La vista interna (tablas y columnas) no puede salir por la API (ADR 0008).
    const serializado = JSON.stringify(catalogo);
    for (const fisico of ['performance_reviews', 'company_id', 'employee_id', '"tables"']) {
      assert.ok(!serializado.includes(fisico), `el catálogo público no expone ${fisico}`);
    }
  });
  it('con ?dryRun=true devuelve el SQL, los parámetros y el plan lógico sin ejecutar', async () => {
    const respuesta = await fetch(`${base}/analytics/query?dryRun=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], dimensions: ['departments.name'] }),
    });

    assert.equal(respuesta.status, 200);
    const { sql, params, plan, rows } = await respuesta.json();
    assert.equal(rows, undefined, 'un dry-run no devuelve filas: no tocó la base');
    assert.match(sql, /^WITH/);
    assert.equal(params[0], 1, 'la empresa del token es el primer parámetro');
    assert.equal(plan.entity, 'reviews');
    assert.deepEqual(plan.measures, ['reviews.count']);
    assert.equal(plan.budget.consumer, 'dashboard');
  });
});

// Límite del cuerpo: un cuerpo gigante no puede crecer sin techo en memoria del
// servidor. Se decide antes de que el engine vea nada, así que este bloque no
// necesita base: el engine y el catálogo son dobles que fallan si alguien los
// toca.
const engineQueNadieDebeTocar = {
  plan() {
    throw new Error('un cuerpo demasiado grande no debe llegar al engine');
  },
  run() {
    throw new Error('un cuerpo demasiado grande no debe llegar al engine');
  },
};

const catalogQueNadieDebeTocar = {
  describe() {
    throw new Error('un cuerpo demasiado grande no debe llegar al catálogo');
  },
};

describe('límite del cuerpo de la petición', { timeout: 10_000 }, () => {
  let servidor;
  let base;

  before(async () => {
    servidor = crearServidor({
      engine: engineQueNadieDebeTocar,
      catalog: catalogQueNadieDebeTocar,
      tokens,
    });
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    await new Promise((listo) => servidor.close(listo));
  });

  it('rechaza con 413 un cuerpo mayor a 64 KiB sin llegar al engine', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], relleno: 'x'.repeat(70 * 1024) }),
    });

    assert.equal(respuesta.status, 413);
    const error = await respuesta.json();
    assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
    assert.match(error.suggestion, /65536/);
  });

  it('deja pasar un cuerpo dentro del límite', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], relleno: 'x'.repeat(1024) }),
    });

    // El doble del engine lanza: lo que importa es que el cuerpo se leyó
    // entero y la petición llegó hasta él, no la respuesta.
    assert.equal(respuesta.status, 500);
  });
});

// Prueba de humo de la capa HTTP (PRD, Decisiones de Testing: "la capa HTTP
// solo tiene una prueba de humo"). Entra por el contrato real —un servidor
// escuchando en un puerto efímero— y no por funciones internas: lo que se
// verifica es el código de estado y el cuerpo que ve un consumidor.
import { after, before, describe, it } from 'node:test';
import { connect } from 'node:net';
import { setTimeout as esperar } from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { crearServidor } from '../src/http/server.js';
import { SemanticError } from '../src/errors.js';
import { crearTelemetria } from '../src/telemetry.js';
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
// Sesión interna: la única que recibe el SQL del dry-run, por la misma razón por
// la que el mapeo físico no sale en la vista pública del catálogo (ADR 0008).
const TOKEN_INTERNO = 'token-demo-interno-empresa-a';
const tokens = tokensDeDemo({
  DEMO_TOKENS: JSON.stringify({
    [TOKEN_A]: { companyId: 1, consumer: 'dashboard' },
    [TOKEN_INTERNO]: { companyId: 1, consumer: 'api', internal: true },
  }),
});

// Timeout por test: una petición que el servidor no contesta debe fallar el
// test, no colgar la suite.
describe('capa HTTP', { ...conBase, timeout: 10_000 }, () => {
  let pool;
  let servidor;
  let base;
  // El observador doble: acumula el evento que el engine emite por consulta. En
  // producción esa función es la que escribe la línea JSON en stdout
  // (`src/server.js`); aquí sólo se guarda para poder mirarla.
  const eventos = [];

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    // Como en producción (`src/server.js`): el servicio arma su engine con la
    // caché L1 del proceso.
    const engine = createEngine({
      catalog,
      pool,
      cache: crearMemoryStore(),
      observar: (evento) => eventos.push(evento),
    });
    servidor = crearServidor({ engine, catalog, tokens });
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    await new Promise((listo) => servidor.close(listo));
    await pool.end();
  });

  it('una consulta por HTTP emite un evento con la empresa y el consumidor del token', async () => {
    const antes = eventos.length;

    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], dimensions: ['departments.name'] }),
    });

    assert.equal(respuesta.status, 200);
    const nuevos = eventos.slice(antes);
    assert.equal(nuevos.length, 1, 'un evento por consulta');
    const [evento] = nuevos;
    assert.equal(evento.kind, 'run');
    assert.equal(evento.result, 'ok');
    // El contexto de sesión sale del token y de ninguna otra parte (ADR 0002):
    // es lo que hace que la línea del log diga de quién era la consulta.
    assert.equal(evento.companyId, 1);
    assert.equal(evento.consumer, 'dashboard');
    assert.equal(evento.plan.entity, 'reviews');
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
  // Hallazgo 4: lo primero que prueba quien no conoce la API es una consulta
  // incompleta. Tiene que salir como error del consumidor (400) con su código,
  // nunca como 500 diciendo que el servidor está mal armado.
  it('una consulta que no pide nada responde 400 INVALID_QUERY y no 500', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(respuesta.status, 400);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.code, 'INVALID_QUERY');
    assert.equal(cuerpo.member, 'measures');
    assert.ok(cuerpo.suggestion.length > 0, 'el error estructurado trae sugerencia');
  });

  // ADR 0010: la misma consulta que hasta el 09-09 salía como 400 —dimensiones
  // sin medidas— es la que responde "cuáles departamentos hay".
  it('una consulta con dimensiones y sin medidas responde 200 con los valores distintos', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dimensions: ['departments.name'],
        order: { 'departments.name': 'asc' },
      }),
    });

    assert.equal(respuesta.status, 200);
    const cuerpo = await respuesta.json();
    // Literales del seed de la empresa 1, no recalculados.
    assert.deepEqual(cuerpo.rows, [{ 'departments.name': 'Ingeniería' }, { 'departments.name': 'Ventas' }]);
  });

  // Hallazgo 5: el dry-run entregaba el SQL —con los nombres de las tablas
  // físicas— a cualquier token, mientras `/analytics/catalog` los esconde. El
  // plan lógico está escrito en nombres semánticos y ése sí es para todos.
  it('con ?dryRun=true devuelve el plan lógico y los parámetros, sin ejecutar y sin SQL', async () => {
    const respuesta = await fetch(`${base}/analytics/query?dryRun=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], dimensions: ['departments.name'] }),
    });

    assert.equal(respuesta.status, 200);
    const cuerpo = await respuesta.json();
    const { sql, params, plan, rows } = cuerpo;
    assert.equal(rows, undefined, 'un dry-run no devuelve filas: no tocó la base');
    assert.equal(sql, undefined, 'el SQL nombra tablas físicas: no sale a un token normal');
    assert.equal(params[0], 1, 'la empresa del token es el primer parámetro');
    assert.equal(plan.entity, 'reviews');
    assert.deepEqual(plan.measures, ['reviews.count']);
    assert.equal(plan.budget.consumer, 'dashboard');

    // Ninguna tabla ni columna física en el cuerpo entero, no sólo en el campo
    // `sql`: los joins del plan lógico se describen por la relación semántica
    // (hallazgo del QA del 08-09: el plan traía employee_id y department_id).
    for (const fisico of ['performance_reviews', 'employee_id', 'department_id', 'company_id']) {
      assert.doesNotMatch(JSON.stringify(cuerpo), new RegExp(fisico), `${fisico} se filtró en el dry-run`);
    }
  });

  // Comparación de períodos (ADR 0015): la única consulta que cambia la forma de
  // la respuesta también cambia la del dry-run —un plan por rango—, y el SQL se
  // tiene que seguir escondiendo en cada uno de ellos.
  it('el dry-run de una comparación devuelve un plan por rango, sin SQL', async () => {
    const respuesta = await fetch(`${base}/analytics/query?dryRun=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        measures: ['reviews.count'],
        timeDimensions: [
          {
            dimension: 'reviews.period',
            granularity: 'quarter',
            compareDateRange: [
              ['2025-01-01', '2025-06-30'],
              ['2024-01-01', '2024-06-30'],
            ],
          },
        ],
      }),
    });

    assert.equal(respuesta.status, 200);
    const cuerpo = await respuesta.json();
    assert.equal(cuerpo.results.length, 2);
    assert.deepEqual(cuerpo.results[0].dateRange, ['2025-01-01', '2025-06-30']);
    assert.deepEqual(cuerpo.results[1].dateRange, ['2024-01-01', '2024-06-30']);
    for (const resultado of cuerpo.results) {
      assert.equal(resultado.sql, undefined, 'el SQL nombra tablas físicas: no sale a un token normal');
      assert.equal(resultado.plan.entity, 'reviews');
      assert.equal(resultado.params[0], 1, 'la empresa del token es el primer parámetro de cada rango');
    }
    assert.doesNotMatch(JSON.stringify(cuerpo), /performance_reviews/);
  });

  it('un token interno sí recibe el SQL del dry-run', async () => {
    const respuesta = await fetch(`${base}/analytics/query?dryRun=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_INTERNO}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'], dimensions: ['departments.name'] }),
    });

    assert.equal(respuesta.status, 200);
    const { sql, plan } = await respuesta.json();
    assert.match(sql, /^WITH/);
    assert.match(sql, /performance_reviews/);
    assert.equal(plan.entity, 'reviews');
  });

  // Telemetría por HTTP (09-09): los contadores del proceso y la tabla de
  // presupuestos salen por una ruta más, y sólo para una sesión interna — la
  // misma marca que abre el SQL del dry-run. Quien no puede ver el esquema
  // físico tampoco tiene por qué ver qué pide el resto de los consumidores.
  it('la telemetría sin token conocido es 401, como todo lo demás', async () => {
    const respuesta = await fetch(`${base}/analytics/telemetry`);

    assert.equal(respuesta.status, 401);
    assert.equal((await respuesta.json()).code, 'MISSING_TENANT');
  });

  it('un token conocido que no es interno recibe 403 FORBIDDEN', async () => {
    const respuesta = await fetch(`${base}/analytics/telemetry`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });

    assert.equal(respuesta.status, 403);
    const { code, suggestion } = await respuesta.json();
    assert.equal(code, 'FORBIDDEN');
    assert.match(suggestion, /interna/);
  });

  it('el token interno recibe los contadores del proceso y los presupuestos', async () => {
    // Una consulta antes: la telemetría es del proceso y lo que cuenta es lo
    // que ya pasó por él.
    await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'] }),
    });

    const respuesta = await fetch(`${base}/analytics/telemetry`, {
      headers: { authorization: `Bearer ${TOKEN_INTERNO}` },
    });

    assert.equal(respuesta.status, 200);
    const { telemetry, budgets, process: proceso } = await respuesta.json();
    assert.ok(telemetry.total >= 1, 'la telemetría del proceso ya contó consultas');
    assert.equal(typeof telemetry.byResult.ok, 'number');
    assert.equal(typeof telemetry.cache.hitRatio, 'number');
    assert.ok(Object.hasOwn(telemetry.byConsumer, 'dashboard'), 'desglosada por consumidor');
    // La tabla de presupuestos tal cual la declara `src/budgets.js`: es lo que
    // explica por qué a un consumidor se le recorta la salida y a otro no.
    assert.equal(budgets.agent.maxFilas, 1000);
    assert.equal(budgets.agent.timeoutMs, 10_000);
    assert.equal(budgets.dashboard.cacheTtlMs, 60_000);
    assert.equal(budgets.api.maxFilas, 10_000);
    assert.ok(proceso.uptimeMs >= 0);
    assert.match(proceso.startedAt, /^\d{4}-\d{2}-\d{2}T/);
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

// Doble delgado del pool, como el de run.test.js: clientes reales, y solo la
// consulta principal (la única con parámetros) se cambia por una que duerme.
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

// Decisión del usuario (CONTEXTO, 07-09): una consulta cuyo SQL ya corre NO se
// cancela cuando el cliente se va —se deja terminar y se cachea, así el retry
// es un hit—. Lo que sí se cuenta es el indicador: "cliente se fue antes de la
// respuesta", por consumidor. Es la señal adelantada de refresh excesivo o de
// timeouts del lado cliente más cortos que el presupuesto.
describe('cliente que se va antes de la respuesta', { ...conBase, timeout: 15_000 }, () => {
  let pool;
  let servidor;
  let telemetria;
  let engine;
  let puerto;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    telemetria = crearTelemetria();
    engine = createEngine({ catalog, pool: poolQueDuerme(pool, 1), telemetria });
    servidor = crearServidor({ engine, catalog, tokens, telemetria });
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    puerto = servidor.address().port;
  });

  after(async () => {
    await new Promise((listo) => servidor.close(listo));
    await pool.end();
  });

  it('se cuenta por consumidor y la consulta termina igual', async () => {
    const cuerpo = JSON.stringify({ measures: ['reviews.count'], dimensions: ['reviews.status'] });
    const socket = connect(puerto, '127.0.0.1');
    await new Promise((listo) => socket.once('connect', listo));
    socket.write(
      `POST /analytics/query HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN_A}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(cuerpo)}\r\n\r\n${cuerpo}`,
    );
    // La consulta duerme 1 s; el cliente se rinde a los 200 ms.
    await esperar(200);
    socket.destroy();
    await esperar(1_300);

    const contadores = engine.telemetry();
    assert.deepEqual(contadores.clientGone, { dashboard: 1 });
    // No se canceló: la consulta se sirvió (y por lo tanto se pudo cachear).
    assert.equal(contadores.byResult.ok, 1);
    assert.equal(contadores.byResult.error, 0);
    // Y la conexión volvió limpia al pool: la siguiente petición responde.
    assert.equal(pool.totalCount - pool.idleCount, 0, 'ninguna conexión quedó tomada');
  });

  it('una respuesta que sí llegó no cuenta como cliente que se fue', async () => {
    const respuesta = await fetch(`http://127.0.0.1:${puerto}/analytics/catalog`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    assert.equal(respuesta.status, 200);
    await respuesta.json();
    assert.deepEqual(engine.telemetry().clientGone, { dashboard: 1 });
  });
});

// La fuente que no responde entra por el mismo camino que cualquier otro error
// del engine: el servidor no sabe qué es SOURCE_UNAVAILABLE, sólo lo busca en la
// tabla de códigos. Por eso alcanza con un engine que lo lanza; no hace falta
// una base caída de verdad.
describe('la fuente caída sale como 503 con Retry-After', { timeout: 10_000 }, () => {
  let servidor;
  let base;

  before(async () => {
    servidor = crearServidor({
      engine: {
        async run() {
          throw new SemanticError({
            code: 'SOURCE_UNAVAILABLE',
            suggestion: 'La base de esta fuente no está respondiendo; reintenta más tarde.',
          });
        },
      },
      catalog: catalogQueNadieDebeTocar,
      tokens,
    });
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    await new Promise((listo) => servidor.close(listo));
  });

  it('responde 503 y le dice al cliente cuándo reintentar', async () => {
    const respuesta = await fetch(`${base}/analytics/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ measures: ['reviews.count'] }),
    });

    assert.equal(respuesta.status, 503);
    assert.equal(respuesta.headers.get('retry-after'), '5');
    assert.equal((await respuesta.json()).code, 'SOURCE_UNAVAILABLE');
  });
});

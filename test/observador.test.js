// Observador del engine: un evento por consulta, la línea que el servicio
// escribe como log en vivo (discusiones 09 y 17). La telemetría son contadores
// agregados; esto es lo otro —qué se planificó, de dónde salió y por qué se
// rechazó, consulta por consulta—.
//
// Se prueba por los seams `engine.run` y `engine.plan` con un observador doble
// que acumula los eventos en un arreglo.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

// Una consulta rechazada antes de planificar no llega a la base.
const poolQueNadieDebeTocar = {
  connect() {
    throw new Error('una consulta rechazada no debe abrir conexión');
  },
};

// El doble: acumula lo que reciba, sin interpretar nada.
function observadorDoble() {
  const eventos = [];
  return { eventos, observar: (evento) => eventos.push(evento) };
}

function engineCon({ observar, observarSql, pool = poolQueNadieDebeTocar, cache }) {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  return createEngine({ catalog, pool, cache, observar, observarSql });
}

const dashboard = { companyId: 1, consumer: 'dashboard' };

describe('observador sin base', () => {
  it('una consulta rechazada emite un evento de error con código, puerta y sin queryId', async () => {
    const { eventos, observar } = observadorDoble();
    const engine = engineCon({ observar });

    await assert.rejects(engine.run({ measures: ['reviews.avg_scor'] }, dashboard));

    assert.equal(eventos.length, 1, 'un evento por consulta, también cuando se rechaza');
    const [evento] = eventos;
    assert.equal(evento.kind, 'run');
    assert.equal(evento.result, 'error');
    assert.equal(evento.code, 'UNKNOWN_MEMBER');
    assert.equal(evento.member, 'reviews.avg_scor');
    // La misma puerta que anota la telemetría.
    assert.equal(evento.gate, 'resolverMiembros');
    assert.equal(evento.companyId, 1);
    assert.equal(evento.consumer, 'dashboard');
    // El rechazo ocurrió antes de planificar: no hubo queryId que calcular ni
    // plan que describir.
    assert.ok(!('queryId' in evento), 'sin queryId: la consulta no llegó a tener identidad');
    assert.ok(!('plan' in evento), 'sin plan: el rechazo fue antes de planificar');
    assert.equal(typeof evento.ms, 'number');
  });

  it('el dry-run emite un evento kind plan con el plan lógico y sin SQL', () => {
    const { eventos, observar } = observadorDoble();
    const engine = engineCon({ observar });

    engine.plan({ measures: ['reviews.count'], dimensions: ['departments.name'] }, dashboard);

    assert.equal(eventos.length, 1);
    const [evento] = eventos;
    assert.equal(evento.kind, 'plan');
    assert.equal(evento.result, 'ok');
    assert.equal(evento.plan.entity, 'reviews');
    assert.deepEqual(
      evento.plan.joins.map(({ from, to, via }) => ({ from, to, via })),
      [
        { from: 'reviews', to: 'employees', via: 'employee' },
        { from: 'employees', to: 'departments', via: 'department' },
      ],
    );
    assert.deepEqual(evento.plan.measures, ['reviews.count']);
    assert.deepEqual(evento.plan.dimensions, ['departments.name']);
    assert.ok(!('sql' in evento), 'el SQL nombra tablas físicas: no sale por defecto');
    // Ni por el plan lógico resumido.
    const serializado = JSON.stringify(evento);
    assert.ok(!serializado.includes('performance_reviews'), serializado);
    assert.ok(!serializado.includes('employee_id'), serializado);
  });

  it('con observarSql el evento del dry-run trae el SQL', () => {
    const { eventos, observar } = observadorDoble();
    const engine = engineCon({ observar, observarSql: true });

    engine.plan({ measures: ['reviews.count'] }, dashboard);

    assert.equal(eventos.length, 1);
    assert.match(eventos[0].sql, /performance_reviews/);
  });
});

const { DATABASE_URL } = process.env;
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

describe('observador contra la base', conBase, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  it('una consulta servida en vivo emite un evento con servedFrom, filas y tiempo de base', async () => {
    const { eventos, observar } = observadorDoble();
    const engine = engineCon({ observar, pool });

    const { rows } = await engine.run(
      { measures: ['reviews.count'], dimensions: ['reviews.status'] },
      dashboard,
    );

    assert.equal(eventos.length, 1);
    const [evento] = eventos;
    assert.equal(evento.kind, 'run');
    assert.equal(evento.result, 'ok');
    assert.equal(evento.servedFrom, 'live');
    // Tres estados en el seed de la empresa 1: completed, pending y calibrated.
    assert.equal(rows.length, 3);
    assert.equal(evento.rows, 3);
    assert.equal(typeof evento.dbMs, 'number');
    assert.ok(evento.dbMs > 0, 'tocó la base: el tiempo de base es un número mayor que cero');
    assert.equal(evento.warnings, 0);
    assert.equal(typeof evento.queryId, 'string');
    assert.equal(evento.plan.entity, 'reviews');
    assert.deepEqual(evento.plan.dimensions, ['reviews.status']);
    assert.ok(!('sql' in evento));
    const serializado = JSON.stringify(evento);
    assert.ok(!serializado.includes('performance_reviews'), serializado);
    assert.ok(!serializado.includes('employee_id'), serializado);
  });

  it('un hit de caché emite servedFrom cache-l1 y sin tiempo de base', async () => {
    const { eventos, observar } = observadorDoble();
    const engine = engineCon({ observar, pool, cache: crearMemoryStore() });
    const consulta = { measures: ['reviews.avg_score'], dimensions: ['reviews.status'] };

    await engine.run(consulta, dashboard);
    await engine.run(consulta, dashboard);

    assert.equal(eventos.length, 2);
    assert.equal(eventos[0].servedFrom, 'live');
    assert.equal(eventos[1].servedFrom, 'cache-l1');
    assert.ok(!('dbMs' in eventos[1]), 'la respuesta de caché no consultó la base');
    assert.equal(eventos[1].rows, eventos[0].rows);
  });

  it('un observador que lanza no impide que la consulta devuelva las filas', async () => {
    const engine = engineCon({
      observar: () => {
        throw new Error('el observador falló');
      },
      pool,
    });

    const { rows, meta } = await engine.run(
      { measures: ['reviews.count'], dimensions: ['reviews.status'] },
      dashboard,
    );

    assert.equal(rows.length, 3);
    assert.equal(meta.servedFrom, 'live');
  });
});

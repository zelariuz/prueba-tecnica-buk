import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
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

    assert.deepEqual(porDepartamentoYTrimestre(rows), [
      {
        'departments.name': 'Ingeniería',
        'reviews.period': '2025-01-01',
        'reviews.avg_score': 4.35,
        'reviews.completed_count': 2,
      },
      {
        'departments.name': 'Ventas',
        'reviews.period': '2025-01-01',
        'reviews.avg_score': 3.5,
        'reviews.completed_count': 0,
      },
      {
        'departments.name': 'Ingeniería',
        'reviews.period': '2025-04-01',
        'reviews.avg_score': 3.4,
        'reviews.completed_count': 1,
      },
      {
        'departments.name': 'Ventas',
        'reviews.period': '2025-04-01',
        'reviews.avg_score': 2.9,
        'reviews.completed_count': 0,
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
        'departments.name': 'Ventas',
        'reviews.period': '2025-01-01',
        'reviews.avg_score': 3.2,
        'reviews.completed_count': 0,
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

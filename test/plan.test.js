import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

// Valor improbable a propósito: si aparece en el SQL, es que se interpoló.
const EMPRESA = 424242;

const conteoPorEstado = {
  measures: ['reviews.count'],
  dimensions: ['reviews.status'],
};

const CTX = { companyId: EMPRESA, consumer: 'api' };

function engineDePrueba() {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  return createEngine({ catalog });
}

test('el plan encierra las evaluaciones en una CTE filtrada por empresa', () => {
  const { sql, params } = engineDePrueba().plan(conteoPorEstado, {
    companyId: EMPRESA,
    consumer: 'api',
  });

  assert.match(sql, /WITH reviews AS \(/);
  assert.match(sql, /FROM performance_reviews\s+WHERE company_id = \$1/);
  assert.deepEqual(params, [EMPRESA]);
  assert.ok(
    !sql.includes(String(EMPRESA)),
    'la empresa viaja como parámetro, nunca interpolada en el SQL',
  );
});

function errorDe(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('se esperaba un error estructurado y la llamada no falló');
}

test('sin contexto de empresa el engine corta con MISSING_TENANT', () => {
  const engine = engineDePrueba();

  for (const ctx of [undefined, {}, { consumer: 'api' }, { companyId: null }]) {
    const error = errorDe(() => engine.plan(conteoPorEstado, ctx));
    assert.equal(error.code, 'MISSING_TENANT');
    assert.equal(error.member, 'companyId');
    assert.ok(error.suggestion.length > 0, 'el error estructurado trae sugerencia');
  }
});

const conteoPorDepartamento = {
  measures: ['reviews.count'],
  dimensions: ['departments.name'],
};

test('el plan llega al departamento recorriendo las relaciones declaradas', () => {
  const { sql } = engineDePrueba().plan(conteoPorDepartamento, CTX);

  // El consumidor nunca nombra la relación: el engine encuentra el camino
  // evaluaciones → empleados → departamentos (CONTEXT.md, "Relación").
  assert.match(sql, /JOIN employees ON reviews\.employee_id = employees\.id/);
  assert.match(sql, /JOIN departments ON employees\.department_id = departments\.id/);
});

test('cada entidad del camino viaja en su propia CTE filtrada por empresa', () => {
  const { sql, params } = engineDePrueba().plan(conteoPorDepartamento, CTX);

  // Invariante del ADR 0003: el filtro de empresa acompaña a cada tabla física.
  for (const [entidad, tabla] of [
    ['reviews', 'performance_reviews'],
    ['employees', 'employees'],
    ['departments', 'departments'],
  ]) {
    assert.match(
      sql,
      new RegExp(`${entidad} AS \\([^)]*FROM ${tabla}\\s+WHERE company_id = \\$1`),
      `la CTE de ${entidad} filtra por empresa`,
    );
  }
  assert.equal(sql.match(/company_id = \$1/g).length, 3);
  assert.deepEqual(params, [EMPRESA]);
});

test('la medida avg promedia la columna declarada de su entidad', () => {
  const { sql } = engineDePrueba().plan(
    { measures: ['reviews.avg_score'], dimensions: ['departments.name'] },
    CTX,
  );

  assert.match(sql, /AVG\(reviews\.score\) AS "reviews\.avg_score"/);
  // La columna agregada también viaja dentro de la CTE de su entidad.
  assert.match(sql, /reviews AS \(\n  SELECT [^)]*score/);
});

const porTrimestreDe2025 = {
  measures: ['reviews.count'],
  timeDimensions: [
    {
      dimension: 'reviews.period',
      granularity: 'quarter',
      dateRange: ['2025-01-01', '2025-12-31'],
    },
  ],
};

test('la dimensión temporal agrupa por granularidad y su rango viaja como parámetros', () => {
  const { sql, params } = engineDePrueba().plan(porTrimestreDe2025, CTX);

  assert.match(
    sql,
    /TO_CHAR\(DATE_TRUNC\('quarter', reviews\.period\), 'YYYY-MM-DD'\) AS "reviews\.period"/,
  );
  // El rango acota la CTE de la entidad temporal, no el resultado ya agregado.
  assert.match(sql, /WHERE company_id = \$1\s+AND period >= \$2\s+AND period <= \$3/);
  assert.deepEqual(params, [EMPRESA, '2025-01-01', '2025-12-31']);
});

test('la medida con segmento se agrega con COUNT FILTER y su valor viaja como parámetro', () => {
  const { sql, params } = engineDePrueba().plan(
    { measures: ['reviews.completed_count'], dimensions: ['departments.name'] },
    CTX,
  );

  assert.match(
    sql,
    /COUNT\(\*\) FILTER \(WHERE reviews\.status = \$2\) AS "reviews\.completed_count"/,
  );
  assert.deepEqual(params, [EMPRESA, 'completed']);
});

test('order ordena por el nombre semántico y limit viaja como parámetro', () => {
  const { sql, params } = engineDePrueba().plan(
    { ...porTrimestreDe2025, order: { 'reviews.period': 'asc' }, limit: 500 },
    CTX,
  );

  assert.match(sql, /ORDER BY "reviews\.period" ASC\nLIMIT \$4$/);
  assert.deepEqual(params, [EMPRESA, '2025-01-01', '2025-12-31', 500]);
});

test('medidas de dos entidades cortan con MULTI_ENTITY_MEASURES', () => {
  // Contar empleados y promediar evaluaciones en el mismo SELECT multiplicaría
  // el headcount por la cantidad de evaluaciones de cada empleado (ADR 0006).
  const error = errorDe(() =>
    engineDePrueba().plan(
      { measures: ['reviews.avg_score', 'employees.headcount'], dimensions: ['departments.name'] },
      CTX,
    ),
  );

  assert.equal(error.code, 'MULTI_ENTITY_MEASURES');
  assert.equal(error.member, 'employees.headcount');
  assert.ok(error.suggestion.length > 0, 'el error estructurado trae sugerencia');
});

// La consulta del caso, tal cual la escribiría un dashboard.
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

test('el SQL del caso obligatorio es el del snapshot del repo', () => {
  const { sql, params } = engineDePrueba().plan(casoObligatorio, CTX);

  // El snapshot vive en test/snapshots/caso-obligatorio.sql para poder leerse
  // en el repo; si el SQL cambia a propósito, se edita ese archivo.
  const esperado = readFileSync(new URL('./snapshots/caso-obligatorio.sql', import.meta.url), 'utf8');
  assert.equal(sql, esperado.trimEnd());
  assert.deepEqual(params, [EMPRESA, '2025-01-01', '2025-12-31', 'completed', 500]);
});

test('order solo acepta miembros que la consulta devuelve', () => {
  // La llave de order termina como identificador entre comillas en el SQL: si
  // no se valida contra lo que la consulta devuelve, una comilla dentro de la
  // llave cierra el identificador y el resto se ejecuta como SQL.
  const error = errorDe(() =>
    engineDePrueba().plan(
      { ...porTrimestreDe2025, order: { 'x" OR (SELECT pg_sleep(5))="': 'asc' } },
      CTX,
    ),
  );

  assert.equal(error.code, 'UNKNOWN_MEMBER');
  assert.equal(error.member, 'x" OR (SELECT pg_sleep(5))="');
  assert.ok(error.suggestion.length > 0, 'el error estructurado trae sugerencia');
});

test('order acepta una medida o una dimensión temporal de la consulta', () => {
  const { sql } = engineDePrueba().plan(
    { ...porTrimestreDe2025, order: { 'reviews.count': 'desc', 'reviews.period': 'asc' } },
    CTX,
  );

  assert.match(sql, /ORDER BY "reviews\.count" DESC, "reviews\.period" ASC/);
});

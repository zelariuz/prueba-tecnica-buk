import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';
import { consultasTipo } from '../src/definitions/consultas-tipo.js';

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
  // El último parámetro es el límite del consumidor: ninguna consulta sale sin LIMIT.
  assert.deepEqual(params, [EMPRESA, 10000]);
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
  assert.deepEqual(params, [EMPRESA, 10000]);
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
  assert.deepEqual(params, [EMPRESA, '2025-01-01', '2025-12-31', 10000]);
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
  assert.deepEqual(params, [EMPRESA, 'completed', 10000]);
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
  // El mensaje nombra las dos entidades en conflicto: quien lo lee sabe cuál
  // es la entidad de hechos y cuál la medida que sobra.
  assert.match(error.suggestion, /\breviews\b/);
  assert.match(error.suggestion, /\bemployees\b/);
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

test('companyId o consumer dentro del JSON cortan con FORBIDDEN_FIELD', () => {
  // El contexto de sesión lo construye el servidor desde el token (ADR 0002):
  // no existe forma de expresar otra empresa ni otra clase de consumidor en la
  // consulta.
  for (const campo of ['companyId', 'consumer']) {
    const error = errorDe(() => engineDePrueba().plan({ ...conteoPorEstado, [campo]: 7 }, CTX));

    assert.equal(error.code, 'FORBIDDEN_FIELD');
    assert.equal(error.member, campo);
    assert.match(error.suggestion, /token/);
  }
});

test('un consumidor desconocido o ausente no obtiene presupuesto', () => {
  const engine = engineDePrueba();

  for (const consumer of [undefined, 'root', 'API']) {
    const error = errorDe(() => engine.plan(conteoPorEstado, { companyId: EMPRESA, consumer }));

    assert.equal(error.code, 'INVALID_CONSUMER');
    assert.equal(error.member, 'consumer');
    assert.match(error.suggestion, /dashboard/);
  }
});

test('el límite efectivo es el menor entre el pedido y el máximo del consumidor', () => {
  const engine = engineDePrueba();

  // El agente tiene el presupuesto más chico: 1000 filas.
  const ctxAgente = { companyId: EMPRESA, consumer: 'agent' };
  const { params: recortado } = engine.plan({ ...porTrimestreDe2025, limit: 50000 }, ctxAgente);
  assert.deepEqual(recortado, [EMPRESA, '2025-01-01', '2025-12-31', 1000]);

  const { params: respetado } = engine.plan({ ...porTrimestreDe2025, limit: 10 }, ctxAgente);
  assert.deepEqual(respetado, [EMPRESA, '2025-01-01', '2025-12-31', 10]);

  // Sin limit pedido, manda el máximo del consumidor: ninguna consulta sale sin
  // LIMIT hacia la base.
  const { sql, params } = engine.plan(porTrimestreDe2025, { companyId: EMPRESA, consumer: 'api' });
  assert.match(sql, /LIMIT \$4$/);
  assert.deepEqual(params, [EMPRESA, '2025-01-01', '2025-12-31', 10000]);
});

const sinRango = {
  measures: ['reviews.count'],
  timeDimensions: [{ dimension: 'reviews.period', granularity: 'quarter' }],
};

test('el consumidor con rango obligatorio no puede consultar sin dateRange', () => {
  const engine = engineDePrueba();

  // Sin dimensión temporal siquiera.
  const sinTemporal = errorDe(() =>
    engine.plan(conteoPorEstado, { companyId: EMPRESA, consumer: 'agent' }),
  );
  assert.equal(sinTemporal.code, 'MISSING_TIME_RANGE');
  assert.equal(sinTemporal.member, 'timeDimensions');
  assert.ok(sinTemporal.suggestion.length > 0, 'el error estructurado trae sugerencia');

  // Con dimensión temporal, pero sin acotar el rango.
  const conTemporal = errorDe(() =>
    engine.plan(sinRango, { companyId: EMPRESA, consumer: 'agent' }),
  );
  assert.equal(conTemporal.code, 'MISSING_TIME_RANGE');
  assert.equal(conTemporal.member, 'reviews.period');
});

test('la misma consulta sin rango la planifica un consumidor sin rango obligatorio', () => {
  const { sql } = engineDePrueba().plan(sinRango, { companyId: EMPRESA, consumer: 'dashboard' });

  assert.match(sql, /GROUP BY TO_CHAR\(DATE_TRUNC\('quarter', reviews\.period\)/);
});

test('un miembro mal escrito corta con UNKNOWN_MEMBER y sugiere el correcto', () => {
  const engine = engineDePrueba();

  const casos = [
    [{ measures: ['reviews.avg_scor'] }, 'reviews.avg_scor', 'reviews.avg_score'],
    [
      { measures: ['reviews.count'], dimensions: ['departments.nam'] },
      'departments.nam',
      'departments.name',
    ],
    // Entidad mal escrita: la sugerencia también la corrige.
    [{ measures: ['review.count'] }, 'review.count', 'reviews.count'],
    [
      {
        measures: ['reviews.count'],
        timeDimensions: [{ dimension: 'reviews.perio', granularity: 'quarter' }],
      },
      'reviews.perio',
      'reviews.period',
    ],
  ];

  for (const [query, escrito, esperada] of casos) {
    const error = errorDe(() => engine.plan(query, CTX));

    assert.equal(error.code, 'UNKNOWN_MEMBER', escrito);
    assert.equal(error.member, escrito);
    assert.match(error.suggestion, new RegExp(esperada.replace('.', '\\.')), escrito);
  }
});

test('pedir una dimensión como medida dice de qué clase es el miembro', () => {
  const error = errorDe(() => engineDePrueba().plan({ measures: ['reviews.status'] }, CTX));

  assert.equal(error.code, 'UNKNOWN_MEMBER');
  assert.equal(error.member, 'reviews.status');
  assert.match(error.suggestion, /dimensión/);
});

test('dos entidades sin relación declarada cortan con NO_JOIN_PATH', () => {
  // Las relaciones son dirigidas: desde `employees` se llega a `departments`,
  // pero nunca a `reviews`, que es quien declara la relación hacia empleados.
  const error = errorDe(() =>
    engineDePrueba().plan(
      { measures: ['employees.headcount'], dimensions: ['reviews.status'] },
      CTX,
    ),
  );

  assert.equal(error.code, 'NO_JOIN_PATH');
  assert.equal(error.member, 'reviews');
  assert.match(error.suggestion, /employees/);
});

test('un filtro de consulta se aplica dentro de la CTE de su entidad', () => {
  const { sql, params } = engineDePrueba().plan(
    {
      measures: ['reviews.count'],
      dimensions: ['reviews.status'],
      filters: [{ member: 'departments.name', operator: 'equals', values: ['Ingeniería'] }],
    },
    CTX,
  );

  // El filtro entra donde se nombra la tabla física, junto al de empresa: el
  // engine llega a departments aunque la consulta no lo pida como dimensión.
  assert.match(sql, /departments AS \([^)]*WHERE company_id = \$1\n {4}AND name = \$2\n\)/);
  assert.deepEqual(params, [EMPRESA, 'Ingeniería', 10000]);
});

test('los operadores in y notEquals se emiten con sus parámetros', () => {
  const engine = engineDePrueba();
  const base = { measures: ['reviews.count'], dimensions: ['reviews.status'] };

  const { sql: conIn, params: deIn } = engine.plan(
    { ...base, filters: [{ member: 'reviews.status', operator: 'in', values: ['completed', 'calibrated'] }] },
    CTX,
  );
  assert.match(conIn, /AND status IN \(\$2, \$3\)/);
  assert.deepEqual(deIn, [EMPRESA, 'completed', 'calibrated', 10000]);

  const { sql: conNot, params: deNot } = engine.plan(
    { ...base, filters: [{ member: 'reviews.status', operator: 'notEquals', values: ['pending'] }] },
    CTX,
  );
  assert.match(conNot, /AND status <> \$2/);
  assert.deepEqual(deNot, [EMPRESA, 'pending', 10000]);
});

test('un filtro de lista sin valores se rechaza en vez de emitir IN ()', () => {
  const engine = engineDePrueba();
  const base = { measures: ['reviews.count'], dimensions: ['reviews.status'] };

  // `IN ()` no es SQL válido: sin esta puerta el error aparecería recién en la
  // base, con un mensaje de sintaxis que no dice qué escribió mal el consumidor.
  for (const operator of ['in', 'notIn']) {
    const error = errorDe(() =>
      engine.plan({ ...base, filters: [{ member: 'reviews.status', operator, values: [] }] }, CTX),
    );

    assert.equal(error.code, 'INVALID_OPERATOR', operator);
    assert.equal(error.member, 'reviews.status', operator);
    assert.match(error.suggestion, /al menos un valor/, operator);
  }

  // Un segmento mal declarado llega por el mismo camino y se rechaza igual.
  const catalog = createCatalog();
  catalog.register({
    ...reviews,
    segments: {
      ...reviews.segments,
      vacio: {
        description: 'Segmento mal declarado: lista de valores vacía.',
        filters: [{ member: 'reviews.status', operator: 'in', values: [] }],
      },
    },
  });
  for (const definicion of [employees, departments]) catalog.register(definicion);

  const desdeSegmento = errorDe(() =>
    createEngine({ catalog }).plan({ ...base, segments: ['reviews.vacio'] }, CTX),
  );
  assert.equal(desdeSegmento.code, 'INVALID_OPERATOR');
  assert.equal(desdeSegmento.member, 'reviews.status');
});

test('un operador que no aplica al tipo de la dimensión corta con INVALID_OPERATOR', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        measures: ['reviews.count'],
        dimensions: ['reviews.status'],
        filters: [{ member: 'reviews.period', operator: 'contains', values: ['2025'] }],
      },
      CTX,
    ),
  );

  assert.equal(error.code, 'INVALID_OPERATOR');
  assert.equal(error.member, 'reviews.period');
  // El mensaje nombra los operadores que sí acepta el tipo.
  assert.match(error.suggestion, /inDateRange/);
});

test('un operador declarado para el tipo pero todavía sin SQL se rechaza, no se ignora', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        measures: ['reviews.count'],
        dimensions: ['reviews.status'],
        filters: [{ member: 'reviews.status', operator: 'contains', values: ['comp'] }],
      },
      CTX,
    ),
  );

  // `contains` es válido para una dimensión de texto y el catálogo lo publica;
  // mientras el planificador no lo emita, aplicarlo a medias sería devolver un
  // número equivocado en silencio.
  assert.equal(error.code, 'UNSUPPORTED_OPERATOR');
  assert.equal(error.member, 'reviews.status');
  assert.match(error.suggestion, /equals/);
});

test('un segmento de la consulta aplica su regla declarada una sola vez', () => {
  const { sql, params } = engineDePrueba().plan(
    {
      measures: ['reviews.count'],
      dimensions: ['departments.name'],
      segments: ['reviews.completed'],
    },
    CTX,
  );

  // La regla "evaluación completada" la escribe el dueño del módulo una vez; el
  // consumidor la nombra y nunca la reescribe (ADR 0005).
  assert.match(sql, /reviews AS \([^)]*WHERE company_id = \$1\n {4}AND status = \$2\n\)/);
  assert.deepEqual(params, [EMPRESA, 'completed', 10000]);
});

test('un segmento inexistente corta con UNKNOWN_MEMBER y sugiere el correcto', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      { measures: ['reviews.count'], dimensions: ['reviews.status'], segments: ['reviews.complete'] },
      CTX,
    ),
  );

  assert.equal(error.code, 'UNKNOWN_MEMBER');
  assert.equal(error.member, 'reviews.complete');
  assert.match(error.suggestion, /reviews\.completed/);
});

// Las CTE del plan, cada una con su nombre: es donde vive el filtro de empresa
// y por tanto donde se comprueba el invariante de aislamiento (ADR 0003).
function ctesDe(sql) {
  const bloque = sql.slice(sql.indexOf('WITH ') + 'WITH '.length, sql.indexOf('\nSELECT '));
  return bloque.split(/\),\n/).map((cte) => cte.trim());
}

test('toda consulta tipo planifica y filtra por empresa en cada una de sus CTE', () => {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  for (const consulta of consultasTipo) catalog.registerQuery(consulta);
  const engine = createEngine({ catalog });

  // Un parámetro de más lo ignora la consulta que no lo declara.
  const params = { dateRange: ['2025-01-01', '2025-12-31'] };

  assert.ok(consultasTipo.length >= 3, 'el módulo registra al menos tres consultas tipo');
  for (const { name } of consultasTipo) {
    const { sql, params: valores } = engine.plan(catalog.query(name, params), CTX);

    const ctes = ctesDe(sql);
    assert.ok(ctes.length > 0, `${name} genera al menos una CTE`);
    for (const cte of ctes) {
      assert.match(cte, /WHERE company_id = \$1/, `${name}: la CTE ${cte.split(' ')[0]} filtra por empresa`);
    }
    // Ninguna tabla queda fuera: tantos filtros de empresa como CTE.
    assert.equal(sql.match(/company_id = \$1/g).length, ctes.length, name);
    assert.equal(valores[0], EMPRESA, `${name}: la empresa es el primer parámetro`);
  }
});

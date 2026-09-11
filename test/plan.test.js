import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { postgres as dialectoPostgres } from '../src/dialect/postgres.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';
import { consultasTipo } from '../src/definitions/consultas-tipo.js';
import { registrarModulos } from '../src/definitions/index.js';

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

const completitudPorDepartamento = {
  measures: ['reviews.completion_rate'],
  dimensions: ['departments.name'],
};

test('la derivada ratio divide las medidas ya agregadas, no fila por fila', () => {
  const { sql, params } = engineDePrueba().plan(completitudPorDepartamento, CTX);

  // Dos COUNT son enteros y 3/4*100 daría 0: la razón convierte a numérico y
  // protege el denominador con NULLIF (ADR 0004). La fórmula se escribe sobre
  // los alias de la consulta agregada, así que solo puede ver valores ya
  // agregados: la garantía es estructural, no una convención.
  assert.match(
    sql,
    /"reviews\.completed_count"::numeric \/ NULLIF\("reviews\.count", 0\) \* 100 AS "reviews\.completion_rate"/,
  );

  // Sus medidas base se agregan aunque el consumidor no las haya pedido.
  assert.match(
    sql,
    /COUNT\(\*\) FILTER \(WHERE reviews\.status = \$2\) AS "reviews\.completed_count"/,
  );
  assert.match(sql, /COUNT\(\*\) AS "reviews\.count"/);

  // Y no salen en las filas: el consumidor recibe lo que pidió.
  const seleccionExterna = sql.slice(sql.indexOf('\nSELECT '), sql.indexOf('\nFROM ('));
  assert.match(seleccionExterna, /"departments\.name"/);
  assert.ok(
    !seleccionExterna.includes('"reviews.count"') ||
      seleccionExterna.includes('NULLIF("reviews.count", 0)'),
    'la medida base no pedida no aparece como columna de salida',
  );
  assert.deepEqual(params, [EMPRESA, 'completed', 10000]);
});

test('una razón apoyada en otra razón se emite con la fórmula de aquella dentro', () => {
  const catalog = createCatalog();
  catalog.register({
    ...reviews,
    measures: {
      ...reviews.measures,
      completion_rate_por_evaluacion: {
        type: 'ratio',
        numerator: 'completion_rate',
        denominator: 'count',
        description: 'Razón declarada sobre otra razón; existe para probar el orden de cálculo.',
      },
    },
  });
  for (const definicion of [employees, departments]) catalog.register(definicion);

  const { sql } = createEngine({ catalog }).plan(
    {
      measures: ['reviews.completion_rate_por_evaluacion'],
      dimensions: ['departments.name'],
    },
    CTX,
  );

  // El catálogo entrega las derivadas en orden de dependencia, así que al
  // escribir esta razón la de adentro ya está resuelta y entra entre paréntesis.
  assert.match(
    sql,
    /\("reviews\.completed_count"::numeric \/ NULLIF\("reviews\.count", 0\) \* 100\)::numeric \/ NULLIF\("reviews\.count", 0\) AS "reviews\.completion_rate_por_evaluacion"/,
  );
  // La medida base que comparten las dos razones se agrega una sola vez.
  assert.equal(sql.match(/AS "reviews\.count"/g).length, 1);
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
  segments: ['reviews.completed'],
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
  assert.deepEqual(params, [EMPRESA, '2025-01-01', '2025-12-31', 'completed', 'completed', 500]);
});

test('el SQL de la completitud por departamento es el del snapshot del repo', () => {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  for (const consulta of consultasTipo) catalog.registerQuery(consulta);

  const { sql, params } = createEngine({ catalog }).plan(
    catalog.query('completitud-por-departamento', { dateRange: ['2025-01-01', '2025-12-31'] }),
    CTX,
  );

  // Segundo snapshot legible del repo, junto al del caso obligatorio: es donde
  // se ve de un vistazo la consulta agregada y la fórmula escrita sobre ella.
  const esperado = readFileSync(new URL('./snapshots/completion-rate.sql', import.meta.url), 'utf8');
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

// Desde el 09-09 ninguna clase de la tabla real exige rango (ADR 0009), pero el
// mecanismo sigue vivo para quien inyecte su propia tabla con
// `createEngine({ presupuestos })`. Por eso este test entra por esa costura: la
// clase `estricta` no existe en `src/budgets.js` a propósito.
const CLASE_ESTRICTA = {
  timeoutMs: 5_000,
  maxFilas: 1_000,
  rangoObligatorio: true,
  cacheTtlMs: 30_000,
};

function engineConClaseEstricta() {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  return createEngine({ catalog, presupuestos: { estricta: CLASE_ESTRICTA } });
}

test('el consumidor con rango obligatorio no puede consultar sin dateRange', () => {
  const engine = engineConClaseEstricta();

  // Sin dimensión temporal siquiera.
  const sinTemporal = errorDe(() =>
    engine.plan(conteoPorEstado, { companyId: EMPRESA, consumer: 'estricta' }),
  );
  assert.equal(sinTemporal.code, 'MISSING_TIME_RANGE');
  assert.equal(sinTemporal.member, 'timeDimensions');
  assert.ok(sinTemporal.suggestion.length > 0, 'el error estructurado trae sugerencia');

  // Con dimensión temporal, pero sin acotar el rango.
  const conTemporal = errorDe(() =>
    engine.plan(sinRango, { companyId: EMPRESA, consumer: 'estricta' }),
  );
  assert.equal(conTemporal.code, 'MISSING_TIME_RANGE');
  assert.equal(conTemporal.member, 'reviews.period');
});

// La contracara de lo anterior, y el motivo del ADR 0009: con rango obligatorio
// la clase `agent` no podía responder "cuántos empleados hay por departamento",
// porque `employees` no publica dimensión temporal ni hay camino de joins hacia
// una. Ahora sí planifica, con el tope de filas de su clase.
test('la clase agent planifica una consulta sin timeDimensions', () => {
  const engine = engineDePrueba();

  const { sql, params } = engine.plan(
    { measures: ['employees.headcount'], dimensions: ['departments.name'] },
    { companyId: EMPRESA, consumer: 'agent' },
  );

  assert.match(sql, /GROUP BY departments\.name/);
  assert.equal(params.at(-1), 1000, 'el LIMIT sigue siendo el tope de la clase agent');
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
  // QA M4 (10-09): la sugerencia dice qué hacer, no sólo qué falló.
  assert.match(error.suggestion, /pide una medida de reviews/);
  assert.match(error.suggestion, /declara la relación en la definición de employees/);
});

// Una entidad de otra fuente: otra base, otro dialecto. En esta fase el
// dialecto es el mismo, pero la fuente no, y eso alcanza para que un JOIN entre
// las dos sea imposible: no hay una sola consulta que las alcance.
const visitas = {
  name: 'visitas',
  source: 'otra',
  table: 'visitas',
  primaryKey: 'id',
  companyColumn: 'company_id',
  description: 'Visitas al portal del empleado, en la base del módulo de portal.',
  dimensions: {
    canal: { column: 'canal', type: 'string', description: 'Canal por el que llegó la visita.' },
  },
  measures: { count: { type: 'count', description: 'Cantidad de visitas.' } },
};

test('una consulta que mezcla entidades de dos fuentes corta con NO_JOIN_PATH', () => {
  const fuentes = {
    postgres: { dialecto: dialectoPostgres },
    otra: { dialecto: dialectoPostgres },
  };
  const catalog = createCatalog({ fuentes });
  for (const definicion of [reviews, employees, departments, visitas]) catalog.register(definicion);

  const error = errorDe(() =>
    createEngine({ catalog, fuentes }).plan(
      { measures: ['reviews.count'], dimensions: ['visitas.canal'] },
      CTX,
    ),
  );

  // Dos bases no se cruzan con un JOIN: la sugerencia nombra las dos fuentes
  // para que quede claro que el problema no es una relación que falta.
  assert.equal(error.code, 'NO_JOIN_PATH');
  assert.equal(error.member, 'visitas');
  assert.match(error.suggestion, /postgres/);
  assert.match(error.suggestion, /otra/);
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
  // La composición real: todos los módulos y todas sus consultas tipo. El
  // invariante de empresa vale para lo que se sirve, no para una selección.
  registrarModulos(catalog);
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

// Un pool que no tolera que lo toquen: si el dry-run abriera una conexión o
// consultara la base, el test se entera por el error y no por una convención.
const poolIntocable = {
  connect() {
    throw new Error('el dry-run no debe abrir una conexión');
  },
  query() {
    throw new Error('el dry-run no debe consultar la base');
  },
};

test('el dry-run devuelve el plan lógico junto al SQL, sin abrir una conexión', () => {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
  const engine = createEngine({ catalog, pool: poolIntocable });

  const { sql, params, plan } = engine.plan(
    { ...completitudPorDepartamento, limit: 500 },
    CTX,
  );

  assert.match(sql, /^WITH reviews AS \(/);
  assert.deepEqual(params, [EMPRESA, 'completed', 500]);

  // El plan lógico es lo que un agente lee para decidir si vale la pena
  // ejecutar: de dónde salen los datos, por dónde pasa, qué se agrega y con qué
  // presupuesto (historia 25).
  assert.equal(plan.entity, 'reviews');
  // Los joins se describen por la relación declarada, nunca por columnas: el
  // plan lógico sale por HTTP a cualquier token y no puede nombrar el esquema
  // físico (ADR 0008).
  assert.deepEqual(plan.joins, [
    { from: 'reviews', to: 'employees', via: 'employee', type: 'many_to_one' },
    { from: 'employees', to: 'departments', via: 'department', type: 'many_to_one' },
  ]);
  assert.deepEqual(plan.dimensions, ['departments.name']);
  assert.deepEqual(plan.measures, ['reviews.completion_rate']);
  // Las medidas base que la razón necesita, aunque el consumidor no las pidió.
  assert.deepEqual(plan.baseMeasures, ['reviews.completed_count', 'reviews.count']);
  assert.deepEqual(plan.derived, [
    {
      name: 'reviews.completion_rate',
      numerator: 'reviews.completed_count',
      denominator: 'reviews.count',
      scale: 100,
    },
  ]);
  // Filtros: los globales por separado de los que cada medida trae puestos.
  assert.deepEqual(plan.globalFilters, []);
  assert.deepEqual(plan.filtersByMeasure, {
    'reviews.completed_count': [
      { member: 'reviews.status', operator: 'equals', values: ['completed'] },
    ],
  });
  assert.equal(plan.budget.consumer, 'api');
  assert.equal(plan.budget.timeoutMs, 15000);
  assert.equal(plan.budget.rowLimit, 500, 'el límite efectivo, ya recortado al máximo de la clase');
  assert.deepEqual(plan.warnings, []);
});

test('el dry-run de una consulta con filtro global trae el filtro y su advertencia', () => {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);

  const { plan } = createEngine({ catalog, pool: poolIntocable }).plan(
    {
      ...completitudPorDepartamento,
      filters: [{ member: 'reviews.status', operator: 'equals', values: ['completed'] }],
    },
    CTX,
  );

  assert.deepEqual(plan.globalFilters, [
    { member: 'reviews.status', operator: 'equals', values: ['completed'] },
  ]);
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].member, 'reviews.completion_rate');
});

test('una consulta inválida en dry-run vuelve como error estructurado, sin tocar la base', () => {
  const catalog = createCatalog();
  for (const definicion of [reviews, employees, departments]) catalog.register(definicion);

  const error = errorDe(() =>
    createEngine({ catalog, pool: poolIntocable }).plan({ measures: ['reviews.completion_rat'] }, CTX),
  );

  assert.equal(error.code, 'UNKNOWN_MEMBER');
  assert.equal(error.member, 'reviews.completion_rat');
  assert.match(error.suggestion, /reviews\.completion_rate/);
});

// Un módulo puede declarar una relación hacia una entidad que todavía no se
// registró —o que nunca se registrará, porque su módulo no está instalado—. Eso
// es una capa semántica incompleta, no un servidor roto: la arista simplemente
// no existe.
test('una relación hacia una entidad no registrada no rompe una consulta que no la necesita', () => {
  const catalog = createCatalog();
  // `employees` declara una relación hacia `departments`, que aquí no se registra.
  for (const definicion of [reviews, employees]) catalog.register(definicion);

  const { sql } = createEngine({ catalog, pool: poolIntocable }).plan(conteoPorEstado, CTX);

  assert.match(sql, /WITH reviews AS \(/);
});

test('el destino alcanzable sólo por la entidad ausente cae en NO_JOIN_PATH que la nombra', () => {
  const catalog = createCatalog();
  // El camino de `reviews` a `departments` pasa por `employees`, que falta.
  for (const definicion of [reviews, departments]) catalog.register(definicion);

  const error = errorDe(() =>
    createEngine({ catalog, pool: poolIntocable }).plan(
      { measures: ['reviews.count'], dimensions: ['departments.name'] },
      CTX,
    ),
  );

  assert.equal(error.code, 'NO_JOIN_PATH');
  assert.equal(error.member, 'departments');
  assert.match(error.suggestion, /employees/);
});

// Guardia de configuración: el catálogo puede conocer una fuente que el engine
// no tiene configurada (el catálogo sólo necesita el dialecto para validar
// tipos; el engine necesita además el pool). Sin guardia, `fuentes[fuente]?.dialecto`
// da `undefined` y el planificador revienta con un TypeError al pedirle
// `dateTrunc`: un error que no dice nada de lo que hay que arreglar.
test('una fuente del catálogo que el engine no configuró es un error de configuración', () => {
  const catalog = createCatalog({
    fuentes: { postgres: { dialecto: dialectoPostgres }, otra: { dialecto: dialectoPostgres } },
  });
  for (const definicion of [reviews, employees, departments, visitas]) catalog.register(definicion);

  // El engine sólo tiene configurada la fuente por defecto.
  const engine = createEngine({ catalog, fuentes: { postgres: { dialecto: dialectoPostgres } } });
  const error = errorDe(() => engine.plan({ measures: ['visitas.count'] }, CTX));

  // No es un SemanticError: el consumidor no puede arreglar esto cambiando lo
  // que pidió. Es el servidor el que está mal armado.
  assert.equal(error.code, undefined);
  assert.match(error.message, /otra/);
  assert.match(error.message, /visitas/);
  assert.match(error.message, /catálogo/);
});

// --- Hallazgo 2 del abogado del diablo: `sum` se aceptaba al registrar y no
// tenía SQL, y no existía `count_distinct`. Los dos tipos entran por el mismo
// seam que todos: una medida más de una definición.

// Definición de prueba: una suma sobre la misma columna `score` del caso.
// Ninguna pregunta del enunciado pide una suma de scores, así que la definición
// vive aquí; lo que se prueba es que el tipo que el catálogo acepta tenga SQL.
const reviewsConSuma = {
  ...reviews,
  measures: {
    ...reviews.measures,
    score_total: {
      type: 'sum',
      column: 'score',
      description: 'Suma de los scores de todas las evaluaciones.',
    },
    score_completado: {
      type: 'sum',
      column: 'score',
      segment: 'completed',
      description: 'Suma de los scores de las evaluaciones completadas.',
    },
  },
};

test('una medida sum emite SUM de su columna', () => {
  const catalog = createCatalog();
  for (const definicion of [reviewsConSuma, employees, departments]) catalog.register(definicion);

  const { sql } = createEngine({ catalog }).plan(
    { measures: ['reviews.score_total'], dimensions: ['reviews.status'] },
    CTX,
  );

  assert.match(sql, /SUM\(reviews\.score\) AS "reviews\.score_total"/);
});

test('una medida sum con segmento emite SUM filtrado, igual que un count', () => {
  const catalog = createCatalog();
  for (const definicion of [reviewsConSuma, employees, departments]) catalog.register(definicion);

  const { sql, params } = createEngine({ catalog }).plan(
    { measures: ['reviews.score_completado'] },
    CTX,
  );

  assert.match(sql, /SUM\(reviews\.score\) FILTER \(WHERE reviews\.status = \$2\)/);
  assert.deepEqual(params, [EMPRESA, 'completed', 10000]);
});

test('una medida count_distinct emite COUNT(DISTINCT columna) con su filtro', () => {
  const { sql, params } = engineDePrueba().plan(
    { measures: ['reviews.completed_employees'] },
    CTX,
  );

  assert.match(
    sql,
    /COUNT\(DISTINCT reviews\.employee_id\) FILTER \(WHERE reviews\.status = \$2\) AS "reviews\.completed_employees"/,
  );
  assert.deepEqual(params, [EMPRESA, 'completed', 10000]);
});

// --- Hallazgo 3 del abogado del diablo: `equals` y `notEquals` comparan con UN
// valor. Antes se tomaba `values[0]` y se ignoraba el resto: dos valores daban
// el número de uno solo y una lista vacía daba `= NULL`, que en SQL no es falso
// sino desconocido — cero filas y un 200, sin que nada avisara.
test('equals con más de un valor se rechaza y manda a in', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        measures: ['reviews.count'],
        filters: [
          { member: 'reviews.status', operator: 'equals', values: ['completed', 'pending'] },
        ],
      },
      CTX,
    ),
  );

  assert.equal(error.code, 'INVALID_OPERATOR');
  assert.equal(error.member, 'reviews.status');
  assert.match(error.suggestion, /exactamente un valor/);
  assert.match(error.suggestion, /\bin\b/);
});

test('equals y notEquals con lista vacía o sin values se rechazan', () => {
  for (const operator of ['equals', 'notEquals']) {
    for (const values of [[], undefined, 'completed']) {
      const error = errorDe(() =>
        engineDePrueba().plan(
          {
            measures: ['reviews.count'],
            filters: [{ member: 'reviews.status', operator, ...(values === undefined ? {} : { values }) }],
          },
          CTX,
        ),
      );

      assert.equal(error.code, 'INVALID_OPERATOR', `${operator} con ${JSON.stringify(values)}`);
      assert.equal(error.member, 'reviews.status');
    }
  }
});

test('equals con un solo valor sigue emitiendo la misma comparación', () => {
  const { sql, params } = engineDePrueba().plan(
    {
      measures: ['reviews.count'],
      filters: [{ member: 'reviews.status', operator: 'equals', values: ['completed'] }],
    },
    CTX,
  );

  assert.match(sql, /WHERE company_id = \$1\n {4}AND status = \$2/);
  assert.deepEqual(params, [EMPRESA, 'completed', 10000]);
});

// --- Hallazgo 4 del abogado del diablo: la forma de la consulta no se
// validaba. Lo primero que prueba un evaluador —una consulta sin `measures`, un
// `granularity` mal escrito, `order: 'ASC'`— salía como 500 con un mensaje que
// culpaba al servidor. `INVALID_QUERY` es la puerta de forma: se rechaza sin
// mirar el catálogo, con `member` y sugerencia como cualquier otro error.
// Desde el ADR 0010 la consulta sin `measures` es válida si pide dimensiones;
// lo que sigue sin existir es la consulta que no pide nada.
test('una consulta que no pide nada se rechaza con INVALID_QUERY', () => {
  for (const consulta of [{}, { measures: [] }, { measures: [], timeDimensions: [] }]) {
    const error = errorDe(() => engineDePrueba().plan(consulta, CTX));
    assert.equal(error.code, 'INVALID_QUERY', JSON.stringify(consulta));
    assert.equal(error.member, 'measures');
    assert.match(error.suggestion, /al menos una medida/);
  }
});

test('las listas de la consulta tienen que ser listas', () => {
  for (const campo of ['measures', 'dimensions', 'segments', 'filters', 'timeDimensions']) {
    const error = errorDe(() =>
      engineDePrueba().plan({ measures: ['reviews.count'], [campo]: 'reviews.status' }, CTX),
    );
    assert.equal(error.code, 'INVALID_QUERY', campo);
    assert.equal(error.member, campo);
    assert.ok(error.suggestion.length > 0);
  }
});

test('una dimensión temporal sin granularidad válida se rechaza con INVALID_QUERY', () => {
  for (const temporal of [
    { dimension: 'reviews.period' },
    { dimension: 'reviews.period', granularity: 'trimestre' },
    { dimension: 'reviews.period', granularity: 'QUARTER' },
  ]) {
    const error = errorDe(() =>
      engineDePrueba().plan({ measures: ['reviews.count'], timeDimensions: [temporal] }, CTX),
    );
    assert.equal(error.code, 'INVALID_QUERY', JSON.stringify(temporal));
    assert.equal(error.member, 'timeDimensions[0].granularity');
    // La sugerencia trae la lista cerrada: un agente que se equivocó puede
    // corregirse sin ir a buscar el catálogo.
    assert.match(error.suggestion, /day, week, month, quarter, year/);
  }
});

test('una dirección de orden que no es asc ni desc se rechaza con INVALID_QUERY', () => {
  for (const direccion of ['ASC', 'ascending', 1, null]) {
    const error = errorDe(() =>
      engineDePrueba().plan(
        { measures: ['reviews.count'], order: { 'reviews.count': direccion } },
        CTX,
      ),
    );
    assert.equal(error.code, 'INVALID_QUERY', String(direccion));
    assert.equal(error.member, 'order.reviews.count');
    assert.match(error.suggestion, /asc/);
  }
});

test('un limit que no es un entero positivo se rechaza con INVALID_QUERY', () => {
  for (const limit of [-1, 0, 1.5, 'abc', null]) {
    const error = errorDe(() =>
      engineDePrueba().plan({ measures: ['reviews.count'], limit }, CTX),
    );
    assert.equal(error.code, 'INVALID_QUERY', String(limit));
    assert.equal(error.member, 'limit');
  }
});

test('la consulta vacía no pregunta por la fuente: el error es del consumidor y no del servidor', () => {
  // Antes, una consulta sin medidas llegaba a resolver la fuente de
  // `medidas[0]?.entidad` —`undefined`— y salía como error de configuración del
  // servidor ("está mal armado el servidor"), que es un diagnóstico falso.
  // Desde el ADR 0010 la que no tiene entidad de hechos de dónde salir es la
  // consulta que no pide nada; la que pide dimensiones la saca de la primera.
  const error = errorDe(() => engineDePrueba().plan({}, CTX));
  assert.equal(error.code, 'INVALID_QUERY');
  assert.doesNotMatch(error.suggestion, /engine|configurada/);
});

// --- ADR 0010: una consulta sin medidas es el GROUP BY sin agregados, o sea
// los valores distintos de sus dimensiones. Hasta el 09-09 la puerta de forma
// la rechazaba con INVALID_QUERY: "cuáles departamentos hay" no tenía
// traducción y el agente de la demo se quedaba sin JSON que escribir.

const valoresDeDimension = {
  dimensions: ['departments.name'],
  order: { 'departments.name': 'asc' },
};

const TABLERO = { companyId: EMPRESA, consumer: 'dashboard' };

test('una consulta sin medidas agrupa por sus dimensiones y no agrega nada', () => {
  const { sql, params } = engineDePrueba().plan(valoresDeDimension, TABLERO);

  // Cuarto snapshot legible del repo: la consulta de valores distintos, con su
  // CTE filtrada por empresa, su GROUP BY y su LIMIT, y sin una sola función de
  // agregación.
  const esperado = readFileSync(
    new URL('./snapshots/valores-de-dimension.sql', import.meta.url),
    'utf8',
  );
  assert.equal(sql, esperado.trimEnd());
  assert.deepEqual(params, [EMPRESA, 5000]);
});

test('sin medidas la entidad de hechos es la de la primera dimensión', () => {
  const { plan } = engineDePrueba().plan(valoresDeDimension, TABLERO);

  assert.equal(plan.entity, 'departments');
  assert.deepEqual(plan.measures, []);
  assert.deepEqual(plan.baseMeasures, []);
  assert.deepEqual(plan.dimensions, ['departments.name']);
  assert.deepEqual(plan.joins, []);
});

test('sin medidas ni dimensiones la consulta sigue siendo INVALID_QUERY', () => {
  for (const consulta of [{}, { measures: [] }, { measures: [], dimensions: [] }]) {
    const error = errorDe(() => engineDePrueba().plan(consulta, CTX));
    assert.equal(error.code, 'INVALID_QUERY', JSON.stringify(consulta));
    assert.equal(error.member, 'measures');
    assert.match(error.suggestion, /al menos una medida o una dimensión/);
  }
});

test('sin medidas las dimensiones de otra entidad se alcanzan por el mismo camino de joins', () => {
  const { sql, plan } = engineDePrueba().plan(
    { dimensions: ['employees.active', 'departments.name'] },
    TABLERO,
  );

  assert.equal(plan.entity, 'employees');
  assert.match(sql, /JOIN departments ON employees\.department_id = departments\.id/);
  assert.match(sql, /GROUP BY employees\.active, departments\.name/);
  assert.ok(!/COUNT|AVG|SUM/.test(sql), 'una consulta sin medidas no agrega nada');
});

test('sin medidas una dimensión inalcanzable desde la primera sigue siendo NO_JOIN_PATH', () => {
  // `departments` no declara ninguna relación: pedir primero su dimensión deja
  // a `employees` fuera del alcance del BFS. Es la consecuencia visible de que
  // la entidad de hechos sea la de la PRIMERA dimensión.
  const error = errorDe(() =>
    engineDePrueba().plan({ dimensions: ['departments.name', 'employees.active'] }, TABLERO),
  );

  assert.equal(error.code, 'NO_JOIN_PATH');
  assert.equal(error.member, 'employees');
});

test('sin dimensiones la entidad de hechos es la de la primera dimensión temporal', () => {
  const { sql, plan } = engineDePrueba().plan(
    {
      timeDimensions: [{ dimension: 'reviews.period', granularity: 'year' }],
      order: { 'reviews.period': 'asc' },
    },
    TABLERO,
  );

  assert.equal(plan.entity, 'reviews');
  assert.deepEqual(plan.dimensions, ['reviews.period']);
  assert.match(sql, /WITH reviews AS \(\n  SELECT period\n  FROM performance_reviews\n  WHERE company_id = \$1\n\)/);
  assert.match(sql, /GROUP BY TO_CHAR\(DATE_TRUNC\('year', reviews\.period\), 'YYYY-MM-DD'\)/);
});

test('la consulta sin medidas sigue aislada por empresa dentro de cada CTE', () => {
  const { sql, params } = engineDePrueba().plan(
    { dimensions: ['employees.active', 'departments.name'] },
    TABLERO,
  );

  for (const entidad of ['employees', 'departments']) {
    assert.match(sql, new RegExp(`${entidad} AS \\(\\n[^)]*WHERE company_id = \\$1`));
  }
  assert.equal(params[0], EMPRESA);
  assert.ok(!sql.includes(String(EMPRESA)), 'la empresa viaja como parámetro');
});

// --- ADR 0011: una dimensión temporal puede traer `dateRange` y no traer
// `granularity`. Entonces la fecha SÓLO filtra —el rango sigue viviendo dentro
// de la CTE de su entidad— y no aparece como columna del SELECT, del GROUP BY
// ni de las filas. Es la forma de la pregunta literal del enunciado: "la tasa
// de asistencia por departamento durante los últimos tres meses" pide un número
// por departamento, no uno por departamento y mes.

const asistenciaPorDepartamentoSinMes = {
  measures: ['attendance.attendance_rate'],
  dimensions: ['departments.name'],
  timeDimensions: [{ dimension: 'attendance.date', dateRange: ['2025-06-01', '2025-08-31'] }],
};

function engineConTodosLosModulos() {
  const catalog = createCatalog();
  registrarModulos(catalog);
  return createEngine({ catalog });
}

test('una dimensión temporal sin granularidad sólo filtra: no entra al SELECT ni al GROUP BY', () => {
  const { sql, params, plan } = engineConTodosLosModulos().plan(
    asistenciaPorDepartamentoSinMes,
    TABLERO,
  );

  // Quinto snapshot legible del repo: el rango dentro de la CTE de asistencia y
  // una sola columna de agrupación, la del departamento.
  const esperado = readFileSync(
    new URL('./snapshots/rango-sin-granularidad.sql', import.meta.url),
    'utf8',
  );
  assert.equal(sql, esperado.trimEnd());
  assert.ok(!/DATE_TRUNC/.test(sql), 'sin granularidad no hay nada que truncar');
  assert.ok(!sql.includes('"attendance.date"'), 'la fecha no es una columna de salida');
  assert.deepEqual(plan.dimensions, ['departments.name']);
  assert.deepEqual(params, [EMPRESA, '2025-06-01', '2025-08-31', true, 5000]);
});

test('el rango sin granularidad sigue viviendo dentro de la CTE de su entidad', () => {
  const { sql } = engineConTodosLosModulos().plan(asistenciaPorDepartamentoSinMes, TABLERO);

  assert.match(sql, /attendance AS \(\n[^)]*AND date >= \$2\n {4}AND date <= \$3/);
});

test('una dimensión temporal sin dateRange y sin granularidad se rechaza con INVALID_QUERY', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      { measures: ['reviews.count'], timeDimensions: [{ dimension: 'reviews.period' }] },
      CTX,
    ),
  );

  // Una dimensión temporal que ni filtra ni agrupa no dice nada: o trae rango, o
  // trae granularidad, o no va.
  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'timeDimensions[0].granularity');
  assert.match(error.suggestion, /dateRange/);
});

test('una consulta que sólo trae una dimensión temporal que filtra no pide nada', () => {
  const error = errorDe(() =>
    engineDePrueba().plan(
      {
        timeDimensions: [
          { dimension: 'reviews.period', dateRange: ['2025-01-01', '2025-12-31'] },
        ],
      },
      CTX,
    ),
  );

  assert.equal(error.code, 'INVALID_QUERY');
  assert.equal(error.member, 'measures');
  assert.match(error.suggestion, /al menos una medida o una dimensión/);
});

test('la entidad de un rango que sólo filtra entra al camino de joins como cualquier otra', () => {
  // Sin esto, el rango de una entidad que la consulta no alcanza se quedaría en
  // una CTE que nadie emite: el filtro desaparecería en silencio y la consulta
  // devolvería un número mayor que el pedido. `attendance` no llega a `reviews`
  // por ninguna relación, así que la respuesta correcta es el mismo
  // NO_JOIN_PATH que daría con granularidad.
  const error = errorDe(() =>
    engineConTodosLosModulos().plan(
      {
        measures: ['attendance.count'],
        timeDimensions: [
          { dimension: 'reviews.period', dateRange: ['2025-01-01', '2025-12-31'] },
        ],
      },
      TABLERO,
    ),
  );

  assert.equal(error.code, 'NO_JOIN_PATH');
  assert.equal(error.member, 'reviews');
});

// --- ADR 0012: relleno de series densas. Una dimensión temporal puede traer
// `fillMissing: true` y entonces el resultado devuelve TODOS los buckets del
// rango, incluso los que no tienen ninguna fila, para que un gráfico no salte
// días. La bandera es del consumidor —la necesita quien dibuja, no la entidad—,
// así que viaja en la consulta y nunca en la definición del módulo.

const asistenciaPorDiaRellenada = {
  measures: ['attendance.count', 'attendance.attendance_rate'],
  dimensions: ['departments.name'],
  timeDimensions: [
    {
      dimension: 'attendance.date',
      granularity: 'day',
      dateRange: ['2025-06-01', '2025-06-30'],
      fillMissing: true,
    },
  ],
  order: { 'departments.name': 'asc', 'attendance.date': 'asc' },
};

test('el SQL del relleno con dimensión y tiempo es el del snapshot del repo', () => {
  const { sql, params } = engineConTodosLosModulos().plan(asistenciaPorDiaRellenada, TABLERO);

  // Sexto snapshot legible del repo: las tres etapas del relleno una debajo de
  // otra —la serie de buckets, los ejes no temporales y la agregada de
  // siempre— y afuera el producto de las dos primeras con el LEFT JOIN.
  const esperado = readFileSync(new URL('./snapshots/relleno-de-serie.sql', import.meta.url), 'utf8');
  assert.equal(sql, esperado.trimEnd());

  // Rellenar no agrega ni un parámetro: la serie se genera con los mismos $2 y
  // $3 que ya filtran la CTE, así que la numeración es la de siempre.
  assert.deepEqual(params, [EMPRESA, '2025-06-01', '2025-06-30', true, 5000]);
  assert.match(sql, /DATE_TRUNC\('day', \$2::date\)/);
  assert.ok(!sql.includes(String(EMPRESA)), 'la empresa viaja como parámetro');
});

test('el conteo se rellena con cero y la razón queda nula: lo decide el tipo de la medida', () => {
  const { sql } = engineConTodosLosModulos().plan(asistenciaPorDiaRellenada, TABLERO);

  // `count` sobre un bucket sin filas vale 0 de verdad: hubo cero eventos.
  assert.match(sql, /COALESCE\(agregada\."attendance\.count", 0\) AS "attendance\.count"/);
  // La razón NO se rellena: se calcula afuera sobre el resultado ya denso y su
  // denominador en 0 la anula sola por el NULLIF que ya estaba.
  assert.match(
    sql,
    /NULLIF\(COALESCE\(agregada\."attendance\.count", 0\), 0\) \* 100 AS "attendance\.attendance_rate"/,
  );
  assert.ok(
    !/COALESCE\([^)]*attendance_rate/.test(sql),
    'una razón rellenada con cero sería un número falso',
  );
});

test('sin dimensiones no temporales el relleno no arma ejes ni CROSS JOIN', () => {
  const { sql } = engineConTodosLosModulos().plan(
    {
      measures: ['attendance.count'],
      timeDimensions: [
        {
          dimension: 'attendance.date',
          granularity: 'month',
          dateRange: ['2025-01-15', '2025-06-30'],
          fillMissing: true,
        },
      ],
      order: { 'attendance.date': 'asc' },
    },
    TABLERO,
  );

  // Sin eje que multiplicar, la serie sola es el esqueleto del resultado.
  assert.ok(!sql.includes('ejes'), 'no hay dimensión no temporal que distinguir');
  assert.ok(!sql.includes('CROSS JOIN'), 'sin ejes no hay producto que armar');
  assert.match(sql, /FROM serie\nLEFT JOIN agregada ON agregada\."attendance\.date" = serie\.bucket\n/);
  // El inicio del rango se trunca antes de generar: un rango que parte el 15 de
  // enero con granularidad `month` tiene que dar 01/01, 01/02…, no 15/01, 15/02.
  assert.match(sql, /DATE_TRUNC\('month', \$2::date\)/);
});

test('la bandera en false o ausente emite exactamente el mismo SQL de siempre', () => {
  const engine = engineConTodosLosModulos();
  const sinBandera = {
    measures: ['attendance.count'],
    dimensions: ['departments.name'],
    timeDimensions: [
      { dimension: 'attendance.date', granularity: 'day', dateRange: ['2025-06-01', '2025-06-30'] },
    ],
  };
  const conBanderaEnFalse = {
    ...sinBandera,
    timeDimensions: [{ ...sinBandera.timeDimensions[0], fillMissing: false }],
  };

  const { sql, params } = engine.plan(sinBandera, TABLERO);
  assert.deepEqual(engine.plan(conBanderaEnFalse, TABLERO).sql, sql);
  assert.deepEqual(engine.plan(conBanderaEnFalse, TABLERO).params, params);
  // Y ese SQL es el de siempre: una sola etapa, sin ninguna de las tres del
  // relleno. Los snapshots de arriba son la otra mitad de esta comprobación.
  for (const etapa of ['serie AS (', 'ejes AS (', 'agregada AS (']) {
    assert.ok(!sql.includes(etapa), `sin fillMissing no existe la etapa ${etapa}`);
  }
});

test('fillMissing sin granularidad, sin rango o con un valor no booleano se rechaza', () => {
  const casos = [
    [
      { dimension: 'attendance.date', dateRange: ['2025-06-01', '2025-06-30'], fillMissing: true },
      /granularity y dateRange/,
    ],
    [{ dimension: 'attendance.date', granularity: 'day', fillMissing: true }, /granularity y dateRange/],
    [
      {
        dimension: 'attendance.date',
        granularity: 'day',
        dateRange: ['2025-06-01', '2025-06-30'],
        fillMissing: 'true',
      },
      /true o false/,
    ],
  ];

  for (const [temporal, sugerencia] of casos) {
    const error = errorDe(() =>
      engineConTodosLosModulos().plan(
        { measures: ['attendance.count'], timeDimensions: [temporal] },
        TABLERO,
      ),
    );

    assert.equal(error.code, 'INVALID_QUERY', JSON.stringify(temporal));
    assert.equal(error.member, 'timeDimensions[0].fillMissing', JSON.stringify(temporal));
    assert.match(error.suggestion, sugerencia);
  }
});

test('una fuente cuyo dialecto no declara serieDeFechas rechaza el relleno', () => {
  // El mismo dialecto de Postgres con la capacidad apagada: lo que se prueba es
  // que el planificador la mira antes de emitir, no qué motor hay abajo.
  const sinSerie = {
    ...dialectoPostgres,
    name: 'sin-serie',
    capabilities: { ...dialectoPostgres.capabilities, serieDeFechas: false },
  };
  const fuentes = { plana: { dialecto: sinSerie, pool: {} } };
  const catalog = createCatalog({ fuentes });
  for (const definicion of [reviews, employees, departments]) {
    catalog.register({ ...definicion, source: 'plana' });
  }

  const error = errorDe(() =>
    createEngine({ catalog, fuentes }).plan(
      {
        measures: ['reviews.count'],
        timeDimensions: [
          {
            dimension: 'reviews.period',
            granularity: 'month',
            dateRange: ['2025-01-01', '2025-12-31'],
            fillMissing: true,
          },
        ],
      },
      TABLERO,
    ),
  );

  // Es un 400 y no un 500: el consumidor puede arreglarlo quitando la bandera.
  assert.equal(error.code, 'UNSUPPORTED_OPERATOR');
  assert.equal(error.member, 'reviews.period');
  assert.match(error.suggestion, /fillMissing/);
});

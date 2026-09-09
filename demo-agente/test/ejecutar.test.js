// Tests del único seam de comportamiento de la demo: `ejecutar`. Entran por
// ahí y por ningún otro lado —nada de HTML, nada de `fetch`— con la capa y el
// reloj inyectados como dobles. Las preguntas preparadas NO se doblan: son
// datos del repo, y que los tests las usen tal cual es lo que fija que
// `preguntas.json` sigue siendo válido.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ejecutar } from '../src/ejecutar.js';

// Capa falsa: registra lo que le piden y devuelve las respuestas en orden.
function capaFalsa(respuestas) {
  const llamadas = [];
  const cola = [...respuestas];
  const capa = async (llamada) => {
    llamadas.push(llamada);
    return cola.length > 1 ? cola.shift() : cola[0];
  };
  capa.llamadas = llamadas;
  return capa;
}

const respuestaOk = { status: 200, json: { rows: [], meta: { servedFrom: 'live' } }, ms: 7 };

function peticion(extra = {}) {
  return {
    pregunta: 'evaluaciones-por-departamento',
    desde: '2025-01-01',
    hasta: '2025-12-31',
    departamento: 'Ingeniería',
    ...extra,
  };
}

test('el camino sin agente son dos saltos: dry-run con token interno y consulta con token agente', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion(), { agente: null, capa, reloj: () => 0 });

  assert.deepEqual(
    rastro.map((salto) => [salto.via, salto.token, salto.estado]),
    [
      ['POST /analytics/query?dryRun=true', 'interno', 'ok'],
      ['POST /analytics/query', 'agente', 'ok'],
    ],
  );
});

test('los marcadores :desde, :hasta y :departamento se sustituyen en la consulta enviada', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion(), { agente: null, capa, reloj: () => 0 });

  const enviado = rastro[1].enviado;
  assert.deepEqual(enviado.timeDimensions[0].dateRange, ['2025-01-01', '2025-12-31']);
  assert.deepEqual(enviado.filters, [
    { member: 'departments.name', operator: 'equals', values: ['Ingeniería'] },
  ]);
});

test('un departamento vacío saca el filtro de la consulta en vez de mandarlo vacío', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion({ departamento: '' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.equal('filters' in rastro[1].enviado, false);
});

test('un departamento vacío deja intactos los demás filtros de la consulta', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion({ departamento: '' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.deepEqual(rastro[1].enviado.segments, ['reviews.completed']);
  assert.deepEqual(rastro[1].enviado.timeDimensions[0].dateRange, ['2025-01-01', '2025-12-31']);
});

const errorUnknownMember = {
  status: 400,
  json: {
    code: 'UNKNOWN_MEMBER',
    member: 'employees.salary_avg',
    suggestion: 'No existe la medida employees.salary_avg.',
  },
  ms: 3,
};

test('un rechazo de la capa es un salto con estado rechazo y el error tal cual en recibido', async () => {
  const capa = capaFalsa([errorUnknownMember]);

  const rastro = await ejecutar(peticion({ pregunta: 'sueldo-promedio-por-departamento' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.equal(rastro[1].estado, 'rechazo');
  assert.equal(rastro[1].recibido.code, 'UNKNOWN_MEMBER');
});

// Decisión: un dry-run rechazado no corta el rastro. La consulta se intenta
// igual para que el mismo error se vea dos veces —una por clase de token— y
// quede claro que el rechazo es de la capa y no de la demo.
test('un dry-run rechazado no impide el salto de la consulta', async () => {
  const capa = capaFalsa([errorUnknownMember]);

  const rastro = await ejecutar(peticion({ pregunta: 'sueldo-promedio-por-departamento' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.deepEqual(
    rastro.map((salto) => salto.estado),
    ['rechazo', 'rechazo'],
  );
  assert.equal(capa.llamadas.length, 2);
});

// Reloj falso: cada llamada devuelve el siguiente instante de la lista.
function relojFalso(instantes) {
  const cola = [...instantes];
  return () => (cola.length > 1 ? cola.shift() : cola[0]);
}

test('los milisegundos salen del reloj inyectado cuando la capa no los reporta', async () => {
  const capa = capaFalsa([{ status: 200, json: { rows: [] } }]);

  const rastro = await ejecutar(peticion(), {
    agente: null,
    capa,
    reloj: relojFalso([1000, 1012, 2000, 2345]),
  });

  assert.deepEqual(
    rastro.map((salto) => salto.ms),
    [12, 345],
  );
});

test('los milisegundos que la capa mide ganan sobre el reloj', async () => {
  const capa = capaFalsa([{ status: 200, json: { rows: [] }, ms: 7 }]);

  const rastro = await ejecutar(peticion(), {
    agente: null,
    capa,
    reloj: relojFalso([1000, 9999]),
  });

  assert.deepEqual(
    rastro.map((salto) => salto.ms),
    [7, 7],
  );
});

test('si la capa no contesta, el salto queda con estado fallo y el motivo en recibido', async () => {
  const capa = async () => {
    throw new Error('fetch failed');
  };

  const rastro = await ejecutar(peticion(), {
    agente: null,
    capa,
    reloj: relojFalso([1000, 1030]),
  });

  assert.equal(rastro[0].estado, 'fallo');
  assert.equal(rastro[0].recibido.error, 'fetch failed');
  assert.equal(rastro[0].ms, 30);
});

test('una pregunta que no existe falla con un mensaje que nombra las preparadas', async () => {
  const capa = capaFalsa([respuestaOk]);

  await assert.rejects(
    ejecutar(peticion({ pregunta: 'sueldo-en-dolares' }), { agente: null, capa, reloj: () => 0 }),
    (error) =>
      error.message.includes('sueldo-en-dolares') &&
      error.message.includes('evaluaciones-por-departamento'),
  );
  assert.equal(capa.llamadas.length, 0);
});

// ---------------------------------------------------------------------------
// Camino con agente. El agente es una función `prompt -> { texto, ms?, meta? }`
// inyectada: acá es un doble que devuelve textos fijos, así que los tests no
// necesitan Claude Code ni red.
function agenteFalso(textos) {
  const prompts = [];
  const cola = [...textos];
  const agente = async (prompt) => {
    prompts.push(prompt);
    return { texto: cola.length > 1 ? cola.shift() : cola[0], ms: 2100 };
  };
  agente.prompts = prompts;
  agente.via = 'claude -p --resume agente-buk';
  return agente;
}

const consultaDelAgente = {
  measures: ['reviews.avg_score'],
  dimensions: ['departments.name'],
  timeDimensions: [
    { dimension: 'reviews.period', granularity: 'quarter', dateRange: ['2025-01-01', '2025-12-31'] },
  ],
};

test('el camino con agente son tres saltos: el agente primero, después el dry-run y la consulta', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.deepEqual(
    rastro.map((salto) => [salto.destino, salto.estado]),
    [
      ['agente', 'ok'],
      ['capa semántica — dry-run (params, plan y SQL)', 'ok'],
      ['capa semántica — consulta', 'ok'],
    ],
  );
});

test('el JSON que escribió el agente es el que viaja a la capa, no el preparado', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.deepEqual(rastro[1].enviado, consultaDelAgente);
  assert.deepEqual(rastro[2].enviado, consultaDelAgente);
});

test('el prompt del clic lleva el texto de la pregunta y la frase fija de filtros', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.match(agente.prompts[0], /Score promedio y evaluaciones completadas por departamento/);
  assert.match(
    agente.prompts[0],
    /Filtros: desde 2025-01-01, hasta 2025-12-31, departamento Ingeniería\./,
  );
});

test('el texto editado en el formulario reemplaza al de la pregunta preparada', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ agente: true, texto: 'Solo Ventas, por favor.' }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.match(agente.prompts[0], /^Solo Ventas, por favor\./);
  assert.match(agente.prompts[0], /Filtros: desde 2025-01-01/);
});

test('sin departamento la frase de filtros no lo nombra', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ agente: true, departamento: '' }), { agente, capa, reloj: () => 0 });

  assert.match(agente.prompts[0], /Filtros: desde 2025-01-01, hasta 2025-12-31\./);
});

test('un noPuedo del agente es el único salto del rastro y la capa no se llama', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso(['{"noPuedo": "el catálogo no publica sueldos"}']);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 1);
  assert.equal(rastro[0].estado, 'rechazo');
  assert.equal(capa.llamadas.length, 0);
});

test('un JSON malformado del agente es un salto fallido con el texto crudo y la capa no se llama', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso(['Claro, acá va la consulta: {measures: reviews.avg_score']);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 1);
  assert.equal(rastro[0].estado, 'fallo');
  assert.equal(rastro[0].recibido, 'Claro, acá va la consulta: {measures: reviews.avg_score');
  assert.equal(capa.llamadas.length, 0);
});

test('un JSON envuelto en un bloque de código se acepta igual', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso(['```json\n' + JSON.stringify(consultaDelAgente) + '\n```']);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 3);
  assert.deepEqual(rastro[2].enviado, consultaDelAgente);
});

test('el salto del agente muestra el nombre del comando y ningún token', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro[0].via, 'claude -p --resume agente-buk');
  assert.equal(rastro[0].token, null);
  assert.equal(rastro[0].ms, 2100);
});

test('un agente que no responde a tiempo es un salto fallido con el motivo', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = async () => ({ texto: '', fallo: 'timeout' });

  const rastro = await ejecutar(peticion({ agente: true }), {
    agente,
    capa,
    reloj: relojFalso([1000, 1060]),
  });

  assert.deepEqual(
    rastro.map((salto) => [salto.estado, salto.ms]),
    [['fallo', 60]],
  );
  assert.match(rastro[0].recibido, /timeout/);
});

// El adaptador mata el proceso al vencer el tope: lo que alcanzó a escribir no
// es una respuesta, aunque parezca JSON. Un `fallo` manda sobre el texto.
test('una respuesta a medias que igual parece JSON no vale si el adaptador reportó fallo', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = async () => ({ texto: JSON.stringify(consultaDelAgente), fallo: 'timeout' });

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 1);
  assert.equal(rastro[0].estado, 'fallo');
  assert.equal(capa.llamadas.length, 0);
});

// ---------------------------------------------------------------------------
// El reintento: la capa rechaza el JSON del agente, el salto 3b le devuelve el
// error con su `suggestion` y la consulta se repite una sola vez.
const consultaCorregida = { ...consultaDelAgente, measures: ['reviews.completion_rate'] };

test('un rechazo de la consulta manda el error al agente y repite el salto de la consulta', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
  ]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.deepEqual(
    rastro.map((salto) => [salto.destino, salto.estado]),
    [
      ['agente', 'ok'],
      ['capa semántica — dry-run (params, plan y SQL)', 'ok'],
      ['capa semántica — consulta', 'rechazo'],
      ['agente — corrección', 'ok'],
      ['capa semántica — consulta (corregida)', 'ok'],
    ],
  );
  assert.deepEqual(rastro[4].enviado, consultaCorregida);
});

test('el salto de corrección le manda al agente el código, el miembro y la sugerencia', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
  ]);

  await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.match(agente.prompts[1], /UNKNOWN_MEMBER/);
  assert.match(agente.prompts[1], /employees\.salary_avg/);
  assert.match(agente.prompts[1], /No existe la medida employees\.salary_avg\./);
});

// Decisión: el reintento repite el salto 3 y solo ese. El dry-run ya mostró el
// plan y el SQL de lo que el agente escribió primero; repetirlo alargaría el
// rastro sin agregar nada nuevo a la demo.
test('el reintento no repite el dry-run: la capa recibe tres llamadas, no cuatro', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
  ]);

  await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(capa.llamadas.length, 3);
  assert.deepEqual(
    capa.llamadas.map((llamada) => llamada.ruta),
    ['/analytics/query?dryRun=true', '/analytics/query', '/analytics/query'],
  );
});

test('un segundo rechazo termina el rastro: nunca hay un tercer intento', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
  ]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 5);
  assert.equal(rastro[4].estado, 'rechazo');
  assert.equal(agente.prompts.length, 2);
  assert.equal(capa.llamadas.length, 3);
});

test('si la corrección del agente es un noPuedo, el rastro termina ahí sin volver a la capa', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    '{"noPuedo": "el catálogo no publica sueldos"}',
  ]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 4);
  assert.equal(rastro[3].estado, 'rechazo');
  assert.equal(capa.llamadas.length, 2);
});

test('sin agente un rechazo de la capa no dispara ninguna corrección', async () => {
  const capa = capaFalsa([errorUnknownMember]);

  const rastro = await ejecutar(peticion({ pregunta: 'sueldo-promedio-por-departamento' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.equal(rastro.length, 2);
});

// La clase de error importa: 4xx es el consumidor pidiendo mal (y por eso hay
// corrección posible); 5xx es la capa caída, y ahí no hay JSON que corregir.
test('un 5xx de la capa es un salto fallido, no un rechazo', async () => {
  const capa = capaFalsa([{ status: 503, json: { code: 'UPSTREAM_UNAVAILABLE' }, ms: 4 }]);

  const rastro = await ejecutar(peticion(), { agente: null, capa, reloj: () => 0 });

  assert.deepEqual(
    rastro.map((salto) => salto.estado),
    ['fallo', 'fallo'],
  );
});

test('un 5xx de la consulta tampoco dispara la corrección del agente', async () => {
  const capa = capaFalsa([respuestaOk, { status: 500, json: { code: 'INTERNAL' }, ms: 4 }]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(peticion({ agente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 3);
  assert.equal(agente.prompts.length, 1);
});

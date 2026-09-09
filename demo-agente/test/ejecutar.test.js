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

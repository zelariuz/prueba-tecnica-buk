// Tests del único seam de comportamiento de la demo: `ejecutar`. Entran por
// ahí y por ningún otro lado —nada de HTML, nada de `fetch`— con la capa y el
// reloj inyectados como dobles. Las preguntas preparadas NO se doblan: son
// datos del repo, y que los tests las usen tal cual es lo que fija que
// `preguntas.json` sigue siendo válido.
import test from 'node:test';
import assert from 'node:assert/strict';

import { consumidorPorId } from '../src/consumidores.js';
import { ejecutar } from '../src/ejecutar.js';
import { preguntas, preguntasRaras } from '../src/preguntas.js';
import { promptDeRedaccion } from '../src/protocolo.js';

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

  // Sin token en la petición, el par por defecto: el de la empresa A.
  assert.deepEqual(
    rastro.map((salto) => [salto.via, salto.token, salto.estado]),
    [
      ['POST /analytics/query?dryRun=true', 'demo-interno-empresa-a', 'ok'],
      ['POST /analytics/query', 'demo-agente-empresa-a', 'ok'],
    ],
  );
});

// La empresa no viaja en la consulta: viaja en el token (ADR 0002). Elegir la
// empresa C es elegir su token de clase agente, y de ahí sale también el
// interno de la MISMA empresa — mezclarlos mostraría el SQL de una empresa
// junto a las filas de otra.
test('con el token de la empresa C los dos saltos van con los tokens de la C', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion({ token: 'demo-agente-empresa-c' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.deepEqual(
    rastro.map((salto) => salto.token),
    ['demo-interno-empresa-c', 'demo-agente-empresa-c'],
  );
  // Y el adaptador recibe ese mismo nombre: es él quien lo cambia por el valor.
  assert.deepEqual(
    capa.llamadas.map((llamada) => llamada.token),
    ['demo-interno-empresa-c', 'demo-agente-empresa-c'],
  );
});

test('la consulta no lleva la empresa: cambiar de token no cambia el JSON enviado', async () => {
  const capaA = capaFalsa([respuestaOk]);
  const capaC = capaFalsa([respuestaOk]);

  const enA = await ejecutar(peticion(), { agente: null, capa: capaA, reloj: () => 0 });
  const enC = await ejecutar(peticion({ token: 'demo-agente-empresa-c' }), {
    agente: null,
    capa: capaC,
    reloj: () => 0,
  });

  assert.deepEqual(enC[1].enviado, enA[1].enviado);
  assert.equal('companyId' in enC[1].enviado, false);
});

test('un token de demo que no existe corta el rastro con un error que lista los conocidos', async () => {
  const capa = capaFalsa([respuestaOk]);

  await assert.rejects(
    () => ejecutar(peticion({ token: 'demo-agente-empresa-z' }), { agente: null, capa, reloj: () => 0 }),
    /demo-agente-empresa-z.*demo-agente-empresa-a, demo-agente-empresa-c/s,
  );
  assert.equal(capa.llamadas.length, 0);
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

// ADR 0009: la clase agente ya no exige rango, así que las fechas del
// formulario se pueden vaciar. La dimensión temporal se queda —el corte por
// trimestre es lo que la pregunta pidió— y lo que se va es el `dateRange`.
test('sin fechas la consulta preparada conserva la dimensión temporal y va sin dateRange', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion({ desde: '', hasta: '' }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  const [temporal] = rastro[1].enviado.timeDimensions;
  assert.deepEqual(temporal, { dimension: 'reviews.period', granularity: 'quarter' });
  assert.equal('dateRange' in temporal, false);
});

// Una sola fecha no es un rango: mandar [<vacío>, 2025-12-31] sería un rango
// inválido con forma de rango.
test('con una sola de las dos fechas la consulta preparada tampoco lleva dateRange', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(peticion({ hasta: '' }), { agente: null, capa, reloj: () => 0 });

  assert.equal('dateRange' in rastro[1].enviado.timeDimensions[0], false);
});

// Vaciar el formulario le quita el rango a la dimensión que lo recibe DEL
// formulario —la de los marcadores—, no a la pregunta que trae su período
// escrito. Una frase relativa (ADR 0014) es el período que la pregunta pide:
// quitársela dejaba la dimensión temporal sin rango y sin granularidad, que es
// lo único que la capa no acepta.
test('sin fechas, el dateRange que la pregunta trae escrito viaja entero: la frase relativa no se toca', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(
    peticion({ pregunta: 'rango-relativo-ultimo-ano', desde: '', hasta: '', departamento: '' }),
    { agente: null, capa, reloj: () => 0 },
  );

  const consulta = rastro[1].enviado;
  assert.deepEqual(consulta.timeDimensions, [
    { dimension: 'reviews.period', dateRange: 'last year' },
  ]);
  assert.equal(consulta.timezone, 'America/Santiago');
});

// La comparación pone `compareDateRange` EN LUGAR de `dateRange` (ADR 0015):
// la dimensión temporal no lleva rango y no por eso le falta algo.
test('la comparación de períodos viaja con su lista de rangos y sin dateRange', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(
    peticion({ pregunta: 'comparacion-agosto-contra-julio', desde: '', hasta: '', departamento: '' }),
    { agente: null, capa, reloj: () => 0 },
  );

  const [temporal] = rastro[1].enviado.timeDimensions;
  assert.equal('dateRange' in temporal, false);
  assert.deepEqual(temporal.compareDateRange, [
    ['2025-08-01', '2025-08-31'],
    ['2025-07-01', '2025-07-31'],
  ]);
});

// El relleno (ADR 0012) exige granularidad y rango en la misma dimensión: los
// marcadores del formulario se sustituyen y la bandera viaja al lado.
test('la serie densa viaja con fillMissing junto a su granularidad y su rango', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(
    peticion({
      pregunta: 'serie-densa-asistencia-diaria',
      desde: '2025-08-08',
      hasta: '2025-08-14',
      departamento: '',
    }),
    { agente: null, capa, reloj: () => 0 },
  );

  assert.deepEqual(rastro[1].enviado.timeDimensions, [
    {
      dimension: 'attendance.date',
      granularity: 'day',
      dateRange: ['2025-08-08', '2025-08-14'],
      fillMissing: true,
    },
  ]);
});

// `total` es de la consulta, no de la dimensión temporal (ADR 0013), y va con
// un límite chico a propósito: el número que el límite escondía es el punto.
test('la pregunta del total viaja con total: true al lado de measures y con su límite', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(
    peticion({
      pregunta: 'total-de-filas-asistencia',
      desde: '2025-06-01',
      hasta: '2025-08-31',
      departamento: '',
    }),
    { agente: null, capa, reloj: () => 0 },
  );

  assert.equal(rastro[1].enviado.total, true);
  assert.equal(rastro[1].enviado.limit, 20);
  assert.equal('total' in rastro[1].enviado.timeDimensions[0], false);
});

// La pregunta que el rango obligatorio dejaba fuera: ni dimensiones ni tiempo.
test('la pregunta por cuántos empleados hay viaja sin timeDimensions', async () => {
  const capa = capaFalsa([respuestaOk]);

  const rastro = await ejecutar(
    peticion({ pregunta: 'cuantos-empleados-hay', desde: '', hasta: '', departamento: '' }),
    { agente: null, capa, reloj: () => 0 },
  );

  assert.deepEqual(rastro[1].enviado, {
    measures: ['employees.headcount', 'employees.active_headcount'],
  });
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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.deepEqual(rastro[1].enviado, consultaDelAgente);
  assert.deepEqual(rastro[2].enviado, consultaDelAgente);
});

test('el prompt del clic lleva el texto de la pregunta y la frase fija de filtros', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.match(agente.prompts[0], /Score promedio y evaluaciones completadas por departamento/);
  assert.match(
    agente.prompts[0],
    /Filtros: desde 2025-01-01, hasta 2025-12-31, departamento Ingeniería\./,
  );
});

test('el texto editado en el formulario se manda tal cual, sin la línea de filtros', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ usarAgente: true, texto: 'Solo Ventas, por favor.' }), {
    agente,
    capa,
    reloj: () => 0,
  });

  // Pedido del usuario (09-09 noche): lo que escribió es exactamente lo que
  // recibe el agente; las fechas del formulario no se le pegan.
  assert.equal(agente.prompts[0], 'Solo Ventas, por favor.');
});

test('sin departamento la frase de filtros no lo nombra', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ usarAgente: true, departamento: '' }), { agente, capa, reloj: () => 0 });

  assert.match(agente.prompts[0], /Filtros: desde 2025-01-01, hasta 2025-12-31\./);
});

// Las fechas van UNA sola vez, en la línea de filtros: el texto de la pregunta
// ya no las lleva. Antes iban en los dos sitios y el agente veía dos veces lo
// mismo.
test('el texto de la pregunta no repite las fechas de la línea de filtros', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  const [texto, filtros] = agente.prompts[0].split('\n\nFiltros: ');
  assert.ok(!texto.includes('2025-01-01'), 'el texto de la pregunta no nombra las fechas');
  assert.equal(filtros, 'desde 2025-01-01, hasta 2025-12-31, departamento Ingeniería.');
});

test('sin fechas la línea de filtros no las nombra', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(peticion({ usarAgente: true, desde: '', hasta: '' }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.match(agente.prompts[0], /Filtros: departamento Ingeniería\.$/);
});

test('sin ningún filtro el prompt del clic es el texto de la pregunta y nada más', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(
    peticion({
      pregunta: 'cuantos-empleados-hay',
      usarAgente: true,
      desde: '',
      hasta: '',
      departamento: '',
    }),
    { agente, capa, reloj: () => 0 },
  );

  assert.equal(agente.prompts[0], 'Cuántos empleados hay en total y cuántos de ellos están activos.');
});

test('un noPuedo del agente es el único salto del rastro y la capa no se llama', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso(['{"noPuedo": "el catálogo no publica sueldos"}']);

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 1);
  assert.equal(rastro[0].estado, 'rechazo');
  assert.equal(capa.llamadas.length, 0);
});

test('un JSON malformado del agente es un salto fallido con el texto crudo y la capa no se llama', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso(['Claro, acá va la consulta: {measures: reviews.avg_score']);

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 1);
  assert.equal(rastro[0].estado, 'fallo');
  assert.equal(rastro[0].recibido, 'Claro, acá va la consulta: {measures: reviews.avg_score');
  assert.equal(capa.llamadas.length, 0);
});

test('un JSON envuelto en un bloque de código se acepta igual', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso(['```json\n' + JSON.stringify(consultaDelAgente) + '\n```']);

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 3);
  assert.deepEqual(rastro[2].enviado, consultaDelAgente);
});

test('el salto del agente muestra el nombre del comando y ningún token', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro[0].via, 'claude -p --resume agente-buk');
  assert.equal(rastro[0].token, null);
  assert.equal(rastro[0].ms, 2100);
});

test('un agente que no responde a tiempo es un salto fallido con el motivo', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = async () => ({ texto: '', fallo: 'timeout' });

  const rastro = await ejecutar(peticion({ usarAgente: true }), {
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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

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

  await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.match(agente.prompts[1], /UNKNOWN_MEMBER/);
  assert.match(agente.prompts[1], /employees\.salary_avg/);
  assert.match(agente.prompts[1], /No existe la medida employees\.salary_avg\./);
  // Y el contexto completo: con `--fork-session` la corrección no puede contar
  // con la memoria del salto 1 (09-09: "no tengo la consulta ni la pregunta").
  assert.ok(agente.prompts[1].includes(agente.prompts[0]), 'lleva la pregunta original');
  assert.ok(
    agente.prompts[1].includes(JSON.stringify(consultaDelAgente)),
    'lleva el JSON que el agente escribió',
  );
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

  await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

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

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 3);
  assert.equal(agente.prompts.length, 1);
});

// ---------------------------------------------------------------------------
// El observador `alSalto`: la página lo usa para escribir cada salto apenas
// está listo, en vez de esperar al rastro entero. Es opcional y no cambia el
// rastro que se devuelve.
test('alSalto se llama una vez por salto, en orden y con el mismo objeto que termina en el rastro', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
  ]);
  const vistos = [];

  const rastro = await ejecutar(peticion({ usarAgente: true }), {
    agente,
    capa,
    reloj: () => 0,
    alSalto: (salto, indice) => vistos.push([salto, indice]),
  });

  assert.equal(vistos.length, rastro.length);
  assert.deepEqual(
    vistos.map(([, indice]) => indice),
    [0, 1, 2, 3, 4],
  );
  // Mismo objeto, no una copia: lo que se dibujó apenas terminó es lo mismo
  // que después aparece en el rastro.
  vistos.forEach(([salto, indice]) => assert.equal(salto, rastro[indice]));
});

// Misma regla que el observador de la capa: nada falla por observar. Si la
// página revienta al dibujar un salto, el rastro sigue saliendo entero.
test('un alSalto que lanza no corta el rastro', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
  ]);

  const rastro = await ejecutar(peticion({ usarAgente: true }), {
    agente,
    capa,
    reloj: () => 0,
    alSalto: () => {
      throw new Error('el socket se cerró');
    },
  });

  assert.equal(rastro.length, 5);
  assert.equal(capa.llamadas.length, 3);
});

// Observar no cambia lo observado: el rastro es el mismo con y sin observador,
// que es lo que permite que la página progresiva y los tests miren lo mismo.
test('sin alSalto el rastro es exactamente el mismo que con alSalto', async () => {
  const corrida = (extra) =>
    ejecutar(peticion({ usarAgente: true }), {
      agente: agenteFalso([JSON.stringify(consultaDelAgente), JSON.stringify(consultaCorregida)]),
      capa: capaFalsa([respuestaOk, errorUnknownMember, respuestaOk]),
      reloj: () => 0,
      ...extra,
    });

  const sinObservador = await corrida({});
  const conObservador = await corrida({ alSalto: () => {} });

  assert.deepEqual(sinObservador, conObservador);
  assert.equal(sinObservador.length, 5);
});

// ---------------------------------------------------------------------------
// La redacción: un salto más, opcional, después de la consulta que trajo filas.
// El agente es el mismo (misma sesión bifurcada) y lo que devuelve es texto, no
// JSON. Nunca corta el rastro: la respuesta ya está, redactarla es un extra.
const filasDeAsistencia = [
  { 'departments.name': 'Ingeniería', 'attendance.rate': 92.59 },
  { 'departments.name': 'Ventas', 'attendance.rate': 91.55 },
];
const respuestaConFilas = {
  status: 200,
  json: { rows: filasDeAsistencia, meta: { servedFrom: 'live', asOf: '2025-09-10T00:00:00Z' } },
  ms: 9,
};

test('con redactar y la consulta ok, el último salto es la redacción con el texto del agente', async () => {
  const capa = capaFalsa([respuestaConFilas]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    'Ingeniería tiene 92,59 % de asistencia y Ventas 91,55 %.',
  ]);

  const rastro = await ejecutar(peticion({ usarAgente: true, redactar: true }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.deepEqual(
    rastro.map((salto) => [salto.destino, salto.estado]),
    [
      ['agente', 'ok'],
      ['capa semántica — dry-run (params, plan y SQL)', 'ok'],
      ['capa semántica — consulta', 'ok'],
      ['agente — redacción', 'ok'],
    ],
  );
  const redaccion = rastro[3];
  assert.equal(redaccion.recibido, 'Ingeniería tiene 92,59 % de asistencia y Ventas 91,55 %.');
  assert.equal(redaccion.token, null);
  assert.equal(redaccion.via, agente.via);
  // El prompt lleva la pregunta original (la misma del salto 1), las filas y
  // de dónde salieron.
  const prompt = agente.prompts[1];
  assert.match(prompt, /score promedio y evaluaciones completadas/i);
  assert.match(prompt, /Ingeniería/);
  assert.match(prompt, /92\.59/);
  assert.match(prompt, /servedFrom: live/);
});

test('sin redactar el rastro termina en la consulta: no hay salto de redacción', async () => {
  const capa = capaFalsa([respuestaConFilas]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(peticion({ usarAgente: true }), { agente, capa, reloj: () => 0 });

  assert.equal(rastro.length, 3);
  assert.equal(agente.prompts.length, 1);
});

// `redactar` es una opción del camino con agente: sin agente no hay a quién
// pedirle la frase, y la casilla sola no inventa un salto.
test('redactar sin usarAgente no agrega ningún salto', async () => {
  const capa = capaFalsa([respuestaConFilas]);

  const rastro = await ejecutar(peticion({ redactar: true }), {
    agente: null,
    capa,
    reloj: () => 0,
  });

  assert.equal(rastro.length, 2);
});

test('si la capa rechaza y la corrección no llega, no hay redacción que hacer', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, errorUnknownMember]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    '{"noPuedo": "el catálogo no publica eso"}',
  ]);

  const rastro = await ejecutar(peticion({ usarAgente: true, redactar: true }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.deepEqual(
    rastro.map((salto) => salto.destino),
    [
      'agente',
      'capa semántica — dry-run (params, plan y SQL)',
      'capa semántica — consulta',
      'agente — corrección',
    ],
  );
});

test('después de una corrección que sí trae filas, la redacción se hace sobre esas filas', async () => {
  const capa = capaFalsa([respuestaOk, errorUnknownMember, respuestaConFilas]);
  const agente = agenteFalso([
    JSON.stringify(consultaDelAgente),
    JSON.stringify(consultaCorregida),
    'Ingeniería 92,59 % y Ventas 91,55 %.',
  ]);

  const rastro = await ejecutar(peticion({ usarAgente: true, redactar: true }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.deepEqual(
    rastro.map((salto) => salto.destino),
    [
      'agente',
      'capa semántica — dry-run (params, plan y SQL)',
      'capa semántica — consulta',
      'agente — corrección',
      'capa semántica — consulta (corregida)',
      'agente — redacción',
    ],
  );
  assert.equal(rastro[5].estado, 'ok');
  assert.match(agente.prompts[2], /92\.59/);
});

// La respuesta ya está: que el agente no redacte deja el salto en `fallo` y no
// borra las filas que la capa devolvió — mismo criterio que el observador.
test('un fallo del agente al redactar deja el salto en fallo sin cortar el rastro', async () => {
  const capa = capaFalsa([respuestaConFilas]);
  let llamadas = 0;
  const agente = async () => {
    llamadas += 1;
    return llamadas === 1
      ? { texto: JSON.stringify(consultaDelAgente), ms: 2100 }
      : { texto: '', ms: 30, fallo: 'timeout de 60000 ms' };
  };
  agente.via = 'claude -p --resume agente-buk';

  const rastro = await ejecutar(peticion({ usarAgente: true, redactar: true }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.equal(rastro.length, 4);
  assert.equal(rastro[3].estado, 'fallo');
  assert.match(rastro[3].recibido, /timeout/);
  // Las filas siguen ahí: el rastro no perdió la respuesta.
  assert.deepEqual(rastro[2].recibido.rows, filasDeAsistencia);
});

test('un texto vacío del agente también es un salto de redacción fallido', async () => {
  const capa = capaFalsa([respuestaConFilas]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente), '   ']);

  const rastro = await ejecutar(peticion({ usarAgente: true, redactar: true }), {
    agente,
    capa,
    reloj: () => 0,
  });

  assert.equal(rastro[3].estado, 'fallo');
});

test('el prompt de redacción recorta a 50 filas y dice cuántas había', async () => {
  const filas = Array.from({ length: 60 }, (_, i) => ({ departamento: `D${i + 1}`, valor: i }));

  const prompt = promptDeRedaccion('¿Cuántos hay?', filas, { servedFrom: 'cache' });

  assert.match(prompt, /se muestran 50 de 60/);
  assert.match(prompt, /"D50"/);
  assert.equal(prompt.includes('"D51"'), false);
});

test('con 50 filas o menos el prompt no habla de recorte', async () => {
  const prompt = promptDeRedaccion('¿Cuántos hay?', filasDeAsistencia, { servedFrom: 'live' });

  assert.equal(prompt.includes('se muestran'), false);
  assert.match(prompt, /agregados por empresa/);
  assert.match(prompt, /Sin markdown/);
});

// ---------------------------------------------------------------------------
// Casos raros: preguntas SIN JSON preparado, sólo del camino con agente. Viven
// en `preguntas-raras.json` y se buscan por id igual que las preparadas. Acá
// también entran tal cual, sin doblarlas: que el rastro las ejecute es lo que
// fija que ese archivo sigue siendo válido.
test('un caso raro se ejecuta con agente: no hay preparado, viaja el JSON que él escribió', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  const rastro = await ejecutar(
    peticion({ pregunta: 'raro-sueldos-que-no-existen', usarAgente: true }),
    { agente, capa, reloj: () => 0 },
  );

  assert.deepEqual(
    rastro.map((salto) => salto.estado),
    ['ok', 'ok', 'ok'],
  );
  assert.deepEqual(rastro[1].enviado, consultaDelAgente);
});

test('un caso raro sin agente no llama a la capa: falla diciendo que es sólo del camino con agente', async () => {
  const capa = capaFalsa([respuestaOk]);

  await assert.rejects(
    () => ejecutar(peticion({ pregunta: 'raro-sueldos-que-no-existen' }), { agente: null, capa, reloj: () => 0 }),
    (error) =>
      error.message.includes('raro-sueldos-que-no-existen') &&
      error.message.includes('usar agente'),
  );
  assert.equal(capa.llamadas.length, 0);
});

test('el prompt del clic de un caso raro es su texto y nada más: sin fechas que le arruinen el caso', async () => {
  const capa = capaFalsa([respuestaOk]);
  const agente = agenteFalso([JSON.stringify(consultaDelAgente)]);

  await ejecutar(
    {
      pregunta: 'raro-relleno-sin-periodo',
      desde: '',
      hasta: '',
      departamento: '',
      usarAgente: true,
    },
    { agente, capa, reloj: () => 0 },
  );

  assert.equal(
    agente.prompts[0],
    'Muéstrame la asistencia día a día por departamento, sin saltarte los días vacíos.',
  );
  assert.equal(agente.prompts[0].includes('Filtros:'), false);
});

test('los seis casos raros traen id, título, texto y nota, y ninguno trae consulta preparada', () => {
  assert.equal(preguntasRaras.length, 6);
  for (const raro of preguntasRaras) {
    for (const campo of ['id', 'titulo', 'texto', 'nota']) {
      assert.equal(typeof raro[campo], 'string', `${raro.id}: falta ${campo}`);
      assert.ok(raro[campo].length > 0, `${raro.id}: ${campo} vacío`);
    }
    assert.equal('consulta' in raro, false, `${raro.id}: un caso raro no lleva JSON preparado`);
  }
});

test('las dieciséis preparadas siguen trayendo su consulta, y ningún id se repite entre las dos listas', () => {
  assert.equal(preguntas.length, 16);
  for (const preparada of preguntas) {
    assert.equal(typeof preparada.consulta, 'object', `${preparada.id}: perdió su consulta`);
  }
  const ids = [...preguntas, ...preguntasRaras].map((una) => una.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('el token que un caso raro declara es uno de los consumidores de demo', () => {
  for (const raro of preguntasRaras.filter((una) => una.token)) {
    assert.ok(consumidorPorId(raro.token), `${raro.id}: token de demo desconocido`);
  }
});

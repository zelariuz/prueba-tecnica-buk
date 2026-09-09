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

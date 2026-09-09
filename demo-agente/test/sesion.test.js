// Tests del segundo seam: `asegurarSesion`. Entra por ahí con `claude` y la
// persistencia inyectados como dobles —nada de `spawn`, nada de disco— y
// comprueba la única decisión que hay: crear, conservar o recrear la sesión
// según la versión del catálogo con la que se creó.
import test from 'node:test';
import assert from 'node:assert/strict';

import { asegurarSesion, promptDeCreacion } from '../src/sesion.js';

const catalogo = { version: 'v1', granularities: ['month'], entities: [], queries: [] };

// Doble de `claude`: registra los argumentos y el prompt que le llegó por
// stdin, y contesta como el CLI cuando la creación sale bien.
function claudeFalso() {
  const llamadas = [];
  const claude = async (argumentos, entrada) => {
    llamadas.push({ argumentos, entrada });
    return { stdout: 'sesión lista', code: 0 };
  };
  claude.llamadas = llamadas;
  return claude;
}

// Persistencia doble: lo que `leer` devuelve es el estado previo, y `guardado`
// es lo que la sesión decidió dejar escrito.
function estadoFalso(previo = null) {
  const estado = {
    leer: () => previo,
    guardar: (valor) => {
      estado.guardado = valor;
    },
  };
  return estado;
}

test('sin estado previo crea la sesión, la guarda y avisa que la creó', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso();

  const sesion = await asegurarSesion({ claude, catalogo, estado });

  assert.equal(sesion.creada, true);
  assert.equal(sesion.id, estado.guardado.uuid);
  assert.equal(estado.guardado.version, 'v1');
  assert.equal(claude.llamadas.length, 1);
});

test('con un estado de la misma versión del catálogo conserva la sesión y no llama a claude', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({ uuid: 'guardado-1', version: 'v1', creadaEn: '2026-09-09' });

  const sesion = await asegurarSesion({ claude, catalogo, estado });

  assert.deepEqual(sesion, { id: 'guardado-1', creada: false, motivo: 'la sesión guardada sigue vigente' });
  assert.equal(claude.llamadas.length, 0);
});

test('si la versión del catálogo cambió recrea la sesión con un uuid nuevo y lo dice', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({ uuid: 'guardado-1', version: 'v0', creadaEn: '2026-09-09' });

  const sesion = await asegurarSesion({ claude, catalogo, estado, nuevoUuid: () => 'uuid-2' });

  assert.equal(sesion.id, 'uuid-2');
  assert.equal(sesion.creada, true);
  assert.equal(sesion.motivo, 'catalogo cambió');
  assert.equal(estado.guardado.version, 'v1');
});

// El prompt de creación es lo único que el agente sabe: si algo no está acá,
// el agente no lo tiene. Por eso se prueba como función pura y se muestra
// entero en /agente/sesion.
const catalogoReal = {
  version: '219f834021759c19',
  granularities: ['day', 'month'],
  entities: [{ name: 'reviews', measures: [{ name: 'reviews.avg_score' }] }],
  queries: [{ name: 'evaluaciones', query: { measures: ['reviews.avg_score'] } }],
};

test('el prompt de creación lleva el catálogo entero, con su versión, tal cual lo publica la capa', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.ok(prompt.includes(JSON.stringify(catalogoReal, null, 2)));
  assert.ok(prompt.includes('219f834021759c19'));
});

test('el prompt de creación fija el contrato de salida: solo JSON, o noPuedo', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.ok(prompt.includes('{"noPuedo": "motivo breve"}'));
  assert.match(prompt, /ÚNICAMENTE un objeto JSON/);
});

test('el prompt de creación dice las reglas que el catálogo no dice: rango y granularidad obligatorios', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /timeDimensions/);
  assert.match(prompt, /dateRange/);
  assert.match(prompt, /granularity/);
});

test('el prompt de creación prohíbe el SQL y los miembros inventados', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /nunca escribes SQL/i);
  assert.match(prompt, /no inventes/i);
});

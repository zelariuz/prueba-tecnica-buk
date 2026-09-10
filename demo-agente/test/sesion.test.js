// Tests del segundo seam: `asegurarSesion`. Entra por ahí con `claude` y la
// persistencia inyectados como dobles —nada de `spawn`, nada de disco— y
// comprueba la única decisión que hay: crear, conservar o recrear la sesión
// según la huella del catálogo con el que se creó.
import test from 'node:test';
import assert from 'node:assert/strict';

import { asegurarSesion, huellaDelCatalogo, promptDeCreacion } from '../src/sesion.js';

const catalogo = { version: 'v1', granularities: ['month'], entities: [], queries: [] };
const huella = huellaDelCatalogo(catalogo);

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

test('con un estado de la misma huella del catálogo conserva la sesión y no llama a claude', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({ uuid: 'guardado-1', version: 'v1', huella, creadaEn: '2026-09-09' });

  const sesion = await asegurarSesion({ claude, catalogo, estado });

  assert.deepEqual(sesion, {
    id: 'guardado-1',
    creada: false,
    motivo: 'la sesión guardada sigue vigente',
    version: 'v1',
    huella,
  });
  assert.equal(claude.llamadas.length, 0);
});

test('si el catálogo cambió recrea la sesión con un uuid nuevo y lo dice', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({ uuid: 'guardado-1', version: 'v0', huella: 'otra', creadaEn: '2026-09-09' });

  const sesion = await asegurarSesion({ claude, catalogo, estado, nuevoUuid: () => 'uuid-2' });

  assert.equal(sesion.id, 'uuid-2');
  assert.equal(sesion.creada, true);
  assert.equal(sesion.motivo, 'el catálogo cambió');
  assert.equal(estado.guardado.version, 'v1');
  assert.equal(estado.guardado.huella, huella);
});

// La versión del catálogo NO cubre las consultas tipo: registrar una no la
// cambia (decisión de la capa, CLAUDE.md fase 4). Si la sesión se guiara por
// ella, un catálogo con otras consultas tipo seguiría hablándole a un agente
// que aprendió las viejas. Por eso la huella es del catálogo entero.
test('misma versión pero otra consulta tipo: la huella cambia y la sesión se recrea', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({ uuid: 'guardado-1', version: 'v1', huella, creadaEn: '2026-09-09' });
  const conOtraConsulta = {
    ...catalogo,
    queries: [{ name: 'nueva', params: [], query: { measures: ['reviews.count'] } }],
  };

  const sesion = await asegurarSesion({
    claude,
    catalogo: conOtraConsulta,
    estado,
    nuevoUuid: () => 'uuid-3',
  });

  assert.equal(sesion.id, 'uuid-3');
  assert.equal(sesion.motivo, 'el catálogo cambió');
  assert.equal(estado.guardado.version, 'v1');
  assert.notEqual(estado.guardado.huella, huella);
});

// La huella no depende del orden en que la capa serializó sus claves: dos
// catálogos con el mismo contenido son el mismo catálogo.
test('la huella es del contenido del catálogo, no del orden de sus claves', () => {
  assert.equal(
    huellaDelCatalogo({ version: 'v1', granularities: ['month'], entities: [], queries: [] }),
    huellaDelCatalogo({ queries: [], entities: [], granularities: ['month'], version: 'v1' }),
  );
  assert.notEqual(huellaDelCatalogo(catalogo), huellaDelCatalogo({ ...catalogo, entities: [{}] }));
});

// El prompt de creación es lo único que el agente sabe: si algo no está acá,
// el agente no lo tiene. Por eso se prueba como función pura y se muestra
// entero en /agente/sesion.
const catalogoReal = {
  version: '219f834021759c19',
  granularities: ['day', 'month'],
  entities: [{ name: 'reviews', measures: [{ name: 'reviews.avg_score' }] }],
  queries: [
    {
      name: 'evaluaciones',
      description: 'Score promedio por trimestre.',
      params: ['dateRange'],
      query: {
        measures: ['reviews.avg_score'],
        segments: ['reviews.completed'],
        timeDimensions: [
          { dimension: 'reviews.period', granularity: 'quarter', dateRange: ':dateRange' },
        ],
      },
    },
  ],
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

// Desde el ADR 0009 el rango no es obligatorio para la clase agente, y el
// prompt es lo único que el agente sabe: si siguiera diciendo que la capa
// responde MISSING_TIME_RANGE, el agente inventaría fechas para preguntas que
// no las tienen.
test('el prompt de creación dice las reglas que el catálogo no dice: granularidad obligatoria, rango opcional', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /timeDimensions/);
  assert.match(prompt, /granularity/);
  assert.match(prompt, /"dateRange"\) es OPCIONAL/);
  assert.match(prompt, /QUERY_TIMEOUT/);
  assert.ok(!prompt.includes('MISSING_TIME_RANGE'), 'el rango ya no se anuncia como obligatorio');
});

test('el prompt de creación prohíbe el SQL y los miembros inventados', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /nunca escribes SQL/i);
  assert.match(prompt, /no inventes/i);
});

// El hallazgo de la fase 2: sin ver el `query` de la consulta tipo, el agente
// copiaba la forma pero no el `segments`, y la pregunta del caso daba otro
// número. Ahora el catálogo lo trae y el prompt manda copiarlo.
test('el prompt de creación manda copiar el query de la consulta tipo que coincide, marcadores incluidos', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /"query"/);
  assert.match(prompt, /copia/i);
  // Y la contracara (09-09 noche, captura del usuario): con un texto que no
  // pedía trimestre, el agente copió igual la consulta tipo. La pregunta manda.
  assert.match(prompt, /la pregunta manda/i);
  // Captura del usuario (09-09 noche): "Cuántos empleados hay" con fechas en la
  // línea de filtros terminó en noPuedo. Las fechas no mandan sobre la entidad.
  assert.match(prompt, /IGNORA esas fechas/);
  assert.match(prompt, /sólo las dimensiones y la\s+granularidad que el texto nombra/i);
  assert.match(prompt, /segments/);
  assert.match(prompt, /:nombre/);
  // Y el ejemplo viaja entero en el catálogo, con su marcador sin sustituir.
  assert.ok(prompt.includes('":dateRange"'));
});

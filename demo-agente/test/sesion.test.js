// Tests del segundo seam: `asegurarSesion`. Entra por ahí con `claude` y la
// persistencia inyectados como dobles —nada de `spawn`, nada de disco— y
// comprueba la única decisión que hay: crear, conservar o recrear la sesión
// según la huella del catálogo con el que se creó.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asegurarSesion,
  huellaDelCatalogo,
  huellaDelPrompt,
  promptDeCreacion,
} from '../src/sesion.js';

const catalogo = { version: 'v1', granularities: ['month'], entities: [], queries: [] };
const huella = huellaDelCatalogo(catalogo);
const huellaPrompt = huellaDelPrompt(catalogo);

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

test('con un estado de la misma huella del catálogo y del mismo prompt conserva la sesión y no llama a claude', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({
    uuid: 'guardado-1',
    version: 'v1',
    huella,
    huellaDelPrompt: huellaPrompt,
    creadaEn: '2026-09-09',
  });

  const sesion = await asegurarSesion({ claude, catalogo, estado });

  assert.deepEqual(sesion, {
    id: 'guardado-1',
    creada: false,
    motivo: 'la sesión guardada sigue vigente',
    version: 'v1',
    huella,
    huellaDelPrompt: huellaPrompt,
  });
  assert.equal(claude.llamadas.length, 0);
});

// El prompt es lo único que el agente sabe, y sus reglas —el relleno, el total,
// los rangos relativos, la comparación— viven en su TEXTO, no en el catálogo.
// Editar ese texto sin que la capa publique nada nuevo dejaba viva la sesión
// guardada, y el agente nunca veía la regla nueva.
test('si sólo cambió el texto del prompt, la sesión se recrea aunque el catálogo sea el mismo', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({
    uuid: 'guardado-1',
    version: 'v1',
    huella,
    huellaDelPrompt: 'el-prompt-de-ayer',
    creadaEn: '2026-09-09',
  });

  const sesion = await asegurarSesion({ claude, catalogo, estado, nuevoUuid: () => 'uuid-4' });

  assert.equal(sesion.id, 'uuid-4');
  assert.equal(sesion.creada, true);
  assert.equal(sesion.motivo, 'las reglas del prompt cambiaron');
  assert.equal(estado.guardado.huella, huella);
  assert.equal(estado.guardado.huellaDelPrompt, huellaPrompt);
  // Y lo que se le mandó a claude es el prompt nuevo, entero.
  assert.equal(claude.llamadas[0].entrada, promptDeCreacion(catalogo));
});

// Una sesión guardada por la demo de antes de esta huella no la tiene. No hay
// forma de saber con qué texto se creó, así que se recrea: es más barato que
// hablarle a un agente que quizá no conoce las reglas nuevas.
test('una sesión guardada sin huella del prompt se recrea', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({ uuid: 'guardado-1', version: 'v1', huella, creadaEn: '2026-09-09' });

  const sesion = await asegurarSesion({ claude, catalogo, estado, nuevoUuid: () => 'uuid-5' });

  assert.equal(sesion.id, 'uuid-5');
  assert.equal(sesion.motivo, 'las reglas del prompt cambiaron');
  assert.equal(estado.guardado.huellaDelPrompt, huellaPrompt);
});

test('la huella del prompt es del texto entero: dos catálogos distintos dan dos prompts distintos', () => {
  assert.notEqual(huellaDelPrompt(catalogo), huellaDelPrompt({ ...catalogo, entities: [{}] }));
  assert.equal(huellaDelPrompt(catalogo), huellaPrompt);
});

test('si el catálogo cambió recrea la sesión con un uuid nuevo y lo dice', async () => {
  const claude = claudeFalso();
  const estado = estadoFalso({
    uuid: 'guardado-1',
    version: 'v0',
    huella: 'otra',
    huellaDelPrompt: 'otro-prompt',
    creadaEn: '2026-09-09',
  });

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
  const estado = estadoFalso({
    uuid: 'guardado-1',
    version: 'v1',
    huella,
    huellaDelPrompt: huellaPrompt,
    creadaEn: '2026-09-09',
  });
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

// Desde el ADR 0010 una consulta puede no llevar medidas. El agente no tiene
// forma de saberlo mirando el catálogo —que publica medidas y dimensiones sin
// decir cuáles son obligatorias—, así que la regla vive en el prompt: sin ella
// "cuáles departamentos hay" termina en una medida inventada o en un noPuedo
// sobre una pregunta que la capa responde.
test('el prompt de creación dice que para listar los valores de una dimensión no hacen falta medidas', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /SIN medidas/);
  assert.match(prompt, /"measures" puede omitirse/);
  assert.match(prompt, /qué departamentos hay/);
});

// Desde el ADR 0011 una timeDimension puede llevar rango sin granularidad. El
// catálogo publica `granularities` sin decir que la granularidad es opcional, así
// que sin esta regla el agente sigue agrupando por mes lo que nadie pidió: "por
// departamento durante los últimos tres meses" volvería con una fila por
// departamento Y mes.
test('el prompt de creación dice que el rango puede ir sin granularidad y entonces sólo filtra', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /"dateRange" sin "granularity"/);
  assert.match(prompt, /sólo filtra por\s+fecha y no agrupa/);
  assert.match(prompt, /una fila por\s+departamento/);
  assert.ok(
    !prompt.includes('si la pones, "granularity" es'),
    'ya no se anuncia la granularidad como obligatoria',
  );
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
  assert.match(prompt, /sólo las dimensiones y la\s+granularidad que el texto nombra/i);
  assert.match(prompt, /segments/);
  assert.match(prompt, /:nombre/);
  // Y el ejemplo viaja entero en el catálogo, con su marcador sin sustituir.
  assert.ok(prompt.includes('":dateRange"'));
});

// Desde el ADR 0012 una timeDimension puede pedir la serie densa. El catálogo
// no publica la bandera, así que sin esta regla el agente escribe la serie
// dispersa de siempre y el gráfico salta los días sin registros. La contracara
// importa igual o más: el riesgo de enseñarle la bandera es que la ponga en
// todo, y una fila por departamento no tiene buckets que rellenar.
test('el prompt de creación dice cuándo va fillMissing y cuándo NO', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /"fillMissing": true/);
  assert.match(prompt, /Exige "granularity" Y "dateRange"/);
  assert.match(prompt, /NO lo pongas\s+cuando la consulta no agrupe por tiempo/);
  assert.match(prompt, /buckets × ejes/);
});

// Desde el ADR 0013 `total: true` devuelve en `meta` las filas del resultado
// ignorando el límite. Es la propiedad que más fácil se malentiende: no es el
// gran total de una medida, y el prompt lo dice con todas las letras.
test('el prompt de creación dice que total es el número de filas, no el total de una medida', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /"total": true/);
  assert.match(prompt, /ignorando el límite/);
  assert.match(prompt, /NO es el gran total de ninguna medida/);
});

// Desde el ADR 0014 el dateRange acepta una frase de un vocabulario CERRADO de
// quince formas. Cerrado quiere decir que las quince tienen que estar acá: una
// que falte es una que el agente no puede escribir, y una inventada ("previous
// month", "últimos seis meses") es un INVALID_QUERY seguro.
test('el prompt de creación trae las quince formas del vocabulario de rangos relativos', () => {
  const prompt = promptDeCreacion(catalogoReal);

  for (const frase of [
    'today',
    'yesterday',
    'this week',
    'this month',
    'this quarter',
    'this year',
    'last week',
    'last month',
    'last quarter',
    'last year',
    'last N days',
    'last N weeks',
    'last N months',
    'last N quarters',
    'last N years',
  ]) {
    assert.ok(prompt.includes(`"${frase}"`), `falta la forma "${frase}" en el prompt`);
  }
  // Y las dos reglas que deciden qué ventana sale: el plural siempre, y que
  // ninguna frase "last …" incluye hoy.
  assert.match(prompt, /SIEMPRE en plural/);
  assert.match(prompt, /NO incluyen hoy/);
  // La zona es de la consulta y sólo decide qué día es hoy.
  assert.match(prompt, /"timezone" es una propiedad de la consulta/);
});

// Desde el ADR 0015 se compara con `compareDateRange` en lugar de `dateRange`,
// y la respuesta cambia de forma. Las dos mitades tienen que estar: que existe,
// y que no se usa cuando nadie pidió comparar.
test('el prompt de creación dice que compareDateRange reemplaza a dateRange, su tope y cuándo NO usarlo', () => {
  const prompt = promptDeCreacion(catalogoReal);

  assert.match(prompt, /"compareDateRange" EN LUGAR DE/);
  assert.match(prompt, /CUATRO rangos/);
  assert.match(prompt, /\{"results": \[\.\.\.\]\}/);
  assert.match(prompt, /Úsalo SÓLO si la pregunta\s+compara dos o más períodos/);
  assert.match(prompt, /una serie por mes NO es una comparación/);
});

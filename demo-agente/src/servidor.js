// El mini back: sirve el front estático de `public/` y publica tres endpoints
// JSON. No arma HTML —eso lo hace el navegador con `public/app.js`— y no toma
// decisiones sobre el rastro: toda la lógica sigue en el seam `ejecutar`.
//
// El rastro sale como NDJSON en streaming (una línea por salto, apenas queda
// listo) y no como un JSON al final: el salto al agente tarda 3-6 s y esperarlo
// dejaba la página sin nada que mostrar todo ese rato. El observador `alSalto`
// del seam es justo el que escribe cada línea.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import { ejecutar } from './ejecutar.js';
import { preguntaPorId, preguntas, prepararTexto } from './preguntas.js';
import { promptDeCreacion, PROMPT_DE_SISTEMA } from './sesion.js';

const PUBLICO = new URL('../public/', import.meta.url);

// Rutas "bonitas" que no son un archivo: todo lo demás se busca por nombre
// dentro de `public/`, que es plano a propósito.
const PAGINAS = new Map([
  ['/', 'index.html'],
  ['/agente/sesion', 'sesion.html'],
]);

const TIPOS = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
]);

export function crearServidor({
  capa,
  agente = null,
  agenteMotivo = null,
  sesion = null,
  catalogo = null,
  claudeCode = null,
  modelo = null,
  reloj = () => performance.now(),
}) {
  return createServer(async (peticionHttp, respuesta) => {
    const url = new URL(peticionHttp.url, 'http://demo.local');

    if (url.pathname === '/api/preguntas') {
      responderJson(respuesta, 200, preguntas);
      return;
    }
    if (url.pathname === '/api/sesion') {
      responderJson(respuesta, 200, {
        nombre: sesion?.nombre ?? null,
        uuid: sesion?.id ?? null,
        versionCatalogo: catalogo?.version ?? null,
        huella: sesion?.huella ?? null,
        creadaEn: sesion?.creadaEn ?? null,
        motivo: sesion?.motivo ?? null,
        modelo,
        claudeCode,
        agenteDisponible: Boolean(agente),
        agenteMotivo,
        promptDeSistema: PROMPT_DE_SISTEMA,
        promptDeCreacion: catalogo ? promptDeCreacion(catalogo) : null,
      });
      return;
    }
    if (url.pathname === '/api/rastro') {
      await responderRastro(url, respuesta, { capa, agente, agenteMotivo, reloj });
      return;
    }

    await responderEstatico(url.pathname, respuesta);
  });
}

// El rastro por trozos: `inicio` sale de inmediato (así el front sabe cuántos
// saltos esperar y qué texto se mandó de verdad), una línea por salto en el
// momento en que `ejecutar` avisa, y `fin` con el total. La pregunta que no
// existe sale como `error` y cierra: es lo único que `ejecutar` lanza.
async function responderRastro(url, respuesta, { capa, agente, agenteMotivo, reloj }) {
  const peticion = peticionDe(url);
  const pregunta = preguntaPorId(peticion.pregunta);
  const texto = pregunta ? peticion.texto || prepararTexto(pregunta.texto, peticion) : peticion.texto;

  // Sin agente disponible, `agente=1` no rompe nada: se ignora y la nota viaja
  // con el inicio. El camino sin agente siempre está.
  const conAgente = peticion.usarAgente && Boolean(agente);
  const nota =
    peticion.usarAgente && !agente ? `Claude Code no está disponible: ${agenteMotivo}` : null;

  respuesta.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    // Sin `Content-Length`, `node:http` responde `chunked` y cada `write` sale
    // por el socket en el momento.
    'Transfer-Encoding': 'chunked',
  });
  respuesta.write(
    linea({
      tipo: 'inicio',
      peticion: { ...peticion, usarAgente: conAgente, texto },
      // Sin agente son dos saltos (dry-run y consulta); con agente, tres. La
      // corrección agrega dos más y por eso es una previsión, no una promesa.
      saltosPrevistos: conAgente ? 3 : 2,
      nota,
    }),
  );

  const inicio = reloj();
  try {
    await ejecutar(
      { ...peticion, texto, usarAgente: conAgente },
      {
        agente,
        capa,
        reloj,
        alSalto: (salto, indice) => respuesta.write(linea({ tipo: 'salto', indice, salto })),
      },
    );
    respuesta.end(linea({ tipo: 'fin', totalMs: Math.round(reloj() - inicio) }));
  } catch (error) {
    respuesta.end(linea({ tipo: 'error', mensaje: error.message }));
  }
}

// Una línea NDJSON: el JSON escapa los saltos de línea de adentro, así que la
// línea nunca se parte.
function linea(objeto) {
  return `${JSON.stringify(objeto)}\n`;
}

// El front estático. `public/` es plano: sólo nombres de archivo con extensión
// conocida, nada de listados y nada que se salga de la carpeta.
async function responderEstatico(pathname, respuesta) {
  const decodificado = decodificar(pathname);
  const archivo = decodificado === null ? null : PAGINAS.get(decodificado) ?? decodificado.slice(1);
  if (archivo === null || !/^[A-Za-z0-9_-]+\.(?:html|js|css)$/.test(archivo)) {
    responder(respuesta, 404, 'text/plain; charset=utf-8', 'No hay nada acá.');
    return;
  }
  try {
    const cuerpo = await readFile(new URL(archivo, PUBLICO));
    responder(respuesta, 200, TIPOS.get(archivo.split('.').pop()), cuerpo);
  } catch {
    responder(respuesta, 404, 'text/plain; charset=utf-8', 'No hay nada acá.');
  }
}

// `..` no se acepta ni escrito ni escapado (`%2e%2e`): el regex de arriba ya lo
// dejaría fuera, pero rechazarlo acá dice la intención.
function decodificar(pathname) {
  try {
    const valor = decodeURIComponent(pathname);
    return valor.includes('..') ? null : valor;
  } catch {
    return null;
  }
}

function peticionDe(url) {
  const parametro = (nombre) => url.searchParams.get(nombre) ?? '';
  return {
    pregunta: parametro('pregunta') || preguntas[0].id,
    texto: parametro('texto'),
    desde: parametro('desde'),
    hasta: parametro('hasta'),
    departamento: parametro('departamento'),
    // `usarAgente` y no `agente`: el booleano de la URL no es el colaborador
    // `agente` que ejecuta, y llamarlos igual confundía a los dos.
    usarAgente: parametro('agente') === '1',
  };
}

function responderJson(respuesta, estado, valor) {
  responder(respuesta, estado, 'application/json; charset=utf-8', JSON.stringify(valor));
}

function responder(respuesta, estado, tipo, cuerpo) {
  respuesta.writeHead(estado, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  respuesta.end(cuerpo);
}

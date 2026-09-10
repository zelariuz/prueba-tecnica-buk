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

import {
  consumidoresPublicos,
  consumidorPorId,
  CONSUMIDOR_POR_DEFECTO,
  CONSUMIDORES,
} from './consumidores.js';
import { ejecutar } from './ejecutar.js';
import { preguntaPorId, preguntas, prepararTexto } from './preguntas.js';
import { huellaDelCatalogo, promptDeCreacion, PROMPT_DE_SISTEMA } from './sesion.js';

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
  // Pide el catálogo a la capa AHORA (para compararlo con el que aprendió la
  // sesión). Opcional: sin él la ruta /api/catalogo devuelve el del arranque.
  pedirCatalogoEnVivo = null,
  // Pide la telemetría de la capa con el token INTERNO que se le pase. Es una
  // función y no una URL para que el mini back siga siendo el único que conoce
  // los valores de los tokens.
  pedirTelemetria = null,
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
    // Los tokens de demo que la página ofrece elegir: nombre, etiqueta y rangos
    // precargados. Ningún valor de token baja acá — el mini back es el único
    // que los conoce.
    if (url.pathname === '/api/consumidores') {
      responderJson(respuesta, 200, consumidoresPublicos());
      return;
    }
    if (url.pathname === '/api/catalogo') {
      try {
        const enVivo = pedirCatalogoEnVivo ? await pedirCatalogoEnVivo() : catalogo;
        responderJson(respuesta, 200, {
          origen: pedirCatalogoEnVivo ? 'GET /analytics/catalog ahora, token agente' : 'el del arranque',
          huella: enVivo ? huellaDelCatalogo(enVivo) : null,
          huellaDeLaSesion: sesion?.huella ?? null,
          catalogo: enVivo,
        });
      } catch (error) {
        responderJson(respuesta, 502, { error: `la capa no respondió el catálogo: ${error.message}` });
      }
      return;
    }
    // La telemetría de la capa, para el panel del pie. El navegador manda el
    // NOMBRE del token de consumidor elegido; acá se cambia por el token
    // INTERNO de esa misma empresa, que es el único al que la capa le contesta
    // esta ruta (los de clase agente reciben 403). El valor nunca baja al
    // front, igual que en el resto de la demo.
    if (url.pathname === '/api/telemetria') {
      const consumidor = consumidorPorId(url.searchParams.get('token') || CONSUMIDOR_POR_DEFECTO.id);
      if (!consumidor) {
        responderJson(respuesta, 400, {
          error: `no existe el token de demo "${url.searchParams.get('token')}"; los conocidos son ${CONSUMIDORES.map((uno) => uno.id).join(', ')}`,
        });
        return;
      }
      try {
        if (!pedirTelemetria) throw new Error('el mini back arrancó sin acceso a la telemetría');
        responderJson(respuesta, 200, await pedirTelemetria(consumidor.interno));
      } catch (error) {
        responderJson(respuesta, 502, { error: `la capa no respondió la telemetría: ${error.message}` });
      }
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
        // Una sola sesión para las tres empresas, y no una por empresa: el
        // catálogo público no depende del consumidor, así que tampoco de su
        // empresa. La página lo dice en la tarjeta "Antes de todo".
        catalogoUnicoParaTodasLasEmpresas: true,
        motivoCatalogoUnico:
          'El catálogo público es el mismo para todas las empresas (ADR 0008: la vista pública ' +
          'no depende del contexto del consumidor), así que la sesión del agente es una sola: ' +
          'cambiar de token cambia la empresa de los datos, no lo que el agente sabe.',
        promptDeSistema: PROMPT_DE_SISTEMA,
        promptDeCreacion: catalogo ? promptDeCreacion(catalogo) : null,
      });
      return;
    }
    if (url.pathname === '/api/rastro') {
      // POST con cuerpo JSON: el texto editable puede ser largo y no cabe en
      // una URL con garantías. GET con query sigue aceptado (links viejos).
      let peticion;
      try {
        peticion =
          peticionHttp.method === 'POST'
            ? peticionDeCuerpo(await leerCuerpo(peticionHttp))
            : peticionDeUrl(url);
      } catch (error) {
        responderJson(respuesta, 400, { error: error.message });
        return;
      }
      await responderRastro(peticion, respuesta, { capa, agente, agenteMotivo, reloj });
      return;
    }

    await responderEstatico(url.pathname, respuesta);
  });
}

// El rastro por trozos: `inicio` sale de inmediato (así el front sabe cuántos
// saltos esperar y qué texto se mandó de verdad), una línea por salto en el
// momento en que `ejecutar` avisa, y `fin` con el total. La pregunta que no
// existe sale como `error` y cierra: es lo único que `ejecutar` lanza.
async function responderRastro(peticion, respuesta, { capa, agente, agenteMotivo, reloj }) {
  const pregunta = preguntaPorId(peticion.pregunta);
  // `texto` en la petición significa "texto propio, desenganchado": se manda
  // tal cual. Vacío significa enganchado: `promptDelClic` arma el preparado
  // más la línea de filtros. Acá NO se rellena (09-09: rellenarlo hacía que las
  // fechas del formulario nunca llegaran al agente). El texto que se muestra
  // en `inicio` sí es el que va a viajar, calculado aparte.
  const textoMostrado = pregunta
    ? peticion.texto || prepararTexto(pregunta.texto, peticion)
    : peticion.texto;

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
      peticion: { ...peticion, usarAgente: conAgente, texto: textoMostrado },
      // Sin agente son dos saltos (dry-run y consulta); con agente, tres. La
      // corrección agrega dos más y por eso es una previsión, no una promesa.
      saltosPrevistos: conAgente ? 3 : 2,
      nota,
    }),
  );

  const inicio = reloj();
  try {
    await ejecutar(
      { ...peticion, usarAgente: conAgente },
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

const LIMITE_DE_CUERPO = 16 * 1024;

async function leerCuerpo(peticionHttp) {
  let total = 0;
  const trozos = [];
  for await (const trozo of peticionHttp) {
    total += trozo.length;
    if (total > LIMITE_DE_CUERPO) throw new Error(`cuerpo de más de ${LIMITE_DE_CUERPO} bytes`);
    trozos.push(trozo);
  }
  return Buffer.concat(trozos).toString('utf8');
}

function peticionDeCuerpo(texto) {
  let datos;
  try {
    datos = texto ? JSON.parse(texto) : {};
  } catch {
    throw new Error('el cuerpo no es JSON');
  }
  const campo = (nombre) => (typeof datos[nombre] === 'string' ? datos[nombre] : '');
  return {
    pregunta: campo('pregunta') || preguntas[0].id,
    token: tokenConocido(campo('token')),
    texto: campo('texto'),
    desde: campo('desde'),
    hasta: campo('hasta'),
    departamento: campo('departamento'),
    usarAgente: datos.usarAgente === true || datos.agente === '1' || datos.agente === 1,
  };
}

// El token elegido es el nombre de un token de demo conocido, y nada más: uno
// que no está en la lista es una petición mal hecha (400), no un token que el
// mini back vaya a mandarle a la capa para ver qué pasa.
function tokenConocido(valor) {
  if (!valor) return CONSUMIDOR_POR_DEFECTO.id;
  if (consumidorPorId(valor)) return valor;
  throw new Error(
    `no existe el token de demo "${valor}"; los conocidos son ${CONSUMIDORES.map((uno) => uno.id).join(', ')}`,
  );
}

function peticionDeUrl(url) {
  const parametro = (nombre) => url.searchParams.get(nombre) ?? '';
  return {
    pregunta: parametro('pregunta') || preguntas[0].id,
    token: tokenConocido(parametro('token')),
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

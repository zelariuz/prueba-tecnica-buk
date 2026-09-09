// El servidor: traduce la URL a la petición que entiende el seam y el rastro
// que devuelve a HTML. Toda la lógica está en `ejecutar`; aquí no hay
// decisiones que testear.
import { createServer } from 'node:http';

import { ejecutar } from './ejecutar.js';
import { preguntaPorId, preguntas, prepararTexto } from './preguntas.js';
import {
  avisoDeCarga,
  bloqueError,
  bloqueSalto,
  finDePagina,
  inicioDePagina,
  ocultarAviso,
  render,
  renderSesion,
} from './render.js';

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

    if (url.pathname === '/agente/sesion') {
      responder(
        respuesta,
        200,
        renderSesion({ sesion, catalogo, modelo, claudeCode, agenteMotivo }),
      );
      return;
    }
    if (url.pathname !== '/') {
      responder(respuesta, 404, 'No hay nada acá. La demo vive en / y en /agente/sesion.');
      return;
    }

    const peticion = peticionDe(url);
    const pregunta = preguntaPorId(peticion.pregunta);
    const texto = pregunta ? peticion.texto || prepararTexto(pregunta.texto, peticion) : '';

    // Sin agente disponible, `agente=1` en la URL no rompe la demo: se ignora
    // y la página dice por qué. El camino sin agente siempre está.
    const nota = peticion.usarAgente && !agente
      ? `Claude Code no está disponible: ${agenteMotivo}`
      : null;
    const conAgente = peticion.usarAgente && Boolean(agente);
    const pagina = {
      peticion,
      pregunta,
      texto,
      nota,
      agenteDisponible: Boolean(agente),
      agenteMotivo,
    };

    // Sin `pregunta` en la URL, la página es solo el formulario con la primera
    // preparada elegida: entrar a la demo no dispara una consulta sola.
    if (!url.searchParams.has('pregunta')) {
      responder(respuesta, 200, render({ ...pagina, pregunta: preguntas[0] }));
      return;
    }

    // La página sale por trozos y no de una vez: el salto al agente tarda
    // 3-6 s, y esperarlo dejaba el navegador en blanco todo ese rato. Se
    // escribe la cabecera con el formulario, después cada salto en cuanto
    // `ejecutar` avisa que quedó listo, y al final el cierre. Como no hay
    // `Content-Length`, `node:http` responde con `Transfer-Encoding: chunked`
    // y el navegador va pintando lo que llega — sin una línea de JavaScript.
    respuesta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    respuesta.write(inicioDePagina(pagina));
    respuesta.write(avisoDeCarga(1, conAgente ? 'agente' : 'capa'));
    try {
      await ejecutar(
        { ...peticion, usarAgente: conAgente },
        {
          agente,
          capa,
          reloj,
          alSalto: (salto, indice) =>
            respuesta.write(
              ocultarAviso(indice + 1) + bloqueSalto(salto, indice) + '\n' + avisoDeCarga(indice + 2),
            ),
        },
      );
    } catch (error) {
      // La pregunta que no existe: el error va donde habría ido el rastro.
      respuesta.write(bloqueError(error.message));
    }
    respuesta.end(finDePagina());
  });
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

function responder(respuesta, estado, cuerpo) {
  respuesta.writeHead(estado, { 'Content-Type': 'text/html; charset=utf-8' });
  respuesta.end(cuerpo);
}

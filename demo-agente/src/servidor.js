// El servidor: traduce la URL a la petición que entiende el seam y el rastro
// que devuelve a HTML. Toda la lógica está en `ejecutar`; aquí no hay
// decisiones que testear.
import { createServer } from 'node:http';

import { ejecutar } from './ejecutar.js';
import { preguntaPorId, preguntas, prepararTexto } from './preguntas.js';
import { render } from './render.js';

export function crearServidor({ capa, reloj = () => performance.now() }) {
  return createServer(async (peticionHttp, respuesta) => {
    const url = new URL(peticionHttp.url, 'http://demo.local');
    if (url.pathname !== '/') {
      responder(respuesta, 404, 'No hay nada acá. La demo vive en /.');
      return;
    }

    const peticion = peticionDe(url);
    const pregunta = preguntaPorId(peticion.pregunta);
    const texto = pregunta ? peticion.texto || prepararTexto(pregunta.texto, peticion) : '';

    // Sin `pregunta` en la URL, la página es solo el formulario con la primera
    // preparada elegida: entrar a la demo no dispara una consulta sola.
    if (!url.searchParams.has('pregunta')) {
      responder(respuesta, 200, render({ peticion, pregunta: preguntas[0] }));
      return;
    }

    try {
      const rastro = await ejecutar(peticion, { agente: null, capa, reloj });
      responder(respuesta, 200, render({ rastro, peticion, pregunta, texto }));
    } catch (error) {
      responder(respuesta, 200, render({ peticion, error: error.message }));
    }
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
    agente: parametro('agente') === '1',
  };
}

function responder(respuesta, estado, cuerpo) {
  respuesta.writeHead(estado, { 'Content-Type': 'text/html; charset=utf-8' });
  respuesta.end(cuerpo);
}

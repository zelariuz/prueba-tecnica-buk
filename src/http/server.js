// Capa HTTP: el contrato que usan los consumidores reales. Su único trabajo es
// traducir el token a contexto de sesión (ADR 0002), delegar en el engine y
// traducir el error estructurado a su código HTTP. Delgada a propósito: no
// valida miembros, no arma SQL y no decide presupuestos. Si aquí aparece una
// regla de negocio, está en el lugar equivocado.
import { createServer } from 'node:http';

import { SemanticError } from '../errors.js';
import { CODIGOS_HTTP } from './codigos.js';

// `registrarFallo` es la costura por la que salen los errores no estructurados:
// se escriben en el servidor y nunca en la respuesta.
export function crearServidor({ engine, catalog, tokens, registrarFallo = console.error }) {
  async function atender(peticion) {
    const url = new URL(peticion.url, 'http://servidor.local');

    // El contexto de sesión sale del token y de ninguna otra parte: nunca del
    // cuerpo de la petición ni de una variable global (ADR 0002). Un token que
    // no está en la tabla es una petición sin empresa que consultar.
    const sesion = tokens[tokenDe(peticion)];
    if (!sesion) {
      throw new SemanticError({
        code: 'MISSING_TENANT',
        suggestion:
          'La petición necesita un token conocido en la cabecera Authorization: Bearer <token>.',
      });
    }

    if (url.pathname === '/analytics/query' && peticion.method === 'POST') {
      const consulta = interpretar(await cuerpoDe(peticion));
      // El dry-run viaja en la URL y no en el cuerpo a propósito: el cuerpo es
      // la consulta declarativa y nada más, así que pedirlo no cambia su forma
      // ni, por lo tanto, su queryId (historia 25).
      return url.searchParams.get('dryRun') === 'true'
        ? { estado: 200, cuerpo: engine.plan(consulta, sesion) }
        : { estado: 200, cuerpo: await engine.run(consulta, sesion) };
    }

    // Siempre la vista pública, nunca `describeInternal` (ADR 0008): el mapeo
    // físico no sale por la API ni con un contexto que lo pida.
    if (url.pathname === '/analytics/catalog' && peticion.method === 'GET') {
      return { estado: 200, cuerpo: catalog.describe(sesion) };
    }

    return {
      estado: 404,
      cuerpo: {
        code: 'NOT_FOUND',
        suggestion: 'Rutas: POST /analytics/query y GET /analytics/catalog.',
      },
    };
  }

  return createServer(async (peticion, respuesta) => {
    try {
      const { estado, cuerpo } = await atender(peticion);
      responder(respuesta, estado, cuerpo);
    } catch (error) {
      const estado = CODIGOS_HTTP[error?.code];
      if (estado) return responder(respuesta, estado, cuerpoDeError(error));
      // Lo que no está en la tabla no es del consumidor: el detalle se queda en
      // el servidor y afuera sale sólo que algo falló.
      registrarFallo(error);
      responder(respuesta, 500, {
        code: 'INTERNAL_ERROR',
        suggestion: 'La consulta no se pudo procesar. Reporta el queryId si lo tienes.',
      });
    }
  });
}

function tokenDe(peticion) {
  const encabezado = peticion.headers.authorization ?? '';
  return encabezado.startsWith('Bearer ') ? encabezado.slice('Bearer '.length) : '';
}

async function cuerpoDe(peticion) {
  let texto = '';
  for await (const trozo of peticion) texto += trozo;
  return texto;
}

// Un cuerpo que no es JSON no llegó a ser una consulta declarativa: se rechaza
// aquí, con el mismo formato de error que usa el engine.
function interpretar(texto) {
  try {
    return JSON.parse(texto || '{}');
  } catch {
    throw new SemanticError({
      code: 'INVALID_JSON',
      suggestion: 'El cuerpo de la petición debe ser una consulta declarativa en JSON.',
    });
  }
}

// Sólo los tres campos del error estructurado (CONTEXT.md). Nunca el mensaje ni
// la pila: lo que sale al consumidor es lo que puede usar para corregirse.
function cuerpoDeError({ code, member, suggestion }) {
  return {
    code,
    ...(member === undefined ? {} : { member }),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function responder(respuesta, estado, cuerpo) {
  respuesta.writeHead(estado, { 'content-type': 'application/json; charset=utf-8' });
  respuesta.end(JSON.stringify(cuerpo));
}

// Capa HTTP: el contrato que usan los consumidores reales. Su único trabajo es
// traducir el token a contexto de sesión (ADR 0002), delegar en el engine y
// traducir el error estructurado a su código HTTP. Delgada a propósito: no
// valida miembros, no arma SQL y no decide presupuestos. Si aquí aparece una
// regla de negocio, está en el lugar equivocado.
import { createServer } from 'node:http';

import { SemanticError } from '../errors.js';
import { CABECERAS_HTTP, CODIGOS_HTTP } from './codigos.js';
import { crearTelemetria } from '../telemetry.js';
import { presupuestos } from '../budgets.js';

// El instante en que arrancó el proceso, calculado una sola vez: `process.uptime()`
// se mueve a cada llamada y `startedAt` no debería moverse con él.
const ARRANQUE = new Date(Date.now() - process.uptime() * 1000).toISOString();

// `registrarFallo` es la costura por la que salen los errores no estructurados:
// se escriben en el servidor y nunca en la respuesta. `telemetria` es la misma
// del engine: la capa HTTP sólo le aporta lo que únicamente ella ve —el cliente
// que cerró la conexión antes de la respuesta—.
export function crearServidor({
  engine,
  catalog,
  tokens,
  registrarFallo = console.error,
  telemetria = crearTelemetria(),
}) {
  // `marco` es lo que la petición ya resolvió cuando algo la interrumpe: el
  // consumidor sale del token, y hace falta para contar por consumidor.
  async function atender(peticion, marco) {
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
    marco.sesion = sesion;

    if (url.pathname === '/analytics/query' && peticion.method === 'POST') {
      const consulta = interpretar(await cuerpoDe(peticion));
      // El dry-run viaja en la URL y no en el cuerpo a propósito: el cuerpo es
      // la consulta declarativa y nada más, así que pedirlo no cambia su forma
      // ni, por lo tanto, su queryId (historia 25).
      if (url.searchParams.get('dryRun') !== 'true') {
        return { estado: 200, cuerpo: await engine.run(consulta, sesion) };
      }
      // El dry-run devuelve el **plan lógico**: entidad, camino de joins,
      // medidas, filtros y presupuesto, todo en nombres semánticos. El SQL no
      // entra: nombra las tablas y las columnas físicas, exactamente lo que la
      // vista pública del catálogo esconde (ADR 0008), y entregarlo por otra
      // ruta sería tener la regla en un solo lado. Sólo una sesión interna lo
      // recibe, y `internal` viene del token —lo pone el servidor— y nunca de la
      // consulta.
      const { sql, params, plan } = engine.plan(consulta, sesion);
      return {
        estado: 200,
        cuerpo: { params, plan, ...(sesion.internal === true ? { sql } : {}) },
      };
    }

    // Siempre la vista pública, nunca `describeInternal` (ADR 0008): el mapeo
    // físico no sale por la API ni con un contexto que lo pida.
    if (url.pathname === '/analytics/catalog' && peticion.method === 'GET') {
      return { estado: 200, cuerpo: catalog.describe(sesion) };
    }

    // Los contadores del proceso y la tabla de presupuestos, para una sesión
    // interna y sólo para ella: es la misma marca que abre el SQL del dry-run
    // (ADR 0002, ADR 0008), y por la misma razón —quien consulta ve lo suyo;
    // qué pide el resto de los consumidores es información de operación—.
    // `internal` viene del token, nunca de la petición.
    //
    // Es de lectura y nada más: la telemetría es del proceso —los contadores
    // viven mientras él viva— y no hay reset por HTTP. Reiniciarla desde afuera
    // dejaría a cualquiera borrando la única evidencia de lo que pasó, y con
    // varias instancias ni siquiera se sabría a cuál se le borró.
    if (url.pathname === '/analytics/telemetry' && peticion.method === 'GET') {
      if (sesion.internal !== true) {
        throw new SemanticError({
          code: 'FORBIDDEN',
          suggestion:
            'La telemetría del servicio sale sólo para una sesión interna: usa el token de una herramienta del equipo.',
        });
      }
      return {
        estado: 200,
        cuerpo: {
          telemetry: engine.telemetry(),
          // La tabla tal cual la declara `src/budgets.js`: no se recalcula ni se
          // resume acá, para que lo que se lee sea lo que el planificador aplica.
          budgets: presupuestos,
          process: { uptimeMs: Math.round(process.uptime() * 1000), startedAt: ARRANQUE },
        },
      };
    }

    return {
      estado: 404,
      cuerpo: {
        code: 'NOT_FOUND',
        suggestion:
          'Rutas: POST /analytics/query, GET /analytics/catalog y GET /analytics/telemetry (sesión interna).',
      },
    };
  }

  return createServer(async (peticion, respuesta) => {
    const marco = {};
    // La conexión se cerró sin que la respuesta saliera: el cliente se fue. La
    // consulta que ya corre no se cancela —se termina y se cachea, así el retry
    // es un hit—; lo que se hace es contarlo, que es lo que anticipa la queja.
    respuesta.on('close', () => {
      if (!respuesta.writableFinished) {
        telemetria.registrarClienteSeFue({ consumer: marco.sesion?.consumer });
      }
    });
    try {
      const { estado, cuerpo } = await atender(peticion, marco);
      responder(respuesta, estado, cuerpo);
    } catch (error) {
      const estado = CODIGOS_HTTP[error?.code];
      if (estado) {
        responder(respuesta, estado, cuerpoDeError(error), CABECERAS_HTTP[error.code]);
        // Un cuerpo que superó el techo deja bytes sin leer en el socket: no se
        // siguen recibiendo los de algo que ya se rechazó. Se corta recién
        // cuando la respuesta salió, para que el 413 alcance a llegar.
        if (error.code === 'PAYLOAD_TOO_LARGE') respuesta.on('finish', () => peticion.destroy());
        return;
      }
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

// Techo del cuerpo de una petición. Una consulta declarativa son unos cientos
// de bytes; 64 KiB deja margen para una lista de valores larga y sigue siendo
// dos órdenes de magnitud menos de lo que hace falta para que un cliente llene
// la memoria del servidor mandando un cuerpo sin fin.
export const LIMITE_DE_CUERPO = 64 * 1024;

// Se cuentan bytes y no caracteres: `texto.length` mide unidades UTF-16, así
// que un cuerpo de acentos o emojis pasaría el techo sin que el contador lo
// note. El iterador va con `destroyOnReturn: false` porque salir del bucle con
// un throw destruiría el socket —y con él la respuesta 413 que el cliente
// tiene que poder leer—; cortar la conexión es trabajo del handler, después de
// que la respuesta salió.
async function cuerpoDe(peticion) {
  const trozos = [];
  let bytes = 0;
  for await (const trozo of peticion.iterator({ destroyOnReturn: false })) {
    bytes += trozo.length;
    if (bytes > LIMITE_DE_CUERPO) {
      throw new SemanticError({
        code: 'PAYLOAD_TOO_LARGE',
        suggestion: `El cuerpo de la petición no puede superar los ${LIMITE_DE_CUERPO} bytes: una consulta declarativa no los necesita, revisa si estás mandando datos en vez de una consulta.`,
      });
    }
    trozos.push(trozo);
  }
  return Buffer.concat(trozos).toString('utf8');
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

function responder(respuesta, estado, cuerpo, cabeceras) {
  // Sin nadie al otro lado no hay a quién responder; escribir en un socket
  // destruido no sirve de nada y en algunas versiones de Node emite error.
  if (respuesta.destroyed) return;
  respuesta.writeHead(estado, { 'content-type': 'application/json; charset=utf-8', ...cabeceras });
  respuesta.end(JSON.stringify(cuerpo));
}

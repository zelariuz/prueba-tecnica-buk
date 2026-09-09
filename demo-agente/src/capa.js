// Adaptador real de la capa: lo único de la demo que habla HTTP con ella.
// Traduce el NOMBRE del token a su valor —el nombre es lo que viaja por el
// rastro y lo que ve la página— y mide el tiempo de la llamada.
//
// Los nombres son los de `consumidores.js` (`demo-agente-empresa-c`,
// `demo-interno-empresa-a`, …), uno por empresa y clase. Que la empresa se
// elija cambiando de token no es una comodidad de la demo: la capa deriva la
// empresa del token y la consulta no la lleva (ADR 0002).
import { CONSUMIDOR_POR_DEFECTO } from './consumidores.js';

export function crearCapa({ url, tokens }) {
  return async function capa({ ruta, token, cuerpo }) {
    const inicio = performance.now();
    const respuesta = await fetch(`${url}${ruta}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${valorDelToken(tokens, token)}`,
      },
      body: JSON.stringify(cuerpo),
    });
    const json = await respuesta.json();
    return { status: respuesta.status, json, ms: Math.round(performance.now() - inicio) };
  };
}

// El catálogo público es el mismo para las tres empresas (ADR 0008: la vista
// pública no depende del contexto del consumidor), así que se pide una vez y
// con un token cualquiera de clase agente.
export async function pedirCatalogo({ url, tokens, token = CONSUMIDOR_POR_DEFECTO.agente }) {
  const respuesta = await fetch(`${url}/analytics/catalog`, {
    headers: { Authorization: `Bearer ${valorDelToken(tokens, token)}` },
  });
  if (!respuesta.ok) {
    throw new Error(`la capa contestó ${respuesta.status} al catálogo`);
  }
  return respuesta.json();
}

function valorDelToken(tokens, nombre) {
  const valor = tokens[nombre];
  if (!valor) throw new Error(`No hay valor configurado para el token "${nombre}".`);
  return valor;
}

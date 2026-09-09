// Adaptador real de la capa: lo único de la demo que habla HTTP con ella.
// Traduce el NOMBRE del token a su valor —el nombre es lo que viaja por el
// rastro y lo que ve la página— y mide el tiempo de la llamada.
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

export async function pedirCatalogo({ url, tokens }) {
  const respuesta = await fetch(`${url}/analytics/catalog`, {
    headers: { Authorization: `Bearer ${valorDelToken(tokens, 'agente')}` },
  });
  if (!respuesta.ok) {
    throw new Error(`la capa contestó ${respuesta.status} al catálogo`);
  }
  return respuesta.json();
}

function valorDelToken(tokens, nombre) {
  const valor = tokens[nombre];
  if (!valor) throw new Error(`No hay token configurado para la clase "${nombre}".`);
  return valor;
}

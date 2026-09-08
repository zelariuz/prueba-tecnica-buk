// Tabla de tokens de demo: `{ token → { companyId, consumer, internal? } }`.
//
// La autenticación real está fuera de alcance (PRD, Fuera de Alcance): la
// aplicación entrega un usuario ya autenticado y esta capa sólo consume su
// empresa y su clase de consumidor. Lo que hay aquí es el mínimo que permite
// probar el contrato HTTP de punta a punta: una tabla en memoria, cargada de
// una variable de entorno, con valores de demo. En producción esta función se
// reemplaza por el verificador de tokens de la plataforma y nada más cambia:
// el resto de la capa sólo ve `{ companyId, consumer }`.
const CLASES = new Set(['dashboard', 'api', 'agent']);

// `internal` marca la sesión de una herramienta del equipo, no la de un
// consumidor: es lo único que abre el SQL del dry-run, que nombra tablas y
// columnas físicas. Es opcional y por defecto falsa —ningún token de demo de
// consumidor la trae—, y viaja en el token justamente para que no se pueda
// pedir desde la consulta (ADR 0002, ADR 0008).
const INTERNO_POR_DEFECTO = false;

export function tokensDeDemo(env = process.env) {
  const crudo = env.DEMO_TOKENS;
  if (!crudo) {
    throw new Error(
      'Falta DEMO_TOKENS: el servicio necesita la tabla de tokens de demo en JSON (ver .env.example).',
    );
  }

  let tabla;
  try {
    tabla = JSON.parse(crudo);
  } catch {
    throw new Error('DEMO_TOKENS no es JSON válido: { "<token>": { "companyId": 1, "consumer": "dashboard", "internal": false } }.');
  }

  for (const [token, sesion] of Object.entries(tabla)) {
    if (!Number.isInteger(sesion?.companyId) || !CLASES.has(sesion?.consumer)) {
      throw new Error(
        `El token ${token} de DEMO_TOKENS debe traer companyId entero y consumer en ${[...CLASES].join(', ')}.`,
      );
    }
    if (sesion.internal !== undefined && typeof sesion.internal !== 'boolean') {
      throw new Error(`El internal del token ${token} de DEMO_TOKENS es true o false.`);
    }
    sesion.internal = sesion.internal ?? INTERNO_POR_DEFECTO;
  }
  return tabla;
}

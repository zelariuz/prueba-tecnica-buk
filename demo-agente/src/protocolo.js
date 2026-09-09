// El protocolo con el agente: qué se le manda y cómo se lee lo que devuelve.
// Son funciones puras de texto —ni HTTP, ni procesos, ni rastro— y por eso
// viven aparte del seam que las usa: `ejecutar` decide el camino, esto decide
// las palabras.
import { prepararTexto } from './preguntas.js';

// El prompt del clic: el texto de la pregunta —el editado si lo hay— más la
// frase fija de filtros. El agente traduce esa frase a `timeDimensions` y
// `filters`; la demo no le pasa el JSON preparado nunca.
export function promptDelClic(pregunta, peticion) {
  const texto = peticion.texto || prepararTexto(pregunta.texto, peticion);
  const departamento = peticion.departamento ? `, departamento ${peticion.departamento}` : '';
  return `${texto}\n\nFiltros: desde ${peticion.desde}, hasta ${peticion.hasta}${departamento}.`;
}

// El prompt de corrección: el error tal cual lo publica la capa. La sugerencia
// es la que hace posible el reintento, y por eso se manda entera.
export function promptDeCorreccion(error) {
  return `La capa rechazó tu consulta.

code: ${error?.code ?? '(sin código)'}
member: ${error?.member ?? '(no lo dice)'}
suggestion: ${error?.suggestion ?? '(no la dice)'}

Devuelve el JSON corregido, o {"noPuedo": "motivo breve"} si el catálogo no alcanza.`;
}

// El contrato dice "solo JSON", pero un modelo puede envolverlo en un bloque de
// código igual. La leniencia es deliberada: se le tolera la envoltura ``` y no
// la prosa. Un modelo que agrega markdown sigue habiendo entendido la pregunta,
// y castigar eso convertiría un detalle de formato en un salto fallido; un
// modelo que explica en vez de responder no entendió el contrato, y ese sí
// tiene que verse roto en la página.
export function comoJson(texto) {
  const limpio = String(texto ?? '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const valor = JSON.parse(limpio);
    return valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
  } catch {
    return null;
  }
}

// El protocolo con el agente: qué se le manda y cómo se lee lo que devuelve.
// Son funciones puras de texto —ni HTTP, ni procesos, ni rastro— y por eso
// viven aparte del seam que las usa: `ejecutar` decide el camino, esto decide
// las palabras.
import { prepararTexto } from './preguntas.js';

// El prompt del clic: el texto de la pregunta —el editado si lo hay— más la
// línea de filtros. El agente traduce esa línea a `timeDimensions` y `filters`;
// la demo no le pasa el JSON preparado nunca.
//
// Cada filtro se nombra UNA sola vez y sólo si existe: el texto de la pregunta
// ya no lleva las fechas (antes iban ahí y otra vez acá, y el agente veía dos
// veces lo mismo), y sin fechas ni departamento la línea entera desaparece. Un
// rango vacío no es un error desde el ADR 0009: es una consulta sin rango.
//
// Texto propio (desenganchado): se manda TAL CUAL, sin línea de filtros. Lo que
// la persona escribió es exactamente lo que recibe el agente (pedido del
// usuario, 09-09 noche: las fechas del formulario se le pegaban a su texto).
export function promptDelClic(pregunta, peticion) {
  if (peticion.texto) return peticion.texto;
  const texto = prepararTexto(pregunta.texto, peticion);
  const filtros = [
    peticion.desde ? `desde ${peticion.desde}` : null,
    peticion.hasta ? `hasta ${peticion.hasta}` : null,
    peticion.departamento ? `departamento ${peticion.departamento}` : null,
  ].filter(Boolean);
  return filtros.length > 0 ? `${texto}\n\nFiltros: ${filtros.join(', ')}.` : texto;
}

// El prompt de corrección: el error tal cual lo publica la capa. La sugerencia
// es la que hace posible el reintento, y por eso se manda entera.
//
// Viaja COMPLETO: pregunta original, el JSON que el agente escribió y el error.
// Con `--fork-session` cada llamada arranca desde el estado de creación de la
// sesión, así que la corrección no puede apoyarse en "lo que dijimos recién":
// verificado el 09-09 (el agente respondió "no tengo la consulta ni la
// pregunta original para corregirla").
export function promptDeCorreccion(error, { pregunta = '', consulta = null } = {}) {
  const contexto = [
    pregunta ? `La pregunta original era:\n${pregunta}` : null,
    consulta ? `Tu consulta fue:\n${JSON.stringify(consulta)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
  return `${contexto ? `${contexto}\n\n` : ''}La capa rechazó tu consulta.

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

// El prompt de redacción: el segundo momento del mismo modelo. Primero tradujo
// la pregunta a JSON; ahora, con las filas que la capa devolvió delante, escribe
// la frase. Es el mismo agente y la misma sesión bifurcada, así que acá sólo
// hacen falta las palabras: la pregunta original —el mismo texto del salto 1—,
// las filas y de dónde salieron.
//
// Al modelo llegan SÓLO agregados por empresa: la capa no publica filas crudas
// ni columnas personales (ADR 0002 y el catálogo público), y el prompt lo dice
// para que se lea en la página quién ve qué.
const TOPE_DE_FILAS = 50;

export function promptDeRedaccion(pregunta, filas, meta = {}) {
  const todas = Array.isArray(filas) ? filas : [];
  const mostradas = todas.slice(0, TOPE_DE_FILAS);
  // El recorte se declara: una frase escrita sobre 50 de 300 filas es otra cosa
  // que una escrita sobre todas, y el modelo tiene que saber cuál está viendo.
  const recorte =
    todas.length > TOPE_DE_FILAS ? `\n(se muestran ${TOPE_DE_FILAS} de ${todas.length} filas)` : '';
  const origen = [
    meta?.servedFrom ? `servedFrom: ${meta.servedFrom}` : null,
    meta?.asOf ? `asOf: ${meta.asOf}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return `La pregunta era:
${pregunta}

Éstas son las filas que devolvió la capa (agregados por empresa; no hay datos personales):
${JSON.stringify(mostradas)}${recorte}
${origen ? `${origen}\n` : ''}
Responde en español, en texto plano, una o dos frases que contesten la pregunta con los números de las filas tal cual están (no redondees más de dos decimales, no inventes ningún número ni categoría que no esté en las filas, no menciones SQL ni JSON). Si las filas están vacías, dilo. Sin markdown.`;
}

// Rangos relativos: el `dateRange` de una dimensión temporal puede venir como
// una frase —`last 6 months`, `this quarter`— en vez del par de fechas
// absolutas, y esta pieza la convierte en ese mismo par (ADR 0014).
//
// El vocabulario es una **lista cerrada**, no un analizador de lenguaje
// natural. Cube interpreta frases libres con Chrono; aquí no. Es la misma razón
// por la que las granularidades son una lista cerrada: una capa que promete
// determinismo no puede depender de cómo alguien escriba una frase, y un rango
// mal interpretado no falla —devuelve los datos de otro período, con 200 y sin
// una sola advertencia—. Lo que no está en la lista se rechaza con la lista
// entera en la sugerencia, igual que una granularidad inválida.
//
// Toda la aritmética ocurre sobre el **día calendario** —año, mes y día— de la
// zona pedida, representado como un `Date` en UTC, nunca sobre instantes. Así
// no hay horario de verano que corra un límite ni zona del proceso que se
// cuele: el mismo "hoy" da el mismo rango en cualquier máquina.
import { SemanticError } from './errors.js';

// Sin zona, UTC. La zona sirve ÚNICAMENTE para saber qué día es hoy y resolver
// la frase; la capa sigue sin convertir nada (ver `zonaValida`).
export const ZONA_POR_DEFECTO = 'UTC';

const DIA_EN_MS = 86_400_000;

// `last N <unidad>`: N es un entero positivo escrito sin ceros a la izquierda,
// para que `last 07 days` no sea una segunda forma de escribir lo mismo.
const FRASE_ULTIMOS_N = /^last ([1-9]\d*) (days|weeks|months|quarters|years)$/;

const UNIDADES = ['day', 'week', 'month', 'quarter', 'year'];

// El comienzo del período en curso al que pertenece un día, por unidad. Es la
// única función de calendario del módulo: todo lo demás se arma con ella.
const INICIO_DE = {
  day: (dia) => dia,
  // La semana empieza el lunes, como el `DATE_TRUNC('week', …)` de Postgres
  // —el mismo criterio con el que el planificador cuenta buckets—. Que las dos
  // cuentas coincidan importa: `fillMissing` genera la serie desde el inicio
  // truncado del rango que esto resolvió.
  week: (dia) => sumarDias(dia, -((dia.getUTCDay() + 6) % 7)),
  month: (dia) => primeroDeMes(dia.getUTCFullYear(), dia.getUTCMonth()),
  quarter: (dia) => primeroDeMes(dia.getUTCFullYear(), dia.getUTCMonth() - (dia.getUTCMonth() % 3)),
  year: (dia) => primeroDeMes(dia.getUTCFullYear(), 0),
};

// Cuántos meses retrocede un período. La semana y el día no se cuentan en
// meses, así que tienen su propio salto más abajo.
const MESES_POR_UNIDAD = { month: 1, quarter: 3, year: 12 };

// Las frases de una sola pieza. Las `this …` van del comienzo del período en
// curso a HOY, y no al final del período: un rango que llegara al 31 de
// diciembre incluiría días que todavía no ocurrieron, y con `fillMissing` eso
// son buckets vacíos del futuro dibujados como si fueran datos faltantes.
//
// Las `last …` son el período calendario anterior COMPLETO y no incluyen hoy
// —ver `ultimosN`—, y son exactamente el caso N=1 de su forma larga:
// `last month` es `last 1 month` y `last 1 day` es `yesterday`.
const FRASES = {
  today: (hoy) => [hoy, hoy],
  yesterday: (hoy) => ultimosN(hoy, 1, 'day'),
  'this week': (hoy) => [INICIO_DE.week(hoy), hoy],
  'this month': (hoy) => [INICIO_DE.month(hoy), hoy],
  'this quarter': (hoy) => [INICIO_DE.quarter(hoy), hoy],
  'this year': (hoy) => [INICIO_DE.year(hoy), hoy],
  'last week': (hoy) => ultimosN(hoy, 1, 'week'),
  'last month': (hoy) => ultimosN(hoy, 1, 'month'),
  'last quarter': (hoy) => ultimosN(hoy, 1, 'quarter'),
  'last year': (hoy) => ultimosN(hoy, 1, 'year'),
};

// El vocabulario, escrito para que quepa en un mensaje de error: quien se
// equivocó se corrige leyendo la sugerencia, sin ir a buscar la documentación.
// Es el mismo trato que reciben las granularidades.
export const VOCABULARIO_DE_RANGOS = [
  ...Object.keys(FRASES),
  ...UNIDADES.map((unidad) => `last N ${unidad}s`),
];

// Un `dateRange` es relativo cuando es una cadena. No se intenta adivinar nada
// más: un arreglo es el par de fechas absolutas de siempre y no pasa por aquí.
export function esRangoRelativo(dateRange) {
  return typeof dateRange === 'string';
}

// La zona de la consulta, validada con la API `Intl` del runtime y no con una
// lista propia: mantener una lista de zonas es mantener la base de datos IANA a
// mano, y el runtime ya la trae y la actualiza.
//
// IMPORTANTE, para que nadie lea de más: la zona **no** convierte ningún dato.
// Las columnas temporales siguen siendo `DATE` —días ya resueltos, sin hora ni
// zona (`docs/riesgos.md`, "fechas y zonas")— y la capa las sigue comparando
// tal cual. Lo único que decide la zona es qué día es "hoy" al resolver una
// frase; con `dateRange` absoluto no cambia absolutamente nada.
export function zonaValida(timezone) {
  if (timezone === undefined) return ZONA_POR_DEFECTO;
  if (typeof timezone === 'string') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      return timezone;
    } catch {
      // Cae al rechazo de abajo: el runtime no la conoce.
    }
  }
  throw new SemanticError({
    code: 'INVALID_QUERY',
    member: 'timezone',
    suggestion: `timezone es una zona IANA que el runtime conozca, por ejemplo America/Santiago o UTC; recibí ${JSON.stringify(timezone)}. Sólo se usa para saber qué día es hoy al resolver un dateRange relativo (today, last 6 months…); por omisión, ${ZONA_POR_DEFECTO}.`,
  });
}

// La frase → el par `[desde, hasta]` en `YYYY-MM-DD`, cerrado en los dos
// extremos como cualquier `dateRange` de la capa.
//
// `ahora` es el milisegundo que dio el reloj inyectado del engine; `member` es
// dónde venía la frase, para que el error la señale. Se le pasa el instante y
// no un "hoy" ya calculado porque qué día es hoy depende de la zona, y eso se
// decide aquí.
export function resolverRangoRelativo(frase, { ahora, zona, member }) {
  const resolver = FRASES[frase] ?? ultimosNDeLaFrase(frase);
  if (!resolver) {
    throw new SemanticError({
      code: 'INVALID_QUERY',
      member,
      suggestion: `dateRange es un par de fechas [desde, hasta] o una de estas frases, escrita exactamente así, en minúsculas: ${VOCABULARIO_DE_RANGOS.join(', ')} (N es un entero positivo). Recibí ${JSON.stringify(frase)}.`,
    });
  }
  return resolver(hoyEn(ahora, zona)).map(comoIso);
}

// `last N <unidad>` → la función que lo resuelve, o `undefined` si la frase no
// tiene esa forma. La `s` final es obligatoria en las cinco unidades: una sola
// escritura por rango, incluso cuando N es 1 (`last 1 days`), porque la forma
// corta de N=1 ya existe y se llama `yesterday`, `last week`…
function ultimosNDeLaFrase(frase) {
  const partes = FRASE_ULTIMOS_N.exec(frase ?? '');
  if (!partes) return undefined;
  const [, cuantos, plural] = partes;
  return (hoy) => ultimosN(hoy, Number(cuantos), plural.slice(0, -1));
}

// Los N períodos calendario anteriores COMPLETOS: terminan justo antes de que
// empiece el período en curso y, por lo tanto, **nunca incluyen hoy**.
//
// Ésta es la definición elegida y el centro del ADR 0014: `last month` es el mes
// calendario anterior entero —del 1 al último día—, no los últimos 30 días. Un
// período a medio transcurrir hunde el último punto de cualquier gráfico y
// arruina toda comparación contra el período anterior, que sí está completo; y
// "el mes pasado" es, para quien pregunta, un mes del calendario. Quien quiera
// incluir lo que va corrido del mes tiene `this month`, que es otra pregunta y
// tiene su propia frase.
function ultimosN(hoy, cuantos, unidad) {
  const inicioDelActual = INICIO_DE[unidad](hoy);
  const meses = MESES_POR_UNIDAD[unidad];
  const desde = meses
    ? primeroDeMes(inicioDelActual.getUTCFullYear(), inicioDelActual.getUTCMonth() - meses * cuantos)
    : sumarDias(inicioDelActual, -(unidad === 'week' ? 7 : 1) * cuantos);
  return [desde, sumarDias(inicioDelActual, -1)];
}

// Qué día es "hoy" en una zona. Se pregunta a `Intl`, que es quien conoce las
// reglas de cada zona, y se lee por partes en vez de por el texto formateado:
// el formato de una configuración regional puede cambiar, los `type` no.
function hoyEn(ahora, zona) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ahora));
  const { year, month, day } = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

// Sumar días sobre un día calendario representado en UTC es aritmética exacta:
// en UTC no hay días de 23 ni de 25 horas.
function sumarDias(dia, cuantos) {
  return new Date(dia.getTime() + cuantos * DIA_EN_MS);
}

// El día 1 de un mes, que `Date.UTC` normaliza solo cuando el mes se sale del
// año (mes -1 es diciembre del año anterior). Todos los saltos por mes de este
// módulo parten del día 1, así que nunca aparece el clásico 31 de enero menos
// un mes: no hay día que recortar.
function primeroDeMes(anio, mes) {
  return new Date(Date.UTC(anio, mes, 1));
}

function comoIso(dia) {
  return dia.toISOString().slice(0, 10);
}

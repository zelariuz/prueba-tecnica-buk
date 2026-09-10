// Preparación de una pregunta preparada: sustituir marcadores por los filtros
// manuales. Funciones puras, sin dependencias, en un módulo ES que usan LOS DOS
// lados: el mini back (`src/preguntas.js` lo importa) y el front (`app.js` lo
// carga como /preparar.js). Una sola implementación: lo que el navegador
// muestra como "JSON preparado" es exactamente lo que el back manda.
const MARCADOR_DEPARTAMENTO = ':departamento';

// `departamento` vacío no manda un filtro vacío: le saca el filtro a la
// consulta. Un filtro con el marcador sin sustituir sería un departamento
// llamado ":departamento", que no existe y devolvería cero filas — justo lo
// que no queremos mostrar.
export function prepararConsulta(pregunta, { desde, hasta, departamento }) {
  const consulta = sinRangoVacio(
    estructuraSinFiltroVacio(pregunta.consulta, departamento),
    desde,
    hasta,
  );
  return sustituir(consulta, { ':desde': desde, ':hasta': hasta, [MARCADOR_DEPARTAMENTO]: departamento });
}

// El texto en lenguaje natural lleva el marcador del departamento; sin
// departamento la frase dice "todos los departamentos" en vez de dejar el
// marcador crudo. Las fechas NO están en el texto: van una sola vez, en la
// línea de filtros de `promptDelClic`.
export function prepararTexto(texto, { departamento }) {
  return texto.replaceAll(MARCADOR_DEPARTAMENTO, departamento || 'todos los departamentos');
}

// Sin fechas no hay `dateRange`: la dimensión temporal se queda con su
// granularidad, que la capa acepta desde el ADR 0009 (ninguna clase exige
// rango). Se le quita el rango, y no la dimensión entera, porque el corte por
// tiempo es lo que la pregunta pidió: "por trimestre" sigue siendo por
// trimestre aunque no se acote el período.
//
// Basta con que falte UNA de las dos fechas: un `dateRange` es un par, y
// mandar [<vacío>, 2025-12-31] sería un rango inválido con forma de rango.
function sinRangoVacio(consulta, desde, hasta) {
  if (desde && hasta) return consulta;
  if (!Array.isArray(consulta.timeDimensions)) return consulta;
  return {
    ...consulta,
    timeDimensions: consulta.timeDimensions.map(({ dateRange: _fuera, ...resto }) => resto),
  };
}

function estructuraSinFiltroVacio(consulta, departamento) {
  if (departamento) return consulta;
  if (!Array.isArray(consulta.filters)) return consulta;
  const filters = consulta.filters.filter(
    (filtro) => !(filtro.values ?? []).includes(MARCADOR_DEPARTAMENTO),
  );
  const { filters: _fuera, ...resto } = consulta;
  return filters.length > 0 ? { ...resto, filters } : resto;
}

function sustituir(valor, reemplazos) {
  if (typeof valor === 'string') return valor in reemplazos ? reemplazos[valor] : valor;
  if (Array.isArray(valor)) return valor.map((elemento) => sustituir(elemento, reemplazos));
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([clave, dentro]) => [clave, sustituir(dentro, reemplazos)]),
    );
  }
  return valor;
}

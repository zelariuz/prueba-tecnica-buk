// Los consumidores de demo: datos, no código. Cada uno es un PAR de tokens de
// la misma empresa —el de clase `agente`, que hace la consulta real, y el
// interno, el único que ve el SQL en el dry-run— más lo que la página necesita
// para presentarlo.
//
// Se elige por el NOMBRE del token de clase agente, y ese nombre es también el
// `id` del consumidor y lo que viaja en la URL (`?token=…`). Está publicado en
// el `docker-compose.yml` del repo, así que nombrarlo acá no filtra nada: el
// VALOR que va en `Authorization` sale del `.env` del mini back y nunca baja al
// navegador. La página muestra nombres; el adaptador `capa.js` es el único que
// traduce nombre → valor.
//
// La empresa NO viaja en la consulta: la capa la deriva del token (ADR 0002).
// Por eso cambiar de empresa acá es, literalmente, cambiar de token.

export const CONSUMIDORES = [
  {
    id: 'demo-agente-empresa-a',
    empresa: 'A',
    agente: 'demo-agente-empresa-a',
    interno: 'demo-interno-empresa-a',
    // La clase de consumidor con la que la capa presupuesta la consulta real.
    // Es la del token agente; el interno es de clase `api` y sólo hace el
    // dry-run. La página la usa para resaltar su fila en la tabla de
    // presupuestos.
    clase: 'agent',
    etiqueta: 'demo-agente-empresa-a — clase agente · Empresa A (seed chico, números verificables)',
    variables: { agente: 'TOKEN_AGENTE_A', interno: 'TOKEN_INTERNO_A' },
    // Compatibilidad: el `.env` de antes de la empresa C tenía un solo par de
    // tokens, sin sufijo, y era el de la A.
    compatibles: { agente: 'TOKEN_AGENTE', interno: 'TOKEN_INTERNO' },
    nota: null,
    // La asistencia del seed chico son junio a agosto de 2025; el resto de las
    // preguntas mira las evaluaciones, que viven en todo 2025. Las dos sobre
    // `employees` van con el rango vacío: esa entidad no tiene dimensión
    // temporal, así que no hay fecha que precargar (ADR 0009). La de los
    // departamentos también: no lleva `timeDimensions` porque no lleva nada
    // más que la dimensión (ADR 0010).
    rangos: {
      // Las tres preguntas literales del enunciado: "el último año" y "los
      // últimos tres meses" son, en la demo, los del seed. Cada pregunta lo
      // dice en su `nota`.
      'enunciado-1-score-por-departamento': ['2025-01-01', '2025-12-31'],
      'enunciado-2-completaron-por-trimestre': ['2025-01-01', '2025-12-31'],
      'enunciado-3-asistencia-por-departamento': ['2025-06-01', '2025-08-31'],
      'asistencia-por-departamento': ['2025-06-01', '2025-08-31'],
      // La semana del ADR 0012: del 8 al 14 de agosto Ventas deja de registrar
      // el 11, así que sin relleno son 10 filas y con relleno 14.
      'serie-densa-asistencia-diaria': ['2025-08-08', '2025-08-14'],
      // Tres meses por día y departamento: 152 filas, de las que la consulta
      // pide 20. El `total` es el número que el límite escondía.
      'total-de-filas-asistencia': ['2025-06-01', '2025-08-31'],
      // Éstas traen el período puesto en la consulta —una frase relativa, o la
      // lista de rangos a comparar—, así que los campos van VACÍOS: si el
      // formulario precargara fechas, la línea "Filtros: desde…, hasta…" del
      // prompt del clic le pediría al agente justo lo contrario de lo que la
      // pregunta demuestra.
      'rango-relativo-ultimo-ano': ['', ''],
      'comparacion-agosto-contra-julio': ['', ''],
      'headcount-por-departamento': ['', ''],
      'cuantos-empleados-hay': ['', ''],
      'cuales-departamentos-hay': ['', ''],
    },
    rangoPorDefecto: ['2025-01-01', '2025-12-31'],
  },
  {
    id: 'demo-agente-empresa-c',
    empresa: 'C',
    agente: 'demo-agente-empresa-c',
    interno: 'demo-interno-empresa-c',
    clase: 'agent',
    etiqueta: 'demo-agente-empresa-c — clase agente · Empresa C (1 millón de filas de asistencia)',
    variables: { agente: 'TOKEN_AGENTE_C', interno: 'TOKEN_INTERNO_C' },
    compatibles: null,
    nota:
      'La empresa C existe para ver tiempos, caché, el tope de filas de la clase agente y la ' +
      'advertencia de índice; sus números no están calculados a mano.',
    // Un año entero para todas, asistencia incluida: son 1.062.283 filas y la
    // gracia es justamente pedirle a la capa un rango grande. Las dos preguntas
    // sobre `employees` y la de los departamentos van sin rango: no hay
    // dimensión temporal que acotar.
    rangos: {
      // La misma semana de agosto que en la empresa A, y por el mismo motivo:
      // la serie densa se mira día a día. Acá no hay huecos que rellenar —la C
      // registra todos los días—, así que lo que se ve es el otro lado de la
      // bandera: la serie ya venía completa y el relleno no cambia nada.
      'serie-densa-asistencia-diaria': ['2025-08-08', '2025-08-14'],
      'rango-relativo-ultimo-ano': ['', ''],
      'comparacion-agosto-contra-julio': ['', ''],
      'headcount-por-departamento': ['', ''],
      'cuantos-empleados-hay': ['', ''],
      'cuales-departamentos-hay': ['', ''],
    },
    rangoPorDefecto: ['2025-01-01', '2025-12-31'],
  },
];

export const CONSUMIDOR_POR_DEFECTO = CONSUMIDORES[0];

export function consumidorPorId(id) {
  if (!id) return CONSUMIDOR_POR_DEFECTO;
  return CONSUMIDORES.find((consumidor) => consumidor.id === id) ?? null;
}

// Lo que baja al navegador: nombres, etiquetas y rangos precargados. Ningún
// valor de token, porque acá no hay ninguno.
export function consumidoresPublicos() {
  return CONSUMIDORES.map(({ id, empresa, clase, etiqueta, nota, rangos, rangoPorDefecto }) => ({
    id,
    empresa,
    clase,
    etiqueta,
    nota,
    rangos,
    rangoPorDefecto,
  }));
}

// El mapa nombre de token → valor con el que se firma la petición. Las claves
// son los nombres que la página muestra en el chip de cada salto; los valores
// salen del entorno y, si no está la variable, del propio nombre —los tokens de
// demo del `docker-compose.yml` se llaman igual que valen, y así la demo
// arranca sin `.env`.
export function tokensDelEntorno(entorno = process.env) {
  const tokens = {};
  for (const consumidor of CONSUMIDORES) {
    for (const clase of ['agente', 'interno']) {
      const nombre = consumidor[clase];
      const compatible = consumidor.compatibles?.[clase];
      tokens[nombre] =
        entorno[consumidor.variables[clase]] ?? (compatible ? entorno[compatible] : undefined) ?? nombre;
    }
  }
  return tokens;
}

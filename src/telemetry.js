// Telemetría del engine (CONTEXT.md, "Telemetría"): señales de monitoreo, no
// medidas de negocio. Vive en memoria del proceso y se lee con `snapshot()`;
// exportarla a Prometheus u OpenTelemetry está fuera de alcance y sería otra
// implementación de esta misma interfaz.
//
// Lo que cuenta responde tres preguntas de plataforma (historia 31): cuántas
// consultas se rechazan, con qué código y en qué puerta, y dónde se va el
// tiempo de base. Todo desglosado por consumidor, que es quien tiene
// presupuesto.
export function crearTelemetria() {
  let contadores = vacios();

  function sumar(mapa, clave) {
    if (clave === undefined) return;
    mapa[clave] = (mapa[clave] ?? 0) + 1;
  }

  function porConsumidor(consumer) {
    const clave = consumer ?? 'desconocido';
    contadores.byConsumer[clave] ??= { ok: 0, error: 0 };
    return contadores.byConsumer[clave];
  }

  return {
    registrarOk({ consumer, dbMs }) {
      contadores.total += 1;
      contadores.byResult.ok += 1;
      porConsumidor(consumer).ok += 1;
      contadores.database.count += 1;
      contadores.database.totalMs += dbMs;
    },

    // `gate` es la puerta del pipeline que cortó: es lo que dice si los
    // rechazos son del vocabulario del consumidor o del presupuesto.
    registrarError({ consumer, code, gate }) {
      contadores.total += 1;
      contadores.byResult.error += 1;
      porConsumidor(consumer).error += 1;
      sumar(contadores.byErrorCode, code);
      sumar(contadores.byGate, gate);
    },

    snapshot() {
      return structuredClone(contadores);
    },

    reset() {
      contadores = vacios();
    },
  };
}

function vacios() {
  return {
    total: 0,
    byResult: { ok: 0, error: 0 },
    byErrorCode: {},
    byGate: {},
    byConsumer: {},
    // Suma y cuenta en vez de histograma: con las dos se saca el promedio, y
    // los percentiles son trabajo del exportador, que está fuera de alcance.
    database: { count: 0, totalMs: 0 },
  };
}

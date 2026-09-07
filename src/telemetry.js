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
    contadores.byConsumer[clave] ??= { ok: 0, error: 0, cacheHits: 0, cacheMisses: 0 };
    return contadores.byConsumer[clave];
  }

  return {
    // Una respuesta servida. `dbMs` ausente significa que no hubo consulta a la
    // base —la respuesta salió de la caché—, y por eso no suma al contador de
    // base: si contara con 0 ms, el promedio de tiempo de base mentiría hacia
    // abajo justamente cuando la caché está funcionando.
    registrarOk({ consumer, dbMs }) {
      contadores.total += 1;
      contadores.byResult.ok += 1;
      porConsumidor(consumer).ok += 1;
      if (dbMs === undefined) return;
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

    // La puerta de caché: `hit` cuando la entrada estaba, `miss` cuando hubo
    // que ir a la base. Se cuenta aparte de `registrarOk` porque un hit y un
    // miss son el mismo evento servido —las dos respuestas son `ok`— y lo que
    // se quiere medir es cuántas de ellas se ahorraron la base. Un engine sin
    // caché no llama a esta función: sin caché no hay miss que reportar, y un
    // hit ratio de 0 sobre nada diría algo falso.
    registrarCache({ consumer, resultado }) {
      const esHit = resultado === 'hit';
      contadores.cache[esHit ? 'hits' : 'misses'] += 1;
      porConsumidor(consumer)[esHit ? 'cacheHits' : 'cacheMisses'] += 1;
    },

    snapshot() {
      const copia = structuredClone(contadores);
      const consultadas = copia.cache.hits + copia.cache.misses;
      // Sin consultas por la caché el ratio es 0 y no NaN: quien lo grafique no
      // tiene que defenderse de una división por cero.
      copia.cache.hitRatio = consultadas === 0 ? 0 : copia.cache.hits / consultadas;
      return copia;
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
    // Hits y misses de la caché; el `hitRatio` lo calcula `snapshot()` a partir
    // de estos dos, para que no haya dos números que puedan contradecirse.
    cache: { hits: 0, misses: 0 },
    // Suma y cuenta en vez de histograma: con las dos se saca el promedio, y
    // los percentiles son trabajo del exportador, que está fuera de alcance.
    database: { count: 0, totalMs: 0 },
  };
}

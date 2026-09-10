// Engine: recibe una consulta declarativa más el contexto de sesión, le pide el
// SQL al planificador y lo ejecuta. No conoce módulos concretos (ADR 0001) ni
// escribe SQL: eso es del planificador (ADR 0005).
import { createHash } from 'node:crypto';

import { presupuestos as presupuestosPorDefecto } from './budgets.js';
import { canonica } from './canonical.js';
import { postgres } from './dialect/postgres.js';
import { crearPlanificador } from './planner.js';
import { crearTelemetria } from './telemetry.js';

// `presupuestos` se inyecta para poder probar el comportamiento bajo un
// presupuesto extremo (por ejemplo un timeout de 1 ms) sin tocar la tabla real.
// `cache` es opcional: un engine sin caché sirve todo en vivo. Es la costura por
// la que entra `MemoryStore` (L1) y, más adelante, cualquier otra
// implementación de `CacheStore`.
export function createEngine({
  catalog,
  pool,
  dialect = postgres,
  // `fuentes` es el mapa nombre → { dialecto, pool } de las bases que este
  // engine puede consultar (CONTEXT.md, "Fuente"). Sin él, el engine tiene una
  // sola fuente —la del `pool` y el `dialect` de siempre—, que es exactamente
  // lo que era hasta ahora: un engine que sólo recibe `pool` sigue funcionando.
  fuentes,
  presupuestos = presupuestosPorDefecto,
  telemetria = crearTelemetria(),
  cache,
  // El reloj, inyectable: el `asOf` de una respuesta y la edad que el lector le
  // mide a una entrada de caché son el mismo tiempo, y tienen que salir de la
  // misma fuente. Además es lo que permite probar la expiración sin esperarla.
  reloj = Date.now,
  // `observar` es la costura del log en vivo (CONTEXT.md, "Observador"): una
  // función que recibe un evento por llamada a `run` o a `plan`. Es opcional y
  // por defecto no hace nada — la telemetría son contadores agregados y esto es
  // lo otro: una línea por consulta, que el servicio escribe en stdout y la
  // demo no—. `observarSql` decide si esa línea lleva el SQL: por defecto no,
  // porque nombra las tablas y las columnas físicas que la vista pública
  // esconde (ADR 0008); se enciende en desarrollo con LOG_SQL=true.
  observar,
  observarSql = false,
}) {
  const fuentesDelEngine = fuentes ?? { [dialect.name]: { dialecto: dialect, pool } };
  // Huella por fuente, resuelta una vez (ver `identidadDeFuente`).
  const huellas = new Map();
  const planificar = crearPlanificador({ catalog, fuentes: fuentesDelEngine, presupuestos });

  // Dry-run: el plan sin tocar la base (historia 25). También se observa: el
  // dry-run es una consulta que alguien pidió, y no verla en el log sería no
  // ver justo la que se estaba escribiendo.
  function plan(query, ctx) {
    const comienzo = performance.now();
    const registro = {};
    try {
      const { sql, params, logico } = planificar(query, ctx);
      registro.logico = logico;
      registro.sql = sql;
      return { sql, params, plan: logico };
    } catch (error) {
      registro.error = error;
      registro.gate = error?.gate;
      throw error;
    } finally {
      emitir('plan', ctx, registro, comienzo);
    }
  }

  // Una llamada, un evento: al final, haya terminado bien o mal. Va en el
  // `finally` y no en cada salida para que no haya un camino que se olvide de
  // emitir; el `registro` es lo que la llamada fue aprendiendo por el camino.
  async function run(query, ctx) {
    const comienzo = performance.now();
    const registro = {};
    try {
      return await correr(query, ctx, registro);
    } catch (error) {
      registro.error = error;
      throw error;
    } finally {
      emitir('run', ctx, registro, comienzo);
    }
  }

  // Nada falla por observar, la misma regla que la caché: el engine no sabe qué
  // función le pasaron, y una consulta ya respondida no puede morir porque a
  // alguien le falló el log. El fallo no se cuenta en ninguna parte —quien no
  // logra observar tampoco se enteraría del contador—.
  function emitir(kind, ctx, registro, comienzo) {
    if (!observar) return;
    try {
      observar(eventoDe({ kind, ctx, registro, ms: performance.now() - comienzo, observarSql }));
    } catch {
      // Silencio a propósito.
    }
  }

  // Todo se ejecuta dentro de una transacción: el cliente se libera siempre, y
  // ante un error se hace ROLLBACK antes de soltarlo —y se suelta con el error,
  // que es lo que hace que el pool lo destruya en vez de reciclarlo— para que
  // la siguiente petición no herede ni una transacción abierta ni una conexión
  // muerta. Qué más hay que decirle a la sesión antes de la consulta —en
  // Postgres, el `SET LOCAL statement_timeout` que hace cumplir el
  // presupuesto— lo dice el dialecto: el engine no nombra ninguna sentencia de
  // ningún motor, y un motor que no ofrece ninguna no recibe ninguna.
  async function ejecutar(sql, params, presupuesto, nombreDeFuente) {
    // Contra qué base se ejecuta y quién traduce sus errores sale de la fuente
    // de la entidad de hechos, que resolvió el planificador.
    const { pool: poolDeLaFuente, dialecto } = fuentesDelEngine[nombreDeFuente];
    // Abrir la conexión falla de un modo que el SQL no puede: la base no está.
    // Va envuelto porque un error crudo de socket saldría sin traducir y el
    // consumidor recibiría un 500 sin nombre en vez del código que le dice que
    // vuelva a intentar.
    const cliente = await conectar(poolDeLaFuente, dialecto, presupuesto);
    // Qué se le pasa a `release` depende de si esto terminó bien o mal, y eso
    // se sabe en el `catch`: el `finally` lo lee de aquí para que la liberación
    // siga ocurriendo exactamente una vez, pase lo que pase.
    let fallo;
    try {
      await cliente.query('BEGIN');
      for (const sentencia of dialecto.sentenciasDeSesion?.(presupuesto) ?? []) {
        await cliente.query(sentencia);
      }
      const resultado = await cliente.query(sql, params);
      await cliente.query('COMMIT');
      return resultado.rows;
    } catch (error) {
      fallo = error;
      await cliente.query('ROLLBACK').catch(() => {});
      // Qué significa un código nativo del motor lo sabe el dialecto: el engine
      // no conoce ningún código de error de Postgres, y lo que el dialecto no
      // reconoce vuelve tal cual.
      throw dialecto.traducirError(error, presupuesto);
    } finally {
      // Con el error, el pool destruye la conexión en vez de devolverla a la
      // fila: si la sesión se murió a mitad de consulta —la mataron desde otra
      // conexión, se cayó el socket— reciclarla es servirle a la próxima
      // petición un cliente que ya no existe. El driver hoy la descarta igual
      // por su cuenta, pero eso es un detalle interno suyo; decirlo aquí hace
      // que sea nuestra decisión y no su casualidad. Sin error, `release` no
      // recibe nada y la conexión vuelve al pool como siempre.
      cliente.release(fallo);
    }
  }

  // Qué significa un fallo al conectar lo sabe el dialecto, igual que cualquier
  // otro error nativo: el engine no conoce ni un código de socket ni un
  // SQLSTATE.
  async function conectar(pool, dialecto, presupuesto) {
    try {
      return await pool.connect();
    } catch (error) {
      throw dialecto.traducirError(error, presupuesto);
    }
  }

  async function correr(query, ctx, registro) {
    // El dry-run no cuenta en la telemetría: no responde a nadie ni toca la
    // base. Lo que se mide es lo que se sirvió.
    let plan;
    try {
      plan = planificar(query, ctx);
    } catch (error) {
      telemetria.registrarError({ consumer: ctx?.consumer, code: error?.code, gate: error?.gate });
      // `gate` es no enumerable en el error (planner.js), así que el evento se
      // lo copia en vez de esperar que salga solo al serializar.
      registro.gate = error?.gate;
      throw error;
    }
    const { sql, params, medidas, presupuesto, advertencias, fuente } = plan;
    registro.logico = plan.logico;
    // El SQL del plan, sin la marca de comentario: el `queryId` que la marca
    // repite ya viaja como campo propio del evento.
    registro.sql = sql;

    // La identidad de la consulta nace de lo que realmente se va a
    // ejecutar: el SQL sin su marca de comentario, sus parámetros, la empresa y
    // la versión del catálogo. Que salga del SQL y no del JSON no es un detalle:
    // el LIMIT efectivo lo pone el presupuesto de la clase de consumidor y viaja
    // en los parámetros, así que dos consumidores con techos distintos ejecutan
    // consultas distintas y no pueden compartir entrada. La empresa dentro del
    // hash hace imposible que una entrada de A sirva a B, y la versión del
    // catálogo invalida todo al cambiar una definición.
    const catalogVersion = catalog.version();
    const queryId = identificarConsulta({ sql, params, companyId: ctx.companyId, catalogVersion });
    registro.queryId = queryId;

    // La llave con la que la caché guarda es el `queryId` con su procedencia
    // escrita al lado: `{versión del catálogo}:{empresa}:{fuente}.{huella}:{queryId}`.
    // El hash ya lleva empresa y versión adentro —el aislamiento no depende del
    // texto—, pero en un Redis compartido entre instancias lo que no se ve no se
    // puede auditar: con la empresa en el texto, comprobar que ninguna entrada
    // quedó sin dueño es un `SCAN`, y no un acto de fe en el hash. La fuente va
    // con su huella porque el queryId identifica la consulta y no la base: dos
    // despliegues con una fuente que se llama igual sobre bases distintas
    // producirían el mismo queryId, y sin la huella compartirían entradas.
    const { huella } = await identidadDeFuente(fuente);
    const llave = `${catalogVersion}:${ctx.companyId}:${fuente}.${huella}:${queryId}`;

    // Puerta · Buscar en caché. Va después de planificar, no antes: una
    // consulta inválida se rechaza igual, esté o no en la caché.
    const guardado = await buscarEnCache(llave, ctx, presupuesto);
    if (guardado) {
      // Servida igual que cualquier otra, sólo que sin tiempo de base: `dbMs`
      // ausente es lo que distingue en la telemetría a la que no la consultó.
      telemetria.registrarOk({ consumer: ctx?.consumer });
      registro.servedFrom = nivelDe(guardado);
      registro.rows = guardado.rows.length;
      registro.warnings = guardado.warnings?.length ?? 0;
      return {
        rows: guardado.rows,
        meta: {
          servedFrom: nivelDe(guardado),
          // El instante de la ejecución que produjo estas filas, no el de
          // ahora: es lo que le dice al consumidor qué tan viejo es el dato.
          asOf: guardado.asOf,
          queryId,
          warnings: guardado.warnings,
        },
      };
    }

    // Instante en que se ejecutó la consulta que produjo el resultado; la
    // entrada guardada conserva su propio asOf.
    const asOf = new Date(reloj()).toISOString();
    const comienzo = performance.now();
    let filas;
    try {
      filas = await ejecutar(marcado(sql, queryId, ctx), params, presupuesto, fuente);
    } catch (error) {
      telemetria.registrarError({ consumer: ctx?.consumer, code: error?.code, gate: 'ejecutar' });
      registro.gate = 'ejecutar';
      throw error;
    }
    const dbMs = performance.now() - comienzo;
    telemetria.registrarOk({ consumer: ctx?.consumer, dbMs });

    const rows = aNumeros(filas, medidas);
    registro.servedFrom = 'live';
    registro.rows = rows.length;
    registro.dbMs = dbMs;
    registro.warnings = advertencias.length;

    // Puerta · Guardar en caché. Sólo lo que se ejecutó en vivo: un resultado
    // servido desde la caché no se vuelve a guardar, así que su TTL cuenta
    // desde la ejecución real y una entrada no se renueva sola para siempre.
    await guardarEnCache(llave, { rows, asOf, warnings: advertencias }, presupuesto.cacheTtlMs);

    return {
      rows,
      meta: {
        servedFrom: 'live',
        asOf,
        queryId,
        // Siempre presente, aunque esté vacía: quien la lee no tiene que
        // preguntarse si el campo existe.
        warnings: advertencias,
      },
    };
  }

  // La entrada la evalúa quien la lee. El store la conserva mientras alguien la
  // pueda querer, pero cuánta antigüedad se tolera es del presupuesto de la
  // clase que pregunta: una entrada que el tablero dejó hace 50 s le sirve a él
  // (60 s) y no a la API (30 s). Si el TTL se decidiera sólo al escribir, el
  // primero en llegar le impondría su frescura a todos los que vengan después.
  // La entrada vieja para este lector **no** se borra: sigue siendo válida para
  // quien tolera más, y borrarla sería quitarle a otro un dato que le sirve.
  async function buscarEnCache(llave, ctx, presupuesto) {
    if (!cache) return undefined;
    // Red de seguridad: ninguna consulta falla por la caché. El store compuesto
    // ya se defiende de su segundo nivel, pero el engine no sabe qué
    // implementación le pasaron, y la garantía no puede depender de eso. Una
    // lectura que revienta es un miss como cualquier otro —se va a la base
    // igual—, y el fallo queda contado aparte para que un Redis muerto se vea
    // antes de que se note como latencia.
    let guardado;
    try {
      guardado = await cache.get(llave);
    } catch {
      telemetria.registrarErrorDeCache({ nivel: 'cache' });
      guardado = undefined;
    }
    const utilizable = guardado && !demasiadoVieja(guardado, presupuesto);
    telemetria.registrarCache({
      consumer: ctx?.consumer,
      resultado: utilizable ? 'hit' : 'miss',
      nivel: utilizable ? nivelDe(guardado) : undefined,
    });
    return utilizable ? guardado : undefined;
  }

  function demasiadoVieja(guardado, presupuesto) {
    return reloj() - Date.parse(guardado.asOf) > presupuesto.cacheTtlMs;
  }

  // El TTL sale del presupuesto de la clase de consumidor, como el timeout y el
  // límite de filas: cuánta antigüedad tolera quien pregunta es parte de lo que
  // su clase puede gastar, y no algo que la consulta pueda elegirse sola.
  async function guardarEnCache(llave, entrada, ttlMs) {
    if (!cache) return;
    // La misma red del otro lado: el resultado ya está, no guardarlo sólo
    // significa que la próxima vuelve a la base.
    try {
      await cache.set(llave, entrada, ttlMs);
    } catch {
      telemetria.registrarErrorDeCache({ nivel: 'cache' });
    }
  }

  // Identidad de una fuente para la llave de caché: quién es la base detrás
  // del nombre. Prioridad: (1) el `id` que configuró quien despliega en el mapa
  // `fuentes`; (2) lo que el motor sabe de sí mismo (`dialecto.identificador`:
  // en Postgres el `system_identifier`, que las réplicas físicas comparten);
  // (3) la conexión del pool (host, puerto y base); (4) el nombre. Sale como
  // huella de 8 hex: distingue bases sin escribir un host en Redis. Se resuelve
  // una vez por fuente y se recuerda; un paso que falla cede al siguiente.
  function identidadDeFuente(nombre) {
    if (!huellas.has(nombre)) huellas.set(nombre, resolverIdentidad(nombre, fuentesDelEngine[nombre]));
    return huellas.get(nombre);
  }

  return { plan, run, telemetry: telemetria.snapshot, identidadDeFuente };
}

// El evento que ve el observador: qué se pidió, qué se planificó, de dónde
// salió la respuesta o por qué se rechazó, y cuánto tardó. Un objeto plano y
// pequeño, pensado para caber en una línea de log.
//
// Los campos que no aplican no viajan en `undefined`: no están. Así la línea de
// un hit de caché no dice `dbMs: undefined` —que se leería como "tardó nada en
// la base"— sino que simplemente no habla de la base, que es lo que pasó.
function eventoDe({ kind, ctx, registro, ms, observarSql }) {
  const { error, logico } = registro;
  return {
    kind,
    ...(registro.queryId === undefined ? {} : { queryId: registro.queryId }),
    ...(ctx?.companyId === undefined ? {} : { companyId: ctx.companyId }),
    ...(ctx?.consumer === undefined ? {} : { consumer: ctx.consumer }),
    result: error ? 'error' : 'ok',
    ...(error === undefined ? {} : camposDelError(error, registro)),
    ...(registro.servedFrom === undefined ? {} : { servedFrom: registro.servedFrom }),
    ...(registro.rows === undefined ? {} : { rows: registro.rows }),
    ...(registro.dbMs === undefined ? {} : { dbMs: registro.dbMs }),
    ...(registro.warnings === undefined ? {} : { warnings: registro.warnings }),
    // Si el rechazo ocurrió antes de planificar no hay plan que describir, y el
    // evento no lo inventa.
    ...(logico === undefined ? {} : { plan: resumenDelPlan(logico) }),
    // El SQL sólo si quien armó el engine lo pidió: nombra tablas físicas.
    ...(observarSql && registro.sql !== undefined ? { sql: registro.sql } : {}),
    ms,
  };
}

// Un error del consumidor tiene código y a veces miembro; `gate` dice en qué
// puerta cortó, que es lo que separa un rechazo de vocabulario de uno de
// presupuesto. Lo que no es un error estructurado no tiene código y el evento
// no se lo inventa: queda `result: 'error'` con el `gate` que lo ubica.
function camposDelError(error, registro) {
  return {
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.member === undefined ? {} : { member: error.member }),
    ...(registro.gate === undefined ? {} : { gate: registro.gate }),
  };
}

// El plan lógico resumido, sin una sola palabra del esquema físico: entidad de
// hechos, camino de joins por el **nombre de la relación** y los miembros
// pedidos. El plan completo trae además presupuesto, filtros y derivadas; en
// una línea de log lo que se quiere ver es qué se consultó y por dónde se llegó
// (ADR 0008: los nombres físicos no salen del servidor).
function resumenDelPlan(logico) {
  return {
    entity: logico.entity,
    joins: logico.joins.map(({ from, to, via }) => ({ from, to, via })),
    measures: logico.measures,
    dimensions: logico.dimensions,
  };
}

// El SQL que sale a la base va marcado con la consulta y el consumidor que lo
// pidieron: es lo que permite reconocer en `pg_stat_activity` o en los logs de
// Postgres a quién pertenece una consulta lenta. Se marca sólo lo que se
// ejecuta, no lo que devuelve `plan()`: el dry-run sigue mostrando el SQL puro
// y los snapshots del repo no cambian.
function marcado(sql, queryId, ctx) {
  return `/* ${queryId} ${ctx?.consumer ?? 'desconocido'} */\n${sql}`;
}

// De qué nivel salió una entrada lo dice la caché: un store compuesto la marca.
// Una caché de un solo nivel no marca nada y es, por definición, el primero que
// el engine consulta.
function nivelDe(guardado) {
  return guardado.nivel ?? 'cache-l1';
}

// Postgres devuelve int8 y numeric como texto para no perder precisión; las
// medidas vuelven al consumidor como números.
function aNumeros(filas, medidas) {
  const miembrosNumericos = new Set(medidas.map((m) => m.miembro));
  return filas.map((fila) =>
    Object.fromEntries(
      Object.entries(fila).map(([miembro, valor]) => [
        miembro,
        miembrosNumericos.has(miembro) && valor !== null ? Number(valor) : valor,
      ]),
    ),
  );
}

// Identidad de la consulta: el SQL que se va a ejecutar (sin la marca de
// comentario, que sólo repite el propio id), sus parámetros, la empresa y la
// versión del catálogo. Sale de lo ejecutado y no del JSON pedido porque entre
// los dos hay decisiones del engine —el LIMIT efectivo de la clase de
// consumidor, sobre todo— que cambian el resultado sin cambiar una letra de la
// consulta: dos JSON iguales que producen SQL o parámetros distintos son dos
// consultas distintas, y dos JSON distintos que producen exactamente lo mismo
// son la misma. La empresa entra al hash para que una entrada de caché nunca
// pueda servir a otra empresa aunque el SQL se pareciera; la versión, para que
// el mismo SQL sobre otro contrato de datos no se confunda con la misma
// consulta. La serialización es canónica: el orden de las claves no lo cambia.
function identificarConsulta({ sql, params, companyId, catalogVersion }) {
  return createHash('sha256')
    .update(canonica({ sql, params, companyId, catalogVersion }))
    .digest('hex')
    .slice(0, 16);
}

// Resuelve la identidad de una fuente probando cada origen en orden; el primero
// que devuelve algo gana. Los fallos (un rol sin permiso para
// `pg_control_system()`, un pool falso sin `options`) no son errores: son
// "este origen no sabe", y se pasa al siguiente.
async function resolverIdentidad(nombre, { id, dialecto, pool } = {}) {
  const origenes = [
    ['configurado', async () => id],
    ['motor', async () => dialecto?.identificador?.(pool)],
    ['conexion', async () => conexionDe(pool)],
    ['nombre', async () => nombre],
  ];
  for (const [origen, obtener] of origenes) {
    let texto;
    try {
      texto = await obtener();
    } catch {
      texto = undefined;
    }
    if (texto) return { fuente: nombre, origen, huella: huellaDe(texto) };
  }
  throw new Error(`La fuente "${nombre}" no tiene identidad posible`);
}

// Host, puerto y base de un pool de node-postgres, sin usuario ni contraseña:
// lo que identifica a qué base se conecta, y nada más.
function conexionDe(pool) {
  const opciones = pool?.options;
  if (!opciones) return undefined;
  if (opciones.connectionString) {
    const url = new URL(opciones.connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  }
  if (opciones.host || opciones.database) {
    return `${opciones.host ?? 'localhost'}:${opciones.port ?? 5432}/${opciones.database ?? ''}`;
  }
  return undefined;
}

function huellaDe(texto) {
  return createHash('sha256').update(String(texto)).digest('hex').slice(0, 8);
}

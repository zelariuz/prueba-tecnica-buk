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
  presupuestos = presupuestosPorDefecto,
  telemetria = crearTelemetria(),
  cache,
  // El reloj, inyectable: el `asOf` de una respuesta y la edad que el lector le
  // mide a una entrada de caché son el mismo tiempo, y tienen que salir de la
  // misma fuente. Además es lo que permite probar la expiración sin esperarla.
  reloj = Date.now,
}) {
  const planificar = crearPlanificador({ catalog, dialect, presupuestos });

  // Dry-run: el plan sin tocar la base (historia 25).
  function plan(query, ctx) {
    const { sql, params, logico } = planificar(query, ctx);
    return { sql, params, plan: logico };
  }

  // El timeout se fija con SET LOCAL dentro de la transacción: fuera de una
  // transacción Postgres lo ignora, y dentro se deshace al cerrarla, así que la
  // conexión vuelve al pool sin el estado de esta petición. El cliente se
  // libera siempre, y ante un error se hace ROLLBACK antes de soltarlo para que
  // la siguiente petición no herede una transacción abierta.
  async function ejecutar(sql, params, presupuesto) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      // SET no admite parámetros: el valor se interpola y por eso solo puede
      // venir de la tabla de presupuestos, ya validado como entero.
      await cliente.query(`SET LOCAL statement_timeout = ${milisegundos(presupuesto)}`);
      const resultado = await cliente.query(sql, params);
      await cliente.query('COMMIT');
      return resultado.rows;
    } catch (error) {
      await cliente.query('ROLLBACK').catch(() => {});
      // Qué significa un código nativo del motor lo sabe el dialecto: el engine
      // no conoce ningún código de error de Postgres, y lo que el dialecto no
      // reconoce vuelve tal cual.
      throw dialect.traducirError(error, presupuesto);
    } finally {
      cliente.release();
    }
  }

  async function run(query, ctx) {
    // El dry-run no cuenta en la telemetría: no responde a nadie ni toca la
    // base. Lo que se mide es lo que se sirvió.
    let plan;
    try {
      plan = planificar(query, ctx);
    } catch (error) {
      telemetria.registrarError({ consumer: ctx?.consumer, code: error?.code, gate: error?.gate });
      throw error;
    }
    const { sql, params, medidas, presupuesto, advertencias } = plan;

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

    // La llave con la que la caché guarda es el `queryId` con su procedencia
    // escrita al lado: `{versión del catálogo}:{empresa}:{queryId}`. El hash ya
    // lleva las dos cosas adentro —el aislamiento no depende del texto—, pero en
    // un Redis compartido entre instancias lo que no se ve no se puede auditar:
    // con la empresa en el texto, comprobar que ninguna entrada quedó sin dueño
    // es un `SCAN`, y no un acto de fe en el hash.
    const llave = `${catalogVersion}:${ctx.companyId}:${queryId}`;

    // Puerta · Buscar en caché. Va después de planificar, no antes: una
    // consulta inválida se rechaza igual, esté o no en la caché.
    const guardado = await buscarEnCache(llave, ctx, presupuesto);
    if (guardado) {
      // Servida igual que cualquier otra, sólo que sin tiempo de base: `dbMs`
      // ausente es lo que distingue en la telemetría a la que no la consultó.
      telemetria.registrarOk({ consumer: ctx?.consumer });
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
      filas = await ejecutar(marcado(sql, queryId, ctx), params, presupuesto);
    } catch (error) {
      telemetria.registrarError({ consumer: ctx?.consumer, code: error?.code, gate: 'ejecutar' });
      throw error;
    }
    telemetria.registrarOk({ consumer: ctx?.consumer, dbMs: performance.now() - comienzo });

    const rows = aNumeros(filas, medidas);

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

  return { plan, run, telemetry: telemetria.snapshot };
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

function milisegundos(presupuesto) {
  if (!Number.isInteger(presupuesto.timeoutMs) || presupuesto.timeoutMs <= 0) {
    throw new Error(`Timeout de presupuesto inválido: ${presupuesto.timeoutMs}`);
  }
  return presupuesto.timeoutMs;
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

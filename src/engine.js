// Engine: recibe una consulta declarativa más el contexto de sesión, le pide el
// SQL al planificador y lo ejecuta. No conoce módulos concretos (ADR 0001) ni
// escribe SQL: eso es del planificador (ADR 0005).
import { createHash } from 'node:crypto';

import { presupuestos as presupuestosPorDefecto } from './budgets.js';
import { canonica } from './canonical.js';
import { postgres } from './dialect/postgres.js';
import { SemanticError } from './errors.js';
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
      throw traducirErrorDeBase(error, presupuesto);
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

    // La llave de la caché **es** el queryId: ya es el hash de la forma
    // canónica de la consulta con sus parámetros, más la empresa, más la
    // versión del catálogo. Que sea el mismo valor no es una economía: es la
    // garantía de que dos consultas se sirven de la misma entrada exactamente
    // cuando el consumidor las llamaría la misma consulta. La empresa dentro
    // del hash es lo que hace imposible que una entrada de A sirva a B, y la
    // versión del catálogo es lo que invalida todo al cambiar una definición.
    const queryId = identificarConsulta(query, ctx, catalog.version());

    // Puerta · Buscar en caché. Va después de planificar, no antes: una
    // consulta inválida se rechaza igual, esté o no en la caché.
    const guardado = await buscarEnCache(queryId, ctx);
    if (guardado) {
      // Servida igual que cualquier otra, sólo que sin tiempo de base: `dbMs`
      // ausente es lo que distingue en la telemetría a la que no la consultó.
      telemetria.registrarOk({ consumer: ctx?.consumer });
      return {
        rows: guardado.rows,
        meta: {
          servedFrom: 'cache-l1',
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
    const asOf = new Date().toISOString();
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
    await guardarEnCache(queryId, { rows, asOf, warnings: advertencias }, presupuesto.cacheTtlMs);

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

  async function buscarEnCache(queryId, ctx) {
    if (!cache) return undefined;
    const guardado = await cache.get(queryId);
    telemetria.registrarCache({ consumer: ctx?.consumer, resultado: guardado ? 'hit' : 'miss' });
    return guardado;
  }

  // El TTL sale del presupuesto de la clase de consumidor, como el timeout y el
  // límite de filas: cuánta antigüedad tolera quien pregunta es parte de lo que
  // su clase puede gastar, y no algo que la consulta pueda elegirse sola.
  async function guardarEnCache(queryId, entrada, ttlMs) {
    if (!cache) return;
    await cache.set(queryId, entrada, ttlMs);
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

function milisegundos(presupuesto) {
  if (!Number.isInteger(presupuesto.timeoutMs) || presupuesto.timeoutMs <= 0) {
    throw new Error(`Timeout de presupuesto inválido: ${presupuesto.timeoutMs}`);
  }
  return presupuesto.timeoutMs;
}

// Postgres cancela la consulta que pasa el statement_timeout con el código
// 57014 (query_canceled). Para el consumidor no es un fallo de la base: es su
// presupuesto agotado, y como tal vuelve con sugerencia de qué reducir.
function traducirErrorDeBase(error, presupuesto) {
  if (error?.code !== '57014') return error;
  return new SemanticError({
    code: 'QUERY_TIMEOUT',
    suggestion: `La consulta superó los ${presupuesto.timeoutMs} ms de presupuesto de tu clase de consumidor: acota el rango temporal, sube la granularidad o pide menos dimensiones.`,
  });
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

// Identidad de la consulta: su forma con los parámetros puestos, más la
// empresa, más la versión del catálogo. La empresa entra al hash para que una
// entrada de caché nunca pueda servir a otra empresa; la versión, para que el
// mismo JSON sobre otro contrato de datos no se confunda con la misma consulta.
// La serialización es canónica: reordenar las claves del JSON no cambia el id.
function identificarConsulta(query, ctx, versionDelCatalogo) {
  return createHash('sha256')
    .update(canonica({ companyId: ctx.companyId, query, catalogVersion: versionDelCatalogo }))
    .digest('hex')
    .slice(0, 16);
}

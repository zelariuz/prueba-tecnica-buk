// Caché L2 contra Redis de verdad (historias 34 y 35). Se salta con aviso si
// falta `REDIS_URL`, igual que los tests de base se saltan sin `DATABASE_URL`:
// `npm test` sin ninguna de las dos tiene que seguir verde.
//
// Cada corrida usa su propio prefijo de llaves y lo limpia al empezar y al
// terminar. Nunca `FLUSHALL`: el Redis puede no ser sólo nuestro.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from 'redis';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { crearRedisStore, TIMEOUT_DE_REDIS_MS } from '../src/cache/redis-store.js';
import { crearTieredStore } from '../src/cache/tiered.js';
import { crearTelemetria } from '../src/telemetry.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

const { DATABASE_URL, REDIS_URL } = process.env;
const faltan = [
  DATABASE_URL ? undefined : 'DATABASE_URL',
  REDIS_URL ? undefined : 'REDIS_URL',
].filter(Boolean);
const conRedis =
  faltan.length === 0
    ? {}
    : {
        skip: `falta ${faltan.join(' y ')} — levanta el entorno con \`docker compose up -d db redis\` (ver README)`,
      };

const CONTEO_POR_ESTADO = { measures: ['reviews.count'], dimensions: ['reviews.status'] };
const DASHBOARD_A = { companyId: 1, consumer: 'dashboard' };

// Literales del seed: la empresa 1 tiene 5 completadas, 4 pendientes, 2 calibradas.
const ESTADOS_EMPRESA_A = { completed: 5, pending: 4, calibrated: 2 };

function porEstado(rows) {
  return Object.fromEntries(rows.map((fila) => [fila['reviews.status'], fila['reviews.count']]));
}

describe('caché L2 en Redis', { ...conRedis, timeout: 20_000 }, () => {
  // Prefijo propio de esta corrida: dos corridas simultáneas no se pisan y la
  // limpieza no puede llevarse por delante llaves de nadie más.
  const PREFIJO = `capa-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let pool;
  let inspector;
  const abiertos = [];

  async function limpiarPrefijo() {
    for await (const llaves of inspector.scanIterator({ MATCH: `${PREFIJO}:*`, COUNT: 100 })) {
      if (llaves.length > 0) await inspector.del(llaves);
    }
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    inspector = createClient({ url: REDIS_URL });
    inspector.on('error', () => {});
    await inspector.connect();
    await limpiarPrefijo();
  });

  after(async () => {
    await limpiarPrefijo();
    await inspector.close();
    for (const store of abiertos) await store.cerrar();
    await pool.end();
  });

  // Una instancia del servicio: su propio engine, su propia L1 vacía y su propio
  // cliente de Redis. Lo único compartido es Redis, que es de lo que se trata.
  function armarInstancia({ telemetria = crearTelemetria() } = {}) {
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    const l2 = crearRedisStore({
      url: REDIS_URL,
      prefijo: PREFIJO,
      alFallar: ({ nivel }) => telemetria.registrarErrorDeCache({ nivel }),
    });
    abiertos.push(l2);
    const cache = crearTieredStore({
      l1: crearMemoryStore(),
      l2,
      alFallar: ({ nivel }) => telemetria.registrarErrorDeCache({ nivel }),
    });
    return { catalog, engine: createEngine({ catalog, pool, cache, telemetria }), telemetria };
  }

  it('una segunda instancia responde cache-l2 a lo que ejecutó la primera', async () => {
    const primera = armarInstancia();
    const segunda = armarInstancia();

    const enVivo = await primera.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const desdeRedis = await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const yaEnCasa = await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(enVivo.meta.servedFrom, 'live');
    assert.equal(desdeRedis.meta.servedFrom, 'cache-l2', 'la L1 de la segunda instancia está vacía');
    assert.deepEqual(porEstado(desdeRedis.rows), ESTADOS_EMPRESA_A);
    assert.deepEqual(desdeRedis.rows, enVivo.rows);
    assert.equal(desdeRedis.meta.asOf, enVivo.meta.asOf, 'el asOf es el de la ejecución original');
    assert.equal(yaEnCasa.meta.servedFrom, 'cache-l1', 'el hit de L2 dejó la copia en su L1');
  });

  // El aislamiento por empresa no puede depender de que el hash esté bien hecho:
  // en un Redis compartido la empresa tiene que verse **en el texto** de la
  // llave, para que auditarlo sea mirar y no confiar. Una entrada sin empresa en
  // la llave es una entrada que nadie puede afirmar de quién es.
  const DASHBOARD_B = { companyId: 2, consumer: 'dashboard' };

  it('toda llave en Redis lleva la empresa a la que pertenece', async () => {
    const { engine } = armarInstancia();

    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    await engine.run(CONTEO_POR_ESTADO, DASHBOARD_B);

    const llaves = [];
    for await (const tanda of inspector.scanIterator({ MATCH: `${PREFIJO}:*`, COUNT: 100 })) {
      llaves.push(...tanda);
    }

    assert.ok(llaves.length >= 2, `esperaba llaves del prefijo, hay ${llaves.length}`);
    // `prefijo : versión del catálogo : empresa : queryId`
    const empresas = llaves.map((llave) => llave.split(':')[2]);
    const sinEmpresa = llaves.filter((llave, i) => !['1', '2'].includes(empresas[i]));
    assert.deepEqual(sinEmpresa, [], 'no puede existir una llave sin la empresa');
    assert.ok(empresas.includes('1') && empresas.includes('2'), 'están las dos empresas');
  });

  // El caso que la historia 35 quiere garantizar, con Redis de verdad: una L2
  // inalcanzable no le cuesta al consumidor ni la consulta ni la espera. Lo
  // segundo importa tanto como lo primero: una caché que se cuelga es peor que
  // no tener caché, porque le agrega latencia a cada respuesta a cambio de nada.
  const PUERTO_SIN_NADIE = 'redis://127.0.0.1:1';
  // El techo: dos operaciones de caché (una lectura y una escritura) más el
  // tiempo de la consulta real y el ruido de la máquina. Si la caché esperara
  // sin límite, esto no se cumpliría por varios órdenes de magnitud.
  const MARGEN_MS = 3_000;

  it('un Redis inalcanzable se sirve en vivo, sin fallar y sin esperarlo', async () => {
    const telemetria = crearTelemetria();
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    const avisar = ({ nivel }) => telemetria.registrarErrorDeCache({ nivel });
    const l2 = crearRedisStore({ url: PUERTO_SIN_NADIE, prefijo: PREFIJO, alFallar: avisar });
    abiertos.push(l2);
    const cache = crearTieredStore({ l1: crearMemoryStore(), l2, alFallar: avisar });
    const engine = createEngine({ catalog, pool, cache, telemetria });

    const comienzo = performance.now();
    const respuesta = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const transcurrido = performance.now() - comienzo;

    assert.equal(respuesta.meta.servedFrom, 'live');
    assert.deepEqual(porEstado(respuesta.rows), ESTADOS_EMPRESA_A);
    const contadores = engine.telemetry();
    assert.equal(contadores.byResult.error, 0, 'ninguna consulta falló por la caché');
    assert.ok(contadores.cacheErrors['cache-l2'] > 0, 'el fallo de la L2 quedó contado');
    assert.ok(
      transcurrido < 2 * TIMEOUT_DE_REDIS_MS + MARGEN_MS,
      `la consulta esperó ${transcurrido.toFixed(0)} ms por una caché caída`,
    );
  });
});

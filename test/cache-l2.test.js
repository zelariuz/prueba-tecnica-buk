// Caché L2 compartida entre instancias (historias 34 y 35). Se prueba por el
// seam `engine.run`: lo que importa no es cómo guarda Redis, sino qué ve el
// consumidor —`servedFrom: 'cache-l2'`, las mismas filas, el `asOf` de la
// ejecución original— y que una L2 caída no le cueste una sola consulta.
//
// La composición de los dos niveles se prueba aquí con dos `MemoryStore`: el
// segundo nivel no tiene que ser Redis para que la lógica de L1 → L2 → base sea
// la misma. Los tests contra Redis de verdad viven en `test/redis.test.js`.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createCatalog } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { crearMemoryStore } from '../src/cache/store.js';
import { crearTieredStore } from '../src/cache/tiered.js';
import { crearTelemetria } from '../src/telemetry.js';
import { departments } from '../src/definitions/departments.js';
import { employees } from '../src/definitions/employees.js';
import { reviews } from '../src/definitions/reviews.js';

const { DATABASE_URL } = process.env;
const conBase = DATABASE_URL
  ? {}
  : { skip: 'falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)' };

const CONTEO_POR_ESTADO = { measures: ['reviews.count'], dimensions: ['reviews.status'] };
const DASHBOARD_A = { companyId: 1, consumer: 'dashboard' };

// Literales del seed, no recalculados: la empresa 1 tiene 5 evaluaciones
// completadas, 4 pendientes y 2 calibradas.
const ESTADOS_EMPRESA_A = { completed: 5, pending: 4, calibrated: 2 };

function porEstado(rows) {
  return Object.fromEntries(rows.map((fila) => [fila['reviews.status'], fila['reviews.count']]));
}

describe('caché de dos niveles', { ...conBase, timeout: 15_000 }, () => {
  let pool;

  before(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  after(async () => {
    await pool.end();
  });

  // Cada instancia del servicio tiene su propia L1 —vive en su proceso— y todas
  // comparten la L2. `armarInstancia` es exactamente eso: un engine nuevo, con
  // su catálogo y su L1 vacía, sobre la L2 que se le pase.
  function armarInstancia({ l2, telemetria = crearTelemetria(), alFallar } = {}) {
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    const cache = crearTieredStore({ l1: crearMemoryStore(), l2, alFallar });
    return { catalog, engine: createEngine({ catalog, pool, cache, telemetria }), telemetria };
  }

  it('una entrada que sólo está en el segundo nivel se sirve como cache-l2', async () => {
    const compartida = crearMemoryStore();
    const primera = armarInstancia({ l2: compartida });
    const segunda = armarInstancia({ l2: compartida });

    const enVivo = await primera.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const desdeLaOtra = await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(enVivo.meta.servedFrom, 'live');
    assert.equal(desdeLaOtra.meta.servedFrom, 'cache-l2', 'la L1 de la segunda instancia está vacía');
    assert.deepEqual(porEstado(desdeLaOtra.rows), ESTADOS_EMPRESA_A);
    assert.equal(desdeLaOtra.meta.asOf, enVivo.meta.asOf, 'el asOf es el de la ejecución original');
  });

  // Bajar a L2 cuesta una ida por la red; hacerlo dos veces por la misma
  // entrada es puro desperdicio. El hit de L2 deja la copia en L1, así que la
  // instancia que la pidió una vez no vuelve a salir del proceso por ella.
  it('un hit en el segundo nivel deja la entrada en el primero', async () => {
    const compartida = crearMemoryStore();
    const primera = armarInstancia({ l2: compartida });
    const segunda = armarInstancia({ l2: compartida });

    await primera.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const bajoALaL2 = await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const yaEstabaEnCasa = await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(bajoALaL2.meta.servedFrom, 'cache-l2');
    assert.equal(yaEstabaEnCasa.meta.servedFrom, 'cache-l1');
    assert.deepEqual(yaEstabaEnCasa.rows, bajoALaL2.rows);
  });

  // Un hit de L1 y uno de L2 no valen lo mismo: el primero no salió del proceso
  // y el segundo cruzó la red. Contarlos juntos deja invisible lo único que
  // dice si la L2 sirve de algo —cuántas respuestas se ahorraron la base
  // gracias a lo que había calculado otra instancia—.
  it('la telemetría separa los hits por nivel', async () => {
    const compartida = crearMemoryStore();
    const primera = armarInstancia({ l2: compartida });
    const segunda = armarInstancia({ l2: compartida });

    await primera.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    await segunda.engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    const contadores = segunda.engine.telemetry();
    assert.equal(contadores.cache.hits, 2);
    assert.deepEqual(contadores.cache.porNivel, { 'cache-l2': 1, 'cache-l1': 1 });
    assert.deepEqual(primera.engine.telemetry().cache.porNivel, {}, 'la primera no tuvo hits');
  });

  // La caché existe para abaratar, no para poner en riesgo. Una L2 que se cayó
  // —Redis apagado, red cortada, timeout— no puede costarle al consumidor ni una
  // sola consulta: se sirve en vivo y el fallo queda contado en la telemetría,
  // que es donde alguien lo va a ver.
  const l2QueSeCayo = {
    async get() {
      throw new Error('ECONNREFUSED');
    },
    async set() {
      throw new Error('ECONNREFUSED');
    },
    async delete() {
      throw new Error('ECONNREFUSED');
    },
  };

  it('con el segundo nivel caído la consulta se sirve igual y el fallo queda contado', async () => {
    const { engine, telemetria } = armarInstancia({
      l2: l2QueSeCayo,
      alFallar: ({ nivel }) => telemetria.registrarErrorDeCache({ nivel }),
    });

    const primera = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);
    const segunda = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(primera.meta.servedFrom, 'live');
    assert.deepEqual(porEstado(primera.rows), ESTADOS_EMPRESA_A);
    assert.equal(segunda.meta.servedFrom, 'cache-l1', 'la L1 sigue trabajando sin la L2');
    const contadores = engine.telemetry();
    assert.ok(contadores.cacheErrors['cache-l2'] > 0, 'el fallo de la L2 quedó contado por nivel');
    assert.equal(contadores.byResult.error, 0, 'ninguna consulta falló por la caché');
  });

  // Red de seguridad del engine, aparte de la del store compuesto. El store se
  // defiende de la L2 porque sabe que hay una; el engine se defiende de la caché
  // entera porque no sabe qué le pasaron. Dos redes y no una: la garantía es
  // "ninguna consulta falla por la caché", y no puede depender de qué
  // implementación le tocó al engine.
  it('una caché que falla entera no le cuesta una consulta al consumidor', async () => {
    const catalog = createCatalog();
    for (const definicion of [reviews, employees, departments]) catalog.register(definicion);
    const engine = createEngine({ catalog, pool, cache: l2QueSeCayo });

    const respuesta = await engine.run(CONTEO_POR_ESTADO, DASHBOARD_A);

    assert.equal(respuesta.meta.servedFrom, 'live');
    assert.deepEqual(porEstado(respuesta.rows), ESTADOS_EMPRESA_A);
    const contadores = engine.telemetry();
    assert.equal(contadores.byResult.error, 0, 'ninguna consulta falló por la caché');
    assert.ok(contadores.cacheErrors.cache > 0, 'el fallo quedó contado');
    assert.equal(contadores.cache.misses, 1, 'una lectura que falla es un miss');
  });
});

// Cómo se arma la caché de un proceso, en un solo lugar: el servicio HTTP y la
// demo la necesitan igual, y dos copias de esta decisión se separarían.
//
// Con `REDIS_URL` la caché tiene dos niveles (L1 en el proceso, L2 compartida);
// sin él, sólo L1, y se dice en el log. Que la L2 sea opcional no es una
// concesión: la historia 35 pide que la capa funcione igual sin Redis, y esta
// es la forma más honesta de tenerlo probado —el modo sin L2 es el que corre
// cada vez que alguien levanta sólo la base—.
import { crearMemoryStore, MAXIMO_DE_ENTRADAS } from './store.js';
import { crearRedisStore } from './redis-store.js';
import { crearTieredStore } from './tiered.js';

export function crearCacheDelServicio({ redisUrl, telemetria }) {
  const l1 = crearMemoryStore();
  if (!redisUrl) {
    return {
      cache: l1,
      descripcion: `L1 en memoria (hasta ${MAXIMO_DE_ENTRADAS} entradas), sin L2: falta REDIS_URL`,
      async cerrar() {},
    };
  }

  // Los fallos de la L2 no viajan como excepción: llegan acá y se cuentan. La
  // caché no conoce la telemetría —recibe un callback— para que se pueda armar
  // sin ella.
  const alFallar = ({ nivel }) => telemetria?.registrarErrorDeCache({ nivel });
  const l2 = crearRedisStore({ url: redisUrl, alFallar });

  return {
    cache: crearTieredStore({ l1, l2, alFallar }),
    descripcion: `L1 en memoria (hasta ${MAXIMO_DE_ENTRADAS} entradas) + L2 en Redis (${redisUrl})`,
    cerrar: () => l2.cerrar(),
  };
}

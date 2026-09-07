// `CacheStore`: la interfaz de caché del engine. Tres métodos y nada más —
// `get(key)`, `set(key, value, ttlMs)`, `delete(key)`— y los tres **async**
// aunque esta implementación no necesite esperar nada: la caché L2 en Redis es
// otra implementación de esta misma interfaz, y si la interfaz fuera síncrona
// habría que cambiar el engine para que quepa. La forma la fija el más lento.
//
// El engine no conoce ninguna implementación concreta: recibe una en
// `createEngine({ cache })` y sin ella sirve todo en vivo.

// Cota de la caché en memoria: una caché sin techo es una fuga de memoria con
// otro nombre. 200 entradas alcanzan de sobra para los tableros que se repiten
// —que es lo que la historia 34 quiere abaratar— y el desalojo es LRU: la que
// lleva más tiempo sin usarse es la que menos probable es que vuelva.
export const MAXIMO_DE_ENTRADAS = 200;

export function crearMemoryStore({ maximo = MAXIMO_DE_ENTRADAS } = {}) {
  const entradas = new Map();

  return {
    async get(key) {
      return entradas.get(key);
    },

    async set(key, value) {
      entradas.set(key, value);
      return undefined;
    },

    async delete(key) {
      entradas.delete(key);
      return undefined;
    },
  };
}

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

// `now` es el reloj, inyectable: la expiración es comportamiento, y un
// comportamiento que sólo se puede observar esperando un minuto real no se
// puede probar. Por defecto es el del sistema.
// El store guarda una copia y entrega copias: lo que hay dentro es suyo y nadie
// de afuera lo puede mutar. Sin eso, el consumidor que ordena o recorta las
// filas que recibió le estaría cambiando la respuesta al siguiente —y de la
// forma más difícil de diagnosticar, porque el síntoma aparece en otra
// petición—. Es además lo que la L2 en Redis hace gratis al serializar: copiar
// aquí deja a las dos implementaciones con la misma semántica.
export function crearMemoryStore({ maximo = MAXIMO_DE_ENTRADAS, now = Date.now } = {}) {
  const entradas = new Map();

  return {
    async get(key) {
      const entrada = entradas.get(key);
      if (entrada === undefined) return undefined;
      // Expirada: se borra al leerla en vez de con un temporizador de fondo. Un
      // temporizador por entrada mantendría vivo el proceso y despertaría para
      // borrar algo que a nadie le importa; la entrada muerta que nadie vuelve
      // a pedir la desaloja la cota.
      if (now() >= entrada.expiraEn) {
        entradas.delete(key);
        return undefined;
      }
      // Usarla la manda al final de la fila: eso es lo que hace que el desalojo
      // sea LRU y no por antigüedad de guardado. No corre el vencimiento —el
      // `expiraEn` sigue siendo el de la ejecución que produjo el dato—, así
      // que una entrada muy pedida no se vuelve eterna.
      entradas.delete(key);
      entradas.set(key, entrada);
      return structuredClone(entrada.valor);
    },

    async set(key, value, ttlMs) {
      // Reinsertar al final: `Map` conserva el orden de inserción, así que el
      // primero es siempre el menos usado recientemente.
      entradas.delete(key);
      entradas.set(key, { valor: structuredClone(value), expiraEn: now() + ttlMs });
      if (entradas.size > maximo) entradas.delete(entradas.keys().next().value);
      return undefined;
    },

    async delete(key) {
      entradas.delete(key);
      return undefined;
    },
  };
}

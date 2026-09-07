// `TieredStore`: la caché de dos niveles, escrita como una implementación más de
// `CacheStore`. Lee L1, después L2; escribe en los dos. El engine no sabe que
// hay dos niveles: le entrega una caché y recibe entradas que dicen de dónde
// salieron (`nivel`), que es lo único que necesita para llenar `servedFrom`.
//
// Que la composición viva aquí y no en el engine es lo que permite cambiarla
// —agregar un tercer nivel, quitar el segundo— sin tocar el pipeline de puertas.

// Vida de la copia que un hit de L2 deja en L1. No pretende ser la vida que le
// quedaba a la entrada en L2 —eso no se sabe desde acá—, y no hace falta que lo
// sea: la frescura la decide el lector contra el `asOf` de la entrada, así que
// este número sólo acota cuánto tiempo una copia ocupa un lugar en la L1. Se
// elige el TTL más largo que cualquier consumidor tolera: pasado eso, ninguna
// clase la aceptaría y guardarla más sería ocupar sitio por nada.
export const TTL_DE_RELLENO_MS = 60_000;

// `alFallar({ nivel, operacion, error })` es por dónde salen los fallos del
// segundo nivel: se llama en vez de propagar. La caché existe para abaratar, no
// para poner en riesgo, así que una L2 caída degrada a un nivel y no le cuesta
// al consumidor ni una consulta. Se avisa por un callback y no escribiendo en la
// telemetría directamente para que la caché no tenga que conocerla: quien arma
// el store decide dónde va la señal.
//
// Sólo se envuelve el **segundo** nivel: es el único que cruza la red. Si la L1
// —memoria del proceso— lanza, lo que está roto es el proceso, y para eso está
// la red de seguridad del engine.
export function crearTieredStore({
  l1,
  l2,
  ttlDeRellenoMs = TTL_DE_RELLENO_MS,
  alFallar = () => {},
}) {
  async function enElSegundoNivel(operacion, hacer) {
    try {
      return await hacer();
    } catch (error) {
      alFallar({ nivel: 'cache-l2', operacion, error });
      return undefined;
    }
  }

  return {
    async get(key) {
      const enL1 = await l1.get(key);
      if (enL1 !== undefined) return { ...enL1, nivel: 'cache-l1' };

      const enL2 = await enElSegundoNivel('get', () => l2.get(key));
      if (enL2 === undefined) return undefined;
      // Bajar a L2 cuesta una ida por la red; hacerlo dos veces por la misma
      // entrada es desperdicio puro. La copia se queda en casa.
      await l1.set(key, enL2, ttlDeRellenoMs);
      return { ...enL2, nivel: 'cache-l2' };
    },

    async set(key, value, ttlMs) {
      await l1.set(key, value, ttlMs);
      await enElSegundoNivel('set', () => l2.set(key, value, ttlMs));
    },

    async delete(key) {
      await l1.delete(key);
      await enElSegundoNivel('delete', () => l2.delete(key));
    },
  };
}

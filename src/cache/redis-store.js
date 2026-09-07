// `RedisStore`: la caché L2, compartida entre instancias, escrita como una
// implementación más de `CacheStore` (`get`, `set`, `delete`, los tres async).
// El engine no la conoce: entra por la misma costura que la L1, dentro del store
// compuesto (`tiered.js`).
import { createClient } from 'redis';

// Namespace de las llaves. La llave completa queda
// `capa:{versión del catálogo}:{empresa}:{queryId}`: el prefijo separa nuestras
// llaves de las de cualquier otro que comparta el Redis, y el resto lo arma el
// engine —es el único que sabe de qué empresa y de qué contrato de datos es una
// consulta—. Que la empresa esté **en el texto** de la llave, y no sólo dentro
// del hash, es lo que permite auditar con un `SCAN` que ninguna entrada quedó
// sin dueño.
export const PREFIJO_POR_DEFECTO = 'capa';

// Techo de espera por operación. La caché existe para abaratar: una que se
// cuelga es peor que no tenerla, porque le agrega latencia a cada respuesta a
// cambio de nada. 200 ms es holgado para un Redis en la misma red y corto frente
// al presupuesto de timeout más ajustado (5 s del tablero); pasado eso se da por
// perdida y la consulta sigue su camino a la base.
export const TIMEOUT_DE_REDIS_MS = 200;

// Tope de reintentos de reconexión. Sin tope, un Redis que no vuelve deja al
// proceso reintentando para siempre —y con temporizadores vivos que impiden que
// termine—. Al agotarse, el cliente se cierra; la próxima operación abre uno
// nuevo, así que rendirse no es rendirse para siempre.
export const MAXIMO_DE_REINTENTOS = 5;

export function crearRedisStore({
  url,
  prefijo = PREFIJO_POR_DEFECTO,
  timeoutMs = TIMEOUT_DE_REDIS_MS,
  alFallar = () => {},
}) {
  let cliente;
  let conectando;

  // Conexión perezosa: el store se crea sin tocar la red, así que un Redis que
  // no está no impide arrancar el servicio. La promesa de conexión se memoriza
  // para que dos consultas simultáneas no abran dos; quien la descarta cuando el
  // cliente muere es `olvidarSiMurio`.
  function conectado() {
    conectando ??= abrir();
    return conectando;
  }

  async function abrir() {
    cliente = createClient({
      url,
      socket: {
        connectTimeout: timeoutMs,
        // Espera creciente con tope de intentos. Devolver `false` cierra el
        // cliente en vez de reintentar eternamente.
        reconnectStrategy: (reintentos) =>
          reintentos >= MAXIMO_DE_REINTENTOS ? false : Math.min(2 ** reintentos * 50, 1_000),
      },
    });
    // Sin este listener, un error de socket es un `error` sin manejar en un
    // EventEmitter, y eso tumba el proceso: la caché mataría al servicio que
    // vino a abaratar. Se registra y no se propaga.
    cliente.on('error', (error) => alFallar({ nivel: 'cache-l2', operacion: 'socket', error }));
    await cliente.connect();
    return cliente;
  }

  // Toda operación —conexión incluida— corre contra el reloj. El error que sale
  // de acá lo atrapa el store compuesto, que degrada a un nivel y lo cuenta;
  // aquí sólo se garantiza que nadie espere más de la cuenta.
  async function operar(operacion, hacer) {
    try {
      return await conLimiteDeTiempo(operacion, async () => hacer(await conectado()));
    } catch (error) {
      olvidarSiMurio();
      throw error;
    }
  }

  function conLimiteDeTiempo(operacion, hacer) {
    const enCurso = hacer();
    // La carrera deja huérfana a la perdedora: sin este `catch` un rechazo
    // tardío de Redis sería un rechazo sin dueño, y eso tumba el proceso.
    enCurso.catch(() => {});
    let temporizador;
    return Promise.race([
      enCurso,
      new Promise((_, rechazar) => {
        temporizador = setTimeout(
          () => rechazar(new Error(`Redis no respondió en ${timeoutMs} ms (${operacion})`)),
          timeoutMs,
        );
        // El temporizador no puede ser lo que mantenga vivo al proceso.
        temporizador.unref?.();
      }),
    ]).finally(() => clearTimeout(temporizador));
  }

  // Un cliente que quedó cerrado —se agotaron los reintentos, la conexión nunca
  // se abrió— no sirve para la próxima operación: se olvida para que la
  // siguiente abra uno nuevo, y se destruye el viejo por si quedó reconectando.
  function olvidarSiMurio() {
    if (cliente?.isOpen) return;
    const abandonado = cliente;
    cliente = undefined;
    conectando = undefined;
    try {
      abandonado?.destroy();
    } catch {
      // Ya estaba cerrado: no hay nada que soltar.
    }
  }

  const llaveDe = (key) => `${prefijo}:${key}`;

  return {
    async get(key) {
      const texto = await operar('get', (conexion) => conexion.get(llaveDe(key)));
      // JSON y no otra cosa: serializar es además lo que le da a la L2 la misma
      // semántica de copia que la L1 (`structuredClone`), así que quien mute las
      // filas que recibió no le cambia la respuesta al siguiente.
      return texto === null ? undefined : JSON.parse(texto);
    },

    async set(key, value, ttlMs) {
      // `PX`: el vencimiento lo lleva la propia entrada y lo aplica Redis, así
      // que no hace falta ningún barrido nuestro.
      await operar('set', (conexion) =>
        conexion.set(llaveDe(key), JSON.stringify(value), { PX: ttlMs }),
      );
    },

    async delete(key) {
      await operar('delete', (conexion) => conexion.del(llaveDe(key)));
    },

    // Cerrar es del dueño del store —el servicio al apagarse, el test al
    // terminar—, no de la interfaz `CacheStore`: el engine nunca lo llama.
    async cerrar() {
      if (cliente === undefined) return;
      // Cerrar un cliente que nunca llegó a abrir lanza; apagarse no es un
      // momento para propagar eso.
      await Promise.resolve(cliente.close()).catch(() => {});
      cliente = undefined;
      conectando = undefined;
    },
  };
}

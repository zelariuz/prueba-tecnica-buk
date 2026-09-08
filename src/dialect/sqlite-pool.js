// Adaptador de `node:sqlite` al contrato mínimo de pool que usa el engine:
// `connect()` devuelve un cliente con `query(texto, params) → { rows }` y
// `release()`. Es lo mismo que ofrece node-postgres, y es todo lo que el engine
// mira: por eso el engine no cambia al cambiar de motor.
//
// No es un pool de verdad y no pretende serlo. `DatabaseSync` es síncrona y una
// base en memoria vive en el proceso: hay una sola conexión, `connect()`
// entrega siempre el mismo cliente y `release()` no tiene nada que soltar. Lo
// que sí es real es la transacción: `BEGIN`, `COMMIT` y `ROLLBACK` son las
// mismas sentencias que emite el engine y SQLite las ejecuta.
import { DatabaseSync } from 'node:sqlite';

// El planificador numera los parámetros `$1`, `$2`, … (estilo Postgres) y el
// engine los pasa como arreglo posicional. SQLite lee `$1` como un parámetro
// **nombrado** llamado `1`, así que la traducción es el arreglo convertido en
// objeto: `[a, b]` → `{ 1: a, 2: b }`. Es la conversión más barata posible y
// deja el SQL idéntico en los dos motores, que es lo que permite comparar los
// dos snapshots del repo línea por línea.
function nombrados(params) {
  return Object.fromEntries(params.map((valor, indice) => [String(indice + 1), valor]));
}

export function crearPoolSqlite({ archivo = ':memory:' } = {}) {
  const db = new DatabaseSync(archivo);

  // `async` aunque `DatabaseSync` no espere nada: el contrato del pool lo fija
  // el motor más lento —node-postgres devuelve promesas y el engine hace
  // `await` y `.catch()` sobre lo que recibe—. Un `query` síncrono obligaría a
  // cambiar el engine para que quepa este adaptador, que es exactamente lo que
  // esta fase vino a evitar.
  async function query(texto, params) {
    const sentencia = db.prepare(texto);
    // `all()` sirve para toda sentencia: la que no devuelve filas devuelve una
    // lista vacía, así que `BEGIN` y `COMMIT` pasan por el mismo camino.
    const filas = params === undefined ? sentencia.all() : sentencia.all(nombrados(params));
    // Las filas de `node:sqlite` son objetos sin prototipo; se copian a objetos
    // normales para que el resto del sistema reciba lo mismo que recibe de
    // node-postgres. Los números llegan como números: SQLite no devuelve
    // enteros como texto, así que `aNumeros` del engine no tiene nada que
    // convertir y tampoco estorba.
    return { rows: filas.map((fila) => ({ ...fila })) };
  }

  const cliente = { query, release() {} };

  return {
    query,
    async connect() {
      return cliente;
    },
    // Cargar el esquema y el seed del fixture: varias sentencias de una vez, lo
    // único que `prepare` no acepta. No es parte del contrato del engine.
    ejecutarGuion(sql) {
      db.exec(sql);
    },
    cerrar() {
      db.close();
    },
  };
}

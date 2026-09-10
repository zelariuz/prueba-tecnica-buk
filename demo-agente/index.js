// Arranque de la demo: lee la configuración, comprueba que la capa esté arriba
// —si no, muere diciendo qué levantar—, asegura la sesión del agente y escucha.
// Si Claude Code no está, la demo arranca igual sin él.
import { fileURLToPath } from 'node:url';

import { crearAgente, crearClaude, crearEstadoEnDisco, versionDeClaudeCode } from './src/agente.js';
import { crearCapa, pedirCatalogo, pedirTelemetria } from './src/capa.js';
import { tokensDelEntorno } from './src/consumidores.js';
import { asegurarSesion, NOMBRE_POR_DEFECTO } from './src/sesion.js';
import { crearServidor } from './src/servidor.js';

const url = process.env.CAPA_URL ?? 'http://localhost:3000';
// Un par de tokens por empresa, con el nombre del token como llave: la página
// elige empresa eligiendo el nombre, y sólo acá abajo ese nombre se cambia por
// el valor que va en `Authorization`. Sin `.env` la demo arranca igual, con los
// tokens de demo del `docker-compose.yml`.
const tokens = tokensDelEntorno(process.env);
const puerto = Number(process.env.PUERTO ?? 3100);
const nombre = process.env.SESION_NOMBRE ?? NOMBRE_POR_DEFECTO;
const modelo = process.env.MODELO ?? 'claude-sonnet-5';
const timeoutMs = Number(process.env.AGENTE_TIMEOUT_MS ?? 60000);
const rutaSesion = fileURLToPath(new URL('.sesion.json', import.meta.url));

let catalogo;
try {
  catalogo = await pedirCatalogo({ url, tokens });
} catch (error) {
  console.error(
    `La capa semántica no responde en ${url} (${error.message}).\n` +
      'Levántala desde la raíz del repo con:\n\n  docker compose up -d --build\n',
  );
  process.exit(1);
}

// El agente es opcional: si algo de Claude Code falla, el motivo viaja a la
// página y la casilla "usar agente" queda apagada.
const { version: claudeCode, motivo } = await versionDeClaudeCode();
let agente = null;
let sesion = null;
let agenteMotivo = motivo;
if (claudeCode) {
  try {
    const claude = crearClaude({ timeoutMs });
    const estado = crearEstadoEnDisco(rutaSesion);
    const asegurada = await asegurarSesion({ claude, catalogo, estado, nombre, modelo });
    sesion = { ...asegurada, nombre, creadaEn: estado.leer()?.creadaEn };
    agente = crearAgente({ claude, uuid: sesion.id, nombre, modelo });
    console.log(
      `Sesión ${nombre} ${asegurada.creada ? 'creada' : 'reutilizada'} (${asegurada.motivo}) — ${
        asegurada.id
      }, catálogo versión ${asegurada.version}, huella ${asegurada.huella}.`,
    );
  } catch (error) {
    agenteMotivo = `no se pudo asegurar la sesión ${nombre} (${error.message})`;
    console.error(`Aviso: ${agenteMotivo}. La demo sigue por el camino sin agente.`);
  }
}
if (!agente) console.error(`Aviso: sin agente — ${agenteMotivo}.`);

crearServidor({
  capa: crearCapa({ url, tokens }),
  pedirCatalogoEnVivo: () => pedirCatalogo({ url, tokens }),
  // El panel del pie: la telemetría se pide con el token interno de la empresa
  // elegida, que es el único al que la capa se la entrega.
  pedirTelemetria: (interno) => pedirTelemetria({ url, tokens, token: interno }),
  agente,
  agenteMotivo,
  sesion,
  catalogo,
  claudeCode,
  modelo,
}).listen(puerto, () => {
  console.log(
    `Demo agente en http://localhost:${puerto}/ — capa en ${url}, catálogo versión ${catalogo.version}.`,
  );
});

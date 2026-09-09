// Todo lo que la demo toca del mundo real del agente: el proceso `claude`, el
// archivo donde queda anotada la sesión y la detección al arrancar. Son
// efectos, no decisiones: la decisión de crear o conservar la sesión vive en
// `sesion.js` y el rastro se decide en `ejecutar.js`.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { PROMPT_DE_SISTEMA } from './sesion.js';

// Los flags que hacen barata cada llamada. Medido el 09-09 con una llamada
// mínima a claude-sonnet-5:
//   sin flags .............. 62.037 tokens de entrada, 0,178 USD
//   --tools "" --setting-sources "" .... 9.201 tokens, 0,025 USD
//   + --system-prompt ..................... 515 tokens, 0,002 USD
// `--tools ""` deja al agente sin herramientas (no explora el disco),
// `--setting-sources ""` ignora los settings del usuario y del repo, y
// `--system-prompt` reemplaza el andamiaje de Claude Code por dos líneas: el
// rol de verdad se lo da el prompt de creación de la sesión.
const FLAGS_SIN_CONTEXTO = ['--tools', '', '--setting-sources', '', '--system-prompt', PROMPT_DE_SISTEMA];

// `claude(argumentos, entradaStdin)`: el prompt viaja por stdin —son miles de
// caracteres— y el tope de tiempo mata el proceso en vez de colgar la demo.
export function crearClaude({ binario = 'claude', timeoutMs = 60000 } = {}) {
  return (argumentos, entrada = '') =>
    new Promise((resolve, reject) => {
      const hijo = spawn(binario, [...argumentos, ...FLAGS_SIN_CONTEXTO], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let vencido = false;
      const alarma = setTimeout(() => {
        vencido = true;
        hijo.kill('SIGKILL');
      }, timeoutMs);

      hijo.stdout.on('data', (trozo) => (stdout += trozo));
      hijo.stderr.on('data', (trozo) => (stderr += trozo));
      hijo.on('error', (error) => {
        clearTimeout(alarma);
        reject(error);
      });
      hijo.on('close', (code) => {
        clearTimeout(alarma);
        resolve({ stdout, stderr, code, ...(vencido ? { fallo: `timeout de ${timeoutMs} ms` } : {}) });
      });

      hijo.stdin.end(entrada);
    });
}

// El agente que recibe `ejecutar`: prompt → { texto, ms, meta }. Todo lo que
// el rastro muestra del costo sale del JSON que devuelve `--output-format json`.
export function crearAgente({ claude, uuid, nombre, modelo }) {
  const agente = async (prompt) => {
    const inicio = performance.now();
    const { stdout, stderr, fallo } = await claude(
      // `--fork-session`: cada clic retoma la sesión en su estado de creación
      // (catálogo y reglas, ya en caché) y sigue en una bifurcación propia. La
      // sesión original no acumula preguntas: ni contamina la siguiente ni
      // encarece la llamada. Verificado el 09-09: una bifurcación recuerda lo
      // de la creación y no lo dicho en otra bifurcación.
      ['-p', '--resume', uuid, '--fork-session', '--model', modelo, '--output-format', 'json'],
      prompt,
    );
    const ms = Math.round(performance.now() - inicio);
    if (fallo) return { texto: '', ms, fallo };
    try {
      const json = JSON.parse(stdout);
      return {
        texto: json.result ?? '',
        ms,
        meta: {
          total_cost_usd: json.total_cost_usd,
          duration_api_ms: json.duration_api_ms,
          cache_read_input_tokens: json.usage?.cache_read_input_tokens,
          session_id: json.session_id,
        },
      };
    } catch {
      // Sin JSON no hay respuesta que parsear: lo crudo va al rastro y el seam
      // lo marca como salto fallido. Es justo lo que hay que ver en vivo.
      return { texto: stdout.trim() || stderr.trim() || '(sin salida)', ms };
    }
  };
  agente.via = `claude -p --resume ${nombre}`;
  return agente;
}

// La sesión se anota en un archivo al lado del código: uuid y versión del
// catálogo con la que se creó. Si no existe o está roto, es como no tener
// sesión — se crea una nueva.
export function crearEstadoEnDisco(ruta) {
  return {
    leer() {
      try {
        return JSON.parse(readFileSync(ruta, 'utf8'));
      } catch {
        return null;
      }
    },
    guardar(valor) {
      writeFileSync(ruta, `${JSON.stringify(valor, null, 2)}\n`);
    },
  };
}

// Detección al arrancar: si `claude --version` no contesta, la demo sigue viva
// por el camino sin agente y la página dice por qué.
export function versionDeClaudeCode({ binario = 'claude' } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn(binario, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    hijo.stdout.on('data', (trozo) => (stdout += trozo));
    hijo.on('error', (error) => resolve({ version: null, motivo: error.message }));
    hijo.on('close', (code) =>
      code === 0 && stdout.trim()
        ? resolve({ version: stdout.trim(), motivo: null })
        : resolve({ version: null, motivo: `\`${binario} --version\` terminó con código ${code}` }),
    );
  });
}

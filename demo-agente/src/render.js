// La página: HTML armado en el servidor, sin JavaScript. Dibuja el formulario
// y el rastro que devolvió el seam. No decide nada —si algo se ve raro, el
// rastro venía raro— y por eso no tiene tests: se verifica mirándola.
//
// Sale en piezas porque el servidor la escribe por trozos: primero
// `inicioDePagina` (que ya es una página usable: formulario incluido), después
// un `bloqueSalto` por salto a medida que terminan, y al final `finDePagina`.
// `render` las junta para los caminos que no esperan a nadie.
import { preguntas } from './preguntas.js';
import { promptDeCreacion, PROMPT_DE_SISTEMA } from './sesion.js';

export function render({ rastro, error, ...pagina }) {
  return (
    inicioDePagina(pagina) +
    (error ? bloqueError(error) : '') +
    (rastro ? rastro.map((salto, indice) => bloqueSalto(salto, indice)).join('\n') : '') +
    '\n'
  );
}

// Lo que se puede escribir antes de que empiece a pasar algo: la cabecera, el
// estilo y el formulario. El navegador ya tiene una página con la que
// interactuar mientras el salto al agente sigue en curso.
export function inicioDePagina({
  peticion,
  pregunta,
  texto,
  nota,
  agenteDisponible = false,
  agenteMotivo = null,
}) {
  return `<title>Demo agente — rastro de llamadas a la capa semántica</title>
<style>
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  fieldset { border: 1px solid #999; margin-bottom: 1.5rem; }
  label { display: block; margin: .4rem 0; }
  input, select, textarea { font: inherit; width: 100%; box-sizing: border-box; }
  textarea { height: 4rem; }
  .fila { display: flex; gap: 1rem; }
  .fila > * { flex: 1; }
  .salto { border-left: 4px solid #999; padding-left: .8rem; margin: 1.5rem 0; }
  .ok { border-color: #2a7; } .rechazo { border-color: #d81; } .fallo { border-color: #c33; }
  pre { background: #f4f4f4; padding: .6rem; overflow-x: auto; white-space: pre-wrap; }
  .nota, .apagado, .cargando { color: #666; }
  .error { border-left: 4px solid #c33; padding-left: .8rem; }
</style>
<h1>Demo agente — rastro de llamadas a la capa semántica</h1>
${formulario({ peticion, pregunta, texto, agenteDisponible, agenteMotivo })}
${nota ? `<p class="nota">${escapar(nota)} — se ejecutó el camino sin agente.</p>` : ''}
${pregunta ? cabeceraDeLaPregunta({ pregunta, texto }) : ''}
`;
}

// El "Cargando…" y cómo se apaga, sin una línea de JavaScript: cada aviso es un
// párrafo con su id, y cuando su salto termina se escribe un `<style>` que lo
// oculta. Una regla de estilo que llega después vale para lo que ya se pintó
// —el navegador re-aplica el estilo al documento entero—, así que el aviso
// desaparece solo. El `finDePagina` apaga de una vez el que haya quedado
// colgando: el rastro puede terminar en cualquier salto.
export function avisoDeCarga(numero, quien = null) {
  const de = quien ? ` (${quien})` : '';
  return `<p class="cargando" id="cargando-${numero}">Cargando… salto ${numero}${de} en curso…</p>\n`;
}

export function ocultarAviso(numero) {
  return `<style>#cargando-${numero}{display:none}</style>\n`;
}

export function finDePagina() {
  return '<style>.cargando{display:none}</style>\n';
}

function formulario({ peticion, pregunta, texto, agenteDisponible, agenteMotivo }) {
  const valor = (clave) => escapar(peticion?.[clave] ?? '');
  const opciones = preguntas
    .map(
      (preparada) =>
        `<option value="${escapar(preparada.id)}"${
          preparada.id === pregunta?.id ? ' selected' : ''
        }>${escapar(preparada.titulo)}</option>`,
    )
    .join('\n      ');
  return `<form method="get" action="/">
  <fieldset>
    <legend>Pregunta preparada y filtros</legend>
    <label>Pregunta
      <select name="pregunta">
      ${opciones}
      </select>
    </label>
    <label>Texto en lenguaje natural (editable; es lo que se le manda al agente)
      <textarea name="texto" placeholder="${escapar(texto ?? '')}">${valor('texto')}</textarea>
    </label>
    <div class="fila">
      <label>Desde <input type="date" name="desde" value="${valor('desde')}"></label>
      <label>Hasta <input type="date" name="hasta" value="${valor('hasta')}"></label>
      <label>Departamento (vacío = todos) <input name="departamento" value="${valor(
        'departamento',
      )}"></label>
    </div>
    ${casillaDelAgente({ peticion, agenteDisponible, agenteMotivo })}
    <button type="submit">Ejecutar</button>
  </fieldset>
</form>`;
}

// La casilla se apaga sola si Claude Code no está: la demo no promete algo que
// no puede hacer, y el motivo queda a la vista.
function casillaDelAgente({ peticion, agenteDisponible, agenteMotivo }) {
  const marcada = peticion?.usarAgente ? ' checked' : '';
  if (agenteDisponible) {
    return `<label>
      <input type="checkbox" name="agente" value="1"${marcada} style="width:auto"> Usar agente
    </label>
    <p class="nota">Marcado: el texto de arriba se le manda a una sesión de Claude Code, que escribe el
      JSON de la consulta leyendo el catálogo (<a href="/agente/sesion">lo que sabe esa sesión</a>: un
      prompt fijo que arma este mini back al crearla, con el catálogo pegado).
      Sin marcar: se manda el JSON preparado de esta pregunta, sin ningún modelo de por medio.</p>`;
  }
  return `<label class="apagado">
      <input type="checkbox" name="agente" value="1" disabled style="width:auto"> Usar agente
      — no disponible: ${escapar(agenteMotivo ?? 'Claude Code no responde')}.
    </label>`;
}

function cabeceraDeLaPregunta({ pregunta, texto }) {
  return `<h2>${escapar(pregunta.titulo)}</h2>
<p>${escapar(texto ?? '')}</p>
${pregunta.nota ? `<p class="nota">Nota: ${escapar(pregunta.nota)}</p>` : ''}`;
}

export function bloqueSalto(salto, indice) {
  // El token se nombra, nunca se muestra su valor: el valor no sale del `.env`.
  const token = salto.token
    ? `token <code>${escapar(salto.token)}</code>`
    : 'sin token (no es la capa)';
  return `<div class="salto ${salto.estado}">
  <h3>Salto ${indice + 1} — ${escapar(salto.destino)}</h3>
  <p>vía <code>${escapar(salto.via)}</code> · ${token} · ${salto.ms} ms · estado <strong>${escapar(
    salto.estado,
  )}</strong></p>
  ${salto.meta ? `<p class="nota">${escapar(medicion(salto.meta))}</p>` : ''}
  <p>enviado</p>
  <pre>${escapar(comoTexto(salto.enviado))}</pre>
  <p>recibido</p>
  <pre>${escapar(comoTexto(salto.recibido))}</pre>
</div>`;
}

// Lo de la capa es JSON y se indenta. Lo del agente es texto plano tal cual
// viajó; si ese texto resulta ser JSON (el caso normal), se muestra indentado
// y debajo, en una línea, el crudo, para que se siga viendo lo que salió del
// proceso.
function comoTexto(valor) {
  if (typeof valor !== 'string') return JSON.stringify(valor, null, 2);
  const indentado = jsonIndentado(valor);
  return indentado ? `${indentado}\n\ncrudo: ${valor}` : valor;
}

function jsonIndentado(texto) {
  try {
    const limpio = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.stringify(JSON.parse(limpio), null, 2);
  } catch {
    return null;
  }
}

function medicion(meta) {
  return [
    meta.total_cost_usd != null ? `costo ${meta.total_cost_usd.toFixed(4)} USD` : null,
    meta.duration_api_ms != null ? `API ${meta.duration_api_ms} ms` : null,
    meta.cache_read_input_tokens != null
      ? `${meta.cache_read_input_tokens} tokens desde caché`
      : null,
    meta.session_id ? `sesión ${meta.session_id}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// La página del prompt: lo único que el agente sabe, entero y sin recortar.
export function renderSesion({ sesion, catalogo, modelo, claudeCode, agenteMotivo }) {
  if (!sesion) {
    return `<title>Demo agente — sesión</title>
<h1>No hay sesión del agente</h1>
<p>${escapar(agenteMotivo ?? 'Claude Code no está disponible.')}</p>
<p><a href="/">Volver a la demo</a></p>`;
  }
  return `<title>Demo agente — la sesión del agente</title>
<style>
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  pre { background: #f4f4f4; padding: .6rem; overflow-x: auto; white-space: pre-wrap; }
  th { text-align: left; padding-right: 1rem; vertical-align: top; }
</style>
<h1>La sesión del agente</h1>
<p><a href="/">Volver a la demo</a></p>
<table>
  <tr><th>nombre</th><td>${escapar(sesion.nombre)}</td></tr>
  <tr><th>uuid</th><td>${escapar(sesion.id)}</td></tr>
  <tr><th>versión del catálogo</th><td>${escapar(catalogo?.version ?? '')}</td></tr>
  <tr><th>huella del catálogo</th><td>${escapar(sesion.huella ?? '')}</td></tr>
  <tr><th>creada</th><td>${escapar(sesion.creadaEn ?? '')} (${escapar(sesion.motivo ?? '')})</td></tr>
  <tr><th>modelo</th><td>${escapar(modelo ?? '')}</td></tr>
  <tr><th>Claude Code</th><td>${escapar(claudeCode ?? '')}</td></tr>
</table>
<p class="nota">La sesión se recrea cuando cambia la <strong>huella</strong>, no la
versión: la versión de la capa es el hash de las definiciones más el esquema
físico y no cubre las consultas tipo, así que un catálogo con otras consultas
tipo tiene la misma versión y otra huella. La huella es sha256 del catálogo
público entero con las claves ordenadas.</p>
<h2>Cómo se lee un rechazo</h2>
<p class="nota">Un <code>{"noPuedo": "…"}</code> del agente sale en el rastro como
<code>estado: rechazo</code>, igual que un 4xx de la capa. No son lo mismo y el
<strong>destino</strong> del salto dice de quién viene: el del agente es "no sé
traducir esto con este catálogo" y corta el rastro sin tocar la capa; el de la
capa es "este JSON está mal" y abre el salto de corrección. Un 5xx no es rechazo
sino <code>fallo</code>: ahí no hay nada que corregir.</p>
<p class="nota">El contrato pide JSON pelado, pero si el agente lo envuelve en un
bloque <code>\`\`\`</code> la demo se lo tolera —leniencia deliberada— y sigue. Lo
que no se tolera es la prosa: un texto que no parsea queda como salto
<code>fallo</code> con lo crudo a la vista.</p>
<h2>System prompt de la llamada</h2>
<pre>${escapar(PROMPT_DE_SISTEMA)}</pre>
<h2>Prompt de creación de la sesión</h2>
<p class="nota">Esto es todo lo que el agente sabe: rol, catálogo público tal cual
lo publica la capa, reglas del vocabulario y contrato de salida.</p>
<pre>${escapar(promptDeCreacion(catalogo ?? {}))}</pre>`;
}

export function bloqueError(error) {
  return `<div class="error"><p><strong>No se pudo ejecutar:</strong> ${escapar(error)}</p></div>`;
}

function escapar(valor) {
  return String(valor)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

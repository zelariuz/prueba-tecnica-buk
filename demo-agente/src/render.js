// La página: HTML armado en el servidor, sin JavaScript. Dibuja el formulario
// y el rastro que devolvió el seam. No decide nada —si algo se ve raro, el
// rastro venía raro— y por eso no tiene tests: se verifica mirándola.
import { preguntas } from './preguntas.js';

export function render({ rastro, peticion, pregunta, texto, error }) {
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
  .nota, .apagado { color: #666; }
  .error { border-left: 4px solid #c33; padding-left: .8rem; }
</style>
<h1>Demo agente — rastro de llamadas a la capa semántica</h1>
${formulario({ peticion, pregunta })}
${error ? bloqueError(error) : ''}
${pregunta ? cabeceraDeLaPregunta({ pregunta, texto }) : ''}
${rastro ? rastro.map((salto, indice) => bloqueSalto(salto, indice)).join('\n') : ''}
`;
}

function formulario({ peticion, pregunta }) {
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
    <label>Texto en lenguaje natural (editable; lo usa el agente en la fase 2)
      <textarea name="texto">${valor('texto')}</textarea>
    </label>
    <div class="fila">
      <label>Desde <input type="date" name="desde" value="${valor('desde')}"></label>
      <label>Hasta <input type="date" name="hasta" value="${valor('hasta')}"></label>
      <label>Departamento (vacío = todos) <input name="departamento" value="${valor(
        'departamento',
      )}"></label>
    </div>
    <label class="apagado">
      <input type="checkbox" name="agente" value="1" disabled style="width:auto"> Usar agente
      — fase 2: por ahora la demo solo hace el camino sin agente.
    </label>
    <button type="submit">Ejecutar</button>
  </fieldset>
</form>`;
}

function cabeceraDeLaPregunta({ pregunta, texto }) {
  return `<h2>${escapar(pregunta.titulo)}</h2>
<p>${escapar(texto ?? '')}</p>
${pregunta.nota ? `<p class="nota">Nota: ${escapar(pregunta.nota)}</p>` : ''}`;
}

function bloqueSalto(salto, indice) {
  // El token se nombra, nunca se muestra su valor: el valor no sale del `.env`.
  return `<div class="salto ${salto.estado}">
  <h3>Salto ${indice + 1} — ${escapar(salto.destino)}</h3>
  <p>vía <code>${escapar(salto.via)}</code> · token <code>${escapar(
    salto.token,
  )}</code> · ${salto.ms} ms · estado <strong>${escapar(salto.estado)}</strong></p>
  <p>enviado</p>
  <pre>${escapar(JSON.stringify(salto.enviado, null, 2))}</pre>
  <p>recibido</p>
  <pre>${escapar(JSON.stringify(salto.recibido, null, 2))}</pre>
</div>`;
}

function bloqueError(error) {
  return `<div class="error"><p><strong>No se pudo ejecutar:</strong> ${escapar(error)}</p></div>`;
}

function escapar(valor) {
  return String(valor)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

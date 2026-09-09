// El front entero: pide las preguntas y la sesión, arma la URL de cada
// ejecución y consume el NDJSON del rastro línea a línea, pintando cada salto
// cuando llega. Sin frameworks y sin librerías.
//
// Regla dura: todo lo que viene del agente o de la capa se escribe con
// `textContent`. Nunca `innerHTML` con datos — el texto del salto 1 lo escribió
// un modelo.

const $ = (id) => document.getElementById(id);

const estado = {
  preguntas: [],
  sesion: null,
  controlador: null,
  peticion: null,
  saltosPrevistos: 0,
  saltos: [],
};

// ---------- tema ----------

const raiz = document.documentElement;
const botonTema = $('tema');

function temaGuardado() {
  try {
    return localStorage.getItem('tema');
  } catch {
    return null;
  }
}

function guardarTema(tema) {
  try {
    localStorage.setItem('tema', tema);
  } catch {
    // un navegador que no deja guardar no puede romper la página
  }
}

function esOscuro() {
  const elegido = raiz.dataset.theme;
  if (elegido) return elegido === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function pintarBotonTema() {
  // Sol y luna en texto: el botón dice a qué se va, no dónde se está.
  botonTema.textContent = esOscuro() ? 'sol' : 'luna';
}

const guardado = temaGuardado();
if (guardado === 'dark' || guardado === 'light') raiz.dataset.theme = guardado;
pintarBotonTema();
botonTema.addEventListener('click', () => {
  const siguiente = esOscuro() ? 'light' : 'dark';
  raiz.dataset.theme = siguiente;
  guardarTema(siguiente);
  pintarBotonTema();
});

// ---------- arranque ----------

const formulario = $('controles');
const botonEjecutar = $('ejecutar');
const rastro = $('rastro');
const resumen = $('resumen');
const aviso = $('aviso');
const modal = $('modal-sesion');

formulario.addEventListener('submit', (evento) => {
  evento.preventDefault();
  ejecutar();
});

$('cerrar-modal').addEventListener('click', () => modal.close());
modal.addEventListener('click', (evento) => {
  // Clic en el fondo: el propio `<dialog>` es el área que rodea al contenido.
  if (evento.target === modal) modal.close();
});
for (const boton of [$('ver-prompt'), $('ver-prompt-2')]) {
  boton.addEventListener('click', abrirModal);
}

arrancar();

async function arrancar() {
  try {
    const [preguntas, sesion] = await Promise.all([pedir('/api/preguntas'), pedir('/api/sesion')]);
    estado.preguntas = preguntas;
    estado.sesion = sesion;
    llenarSelector(preguntas);
    pintarSesion(sesion);
  } catch (error) {
    mostrarAviso(`No se pudo hablar con el mini back: ${error.message}`);
    return;
  }

  const parametros = new URLSearchParams(location.search);
  if (parametros.has('pregunta')) {
    aplicarURL(parametros);
    ejecutar();
  } else {
    // Estado inicial: la pregunta de asistencia, el trimestre del seed y sin
    // agente. Entrar a la demo no dispara una consulta sola.
    $('pregunta').value = 'asistencia-por-departamento';
    sincronizarRango();
    sincronizarTexto();
  }
}

async function pedir(ruta) {
  const respuesta = await fetch(ruta, { headers: { Accept: 'application/json' } });
  if (!respuesta.ok) throw new Error(`${ruta} respondió ${respuesta.status}`);
  return respuesta.json();
}

function llenarSelector(preguntas) {
  const selector = $('pregunta');
  selector.replaceChildren();
  for (const pregunta of preguntas) {
    const opcion = document.createElement('option');
    opcion.value = pregunta.id;
    opcion.textContent = pregunta.titulo;
    selector.append(opcion);
  }
  selector.addEventListener('change', () => {
    sincronizarRango();
    sincronizarTexto();
  });
  for (const campo of ['desde', 'hasta', 'departamento']) {
    $(campo).addEventListener('change', sincronizarTexto);
  }
}

// El rango es obligatorio —la clase `agente` no ejecuta sin `dateRange`, y todos
// los JSON preparados llevan los marcadores—, así que cada pregunta trae uno que
// da filas con el seed. Se precarga al cambiar de pregunta y deja de tocarse en
// cuanto el usuario escribe una fecha a mano.
const RANGOS = new Map([['asistencia-por-departamento', ['2025-06-01', '2025-08-31']]]);
const RANGO_POR_DEFECTO = ['2025-01-01', '2025-12-31'];

let fechasEditadas = false;
for (const campo of ['desde', 'hasta']) {
  $(campo).addEventListener('input', () => (fechasEditadas = true));
}

function sincronizarRango() {
  if (fechasEditadas) return;
  const [desde, hasta] = RANGOS.get($('pregunta').value) ?? RANGO_POR_DEFECTO;
  $('desde').value = desde;
  $('hasta').value = hasta;
}

// El textarea muestra el texto ya sustituido de la pregunta elegida mientras
// nadie lo edite a mano: es lo que se le va a mandar al agente.
let textoEditado = false;
$('texto').addEventListener('input', () => (textoEditado = true));

// El texto solo existe para el agente: aparece debajo de la casilla al marcarla.
function mostrarTextoSegunAgente() {
  $('campo-texto').hidden = !$('agente').checked;
}
$('agente').addEventListener('change', mostrarTextoSegunAgente);

function sincronizarTexto() {
  if (textoEditado) return;
  const pregunta = preguntaElegida();
  if (pregunta) $('texto').value = prepararTexto(pregunta.texto, leerFormulario());
}

function preguntaElegida() {
  return estado.preguntas.find((pregunta) => pregunta.id === $('pregunta').value);
}

function pintarSesion(sesion) {
  $('datos-cabecera').textContent = sesion.versionCatalogo
    ? `catálogo ${sesion.versionCatalogo}${sesion.nombre ? ` · sesión ${sesion.nombre}` : ''}${
        sesion.huella ? ` · huella ${sesion.huella}` : ''
      }`
    : 'sin catálogo';

  const tabla = $('tabla-sesion');
  tabla.replaceChildren();
  const filas = [
    ['nombre', sesion.nombre ?? '(sin sesión)'],
    ['modelo', sesion.modelo ?? ''],
    ['claude code', sesion.claudeCode ?? '(no disponible)'],
    ['huella', sesion.huella ?? ''],
    ['uuid', sesion.uuid ?? ''],
    ['creada', sesion.creadaEn ?? ''],
  ];
  for (const [clave, valor] of filas) {
    const dt = document.createElement('dt');
    dt.textContent = clave;
    const dd = document.createElement('dd');
    dd.textContent = valor;
    tabla.append(dt, dd);
  }

  if (!sesion.agenteDisponible) {
    const casilla = $('casilla-agente');
    casilla.classList.add('apagada');
    $('agente').disabled = true;
    $('nota-agente').textContent = `No disponible: ${
      sesion.agenteMotivo ?? 'Claude Code no responde'
    }. El camino sin agente funciona igual.`;
  }
}

// El catálogo se pide a la capa en el momento (por el mini back, con el token
// agente) y se compara con el que aprendió la sesión.
$('ver-catalogo').addEventListener('click', async () => {
  const estadoTexto = $('catalogo-estado');
  const pre = $('modal-catalogo');
  if (!pre.hidden) {
    pre.hidden = true;
    estadoTexto.textContent = '';
    return;
  }
  estadoTexto.textContent = 'pidiendo…';
  try {
    const respuesta = await fetch('/api/catalogo');
    const datos = await respuesta.json();
    if (!respuesta.ok) throw new Error(datos.error ?? `HTTP ${respuesta.status}`);
    pre.textContent = JSON.stringify(datos.catalogo, null, 2);
    pre.hidden = false;
    const igual = datos.huellaDeLaSesion && datos.huella === datos.huellaDeLaSesion;
    estadoTexto.textContent = `${datos.origen} · huella ${datos.huella ?? '?'} · ${
      igual ? 'es el mismo que aprendió la sesión' : 'DISTINTO al que aprendió la sesión: reiniciar el mini back'
    }`;
  } catch (error) {
    estadoTexto.textContent = `No se pudo: ${error.message}`;
  }
});

function abrirModal() {
  const sesion = estado.sesion;
  if (!sesion) return;
  $('modal-datos').textContent = [
    sesion.nombre ?? '(sin sesión)',
    sesion.modelo ?? '',
    sesion.huella ? `huella ${sesion.huella}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  $('modal-sistema').textContent = sesion.promptDeSistema ?? '';
  $('modal-creacion').textContent =
    sesion.promptDeCreacion ?? sesion.agenteMotivo ?? 'No hay sesión del agente.';
  modal.showModal();
}

// ---------- ejecutar ----------

function leerFormulario() {
  return {
    pregunta: $('pregunta').value,
    texto: $('texto').value,
    desde: $('desde').value,
    hasta: $('hasta').value,
    departamento: $('departamento').value,
    usarAgente: $('agente').checked,
  };
}

function aplicarURL(parametros) {
  $('pregunta').value = parametros.get('pregunta') ?? '';
  // El rango del link manda sobre el precargado de la pregunta.
  if (parametros.has('desde') || parametros.has('hasta')) fechasEditadas = true;
  $('desde').value = parametros.get('desde') ?? '';
  $('hasta').value = parametros.get('hasta') ?? '';
  if (!fechasEditadas) sincronizarRango();
  $('departamento').value = parametros.get('departamento') ?? '';
  $('agente').checked = parametros.get('agente') === '1' && !$('agente').disabled;
  mostrarTextoSegunAgente();
  const texto = parametros.get('texto') ?? '';
  if (texto) {
    $('texto').value = texto;
    textoEditado = true;
  } else {
    sincronizarTexto();
  }
}

function parametrosDe(peticion) {
  const parametros = new URLSearchParams({
    pregunta: peticion.pregunta,
    desde: peticion.desde,
    hasta: peticion.hasta,
  });
  if (peticion.departamento) parametros.set('departamento', peticion.departamento);
  if (textoEditado && peticion.texto) parametros.set('texto', peticion.texto);
  if (peticion.usarAgente) parametros.set('agente', '1');
  return parametros;
}

async function ejecutar() {
  const peticion = leerFormulario();
  const parametros = parametrosDe(peticion);
  // Cada estado sigue siendo un link copiable.
  history.replaceState(null, '', `?${parametros}`);

  estado.controlador?.abort();
  const controlador = new AbortController();
  estado.controlador = controlador;
  estado.saltos = [];
  estado.peticion = null;
  estado.saltosPrevistos = 0;
  botonEjecutar.disabled = true;
  aviso.replaceChildren();
  resumen.replaceChildren();
  rastro.replaceChildren();

  try {
    const respuesta = await fetch(`/api/rastro?${parametros}`, { signal: controlador.signal });
    if (!respuesta.ok) throw new Error(`el mini back respondió ${respuesta.status}`);
    await leerLineas(respuesta.body, (linea) => manejarLinea(JSON.parse(linea)));
  } catch (error) {
    if (error.name === 'AbortError') return;
    quitarEnCurso();
    mostrarAviso(`Se cortó el rastro: ${error.message}`);
  } finally {
    if (estado.controlador === controlador) botonEjecutar.disabled = false;
  }
}

// NDJSON: el cuerpo llega por trozos y una línea puede quedar partida entre
// dos, así que lo que sobra se guarda para el trozo siguiente.
async function leerLineas(cuerpo, alLinea) {
  const lector = cuerpo.getReader();
  const decodificador = new TextDecoder();
  let resto = '';
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    resto += decodificador.decode(value, { stream: true });
    const partes = resto.split('\n');
    resto = partes.pop() ?? '';
    for (const linea of partes) if (linea.trim()) alLinea(linea);
  }
  if (resto.trim()) alLinea(resto);
}

function manejarLinea(evento) {
  if (evento.tipo === 'inicio') {
    estado.peticion = evento.peticion;
    estado.saltosPrevistos = evento.saltosPrevistos;
    if (evento.nota) mostrarAviso(`${evento.nota} — se ejecutó el camino sin agente.`);
    rastro.append(tarjetaDelCatalogo());
    mostrarEnCurso(1);
    return;
  }
  if (evento.tipo === 'salto') {
    quitarEnCurso();
    estado.saltos.push(evento.salto);
    rastro.append(tarjetaDeSalto(evento.salto, evento.indice));
    mostrarEnCurso(evento.indice + 2);
    return;
  }
  if (evento.tipo === 'fin') {
    quitarEnCurso();
    pintarResumen(evento.totalMs);
    return;
  }
  if (evento.tipo === 'error') {
    quitarEnCurso();
    mostrarAviso(`No se pudo ejecutar: ${evento.mensaje}`);
  }
}

function mostrarAviso(mensaje) {
  const caja = document.createElement('p');
  caja.className = 'aviso';
  caja.textContent = mensaje;
  aviso.replaceChildren(caja);
}

// ---------- la línea de tiempo ----------

function actorDe(destino) {
  return String(destino).startsWith('agente') ? 'agente' : 'capa';
}

// Con agente el salto 1 es suyo; los demás previstos son de la capa. Pasado el
// número previsto no se adivina: el reintento agrega saltos que nadie prometió.
function actorPrevisto(numero) {
  if (numero > estado.saltosPrevistos) return null;
  return numero === 1 && estado.peticion?.usarAgente ? 'agente' : 'capa';
}

function mostrarEnCurso(numero) {
  const previsto = actorPrevisto(numero);
  const fila = document.createElement('div');
  fila.className = `salto en-curso${previsto ? ` ${previsto}` : ''}`;
  fila.id = 'en-curso';
  const tarjeta = document.createElement('div');
  tarjeta.className = 'tarjeta';
  tarjeta.textContent = previsto
    ? `Salto ${numero} (${previsto === 'agente' ? 'agente' : 'capa semántica'}) en curso…`
    : `Salto ${numero} en curso…`;
  fila.append(tarjeta);
  rastro.append(fila);
}

// Antes del salto 1 no hay un salto: el GET del catálogo lo hizo el mini back
// al arrancar, una sola vez, y lo pegó en el prompt de creación de la sesión.
// Se muestra para que el flujo del consumidor se lea completo: token → catálogo
// → JSON → dry-run → consulta. No se repite por clic.
function tarjetaDelCatalogo() {
  const sesion = estado.sesion ?? {};
  const fila = document.createElement('div');
  fila.className = 'salto capa previo';
  const tarjeta = document.createElement('div');
  tarjeta.className = 'tarjeta';
  const titulo = document.createElement('div');
  titulo.className = 'titulo-salto';
  titulo.append(texto('span', 'Antes de todo', 'numero'), texto('span', 'GET /analytics/catalog', 'destino'));
  tarjeta.append(titulo);
  tarjeta.append(
    texto(
      'p',
      'Lo inició el mini back al arrancar, una sola vez, con el token agente: pidió el catálogo ' +
        'público a la capa y lo pegó entero en el prompt de creación de la sesión del agente. ' +
        'Por eso no aparece como salto en cada clic: el agente ya lo tiene en memoria.' +
        (sesion.creadaEn ? ` Sesión creada el ${sesion.creadaEn}` : '') +
        (sesion.versionCatalogo ? ` · catálogo ${sesion.versionCatalogo}` : '') +
        (sesion.huella ? ` · huella ${sesion.huella}` : '') +
        '. Si el catálogo cambia, la huella cambia y el mini back crea una sesión nueva al arrancar.',
      'nota',
    ),
  );
  fila.append(tarjeta);
  return fila;
}

function quitarEnCurso() {
  document.getElementById('en-curso')?.remove();
}

function tarjetaDeSalto(salto, indice) {
  const actor = actorDe(salto.destino);
  const fila = document.createElement('div');
  fila.className = `salto ${actor}`;

  const tarjeta = document.createElement('div');
  tarjeta.className = 'tarjeta';
  fila.append(tarjeta);

  const titulo = document.createElement('h3');
  titulo.className = 'titulo-salto';
  titulo.append(texto('span', `Salto ${indice + 1}`), texto('span', salto.destino, 'destino'));
  tarjeta.append(titulo);

  const meta = document.createElement('p');
  meta.className = 'meta-salto';
  meta.append(texto('span', salto.via, 'via'));
  // El token se nombra, nunca se muestra su valor.
  meta.append(texto('span', salto.token ?? 'sin token', 'chip'));
  meta.append(texto('span', `${salto.ms} ms`));
  meta.append(texto('span', salto.estado, `pildora ${salto.estado}`));
  tarjeta.append(meta);

  if (salto.meta) {
    const medicion = medicionDe(salto.meta);
    if (medicion) tarjeta.append(texto('p', medicion, 'medicion'));
  }

  const explicacion = explicacionDe(salto, actor);
  if (explicacion) tarjeta.append(texto('p', explicacion, 'explicacion'));

  const cuerpos = document.createElement('div');
  cuerpos.className = 'cuerpos';
  cuerpos.append(panel('enviado', salto.enviado), panel('recibido', salto.recibido));
  // El dry-run con token interno trae el SQL que emitió la capa: se muestra
  // aparte, con saltos de línea de verdad y los $n señalados con su valor.
  if (typeof salto.recibido?.sql === 'string') {
    cuerpos.append(panelSql(salto.recibido.sql, salto.recibido.params));
  }
  tarjeta.append(cuerpos);

  return fila;
}

function explicacionDe(salto, actor) {
  if (salto.estado === 'ok') return null;
  if (actor === 'capa') {
    if (salto.estado === 'fallo') return `La capa no contestó: ${mensajeDeError(salto.recibido)}`;
    const error = salto.recibido ?? {};
    const partes = [error.code, error.member, error.suggestion].filter(Boolean);
    return `La capa rechazó: ${partes.join(' · ') || 'sin detalle'}`;
  }
  const escrito = comoJson(salto.recibido);
  if (escrito?.noPuedo) return `El agente no pudo: ${escrito.noPuedo}`;
  return 'El agente no pudo: lo que devolvió no es el JSON de una consulta.';
}

function mensajeDeError(recibido) {
  if (typeof recibido === 'string') return recibido;
  return recibido?.error ?? recibido?.message ?? 'sin detalle';
}

function medicionDe(meta) {
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

// Un panel por cuerpo. Lo de la capa es JSON y se indenta; lo del agente es
// texto tal cual viajó, y si ese texto resulta ser JSON se muestra indentado
// con lo crudo a un clic.
function panel(titulo, valor) {
  const caja = document.createElement('div');
  caja.className = 'cuerpo';
  caja.append(texto('span', titulo, 'etiqueta'));

  if (typeof valor !== 'string') {
    caja.append(texto('pre', JSON.stringify(valor, null, 2)));
    return caja;
  }
  const indentado = indentar(valor);
  caja.append(texto('pre', indentado ?? valor));
  if (indentado) {
    const detalles = document.createElement('details');
    const resumenCrudo = document.createElement('summary');
    resumenCrudo.textContent = 'crudo';
    detalles.append(resumenCrudo, texto('pre', valor));
    caja.append(detalles);
  }
  return caja;
}

// SQL con palabras clave y parámetros marcados. Se arma con nodos y
// `textContent`, nunca con HTML: el texto viene de la capa.
const PALABRAS_SQL =
  /\b(WITH|SELECT|FROM|WHERE|AND|OR|NOT|AS|ON|JOIN|LEFT|INNER|GROUP BY|ORDER BY|LIMIT|FILTER|COUNT|AVG|SUM|NULLIF|CAST|DISTINCT|ASC|DESC|IN|NULL|TRUE|FALSE|DATE_TRUNC|IS)\b/g;

function panelSql(sql, params = []) {
  const caja = document.createElement('div');
  caja.className = 'cuerpo ancho';
  caja.append(texto('span', 'SQL emitido por la capa', 'etiqueta'));
  caja.append(
    texto(
      'p',
      'Se ve solo aquí: este dry-run usa el token interno para mostrarlo en la demo. ' +
        'El consumidor agente nunca lo recibe: su dry-run devuelve solo params y plan, y la ' +
        'consulta real devuelve filas. Los $n son parámetros, nunca texto interpolado.',
      'nota',
    ),
  );
  const pre = document.createElement('pre');
  pre.className = 'sql';
  const partes = sql.split(/(\$\d+)/);
  for (const parte of partes) {
    const parametro = /^\$(\d+)$/.exec(parte);
    if (parametro) {
      const nodo = texto('span', parte, 'param');
      const valor = params[Number(parametro[1]) - 1];
      if (valor !== undefined) nodo.title = `${parte} = ${JSON.stringify(valor)}`;
      pre.append(nodo);
      continue;
    }
    let ultimo = 0;
    for (const m of parte.matchAll(PALABRAS_SQL)) {
      if (m.index > ultimo) pre.append(document.createTextNode(parte.slice(ultimo, m.index)));
      pre.append(texto('span', m[0], 'kw'));
      ultimo = m.index + m[0].length;
    }
    if (ultimo < parte.length) pre.append(document.createTextNode(parte.slice(ultimo)));
  }
  caja.append(pre);
  if (params.length) {
    caja.append(texto('p', `parámetros: ${params.map((v, i) => `$${i + 1} = ${JSON.stringify(v)}`).join(' · ')}`, 'medicion'));
  }
  return caja;
}

function indentar(cadena) {
  const valor = comoJson(cadena);
  return valor === null ? null : JSON.stringify(valor, null, 2);
}

// La misma leniencia del mini back: se tolera la envoltura ``` y no la prosa.
function comoJson(cadena) {
  if (typeof cadena !== 'string') return null;
  const limpio = cadena
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const valor = JSON.parse(limpio);
    return valor !== null && typeof valor === 'object' ? valor : null;
  } catch {
    return null;
  }
}

// ---------- resumen ----------

function pintarResumen(totalMs) {
  const caja = document.createElement('div');
  caja.className = 'resumen';
  caja.append(dato('saltos', String(estado.saltos.length)));
  caja.append(dato('total', `${totalMs} ms`));

  const consulta = ultimaConsulta();
  const meta = consulta?.recibido?.meta;
  if (meta?.servedFrom) caja.append(dato('servedFrom', meta.servedFrom));
  if (meta?.queryId) caja.append(dato('queryId', meta.queryId));

  const comparacion = comparacionDelAgente();
  if (comparacion) {
    caja.append(
      texto(
        'span',
        `El agente escribió lo mismo que el JSON preparado: ${comparacion.igual ? 'sí' : 'no'}.`,
        'veredicto',
      ),
    );
  }
  resumen.replaceChildren(caja);
  if (comparacion) resumen.append(bloqueComparacion(comparacion));
}

// Con agente, los dos JSON quedan lado a lado: el veredicto dice si son el
// mismo, y esto deja ver en qué se separan.
function bloqueComparacion({ escrito, preparada }) {
  const caja = document.createElement('div');
  caja.className = 'panel comparacion';
  caja.append(texto('h2', 'El JSON preparado y el del agente', 'etiqueta'));
  const cuerpos = document.createElement('div');
  cuerpos.className = 'cuerpos';
  cuerpos.append(panel('preparado', preparada), panel('escrito por el agente', escrito));
  caja.append(cuerpos);
  return caja;
}

function dato(clave, valor) {
  const caja = document.createElement('span');
  caja.append(texto('span', clave, 'clave'), texto('span', valor));
  return caja;
}

function ultimaConsulta() {
  return [...estado.saltos]
    .reverse()
    .find((salto) => actorDe(salto.destino) === 'capa' && !salto.destino.includes('dry-run'));
}

// ¿El agente escribió lo mismo que el JSON preparado? Se compara canónicamente
// —claves ordenadas— contra la consulta preparada con los mismos marcadores
// sustituidos que hace el mini back.
function comparacionDelAgente() {
  if (!estado.peticion?.usarAgente) return null;
  const primero = estado.saltos[0];
  if (!primero || actorDe(primero.destino) !== 'agente') return null;
  const escrito = comoJson(primero.recibido);
  if (!escrito || escrito.noPuedo) return null;
  const pregunta = estado.preguntas.find((una) => una.id === estado.peticion.pregunta);
  if (!pregunta) return null;
  const preparada = prepararConsulta(pregunta, estado.peticion);
  return { escrito, preparada, igual: canonico(escrito) === canonico(preparada) };
}

// Réplica exacta de `src/preguntas.js`: departamento vacío no manda un filtro
// vacío, le saca el filtro a la consulta.
function prepararConsulta(pregunta, { desde, hasta, departamento }) {
  const consulta = sinFiltroVacio(pregunta.consulta, departamento);
  return sustituir(consulta, {
    ':desde': desde,
    ':hasta': hasta,
    ':departamento': departamento,
  });
}

function prepararTexto(texto, { desde, hasta, departamento }) {
  return texto
    .replaceAll(':desde', desde ?? '')
    .replaceAll(':hasta', hasta ?? '')
    .replaceAll(':departamento', departamento || 'todos los departamentos');
}

function sinFiltroVacio(consulta, departamento) {
  if (departamento) return consulta;
  if (!Array.isArray(consulta.filters)) return consulta;
  const filters = consulta.filters.filter(
    (filtro) => !(filtro.values ?? []).includes(':departamento'),
  );
  const { filters: _fuera, ...resto } = consulta;
  return filters.length > 0 ? { ...resto, filters } : resto;
}

function sustituir(valor, reemplazos) {
  if (typeof valor === 'string') return valor in reemplazos ? reemplazos[valor] : valor;
  if (Array.isArray(valor)) return valor.map((dentro) => sustituir(dentro, reemplazos));
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor).map(([clave, dentro]) => [clave, sustituir(dentro, reemplazos)]),
    );
  }
  return valor;
}

function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`;
  if (valor !== null && typeof valor === 'object') {
    const pares = Object.keys(valor)
      .sort()
      .map((clave) => `${JSON.stringify(clave)}:${canonico(valor[clave])}`);
    return `{${pares.join(',')}}`;
  }
  return JSON.stringify(valor) ?? 'null';
}

// ---------- utilidades ----------

function texto(etiqueta, contenido, clase = null) {
  const nodo = document.createElement(etiqueta);
  nodo.textContent = contenido;
  if (clase) nodo.className = clase;
  return nodo;
}

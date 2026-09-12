// El seam de la demo: dada la petición ya parseada y los colaboradores
// inyectados (agente, capa y reloj), devuelve el rastro de saltos. No sabe de
// HTTP ni de HTML: eso vive en los adaptadores. Las palabras que se cruzan con
// el agente están en `protocolo.js`.
import { consumidorPorId, CONSUMIDORES } from './consumidores.js';
import { preguntas, preguntasRaras, preguntaPorId, prepararConsulta } from './preguntas.js';
import { comoJson, promptDeCorreccion, promptDeRedaccion, promptDelClic } from './protocolo.js';

const RUTA_CONSULTA = '/analytics/query';
const RUTA_DRY_RUN = '/analytics/query?dryRun=true';

// Los nombres de los tres saltos a la capa. El dry-run es el único con token
// interno —es el único que puede ver el SQL—; los otros dos van con el token de
// clase `agente`, que es el que la demo quiere mostrar trabajando. Cuál par de
// tokens se usa lo decide `peticion.token`: ahí va el nombre del token de clase
// agente, y con él sale también el interno de la MISMA empresa.
const DRY_RUN = 'dry-run (params, plan y SQL)';
const CONSULTA = 'consulta';
const CONSULTA_CORREGIDA = 'consulta (corregida)';
const REDACCION = 'agente — redacción';

export async function ejecutar(peticion, { agente, capa, reloj, alSalto = null }) {
  const pregunta = preguntaPorId(peticion.pregunta);
  if (!pregunta) {
    throw new Error(
      `No existe la pregunta preparada "${peticion.pregunta}". Preparadas: ${[
        ...preguntas,
        ...preguntasRaras,
      ]
        .map((preparada) => preparada.id)
        .join(', ')}.`,
    );
  }
  // Un caso raro no trae JSON preparado a propósito: lo que se mira es lo que
  // el agente decide escribir. Sin agente no hay nada que mandarle a la capa, y
  // eso es un error de la petición —no un rastro vacío— para que se lea el
  // motivo en vez de un 200 sin saltos.
  if (!pregunta.consulta && !peticion.usarAgente) {
    throw new Error(
      `La pregunta "${pregunta.id}" es un caso raro: existe sólo por el camino con agente y no ` +
        'trae consulta preparada. Marca "usar agente" para ejecutarla.',
    );
  }
  const consumidor = consumidorPorId(peticion.token);
  if (!consumidor) {
    throw new Error(
      `No existe el token de demo "${peticion.token}". Conocidos: ${CONSUMIDORES.map(
        (uno) => uno.id,
      ).join(', ')}.`,
    );
  }
  const aLaCapa = saltosALaCapa({ capa, reloj, consumidor });
  const rastro = [];
  const agregar = anotarEn(rastro, alSalto);

  // Con agente, el JSON que sigue al resto del rastro lo escribe él; sin
  // agente, sale del preparado. De ahí para abajo, el camino es el mismo. Los
  // casos raros no tienen preparado que sustituir: acá no hay nada que hacer y
  // el JSON llega en el salto siguiente.
  let consulta = pregunta.consulta ? prepararConsulta(pregunta, peticion) : null;
  if (peticion.usarAgente) {
    const primero = await saltoAlAgente(promptDelClic(pregunta, peticion), { agente, reloj });
    agregar(primero.salto);
    if (!primero.consulta) return rastro;
    consulta = primero.consulta;
  }

  agregar(await aLaCapa(consulta, DRY_RUN));
  const laConsulta = await aLaCapa(consulta, CONSULTA);
  agregar(laConsulta);

  // La redacción es opcional y va al final: lo mismo si la consulta salió a la
  // primera o si hizo falta corregirla. `redactarSobre` decide si corresponde.
  const redactarSobre = async (ultima) => {
    if (!peticion.redactar || !peticion.usarAgente) return;
    if (ultima.estado !== 'ok' || !Array.isArray(ultima.recibido?.rows)) return;
    agregar(
      await saltoDeRedaccion(
        promptDeRedaccion(promptDelClic(pregunta, peticion), ultima.recibido.rows, ultima.recibido.meta),
        { agente, reloj },
      ),
    );
  };

  // Un solo reintento, y solo con agente: la capa rechazó lo que él escribió,
  // así que se le devuelve el error con su sugerencia y se repite el salto 3.
  // Si eso también se rechaza, el rastro termina: nunca hay un tercer intento.
  if (!peticion.usarAgente || laConsulta.estado !== 'rechazo') {
    await redactarSobre(laConsulta);
    return rastro;
  }

  const correccion = await saltoAlAgente(
    promptDeCorreccion(laConsulta.recibido, { pregunta: promptDelClic(pregunta, peticion), consulta }),
    { agente, reloj },
    'agente — corrección',
  );
  agregar(correccion.salto);
  if (!correccion.consulta) return rastro;

  const corregida = await aLaCapa(correccion.consulta, CONSULTA_CORREGIDA);
  agregar(corregida);
  await redactarSobre(corregida);
  return rastro;
}

// El salto de redacción es el mismo agente y la misma sesión, pero lo que
// vuelve es texto para leer, no JSON para ejecutar: acá no se parsea nada. `ok`
// es "volvió texto"; vacío o fallo del adaptador es `fallo`, y ni así se corta
// el rastro — las filas ya están en el salto anterior (mismo criterio que el
// observador: la respuesta ya está, esto es un extra).
async function saltoDeRedaccion(enviado, { agente, reloj }) {
  const inicio = reloj();
  const salto = { destino: REDACCION, via: agente?.via ?? 'claude -p --resume', token: null, enviado };
  let respuesta;
  try {
    respuesta = await agente(enviado);
  } catch (error) {
    return { ...salto, recibido: String(error.message), ms: reloj() - inicio, estado: 'fallo' };
  }
  const { texto, ms, meta, fallo } = respuesta;
  const escrito = fallo ? '' : String(texto ?? '').trim();
  return {
    ...salto,
    recibido: fallo ? `(sin respuesta del agente: ${fallo})` : texto,
    ms: Number.isFinite(ms) ? ms : reloj() - inicio,
    ...(meta ? { meta } : {}),
    estado: escrito ? 'ok' : 'fallo',
  };
}

// Cada salto entra al rastro por acá, y por acá se avisa. El observador es
// opcional: la página lo usa para dibujar el salto apenas está listo —el rastro
// completo llega segundos después—, y los tests entran sin él.
function anotarEn(rastro, alSalto) {
  return function agregar(salto) {
    rastro.push(salto);
    if (!alSalto) return;
    // El `try` está por lo mismo que el del log de la capa: quien ejecuta no
    // sabe qué función le pasaron, y una consulta ya hecha no puede morir
    // porque el que miraba se cayó.
    try {
      alSalto(salto, rastro.length - 1);
    } catch {
      // nada falla por observar
    }
  };
}

// Los tres saltos a la capa son el mismo salto con otro nombre: qué se manda y
// cómo se llama en la página. La ruta y el token salen del nombre —sólo el
// dry-run es interno— y así no hay tres sitios donde equivocarse de token.
//
// Un salto siempre sale: la capa que rechaza es `rechazo` con su error en
// `recibido`, y la capa que ni contesta es `fallo` con el motivo. La demo no
// tira 500 ni se queda a medias — el rastro es el producto.
function saltosALaCapa({ capa, reloj, consumidor }) {
  return async function aLaCapa(consulta, sufijo) {
    const esDryRun = sufijo === DRY_RUN;
    const inicio = reloj();
    const salto = {
      destino: `capa semántica — ${sufijo}`,
      via: `POST ${esDryRun ? RUTA_DRY_RUN : RUTA_CONSULTA}`,
      token: esDryRun ? consumidor.interno : consumidor.agente,
      enviado: consulta,
    };
    try {
      const { status, json, ms } = await capa({
        ruta: esDryRun ? RUTA_DRY_RUN : RUTA_CONSULTA,
        token: salto.token,
        cuerpo: consulta,
      });
      return {
        ...salto,
        recibido: json,
        ms: Number.isFinite(ms) ? ms : reloj() - inicio,
        estado: estadoDelStatus(status),
      };
    } catch (error) {
      return { ...salto, recibido: { error: error.message }, ms: reloj() - inicio, estado: 'fallo' };
    }
  };
}

// El salto al agente devuelve el salto para el rastro y, si el texto era el
// JSON de una consulta, esa consulta. `noPuedo` y el texto que no parsea
// cortan el rastro: no hay consulta que mandarle a la capa.
async function saltoAlAgente(enviado, { agente, reloj }, destino = 'agente') {
  const inicio = reloj();
  const salto = { destino, via: agente?.via ?? 'claude -p --resume', token: null, enviado };
  let respuesta;
  try {
    respuesta = await agente(enviado);
  } catch (error) {
    return {
      salto: { ...salto, recibido: String(error.message), ms: reloj() - inicio, estado: 'fallo' },
      consulta: null,
    };
  }
  const { texto, ms, meta, fallo } = respuesta;
  const completo = {
    ...salto,
    recibido: fallo ? `(sin respuesta del agente: ${fallo})` : texto,
    ms: Number.isFinite(ms) ? ms : reloj() - inicio,
    ...(meta ? { meta } : {}),
  };
  const escrito = fallo ? null : comoJson(texto);
  if (!escrito) return { salto: { ...completo, estado: 'fallo' }, consulta: null };
  // `noPuedo` sale como `estado: rechazo`, igual que un 4xx de la capa, pero no
  // es lo mismo y la página lo deja ver: el `destino` del salto dice quién
  // rechazó. El del agente es "no sé traducir esto con este catálogo" y corta el
  // rastro sin tocar la capa; el de la capa es "este JSON está mal" y abre la
  // corrección. Un solo estado para los dos porque los dos son lo mismo para
  // quien mira: alguien dijo que no, y nadie se cayó.
  if (escrito.noPuedo) return { salto: { ...completo, estado: 'rechazo' }, consulta: null };
  return { salto: { ...completo, estado: 'ok' }, consulta: escrito };
}

// El rechazo (4xx) es el consumidor pidiendo mal: hay JSON que corregir. El
// 5xx es la capa que no está bien, y ahí no hay nada que el agente pueda
// arreglar — por eso cuenta como fallo, igual que no contestar.
function estadoDelStatus(status) {
  if (status >= 200 && status < 300) return 'ok';
  return status >= 400 && status < 500 ? 'rechazo' : 'fallo';
}

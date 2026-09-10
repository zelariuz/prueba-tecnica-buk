# Demo agente — el rastro de llamadas a la capa semántica

Una página que muestra **lo que viaja** cuando alguien le pregunta algo a la
capa: la consulta declarativa que sale, el plan y el SQL que devuelve el
dry-run interno, y las filas que devuelve la consulta real con el token de
clase `agente`. Cada salto con su token **por nombre** (nunca su valor), su
tiempo y su estado.

Dos caminos, la misma página:

- **Sin agente**: la pregunta preparada se sustituye con los filtros del
  formulario y va directo a la capa. Funciona sin Claude Code.
- **Con agente** (casilla "usar agente"): el JSON lo escribe una sesión
  nombrada de Claude Code que solo conoce el catálogo público. Si la capa
  rechaza lo que escribió, se le devuelve el error con su sugerencia y se
  reintenta una vez.

## Requisitos

- **La capa arriba en Docker**: desde la raíz del repo,
  `docker compose up -d --build`. La demo no importa nada de `src/`: habla con la
  capa solo por HTTP, igual que cualquier otro consumidor.
- **Node 24** (probado en v24.18.0). Sin dependencias: `node:http` y `fetch`
  nativo.
- Para el camino con agente: **Claude Code logueado** (probado en **2.1.266** y **2.1.267**)
  **con crédito del Agent SDK**, y el modelo **`claude-sonnet-5`** (configurable
  con `MODELO`). Si algo de eso falla, la demo arranca igual, la casilla queda
  apagada con el motivo a la vista y `agente=1` en la URL se ignora con una nota:
  **el camino sin agente es el respaldo y no necesita nada de Claude Code**.

## Dos comandos

```bash
cp demo-agente/.env.example demo-agente/.env   # ajusta si cambiaste puertos o tokens
cd demo-agente && npm start                    # http://localhost:3100/
```

Si la capa no responde, el arranque muere diciendo exactamente qué levantar.

## Elegir la empresa es elegir el token

Arriba del formulario hay un **selector de token del consumidor**, y no un
selector de empresa, porque en la capa la empresa **viaja en el token**: la
consulta nunca lleva `companyId` (si lo lleva, `FORBIDDEN_FIELD`). Se ofrecen
dos:

| Token | Empresa | Para qué |
| --- | --- | --- |
| `demo-agente-empresa-a` | Empresa A | El seed chico: seis empleados, números calculados a mano en `docker/init/02-seed.sql` y verificables contra la página |
| `demo-agente-empresa-c` | Empresa C | El seed de volumen: 1.750 empleados y **1.062.283 filas de asistencia**. Sirve para ver tiempos, caché, el tope de 1.000 filas de la clase `agente` y la advertencia de índice; **sus números no están calculados a mano** |

Elegir uno elige el par completo: el token de clase `agente` hace la consulta y
el token **interno de la misma empresa** hace el dry-run, que es el único que ve
el SQL. El chip de cada salto muestra el nombre del token usado —está publicado
en el `docker-compose.yml` del repo—; el **valor** que va en `Authorization`
sale del `.env` del mini back y nunca baja al navegador. El link de la página
lleva el token elegido (`?token=demo-agente-empresa-c&pregunta=…`), y un token
que el mini back no conoce se rechaza con 400.

Cada empresa trae sus **rangos precargados**: la A abre la asistencia en junio a
agosto de 2025 (los meses que tiene el seed chico) y todo lo demás en 2025
entero; la C abre todo en 2025 entero, asistencia incluida, porque tiene los dos
años completos. Las **fechas son opcionales** (ADR 0009): vaciarlas manda la
consulta sin `dateRange`, y las dos preguntas sobre `employees` —que no tiene
dimensión temporal— vienen ya con el rango vacío.

La **sesión del agente es una sola** para las dos: el catálogo público no depende
del consumidor (ADR 0008), así que cambiar de token cambia la empresa de los
datos, no lo que el agente sabe. La tarjeta "Antes de todo" lo dice cuando el
token elegido no es el de la empresa A.

## Qué muestra

Los saltos se numeran en la página según el rastro real: sin agente son dos
(el 2 y el 3 de esta lista), con agente son tres, o cinco si hubo corrección.

- **Salto 1 — al agente** — `claude -p --resume agente-buk`, solo con la casilla
  marcada. Enviado: el texto en lenguaje natural (el editado, si lo hay) más
  la frase fija `Filtros: desde …, hasta …[, departamento …]`. Recibido: el
  texto crudo, que debe ser solo el JSON de la consulta o
  `{"noPuedo": "motivo"}`. Debajo, el costo, los milisegundos de API, los
  tokens leídos de caché y el id de sesión.
- **Salto 2 — dry-run** — `POST /analytics/query?dryRun=true` con el token
  **interno de la empresa elegida** (`demo-interno-empresa-a` o
  `demo-interno-empresa-c`): `params`, `plan` y `sql`. El SQL solo lo recibe una
  sesión interna; el agente nunca lo ve.
- **Salto 3 — consulta** — `POST /analytics/query` con el token de clase
  **`agente` de la misma empresa**: `rows` y `meta` (`servedFrom`, `asOf`,
  `queryId`, `warnings`).
- **Salto 3b — corrección** (solo con agente, y solo una vez) — si la consulta se rechaza
  con 4xx, se le devuelven al agente `code`, `member` y `suggestion` y se
  repite **solo** la consulta: el dry-run ya mostró el plan y el SQL de lo que
  escribió primero. Un segundo rechazo termina el rastro; nunca hay un tercer
  intento. Si la corrección es `noPuedo`, termina ahí. Lo que sigue a la
  corrección es otro salto 3, marcado "consulta (corregida)".

Un `noPuedo` del agente deja el rastro en un solo salto y la capa no se toca.
Un texto que no es JSON queda como salto `fallo` con lo crudo a la vista: para
diagnosticar en vivo, no un 500. Un `claude` que no contesta antes de
`AGENTE_TIMEOUT_MS` se mata y también queda como `fallo`.

El front es **HTML, CSS y JavaScript puro** en `public/` —sin frameworks, sin
librerías y sin paso de build—; el mini back lo sirve como estático y, aparte,
publica estos endpoints:

| Endpoint | Qué devuelve |
| --- | --- |
| `GET /api/preguntas` | las 12 preparadas con su texto, sus filtros y su JSON |
| `GET /api/consumidores` | los tokens de demo elegibles: nombre, etiqueta y rangos precargados. Ningún valor de token — el mini back es el único que los conoce |
| `GET /api/sesion` | la sesión del agente y los dos prompts completos |
| `GET /api/rastro?…` | el rastro como **NDJSON en streaming** |
| `GET /api/telemetria?token=…` | los presupuestos y los contadores de la capa. El mini back se los pide a `GET /analytics/telemetry` con el token **interno** de la empresa de ese token; 400 si el token de demo no existe, 502 si la capa no contesta |

`/api/rastro` responde `application/x-ndjson` con `Transfer-Encoding: chunked` y
una línea por evento: `inicio` (la petición como la entendió el back y cuántos
saltos se prevén) sale en milisegundos, después un `salto` **apenas queda
listo** —el observador `alSalto` del seam es quien las escribe— y al final
`fin` con el total. Una pregunta que no existe sale como `error` y cierra; un
token de demo que no existe se rechaza antes, con 400. El
navegador lee esas líneas con `fetch` + `ReadableStream` y pinta cada salto
cuando llega, con una tarjeta "en curso…" para el que sigue: el salto al agente
tarda 3-6 s y antes dejaba la página sin nada que mostrar todo ese rato.

Cada combinación del formulario es una URL. Recargarla repite la consulta y
`meta.servedFrom` pasa de `live` a `cache-l1`.

Un rechazo de la capa no corta el rastro: el salto queda con estado `rechazo`
y el error (`code`, `member`, `suggestion`) tal cual en "recibido", y la
consulta se intenta igual para ver el mismo error por las dos clases de token.
`rechazo` es 4xx —el consumidor pidió mal, y por eso hay corrección posible—;
un 5xx es `fallo`: ahí no hay JSON que corregir.

## Presupuestos y telemetría de la capa

Al pie del rastro, un panel con lo que la capa dice de sí misma. Sale de
`GET /api/telemetria`, que el mini back le pide a `GET /analytics/telemetry`
con el token **interno** de la empresa elegida: la capa entrega esa ruta sólo a
una sesión interna y a un token de clase `agente` le responde 403.

- **Presupuesto por clase** — la tabla de `src/budgets.js` tal cual: timeout,
  filas máximas, rango obligatorio y TTL de caché de `dashboard`, `api` y
  `agent`. La fila de la clase del token elegido va resaltada con la franja del
  actor agente. La nota al pie explica el desajuste que se ve en el rastro: el
  dry-run del salto 2 va con la sesión interna (clase `api`), así que su
  `plan.budget` muestra 15 s / 10.000, mientras la consulta real del salto 3 va
  con la clase del token elegido.
- **Por consumidor** — total, ok, error, hit ratio de caché, hits por nivel,
  errores de caché y el tiempo de base (consultas, total y promedio); debajo,
  una fila por consumidor con ok, error, hits, misses y `clientGone`, y las
  listas cortas "por código de error" y "por puerta". El JSON completo queda a
  un clic, en `crudo`.

Se carga al abrir la página, se refresca al terminar cada rastro y con el botón
"Actualizar". **Sin refresco por temporizador**: un pedido de fondo mientras se
lee el rastro ensuciaría los contadores que ese mismo rastro acaba de producir.
El dry-run no cuenta en la telemetría (no responde a nadie ni toca la base), así
que la clase que aparece en `byConsumer` es la del token elegido y no la
interna.

## La sesión del agente

Al arrancar, la demo pide el catálogo y **asegura** la sesión: si no hay
ninguna guardada, o si el catálogo cambió, crea una nueva con
`claude -p -n agente-buk --session-id <uuid nuevo>` y el prompt de creación
(rol, catálogo público entero, reglas del vocabulario y contrato de salida).
El uuid, la versión del catálogo y su **huella** quedan en `.sesion.json`
(ignorado por git); no van al `.env`. La consola dice si la creó o la reutilizó
y por qué.

La decisión de recrear se toma con la **huella** —sha256 del catálogo público
entero, con las claves ordenadas— y no con `catalogo.version`: la versión de la
capa es el hash de las definiciones más el esquema físico, y registrar una
consulta tipo no la cambia. Como el prompt de creación lleva el catálogo entero,
guiarse por la versión dejaría al agente hablando de un catálogo que ya no es el
que la capa publica.

El enlace "lo que sabe esa sesión" abre un **modal** (`<dialog>` nativo, con
scroll) con el prompt de creación completo, el system prompt de la llamada, el
nombre, el modelo y la huella; todo sale de `GET /api/sesion`. La misma
información, como página aparte para copiar el link, está en
`GET /agente/sesion`. El README explica cómo
se lee un rechazo: un `{"noPuedo": …}` del agente sale como `estado: rechazo`,
igual que un 4xx de la capa, y el **destino** del salto dice de quién viene —el
del agente corta el rastro sin tocar la capa; el de la capa abre la corrección—;
y que si el agente envuelve el JSON en un bloque de código la demo se lo tolera
(leniencia deliberada), pero la prosa no. Es la página para decir "esto es todo
lo que el agente sabe".

Regla: **nunca abrir esa sesión de forma interactiva mientras el mini back la
usa**. Son el mismo uuid: dos clientes hablándole a la vez se pisan el hilo.

## Cómo se llama a Claude Code (y cuánto cuesta)

Cada llamada corre **sin herramientas y sin configuración**, con el prompt por
stdin:

```
claude -p --resume <uuid> --model claude-sonnet-5 --output-format json \
       --tools "" --setting-sources "" --system-prompt "<dos líneas>"
```

- `--tools ""` — el agente no tiene con qué explorar el disco ni ejecutar nada.
- `--setting-sources ""` — ignora los settings del usuario y del repo.
- `--system-prompt` — reemplaza el andamiaje de Claude Code por dos líneas. El
  rol de verdad se lo da el prompt de creación de la sesión, no el system
  prompt.

Medido el 09-09 con una llamada mínima a `claude-sonnet-5` (tokens de entrada
por llamada y costo):

| Flags | Entrada | Costo |
| --- | --- | --- |
| ninguno | 62.037 tokens | 0,178 USD |
| `--tools "" --setting-sources ""` | 9.201 tokens | 0,025 USD |
| … más `--system-prompt` | 515 tokens | 0,002 USD |

Con esos flags y la sesión ya creada, un clic real de la demo costó entre
**0,002 y 0,004 USD**, con 3.500-5.500 tokens leídos de caché y **3-6 s** en el
salto 1. La capa, en el mismo rastro, contesta en **milisegundos** (2-19 ms):
esa es la diferencia que la demo hace ver. El QA del 09-09 (`docs/qa.md`, 14
corridas) volvió a dar lo mismo: 3,2-6,2 s y 0,0025-0,0056 USD por llamada al
agente, 2-17 ms por llamada a la capa.

## Las 12 preguntas preparadas

Viven en `preguntas.json` (datos, no código). Primero las **3 del enunciado**,
con su texto literal y sin cambiarle una palabra; después las 3 del caso, las
otras 3 consultas tipo del catálogo, la trampa, la más simple de todas y la que
no lleva medidas:

| Pregunta | Qué demuestra |
| --- | --- |
| **Enunciado 1** · Score promedio por departamento (último año) | La pregunta literal. "Durante el último año" es un período, no un corte por tiempo: la `timeDimension` va con `dateRange` y **sin** `granularity`, así que sólo filtra y sale una fila por departamento (**ADR 0011**). En la demo el último año es 2025, el del seed |
| **Enunciado 2** · Empleados que completaron cada trimestre | La pregunta literal. "Cada trimestre" **sí** es un corte por tiempo: acá la granularidad va, y la medida `completed_employees` trae puesto su segmento |
| **Enunciado 3** · Tasa de asistencia por departamento (últimos tres meses) | La pregunta literal. El mismo rango sin granularidad del ADR 0011 sobre otra entidad y una medida derivada: una fila por departamento con su tasa. En la demo, los últimos tres meses son junio a agosto de 2025 |
| Evaluaciones por departamento y trimestre | El caso, con filtros y segmento |
| Completitud por departamento | Medida derivada (ratio) |
| Asistencia por departamento y mes | Otra entidad, otra dimensión temporal |
| Empleados que completaron por trimestre | La medida trae puesto su segmento |
| Conteo de evaluaciones por estado | La consulta tipo no lleva rango y la demo se lo agrega igual; desde el ADR 0009 se puede vaciar |
| Headcount por departamento | Una consulta sin tiempo: `employees` no publica dimensión temporal ni tiene camino de joins hacia una, así que no hay `timeDimensions` que poner. Hasta el 09-09 la clase `agente` la rechazaba con `MISSING_TIME_RANGE` y sólo respondía con un token de otra clase; desde el **ADR 0009** la ejecuta igual que las demás |
| Sueldo promedio por departamento | La trampa: `employees.salary_avg` no existe → `UNKNOWN_MEMBER` con sugerencia |
| Cuántos empleados hay, activos e inactivos | La más simple: sin dimensiones y sin tiempo, una sola fila. Es la pregunta que el rango obligatorio hacía irrespondible (ADR 0009) |
| Cuáles departamentos hay | Una consulta **sin medidas**: sólo una dimensión, y la capa devuelve sus valores distintos (`GROUP BY` sin agregados). Hasta el 09-09 era `INVALID_QUERY` y el agente no tenía JSON que escribir; desde el **ADR 0010** la ejecuta |

## Tests

```bash
cd demo-agente && npm test
```

Sin Postgres, sin Docker, sin Claude Code y sin variables de entorno. Entran
por los dos seams de comportamiento, con dobles inyectados:

- `ejecutar(peticion, { agente, capa, reloj, alSalto })` → el rastro de saltos.
  `alSalto(salto, indice)` es opcional y es lo que permite dibujar la página por
  trozos: se llama en el momento en que cada salto queda listo. Observar no
  cambia lo observado, y un observador que lanza no corta el rastro.
- `asegurarSesion({ claude, catalogo, estado })` → crear, conservar o recrear
  la sesión, y `promptDeCreacion(catalogo)` y `huellaDelCatalogo(catalogo)` como
  funciones puras.

El front estático, el `spawn` de `claude`, el adaptador `fetch` y el arranque no
tienen tests: son efectos, y se verifican mirando la página.

Lo que sí se verificó a mano, contra la capa real y Claude Code real, está en
**[`docs/qa.md`](docs/qa.md)**: las 7 preguntas de la primera vuelta por los dos caminos (y la segunda vuelta con agente, 8 preguntas, tras el ADR 0009), con las
filas, el reintento, la caché, los tiempos y el costo.

## Los archivos

```
index.js            arranque: configuración, catálogo, sesión y escucha
preguntas.json      las 12 preguntas preparadas (datos, no código)
src/ejecutar.js     el seam: petición → rastro de saltos
src/sesion.js       el seam: crear/conservar/recrear la sesión, prompt y huella
src/protocolo.js    las palabras que se cruzan con el agente: prompt del clic,
                    prompt de corrección y lectura del JSON que devuelve
src/preguntas.js    busca la preparada y sustituye :desde, :hasta, :departamento
src/consumidores.js los pares de tokens de demo (uno por empresa), sus etiquetas
                    y los rangos precargados; y el mapa nombre → valor del .env
src/agente.js       efectos de Claude Code: spawn, flags, .sesion.json, versión
src/capa.js         efectos de la capa: fetch, token por nombre, milisegundos
src/servidor.js     estáticos de public/ y los endpoints JSON; el rastro sale
                    como NDJSON, una línea por salto
public/index.html   la página: cabecera, formulario y la línea de tiempo
public/app.js       el front: consume el NDJSON y pinta cada salto al llegar
public/estilo.css   tokens de tema claro/oscuro, tarjetas, píldoras y raíles
public/sesion.html  /agente/sesion como página aparte (lo mismo que el modal)
```

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

## Qué muestra

Los saltos se numeran en la página según el rastro real: sin agente son dos
(el 2 y el 3 de esta lista), con agente son tres, o cinco si hubo corrección.

- **Salto 1 — al agente** — `claude -p --resume agente-buk`, solo con la casilla
  marcada. Enviado: el texto en lenguaje natural (el editado, si lo hay) más
  la frase fija `Filtros: desde …, hasta …[, departamento …]`. Recibido: el
  texto crudo, que debe ser solo el JSON de la consulta o
  `{"noPuedo": "motivo"}`. Debajo, el costo, los milisegundos de API, los
  tokens leídos de caché y el id de sesión.
- **Salto 2 — dry-run** — `POST /analytics/query?dryRun=true` con el token `interno`:
  `params`, `plan` y `sql`. El SQL solo lo recibe una sesión interna; el
  agente nunca lo ve.
- **Salto 3 — consulta** — `POST /analytics/query` con el token `agente`: `rows` y
  `meta` (`servedFrom`, `asOf`, `queryId`, `warnings`).
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

Cada combinación del formulario es una URL. Recargarla repite la consulta y
`meta.servedFrom` pasa de `live` a `cache-l1`.

Un rechazo de la capa no corta el rastro: el salto queda con estado `rechazo`
y el error (`code`, `member`, `suggestion`) tal cual en "recibido", y la
consulta se intenta igual para ver el mismo error por las dos clases de token.
`rechazo` es 4xx —el consumidor pidió mal, y por eso hay corrección posible—;
un 5xx es `fallo`: ahí no hay JSON que corregir.

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

`GET /agente/sesion` muestra el prompt de creación completo, el system prompt
de la llamada, el nombre, el uuid, la versión y la huella del catálogo, el
modelo, la versión de Claude Code y la fecha de creación. Además explica cómo
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

## Las 7 preguntas preparadas

Viven en `preguntas.json` (datos, no código). Las 3 del caso, las otras 3
consultas tipo del catálogo y la trampa:

| Pregunta | Qué demuestra |
| --- | --- |
| Evaluaciones por departamento y trimestre | El caso, con filtros y segmento |
| Completitud por departamento | Medida derivada (ratio) |
| Asistencia por departamento y mes | Otra entidad, otra dimensión temporal |
| Empleados que completaron por trimestre | La medida trae puesto su segmento |
| Conteo de evaluaciones por estado | La clase `agente` exige rango: la demo se lo agrega |
| Headcount por departamento | **No es ejecutable por la clase `agente`**: `employees` no publica dimensión temporal ni tiene camino de joins hacia una, así que no hay `timeDimensions` posible y la consulta termina en `MISSING_TIME_RANGE`. El dry-run interno sí pasa —el token interno no tiene rango obligatorio—, y por eso el rastro muestra el plan y el SQL de algo que la consulta real después rechaza. Con agente se ve entero: JSON correcto → rechazo → corrección → `noPuedo` ("la entidad employees no publica una dimensión temporal") |
| Sueldo promedio por departamento | La trampa: `employees.salary_avg` no existe → `UNKNOWN_MEMBER` con sugerencia |

## Tests

```bash
cd demo-agente && npm test
```

Sin Postgres, sin Docker, sin Claude Code y sin variables de entorno. Entran
por los dos seams de comportamiento, con dobles inyectados:

- `ejecutar(peticion, { agente, capa, reloj })` → el rastro de saltos.
- `asegurarSesion({ claude, catalogo, estado })` → crear, conservar o recrear
  la sesión, y `promptDeCreacion(catalogo)` y `huellaDelCatalogo(catalogo)` como
  funciones puras.

El HTML, el `spawn` de `claude`, el adaptador `fetch` y el arranque no tienen
tests: son efectos, y se verifican mirando la página.

Lo que sí se verificó a mano, contra la capa real y Claude Code real, está en
**[`docs/qa.md`](docs/qa.md)**: las 7 preguntas por los dos caminos, con las
filas, el reintento, la caché, los tiempos y el costo.

## Los archivos

```
index.js            arranque: configuración, catálogo, sesión y escucha
preguntas.json      las 7 preguntas preparadas (datos, no código)
src/ejecutar.js     el seam: petición → rastro de saltos
src/sesion.js       el seam: crear/conservar/recrear la sesión, prompt y huella
src/protocolo.js    las palabras que se cruzan con el agente: prompt del clic,
                    prompt de corrección y lectura del JSON que devuelve
src/preguntas.js    busca la preparada y sustituye :desde, :hasta, :departamento
src/agente.js       efectos de Claude Code: spawn, flags, .sesion.json, versión
src/capa.js         efectos de la capa: fetch, token por nombre, milisegundos
src/servidor.js     URL → petición, rastro → HTML
src/render.js       la página y /agente/sesion
```

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

> **Importante: el camino con agente usa el login activo de Claude Code de
> esta máquina.** No hay API key ni variable de entorno con credenciales: el
> mini back ejecuta el binario `claude` en modo no interactivo (`claude -p`),
> y ese proceso toma las credenciales que dejó el último `claude` / `/login`
> del usuario que corre la demo. Consecuencias: (1) cada clic se cobra al
> crédito del Agent SDK de **esa** cuenta (Pro o Max), no a la de quien mira
> la página; (2) si nadie inició sesión en esta máquina, o el login venció,
> la casilla "usar agente" aparece apagada con el motivo y la demo sigue por
> el camino sin agente; (3) para comprobarlo antes de una demo en vivo, en la
> misma terminal: `claude -p "responde ok"` debe contestar `ok`. Volver a
> iniciar sesión: `claude` y luego `/login`.

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

## Paso a paso desde cero

Para quien clona el repo y nunca vio esto. Cada paso deja algo verificable.

1. **La capa arriba.** Desde la raíz del repo:
   ```bash
   docker compose up -d --build
   curl -s -H 'Authorization: Bearer demo-agente-empresa-a' http://localhost:3000/analytics/catalog | head -c 200
   ```
   Debe devolver JSON con `"version"`. La primera vez el seed tarda ~10 s
   (la empresa C son 1 062 283 filas); `docker compose ps` muestra `db`,
   `redis` y `api` sanos.
2. **Node 24.** `node -v` debe decir `v24.x`; si no, la instalación está en el
   README de la raíz (sección Requisitos, `nvm install 24`). La demo no tiene
   dependencias: no hay `npm install` que correr aquí.
3. **Claude Code, sólo para el camino con agente.** Instalación oficial
   (macOS, Linux, WSL):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   claude --version     # debe imprimir un número seguido de "(Claude Code)"
   claude               # la primera vez pide iniciar sesión en el navegador
   ```
   Inicia sesión con una cuenta **Pro o Max** (el login queda guardado en la
   máquina y es el que la demo usa; ver el aviso de arriba) y activa una vez
   el crédito mensual del Agent SDK en la cuenta (es lo que cubre `claude -p`; sin él,
   las llamadas se detienen cuando se agota el crédito). Sal de la sesión
   interactiva con `/exit`: la demo va a usar `claude -p` por su cuenta.
   Si te saltas este paso, la demo arranca igual con la casilla del agente
   apagada y el motivo a la vista.
4. **Configuración.** Desde la raíz:
   ```bash
   cp demo-agente/.env.example demo-agente/.env
   ```
   Los valores por defecto calzan con el `docker-compose.yml` del repo
   (capa en `:3000`, tokens de demo de las empresas A y C, modelo
   `claude-sonnet-5`, puerto `3100`). Sólo hay que tocarlo si cambiaste
   puertos o tokens.
5. **Arrancar.**
   ```bash
   cd demo-agente && npm start
   ```
   El log dice tres cosas: que leyó el catálogo (versión y huella), qué pasó
   con la sesión del agente (`creada`, `reutilizada` o `creada (el catálogo
   cambió)`; crearla tarda unos 10 s y es una sola llamada a Claude Code), y
   que escucha en <http://localhost:3100/>. Si la capa no responde, muere
   diciendo qué levantar.
6. **Primer clic.** Abre <http://localhost:3100/>, deja el token
   `demo-agente-empresa-a`, elige "Enunciado 3 · Tasa de asistencia por
   departamento" y pulsa Ejecutar sin marcar "usar agente": dos saltos en
   milisegundos y las filas del seed (Ingeniería 92,59 y Ventas 91,55).
   Después marca "usar agente" y repite: aparece el salto 1 con lo que
   escribió Claude Code, 3 a 7 s. F5 sobre la misma URL muestra `cache-l1`.
7. **Reset.** Para empezar con la sesión del agente limpia (por ejemplo,
   antes de una demo en vivo): parar el mini back, borrar
   `demo-agente/.sesion.json` y volver a `npm start`. Si cambia el catálogo
   (una definición nueva), no hace falta: el mini back lo detecta por la
   huella y crea la sesión solo.

Qué puede salir mal y qué significa: casilla del agente apagada = `claude`
no está en el PATH o no está logueado (el motivo está al lado); un salto al
agente en `fallo` con "timeout" = Claude Code tardó más de `AGENTE_TIMEOUT_MS`
(60 s); `502` en el panel de telemetría = la capa se cayó (`docker compose
ps`); `400` al ejecutar = token que el mini back no conoce (revisar `.env`).

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
(el 2 y el 3 de esta lista), con agente son tres, cuatro si además redacta, y
cinco si hubo corrección.

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
  `queryId`, `warnings`, y `total` si se pidió). Si la consulta comparaba
  períodos con `compareDateRange` (**ADR 0015**), la respuesta **cambia de
  forma**: no es `{ rows, meta }` sino `{ results: [...] }`, un elemento por
  rango. La página dibuja los N, cada uno rotulado con su rango ya resuelto y
  con la frase que lo pidió si la hubo (`«last month»`), y con su propio
  `servedFrom`, su `queryId` y sus avisos —cada rango es una consulta de
  verdad, con su caché y su instante—. En el dry-run cada rango trae además
  **su** SQL, que es la mitad de la gracia: son N sentencias, no un `UNION
  ALL`. La forma la decide la respuesta, así que se dibuja igual venga del
  agente o del JSON preparado.
- **Salto 3b — corrección** (solo con agente, y solo una vez) — si la consulta se rechaza
  con 4xx, se le devuelven al agente `code`, `member` y `suggestion` y se
  repite **solo** la consulta: el dry-run ya mostró el plan y el SQL de lo que
  escribió primero. Un segundo rechazo termina el rastro; nunca hay un tercer
  intento. Si la corrección es `noPuedo`, termina ahí. Lo que sigue a la
  corrección es otro salto 3, marcado "consulta (corregida)".
- **Salto 4 — redacción** (opcional, casilla "Redactar la respuesta", solo con
  agente) — el mismo agente, la misma sesión bifurcada, un segundo momento:
  ahora recibe la pregunta original y las filas que devolvió la capa y escribe
  **una o dos frases** en texto plano. Enviado: el prompt de
  `promptDeRedaccion` —la pregunta tal cual viajó en el salto 1, las filas como
  JSON (tope **50 filas**; si había más, el prompt dice "se muestran 50 de N"),
  `servedFrom` y `asOf`, y el contrato: español, texto plano, los números de las
  filas tal cual (sin redondear a más de dos decimales), sin inventar ningún
  número ni categoría, sin nombrar SQL ni JSON, sin markdown, y si las filas
  están vacías decirlo—. Recibido: el texto crudo; `ejecutar` **no** lo parsea.
  La frase aparece arriba del resumen como "Respuesta del agente: …".
  Al modelo llegan **sólo el catálogo público y filas agregadas por empresa**:
  la capa no publica filas crudas ni columnas personales, y el prompt lo dice.
  Cuesta ~0,003 USD y 3-5 s, y **nunca corta el rastro**: si el agente falla o
  devuelve vacío, el salto queda en `fallo` y las filas siguen ahí — la
  respuesta ya estaba, redactarla es un extra. Sólo hay redacción si el último
  salto de consulta terminó `ok` con `rows`: un rechazo, un `noPuedo` o un fallo
  no dejan nada que redactar, y **una comparación de períodos tampoco**: la
  redacción se hace sobre `rows` y ahí no hay uno solo, hay uno por rango. En
  la petición es `redactar` (POST) o `redactar=1` (GET), y sólo tiene efecto
  junto a `usarAgente`.

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

La huella del catálogo no alcanza sola, y por eso la identidad de la sesión
son **dos** huellas: la del catálogo y la del **prompt de creación entero**
(`huellaDelPrompt`, también en `.sesion.json` y en el log de arranque). El
prompt lleva el catálogo, pero lleva además las reglas que el catálogo **no**
publica —el rango opcional, la consulta sin medidas, el relleno de series, el
total de filas, el vocabulario de rangos relativos, la comparación de
períodos—, y ésas cambian editando `src/sesion.js`, sin que la capa publique
nada nuevo. Sin esa segunda huella, agregar una regla dejaba viva la sesión
guardada y el agente **nunca la veía**: seguía escribiendo el JSON de ayer, y
el único síntoma era que no usaba lo nuevo. La consola lo dice al arrancar —
`(las reglas del prompt cambiaron)`—, y una sesión guardada por una demo
anterior a esta huella se recrea por no poder saber con qué texto nació.

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

## Las 16 preguntas preparadas

Viven en `preguntas.json` (datos, no código). Primero las **3 del enunciado**,
con su texto literal y sin cambiarle una palabra; después las 3 del caso, las
otras 3 consultas tipo del catálogo, la trampa, la más simple de todas, la que
no lleva medidas, y al final las **4 de lo último que aprendió la capa**
(ADR 0012 a 0015):

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
| **Serie densa** · Asistencia día a día, sin saltarse los días vacíos | `fillMissing: true` dentro de la dimensión temporal (**ADR 0012**): todos los buckets del rango, también los que no tienen filas. Exige `granularity` y `dateRange`. Con el rango precargado de la empresa A —la semana del ADR, del 8 al 14 de agosto de 2025— y el departamento `Ventas`, la serie pasa de 3 días a 7, y los 4 que se agregan vienen con la tasa en `null`: el promedio de cero valores no existe (un `count` sí vendría en 0) |
| **Rango relativo** · Score promedio por departamento del último año | La pregunta 1 del enunciado con el período escrito como **frase** en vez de con dos fechas (**ADR 0014**): `dateRange: "last year"`, una de las quince formas del vocabulario cerrado, que la capa resuelve al año calendario anterior **completo** antes de que la consulta tenga identidad. Los campos de fecha van vacíos a propósito. En 2026 «last year» es 2025, el año del seed, y da lo mismo que la pregunta 1; en 2027 vendrá vacía, que es justo lo que significa un rango relativo |
| **Comparación** · La asistencia de agosto contra la de julio | `compareDateRange` **en lugar de** `dateRange` (**ADR 0015**): la lista de rangos a comparar, tope cuatro. La respuesta llega como `{ results: [...] }` y la página dibuja los dos, cada uno con su rango, su `servedFrom` y su `queryId` — la segunda vuelta muestra los dos en `cache-l1`. Los meses van con fechas y no con frases porque el seed vive en 2025: «this month» contra «last month» caería en 2026 y devolvería dos ventanas vacías |
| **Total de filas** · Las primeras 20 de la asistencia por día y departamento | `total: true` (**ADR 0013**): las filas que tendría el resultado ignorando el límite, para paginar — **no** es el gran total de una medida. Con junio a agosto de 2025 en la empresa A devuelve 20 filas y `meta.total: 152`, y de yapa la advertencia de truncado del mismo ADR: el resultado llegó al tope y desde las filas no había forma de notarlo |

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
  la sesión, y `promptDeCreacion(catalogo)`, `huellaDelCatalogo(catalogo)` y
  `huellaDelPrompt(catalogo)` como funciones puras. El prompt se prueba por su
  **texto**: que diga las reglas que el catálogo no publica, las quince formas
  del vocabulario de rangos relativos una por una, y —lo que más importa— en
  qué casos NO va cada propiedad nueva.

El front estático, el `spawn` de `claude`, el adaptador `fetch` y el arranque no
tienen tests: son efectos, y se verifican mirando la página.

Lo que sí se verificó a mano, contra la capa real y Claude Code real, está en
**[`docs/qa.md`](docs/qa.md)**: las 7 preguntas de la primera vuelta por los dos caminos (y la segunda vuelta con agente, 8 preguntas, tras el ADR 0009), con las
filas, el reintento, la caché, los tiempos y el costo.

## Los archivos

```
index.js            arranque: configuración, catálogo, sesión y escucha
preguntas.json      las 16 preguntas preparadas (datos, no código)
src/ejecutar.js     el seam: petición → rastro de saltos
src/sesion.js       el seam: crear/conservar/recrear la sesión, prompt y huella
src/protocolo.js    las palabras que se cruzan con el agente: prompt del clic,
                    prompt de corrección, prompt de redacción y lectura del
                    JSON que devuelve
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

# CLAUDE.md — Capa Semántica de Analítica

Contexto para retomar el proyecto sin volver a explorarlo.

## Qué es

Capa semántica sobre PostgreSQL: los módulos declaran sus datos de forma
declarativa, un catálogo los registra y un engine traduce consultas con
vocabulario Cube a SQL con aislamiento por empresa. JavaScript puro, sin
TypeScript, Node 24, `node:test`, node-postgres.

## Documentos de referencia (leer antes de cambiar diseño)

- `CONTEXT.md` — glosario. Los nombres del código salen de aquí.
- `prds/prd-capa-semantica.md` — PRD: decisiones de implementación y de testing.
- `plans/plan-capa-semantica.md` — 8 fases verticales; los criterios de
  aceptación de cada fase son la definición de terminado.
- `docs/semantica-de-filtros.md` — filtros globales, propios de medida y la
  advertencia de la razón anulada.
- `docs/adr/` — decisiones arquitectónicas (0001 tres piezas, 0002 contexto de
  sesión separado, 0003 CTE por entidad con empresa, 0004 derivadas ratio,
  0005 segmentos sin SQL, 0006 medidas de una sola entidad, 0007 vocabulario
  Cube, 0008 catálogo en dos vistas, 0009 rango opcional para el agente,
  0010 consultas sin medida, 0011 rango sin granularidad).

## Estructura

```
src/
  definitions/reviews.js     evaluaciones: dimensiones, medidas, segmento y relación
  definitions/employees.js   empleados: puente hacia departamentos
  definitions/departments.js departamentos: dimensión name
  definitions/attendance.js  asistencia: dimensión temporal `date`, segmento
                             `present` y la derivada `attendance_rate`
  definitions/consultas-tipo.js  seis plantillas del caso con parámetros `:nombre`
  definitions/index.js       composición: qué módulos y qué consultas tipo
                             existen, y `registrarModulos(catalog, snapshot)`
  dialect/postgres.js        el motor, entero: sintaxis (dateTrunc,
                             agregadoFiltrado, aNumerico, tablaFisica,
                             sentenciasDeSesion y capacidades), introspección del
                             esquema, mapa de tipos físicos → semánticos y
                             traducción de errores nativos
  dialect/sqlite.js          el segundo motor, con las mismas cuatro
                             responsabilidades sobre `node:sqlite`: dateTrunc con
                             strftime/printf, introspección por PRAGMA, tipos por
                             afinidad y errores por texto. Declara lo que no
                             puede prometer (tiposGarantizados: false,
                             timeoutDeSentencia: false)
  dialect/sqlite-pool.js     adaptador de DatabaseSync al contrato mínimo de pool
                             (connect → { query, release }); traduce los
                             parámetros posicionales $n a los nombrados de SQLite
  budgets.js                 presupuesto por clase de consumidor (timeout, filas,
                             rango y TTL de caché)
  cache/store.js             interfaz CacheStore (get/set/delete async) y
                             MemoryStore: L1 acotada, LRU, TTL por entrada y
                             reloj inyectable
  cache/redis-store.js       RedisStore: la L2 sobre node-redis, prefijo de
                             llave, TTL con PX, timeout de 200 ms, listener de
                             error y reconexión con tope
  cache/tiered.js            TieredStore: compone L1 y L2 detrás de la misma
                             interfaz; marca de qué nivel salió la entrada y se
                             traga los fallos de la L2
  cache/index.js             cómo arma su caché un proceso según REDIS_URL
                             (L1+L2, o sólo L1 con aviso)
  catalog.js                 registro y validación de definiciones (forma,
                             esquema físico y tipos), fuente por entidad,
                             resolución de miembros, vistas pública e interna,
                             versión y consultas tipo
  suggest.js                 distancia de edición y sugerencia del nombre más parecido
  vocabulary.js              operadores por tipo de dimensión y granularidades
  planner.js                 el planificador: pipeline de puertas (validar, resolver
                             miembros, filtros, joins, agregación y derivadas,
                             emitir SQL, describir el plan lógico). Única pieza
                             que escribe SQL
  engine.js                  plan() y run(): dry-run y ejecución transaccional con
                             SET LOCAL statement_timeout, más las puertas
                             buscarEnCache y guardarEnCache
  errors.js                  SemanticError { code, member, suggestion }
  telemetry.js               contadores en memoria por resultado, código, puerta,
                             consumidor, hits/misses de caché (hits por nivel),
                             fallos de caché por nivel y tiempo de base;
                             inyectable y reiniciable
  canonical.js               serialización canónica compartida (versión del
                             catálogo y queryId)
  http/server.js             las tres rutas con node:http (query, catalog y la
                             telemetría interna); token → ctx, techo de
                             64 KiB al cuerpo y delega
  http/codigos.js            mapa código de error → código HTTP (incluidos 403 y
                             413) y cabeceras por código (Retry-After del 503)
  http/tokens.js             tabla de tokens de demo desde DEMO_TOKENS
  server.js                  bin del servicio `api`: introspecta, registra con
                             snapshot y escucha
  demo.js                    `npm run demo`: catálogo, tres preguntas, telemetría
test/
  plan.test.js               seam engine.plan — sin base
  run.test.js                seam engine.run — contra Postgres, se salta sin DATABASE_URL
  catalog.test.js            seams catalog.register y catalog.describe — sin base
                             salvo el único test del introspector
  http.test.js               prueba de humo HTTP contra un servidor en puerto
                             efímero, contra Postgres
  telemetry.test.js          contadores por el seam engine.run
  cache.test.js              caché L1 por el seam engine.run (contra Postgres) y
                             el dry-run sin caché por engine.plan (sin base)
  cache-l2.test.js           los dos niveles por engine.run con dos MemoryStore:
                             cache-l2, relleno de L1, hits por nivel y las dos
                             redes de seguridad (contra Postgres)
  redis.test.js              caché L2 contra Redis de verdad: dos instancias,
                             llaves con empresa por SCAN y Redis inalcanzable;
                             se salta sin REDIS_URL
  sqlite.test.js             la segunda fuente por los seams engine.run,
                             engine.plan y catalog.register; base en memoria, sin
                             variables de entorno
  snapshots/caso-obligatorio.sql  SQL esperado del caso, comparado por igualdad
  snapshots/caso-obligatorio-sqlite.sql  el mismo caso, emitido por el dialecto
                             SQLite: mismas CTE, mismos $n, otra sintaxis
  snapshots/completion-rate.sql   SQL esperado de la derivada, con su etapa agregada
  snapshots/valores-de-dimension.sql  SQL esperado de la consulta sin medidas:
                             GROUP BY sin agregados (ADR 0010)
  snapshots/rango-sin-granularidad.sql  SQL esperado del rango que sólo filtra:
                             el dateRange en la CTE y sin la fecha en el
                             SELECT ni en el GROUP BY (ADR 0011)
  fixtures/snapshot.json     foto del esquema generada desde la base del caso
  fixtures/caso-sqlite.sql   el mismo esquema y las mismas 16 evaluaciones,
                             escritos para SQLite
docker/init/
  01-schema.sql            DDL del caso, copiado sin cambios
  02-seed.sql              seed determinista + conteos esperados en el encabezado
  03-seed-empresa-c.sql    empresa C: 1,06 M de filas de asistencia, para volumen
docs/
  adr/                     decisiones arquitectónicas numeradas
  semantica-de-filtros.md  qué filtra a qué y cuándo una razón queda en 100
docker-compose.yml         db (Postgres 16, host 5433), redis (host 6380) y api
                           (host 3000, espera a que db y redis estén sanos)
Dockerfile                 imagen del servicio api (node:24-alpine, USER node)
demo-agente/               demo web del rastro de llamadas: paquete aparte, con su
                           package.json, su README y sus tests. NO importa nada de
                           `src/`; habla con la capa solo por HTTP (:3000). Dos
                           caminos: pregunta preparada directa, o el mismo camino
                           con el JSON escrito por una sesión de Claude Code que
                           sólo conoce el catálogo público.
  index.js                 arranque: catálogo, sesión y escucha en :3100
  src/ejecutar.js          seam 1: petición → rastro de saltos
  src/sesion.js            seam 2: crear/conservar/recrear la sesión, prompt de
                           creación y huella del catálogo
  src/protocolo.js         las palabras del agente: prompt del clic, prompt de
                           corrección y lectura del JSON que devuelve
  src/servidor.js          estáticos de public/ y los endpoints JSON (incluida
                           la telemetría de la capa); el rastro sale como
                           NDJSON, una línea por salto
  public/                  el front estático: index.html, app.js, estilo.css y
                           sesion.html (sin frameworks, sin build)
  docs/qa.md               QA del 09-09: las 7 preguntas × 2 caminos, de verdad
```

**Comandos de la demo** (con la capa arriba):
`cp demo-agente/.env.example demo-agente/.env` y
`cd demo-agente && npm start` → <http://localhost:3100/>.
**Sus tests corren aparte**: `cd demo-agente && npm test` (sin Postgres, sin
Docker, sin Claude Code y sin variables). El `npm test` de la raíz **no** los
corre: sólo mira `test/`.

## Comandos

```bash
npm install
docker compose up -d db                       # base con esquema y seed
docker compose up -d --build                  # todo: db, redis y api (host 3000)
# `npm test` sin variables corre y queda verde: los tests de base se saltan sin
# DATABASE_URL y los de Redis sin REDIS_URL.
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica \
  REDIS_URL=redis://localhost:6380 npm test
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica \
  REDIS_URL=redis://localhost:6380 npm run demo   # la segunda instancia da cache-l2

# Re-aplicar esquema y seed. `--renew-anon-volumes` NO sobra: la imagen
# postgres declara un VOLUME anónimo que sobrevive a recrear el contenedor,
# así que sin esa opción el contenedor es nuevo y los datos son los viejos.
docker compose up -d --force-recreate --renew-anon-volumes db

curl -s -H 'Authorization: Bearer demo-dashboard-empresa-a' \
  http://localhost:3000/analytics/catalog
```

## Convenciones

- Rama de trabajo `desarrollo`; commits `[<parte>] descripción` en español, uno
  al cierre de cada fase con los tests en verde.
- TDD estricto: un test de comportamiento por vez, red → green → refactor.
  Los tests entran solo por los seams acordados en el PRD: `engine.run`,
  `engine.plan`, `catalog.register` y `catalog.describe`. Cuando un test pasa en
  verde apenas escrito (porque fija un criterio sobre comportamiento que ya
  existía), se comprueba que muerde mutando el código y viéndolo fallar.
- Los valores esperados de los tests son literales del seed, nunca recalculados
  desde los datos.
- Ninguna definición acepta SQL; el aislamiento por empresa se expresa siempre
  como `company_id = $1` dentro de la CTE de la entidad.
- Repo público: sin datos personales ni nombres reales en seeds ni ejemplos.

## Decisiones de la fase 2

- El camino de joins sale de un BFS sobre relaciones `many_to_one` desde la
  entidad de hechos; el consumidor nunca nombra una relación.
- La entidad de hechos se deduce de la primera medida (`medidas[0].entidad`):
  de ella salen el `FROM`, la fuente y el dialecto.
  **Ampliado el 09-09 (ver ADR 0010):** una consulta sin medidas la toma de su
  primera dimensión, o de su primera dimensión temporal si no pide dimensiones.
  Para una consulta con medidas no cambió nada: los tres snapshots de SQL siguen
  iguales.
- El rango de `timeDimensions` es cerrado en ambos extremos (`>= $2 AND <= $3`,
  como el `dateRange` de Cube) y vive dentro de la CTE de la entidad temporal.
- Los valores literales de la consulta (rango, valores de segmento, `limit`)
  viajan como parámetros: dos consultas con la misma forma generan el mismo SQL.
- La dimensión temporal vuelve como texto ISO `YYYY-MM-DD`, no como `Date`:
  node-postgres convierte `DATE` a un `Date` corrido a la zona del proceso.
- El snapshot del SQL es un archivo `.sql` legible del repo comparado por
  igualdad; si el SQL cambia a propósito, se edita ese archivo.

## Decisiones de la fase 3

- El presupuesto lo fija la clase de consumidor del contexto de sesión, nunca la
  consulta: `dashboard` 5 s y 5000 filas, `api` 15 s y 10000, `agent` 10 s, 1000
  y rango temporal obligatorio. Clase desconocida o ausente → `INVALID_CONSUMER`
  (código nuevo, no estaba en el PRD): sin clase no hay presupuesto y sin
  presupuesto no se ejecuta.
  **Cambiado el 09-09: el rango dejó de ser obligatorio para `agent` (ver ADR
  0009).** El mecanismo `rangoObligatorio` y `MISSING_TIME_RANGE` siguen en el
  código para cualquier clase inyectada por `createEngine({ presupuestos })`.
- Ninguna consulta sale sin `LIMIT`: el límite efectivo es el menor entre el
  pedido y el máximo de la clase; sin `limit` pedido manda el máximo. Por eso
  todos los planes llevan un parámetro más que en la fase 2.
- La llave de `order` solo puede ser un miembro que la consulta devuelve
  (`UNKNOWN_MEMBER` si no): termina como identificador entre comillas en el SQL.
- Ejecución: cliente del pool, `BEGIN`, `SET LOCAL statement_timeout`, consulta,
  `COMMIT`; `ROLLBACK` ante error y `release()` en el `finally`. `SET LOCAL`
  fuera de una transacción se ignora y dentro se deshace al cerrarla: la
  conexión vuelve al pool sin el estado de la petición. El valor se interpola
  (SET no acepta parámetros) y por eso se valida como entero del presupuesto.
- Postgres corta con `57014` (query_canceled); el engine lo traduce a
  `QUERY_TIMEOUT` (código nuevo, no estaba en el PRD) con sugerencia de qué
  reducir.
- `createEngine` acepta `presupuestos` inyectados: es la costura que permite
  probar un presupuesto extremo sin tocar la tabla real. El timeout no se puede
  forzar bajando el presupuesto a 1 ms (medido: la consulta del caso termina
  antes en 48 de 50 corridas), así que el test de timeout usa un doble delgado
  del pool que cambia el texto de la consulta principal por `pg_sleep`: sin SQL
  en las definiciones y sin tocar el seed.

## Decisiones de la fase 4

- `register(def, snapshot)` valida en dos pasos: forma (tabla, clave, columna de
  empresa, `description` obligatoria en entidad, dimensiones, medidas, segmentos
  y relaciones) y esquema físico (cada tabla y cada columna nombrada existe en
  el snapshot). Todo fallo es `INVALID_DEFINITION` con `member` y `suggestion`
  por distancia de edición. El snapshot es **opcional**: sin él se valida la
  forma pero no el esquema, que es lo que permite registrar sin base.
- `introspect(pool)` es la única parte del catálogo que toca la base. Lee
  `information_schema.columns` (solo `BASE TABLE`) y `pg_indexes` del esquema
  `public`; las columnas de un índice salen de parsear su `indexdef` —un índice
  sobre expresión queda registrado con el texto de la expresión y simplemente no
  coincide con ninguna columna, que es la respuesta conservadora.
- La foto fija `test/fixtures/snapshot.json` se generó con el introspector desde
  la base del caso; un test contra Docker comprueba que sigue siendo igual, y
  todos los demás tests del catálogo la inyectan y corren sin Postgres.
- `describe(ctx)` devuelve la vista pública (ADR 0008): entidades con
  descripción, dimensiones con tipo y operadores válidos, medidas, segmentos,
  granularidades, entidades relacionadas **por nombre** y consultas tipo, y
  nunca otra cosa: un contexto con `internal: true` recibe exactamente la misma
  vista. El mapeo físico sale por `describeInternal()`, un método sin contexto
  de consumidor —una vista que dependiera de un campo del contexto sería una
  vista que el consumidor puede pedirse solo. El test de fuga toma tablas y
  columnas del snapshot, descarta las que coinciden con un nombre semántico y
  exige que ninguna otra aparezca en la vista pública serializada.
- La versión del catálogo es sha256 de la serialización canónica (claves
  ordenadas) de definiciones más snapshot, truncado a 16 caracteres. Registrar
  una consulta tipo no la cambia: no altera el contrato de datos.
- El engine ya no lee las definiciones: le pide al catálogo `dimension`,
  `measure` y `segment`, y el catálogo corta con `UNKNOWN_MEMBER` más la
  sugerencia. Si el miembro existe pero es de otra clase, el mensaje lo dice.
- Tabla de operadores por tipo en `vocabulary.js`, una sola copia para el
  catálogo (que la publica) y el engine (que la aplica): `string` equals,
  notEquals, in, notIn, contains; `number` equals, gt, gte, lt, lte, between;
  `date` inDateRange, beforeDate, afterDate; `boolean` equals. Emitidos en SQL
  esta fase: `equals`, `notEquals`, `in`. Operador fuera del tipo →
  `INVALID_OPERATOR`; operador del tipo aún sin SQL → `UNSUPPORTED_OPERATOR`
  (rechazar es mejor que aplicar un filtro a medias en silencio). **La vista
  pública publica sólo los emitidos** (`operadoresEmitidos`, corrección 08-09):
  publicar un operador que el planificador rechaza deja a un agente fallando en
  bucle contra algo que leyó en el catálogo.
- `filters` y `segments` de la consulta se aplican dentro de la CTE de la
  entidad de su dimensión, junto al filtro de empresa, y esa entidad entra al
  camino de joins aunque no se pida como dimensión.
- Consultas tipo: `registerQuery({ name, description, query, params })` guarda
  una plantilla declarativa donde un parámetro se escribe `:nombre`;
  `query(name, params)` la devuelve con los valores puestos sin mutar la
  plantilla. Nombre inexistente → `UNKNOWN_QUERY` con sugerencia; parámetro
  declarado que falta → `MISSING_PARAM`.
- Códigos de error que estrenó esta fase (la lista completa está en
  `CONTEXT.md`, "Error estructurado"):
  - `INVALID_DEFINITION`: la definición no cumple la forma o nombra una tabla o
    columna que el esquema físico no tiene.
  - `UNSUPPORTED_OPERATOR`: operador válido para el tipo de la dimensión que el
    planificador todavía no emite en SQL.
  - `UNKNOWN_QUERY`: no existe una consulta tipo con ese nombre.
  - `MISSING_PARAM`: la consulta tipo declara un parámetro que la llamada no trae.

## Decisiones de la fase 5

- Una medida derivada se declara como una medida más, con tipo propio:
  `completion_rate: { type: 'ratio', numerator, denominator, scale, description }`.
  Así el consumidor la pide igual que cualquier otra y el catálogo la publica en
  la vista pública con su tipo; `numerator` y `denominator` son nombres de
  medidas de la misma entidad, nunca una expresión (ADR 0004).
- El SQL sale en dos etapas **solo si la consulta lleva derivadas**: la
  agregación pasa a ser una subconsulta y la fórmula se escribe afuera, sobre sus
  alias (`"reviews.completed_count"::numeric / NULLIF("reviews.count", 0) * 100`).
  La garantía "sobre agregados" queda estructural: la fórmula no puede ver una
  fila. Una consulta sin derivadas genera exactamente el SQL de antes, y por eso
  el snapshot del caso obligatorio no cambió.
- **Las medidas base que el consumidor no pidió no salen en las filas**: se
  calculan en la etapa agregada y se quedan ahí. La consulta devuelve lo que
  pidió.
- La escala se interpola en el SQL, así que el catálogo la valida como número
  finito; `scale` ausente significa fracción (sin multiplicar).
- El catálogo ordena las derivadas de cada entidad al registrar, con un recorrido
  en profundidad que de paso delata el ciclo (`INVALID_DEFINITION`), y expone el
  orden con `derivedOrder(entidad)`. El planificador lo recorre una vez: cuando
  le toca una razón, las que necesita ya están escritas. Una razón que se
  referencia a sí misma cae antes, al validar la forma.
- Semántica de filtros (`docs/semantica-de-filtros.md`): los filtros de la
  consulta y sus segmentos son globales y se aplican en la CTE; el filtro propio
  de una medida se suma dentro del `FILTER`. Cuando un filtro global repite lo
  que distingue al numerador de una razón, la razón vale 100 y la respuesta trae
  `meta.warnings` explicándolo. La comparación es por igualdad exacta del filtro:
  un equivalente escrito de otra forma no se detecta, y está documentado.
- `meta.warnings` viaja siempre, vacío cuando no hay nada que advertir.
- `plan(consulta, ctx)` devuelve `{ sql, params, plan }` sin abrir conexión: el
  plan lógico trae entidad de hechos, camino de joins, dimensiones, medidas
  pedidas, medidas base resueltas, derivadas, filtros globales, filtros por
  medida, presupuesto con el límite efectivo y advertencias. El test lo prueba
  con un pool que lanza si alguien lo toca.
- El planificador salió de `engine.js` a `src/planner.js` y quedó escrito como el
  pipeline de puertas del PRD: `validar → resolver miembros → filtros → joins →
  agregación y derivadas → emitir SQL → describir el plan`. El orden de las
  puertas es parte del contrato: los filtros aportan entidades al camino de
  joins, y los parámetros `$n` se numeran en el orden en que se piden.

## Decisiones de la fase 6

- La capa HTTP es `node:http` sin frameworks, con dos rutas (tres desde el
  09-09, con la telemetría interna) y un solo trabajo:
  traducir el token a `{ companyId, consumer }` y delegar (ADR 0002). No valida
  miembros, no arma SQL y no decide presupuestos; si aparece una regla de
  negocio ahí, está en el lugar equivocado.
- **Tokens de demo**: tabla en memoria `{ token → { companyId, consumer } }`
  cargada de `DEMO_TOKENS` (JSON). La autenticación está fuera de alcance; esto
  existe para poder ejercitar el contrato. Sin token conocido → `MISSING_TENANT`
  y 401. En producción se reemplaza `tokensDeDemo` y nada más cambia.
- **Mapa de códigos HTTP** en `src/http/codigos.js`: 401 para `MISSING_TENANT`;
  400 para los errores del consumidor (incluido `INVALID_JSON`, el único código
  que nace en la capa HTTP); **504 para `QUERY_TIMEOUT`** —el servicio está
  sano, lo que se agotó es el presupuesto de esa consulta, y 503 diría "vuelve
  más tarde", que no ayudaría—; 500 sin detalles para lo que no está en la
  tabla, con el error escrito en el log del servidor.
- **Dry-run por la URL** (`?dryRun=true`), no por el cuerpo: el cuerpo es la
  consulta declarativa y nada más, así que pedir un dry-run no cambia su forma
  ni, por lo tanto, su `queryId`.
- El servidor **introspecta al arrancar y registra siempre con snapshot**: si
  una definición nombra una tabla o columna que la base no tiene, `register`
  lanza y el proceso no llega a escuchar. Un servicio que arranca con un
  contrato roto es peor que uno que no arranca.
- **Telemetría** (`src/telemetry.js`) inyectada en el engine y expuesta con
  `engine.telemetry()`: total, por resultado, por código de error, por puerta
  que rechazó, por consumidor y tiempo de base (suma y cuenta, no histograma:
  con las dos sale el promedio y los percentiles son del exportador, que está
  fuera de alcance). El dry-run no cuenta: no responde a nadie ni toca la base.
  La puerta que rechazó se anota en el error como propiedad **no enumerable**,
  así que no cambia ninguna respuesta.
- El SQL que se ejecuta lleva `/* queryId consumer */` al inicio; el de `plan()`
  no. Así el dry-run muestra el SQL puro y los snapshots del repo no cambiaron.
- **`queryId`**: hash de la forma canónica de la consulta, más la empresa, más
  la versión del catálogo. La serialización canónica salió de `catalog.js` a
  `src/canonical.js` porque ahora la usan dos piezas que no se conocen.
- **Asistencia** se agregó como un archivo de definición más una línea en
  `src/definitions/index.js`: ni el engine ni el planificador cambiaron
  (historia 9). La columna del esquema es `present BOOLEAN`, así que la
  dimensión se llama `present` y el segmento filtra `present = true`; el nombre
  de negocio no inventa un estado de texto que la base no tiene.
- v1 **exigía granularidad** en una `timeDimension` —no había forma de acotar
  por fecha sin agrupar por ella—, y por eso la consulta tipo de asistencia
  agrupa por departamento **y mes**. **Vigente sólo hasta el ADR 0011
  (10-09)**: una `timeDimension` con `dateRange` y sin `granularity` ahora sólo
  filtra, que es lo que pide la pregunta literal del enunciado ("la tasa de
  asistencia por departamento durante los últimos tres meses" es una fila por
  departamento). La consulta tipo no cambió: sigue dando la tendencia mes a
  mes.
- El seed creció con un bloque de agosto de 2025 de conteos redondos
  (Ingeniería 16 presentes de 20 días → 80; Ventas 5 de 10 → 50; empresa 2, 3
  de 4 → 75). Junio y julio quedaron intactos: los literales anteriores siguen
  verdes.
- Los dos tests que recorren *todas* las consultas tipo ahora arman el catálogo
  con `registrarModulos`, la composición real. Antes registraban tres módulos a
  mano y agregar uno los dejaba desactualizados.

## Decisiones de la fase 7

- **`CacheStore`** (`src/cache/store.js`): `get(key)`, `set(key, value, ttlMs)`,
  `delete(key)`. Los tres **async** aunque `MemoryStore` no espere nada: la L2 en
  Redis es otra implementación de la misma interfaz, y si la interfaz fuera
  síncrona habría que cambiar el engine para que quepa. La forma la fija el más
  lento.
- **La llave ES el `queryId`**, no un valor derivado aparte. Tener un segundo
  hash sería tener dos definiciones de "la misma consulta" que pueden separarse
  sin que nadie lo note. (La llave se corrigió después de la fase 7: ver
  "Arreglos de revisión de la fase 7".)
- **Dos puertas nuevas en el engine**: `buscarEnCache` **después** de planificar
  (una consulta inválida se rechaza igual, esté o no guardada) y `guardarEnCache`
  después de ejecutar en vivo. Un resultado servido desde la caché no se vuelve a
  guardar: su TTL cuenta desde la ejecución real y una entrada muy pedida no se
  renueva sola para siempre.
- **`servedFrom`** vale `live` o `cache-l1`; en un hit, `asOf` es el instante de
  la ejecución original y `meta.warnings` son las de esa ejecución. `cache` es
  opcional en `createEngine`: sin caché, todo es `live`.
- **TTL por clase de consumidor**, en la tabla de presupuestos (`cacheTtlMs`):
  `dashboard` 60 s, `api` y `agent` 30 s. Cuánta antigüedad tolera quien pregunta
  es parte de lo que su clase puede gastar, igual que el timeout; no algo que la
  consulta pueda elegirse sola. Va ahí y no en una constante global por eso.
- **`MemoryStore` acotado** a `MAXIMO_DE_ENTRADAS` = 200 con desalojo **LRU**
  (leer una entrada la manda al final de la fila, sin correrle el vencimiento) y
  **expiración perezosa**: se borra al leerla vencida, no con un temporizador de
  fondo que mantendría vivo el proceso para borrar algo que a nadie le importa.
- **El reloj es inyectable** (`crearMemoryStore({ now })`): la expiración es
  comportamiento, y un comportamiento que sólo se observa esperando un minuto
  real no se puede probar.
- **Guarda una copia y entrega copias** (`structuredClone` en `set` y en `get`):
  el consumidor que ordena o recorta las filas que recibió no puede cambiarle la
  respuesta al siguiente. Es además lo que la L2 hace gratis al serializar, así
  que las dos implementaciones quedan con la misma semántica.
- **Telemetría**: `cache: { hits, misses, hitRatio }` y `cacheHits`/`cacheMisses`
  por consumidor. `registrarCache` se llama sólo si hay caché —sin caché no hay
  miss que reportar— y `registrarOk` sin `dbMs` marca la respuesta que no tocó la
  base: si contara 0 ms, el promedio de tiempo de base mentiría hacia abajo
  justo cuando la caché está funcionando.
- **El dry-run nunca toca la caché**, ni para leer ni para escribir: no ejecutó
  nada que guardar, y devolver el resultado de otra ejecución sería mentir sobre
  lo que muestra el plan.
- El servicio HTTP (`src/server.js`) y la demo arman su engine con
  `crearMemoryStore()`. La L1 vive en el proceso: cada instancia tiene la suya, y
  compartirla es trabajo de la L2 (fase 8), que entra por la misma costura.

## Decisiones de la fase A

- **El dialecto es la única pieza que conoce un motor**, con cuatro
  responsabilidades y ninguna fuera de él: (1) sintaxis SQL y capacidades,
  (2) introspección del esquema, (3) mapa de tipos físicos → semánticos,
  (4) traducción de errores nativos. Agregar un motor es agregar un archivo
  hermano de `dialect/postgres.js`; el catálogo, el planificador y el engine no
  nombran ninguno **salvo como valor por defecto inyectable**: `catalog.js` y
  `engine.js` importan `postgres` sólo para resolver la fuente por defecto
  cuando nadie pasa `fuentes`, y ese default se reemplaza por parámetro.
- **`src/introspect.js` desapareció**: la introspección es `postgres.introspect(pool)`.
  Cómo se descubre el esquema depende del motor (`information_schema` y
  `pg_indexes` son de Postgres); la *forma* del snapshot sigue siendo del
  catálogo, y no cambió: `test/fixtures/snapshot.json` es el mismo archivo.
- **`dialecto.tipoSemantico(tipoFísico)`** traduce el tipo de la columna al tipo
  del vocabulario (`number`, `string`, `date`, `boolean`). Al registrar **con
  snapshot**, el catálogo exige que el `type` de cada dimensión calce con el
  físico y que una medida `avg`/`sum` agregue una columna numérica; si no,
  `INVALID_DEFINITION` con `member` = `entidad.miembro` y una sugerencia que
  nombra los dos tipos. Sin snapshot no se valida, como antes. Un tipo físico
  que el dialecto no reconoce no se juzga: es la misma respuesta conservadora
  que da el catálogo cuando no hay foto del esquema.
- **`tiposGarantizados`** es una capacidad del dialecto, no una decisión del
  catálogo: Postgres declara y hace cumplir el tipo de cada columna, así que un
  desajuste es un hecho y corta el registro. Un motor de tipos laxos (SQLite)
  declarará `false` y ahí la misma incompatibilidad sale como **advertencia**
  de registro, con el formato de siempre (`{ member, warning }`): rechazar una
  sospecha sería negarse a hablar con el motor.
- **`SCHEMA_DRIFT`** (código nuevo): el dialecto traduce `42703`
  (undefined_column) y `42P01` (undefined_table) —el SQL nombra algo que la base
  ya no tiene— y sugiere volver a introspectar y re-registrar. Sale como **503**:
  es una dependencia rota, no una consulta mal escrita, y el consumidor no puede
  arreglarla cambiando lo que pidió. El `57014` del timeout se mudó también: el
  engine ya no contiene ningún código de error de Postgres.
- **Fuente por entidad**: una definición puede declarar `source`; ausente, es
  `postgres` —el nombre de la fuente por defecto es el `name` del dialecto por
  defecto, para no tener dos copias de esa palabra—. El catálogo la guarda
  normalizada, la publica sólo en `describeInternal()` (la vista pública no
  sabe en qué base viven los datos) y **rechaza al registrar una fuente que
  nadie configuró**: sin dialecto no hay ni tipos que validar ni motor contra
  el cual ejecutar.
- **`createCatalog({ fuentes })` y `createEngine({ fuentes })`** reciben el mapa
  nombre → `{ dialecto, pool }`. El catálogo sólo usa el dialecto (no ejecuta
  nada). Un `createEngine({ catalog, pool })` sin `fuentes` sigue siendo lo de
  antes: una sola fuente, la del dialecto por defecto.
- **El dialecto lo elige la entidad de hechos**: el planificador lo toma de la
  fuente de la entidad de la que salen las medidas, y el engine ejecuta contra
  el pool de esa misma fuente. Si la consulta alcanza una entidad de otra fuente
  —por una dimensión, por un filtro o por el camino de joins—, corta con
  `NO_JOIN_PATH` nombrando las dos fuentes: dos bases no se cruzan con un JOIN,
  y la federación es otra pieza con otro presupuesto.

## Decisiones de la fase B

Se agregó **SQLite** (`node:sqlite`, sin dependencias ni flags) como segunda
fuente. No es una fuente de producción: existe para responder una pregunta —¿el
seam del dialecto aguanta un motor de verdad distinto?— y para que lo que un
motor no puede prometer tenga dónde decirse. La respuesta es que **sí**: las
mismas definiciones (`reviews`, `employees`, `departments`, con una sola línea
distinta, `source: 'sqlite'`), el mismo catálogo, el mismo planificador y el
mismo engine devuelven contra SQLite **exactamente las mismas filas** del caso
obligatorio y la misma `completion_rate` (75) que contra Postgres.

### Lista de hallazgos: lo que estaba pegado a Postgres

Cuatro cosas que el planificador o el engine tenían escritas en dialecto
Postgres sin que se notara, porque no había con qué comparar. Cada una es ahora
una pregunta al dialecto, y ninguna cambió el SQL de Postgres (los dos snapshots
del repo siguen byte por byte iguales):

1. **`SET LOCAL statement_timeout` en el engine** (`src/engine.js`, en
   `ejecutar`). El engine nombraba una sentencia que sólo existe en Postgres.
   Ahora pide `dialecto.sentenciasDeSesion(presupuesto)` y emite lo que reciba;
   un dialecto que no ofrece el método no recibe nada. La validación del entero
   se fue con la sentencia, a `postgres.sentenciasDeSesion`.
2. **`::numeric` en la fórmula de una derivada** (`src/planner.js`,
   `resolverAgregacion`). Era el cast de Postgres escrito a mano en el
   planificador. Ahora es `dialect.aNumerico(expresion)`: `::numeric` allá,
   `CAST(... AS REAL)` acá. Sin esto, `completion_rate` contra SQLite daría 0 en
   vez de 75, que es exactamente el bug que el `::numeric` evitaba.
3. **El nombre de la tabla dentro de una CTE que se llama igual**
   (`src/planner.js`, `ctesPorEntidad`). `WITH employees AS (SELECT ... FROM
   employees ...)`: Postgres resuelve la tabla base —una CTE no recursiva no
   puede referirse a sí misma—, pero **SQLite le da precedencia a la CTE** y
   corta con `circular reference: employees`. Es el hallazgo que no se veía
   venir: el planificador daba por sentada una regla de resolución de nombres.
   Ahora es `dialect.tablaFisica(tabla)`: el nombre pelado en Postgres,
   calificado con el esquema (`main.employees`) en SQLite.
4. **El contrato del pool es asíncrono.** `DatabaseSync` es síncrona, pero el
   engine hace `await` sobre `query` y `.catch()` sobre el `ROLLBACK`. El
   adaptador devuelve promesas aunque no espere nada — la misma decisión que
   `CacheStore`: la forma de la interfaz la fija el más lento, y cambiarla para
   que quepa el adaptador habría sido justo lo que esta fase vino a evitar.

Lo que **no** hubo que mover, y por qué se revisó igual: el estilo de
placeholder `$1` (SQLite lo lee como parámetro *nombrado* `1`, así que el
adaptador convierte el arreglo posicional en `{ 1: v, 2: v, … }` y el SQL queda
idéntico en los dos motores), las comillas dobles de los identificadores, el
`LIMIT` con parámetro, `NULLIF`, `COUNT(*) FILTER (WHERE …)` (SQLite lo soporta
desde 3.30; Node 24 trae 3.53) y `BEGIN`/`COMMIT`/`ROLLBACK`. `aNumeros` del
engine tampoco cambió: SQLite devuelve los enteros como números y `Number()`
sobre un número no hace nada.

### Lo que SQLite no puede garantizar

- **El tipo de una columna** (`tiposGarantizados: false`): un tipo declarado es
  una *afinidad*, no una restricción, y nada impide que una columna `NUMERIC`
  tenga un texto en una fila. Por eso una incompatibilidad entre el tipo de una
  dimensión y el físico sale como **advertencia** de registro y no como
  `INVALID_DEFINITION`. El catálogo ya lo soportaba desde la fase A; esta fase
  es la primera vez que ese camino se ejecuta.
- **El presupuesto de tiempo** (`timeoutDeSentencia: false`): no hay
  `statement_timeout` ni equivalente por sentencia, así que el engine no emite
  ninguna sentencia de sesión y **el timeout de la clase de consumidor no se
  hace cumplir en esta fuente**. El resto del presupuesto (límite de filas, TTL
  de caché, rango obligatorio) sí, porque lo aplica el planificador. Un test lo
  fija: la consulta corre dentro de `BEGIN`/`COMMIT` y no hay ni un `SET`.
- **Parámetros booleanos**: `node:sqlite` no acepta un `true` de JavaScript como
  valor de parámetro. Ninguna consulta de esta fase lo usa —el segmento
  `present = true` es del módulo de asistencia, que vive en la fuente Postgres—,
  así que el adaptador no convierte y la limitación queda anotada aquí en vez de
  disimulada con una conversión que nadie ejercita.
- **El seed de asistencia**: `generate_series` no existe en SQLite. La tabla
  `attendance` está en el fixture con su esquema y **sin filas**; ninguna
  consulta de la suite de SQLite la toca.

### Origen que muere: `SOURCE_UNAVAILABLE`

- `pool.connect()` estaba **fuera** del `try` de `ejecutar`: un error de
  conexión salía sin traducir y llegaba al consumidor como 500 sin nombre. Ahora
  pasa por `dialecto.traducirError` como cualquier otro error nativo.
- `postgres.traducirError` reconoce `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, la
  clase **08** de SQLSTATE (excepción de conexión), `57P01` (el servidor se está
  apagando) y el texto del timeout de conexión de node-postgres —que no trae
  `code`, y conocer ese texto es trabajo del dialecto y de nadie más—.
- **503 con `Retry-After: 5`**, y es el único código que lleva cabecera:
  reintentar la misma consulta más tarde sí puede funcionar, a diferencia del
  `QUERY_TIMEOUT` (504). La cabecera sale de `CABECERAS_HTTP` en
  `src/http/codigos.js`, una tabla y no lógica, como la de códigos.
- Los pools de `src/server.js` y `src/demo.js` llevan
  `connectionTimeoutMillis: 2000`: sin techo, una base que no responde deja la
  petición esperando el timeout del sistema operativo.

### Guardia de fuente no configurada

`resolverMiembros` hacía `fuentes[fuente]?.dialecto` y seguía con `undefined`: si
el catálogo conocía una fuente que el engine no tenía configurada, el fallo
aparecía como `TypeError` en la primera dimensión temporal. Ahora lanza un
`Error` —**no** un `SemanticError`: es un error de configuración del servidor, no
del consumidor— que nombra la entidad, su fuente y las fuentes que el engine sí
tiene.

## Arreglos de revisión de la fase 6

- **Techo del cuerpo HTTP**: `cuerpoDe()` acumulaba sin límite. Ahora cuenta
  bytes (no caracteres) y corta en `LIMITE_DE_CUERPO` = 64 KiB con
  `PAYLOAD_TOO_LARGE` → 413, decidido antes de que el engine vea nada. El
  iterador va con `destroyOnReturn: false`: salir del bucle con un throw
  destruiría el socket y el 413 no llegaría; la conexión se corta recién cuando
  la respuesta terminó de salir.
- **La api corre como `node`**, el usuario sin privilegios que la imagen oficial
  ya trae, con los archivos copiados con `--chown=node:node`.
- **Relación hacia una entidad no registrada**: el BFS de `caminoDeJoins`
  reventaba con `TypeError`. Decisión: **no** se valida al registrar —el orden
  importa, `reviews` nombra a `employees` antes de que exista, y una validación
  diferida sería un segundo momento de verdad para el mismo contrato—. La
  relación simplemente no produce arista, y si el destino pedido era alcanzable
  sólo por ahí sale `NO_JOIN_PATH` con la entidad faltante nombrada en la
  sugerencia.

## Arreglos de revisión de la fase 7

- **La llave nace del SQL que se ejecuta, no del JSON pedido**: hasheaba
  `{ companyId, query, catalogVersion }` y con eso no distinguía consumidores.
  Contraejemplo: la misma consulta pedida por `dashboard` (techo de 5000 filas)
  y por `api` (10000) daba el mismo `queryId`, así que la API recibía la entrada
  recortada del tablero sin que nada lo delatara. Ahora es
  `hash(sql sin marca + params + companyId + catalogVersion)`: el LIMIT efectivo
  viaja en los parámetros, así que separa las entradas cuando difiere y las
  comparte cuando es igual (con `limit: 10` pedido, los dos consumidores usan la
  misma). El `queryId` sigue siendo reproducible para la misma forma y empresa.
- **El TTL lo evalúa el lector**, contra el `asOf` que la entrada trae, y no sólo
  el que escribió. Compartir una entrada no puede significar heredar la
  tolerancia del otro: una que el tablero (60 s) dejó hace 50 s le sirve a él y
  la API (30 s) la trata como miss. La entrada **no** se borra al rechazarla:
  sigue siendo válida para quien tolera más. El reloj del engine es inyectable
  (`createEngine({ reloj })`) porque el `asOf` y esa edad son el mismo tiempo y
  tienen que salir de la misma fuente.

## Decisiones de la fase 8

- **`RedisStore`** (`src/cache/redis-store.js`) es una implementación más de
  `CacheStore`, no un caso especial: el engine sigue recibiendo una sola caché.
  Valores en JSON —serializar es además lo que le da la misma semántica de copia
  que el `structuredClone` de la L1— y vencimiento por entrada con `PX`, que lo
  aplica Redis y ahorra cualquier barrido nuestro.
- **Conexión perezosa**: el store se crea sin tocar la red, así que un Redis que
  no está no impide arrancar el servicio. La promesa de conexión se memoriza y se
  descarta cuando el cliente muere, para que el siguiente intento abra uno nuevo:
  rendirse no es rendirse para siempre (verificado: con Redis parado y vuelto a
  levantar, el servicio pasa a `live` y después vuelve a `cache-l2` sin
  reiniciarse por eso).
- **Listener de `error` obligatorio**: sin él, un error de socket es un `error`
  sin manejar en un EventEmitter, y eso **tumba el proceso** — la caché mataría
  al servicio que vino a abaratar. Se registra por el callback `alFallar` y no se
  propaga.
- **Timeout de 200 ms por operación** (`TIMEOUT_DE_REDIS_MS`) y **tope de 5
  reintentos** de reconexión. Una caché que se cuelga es peor que no tener caché:
  agrega latencia a cada respuesta a cambio de nada. Medido con `docker compose
  stop redis`: la consulta nueva se sirvió `live` con HTTP 200 en 230 ms en vez
  de colgarse, y la repetida en 2 ms desde L1.
- **`TieredStore`** (`src/cache/tiered.js`) es dónde vive la composición, y es
  otra implementación de `CacheStore`: lee L1 → L2, escribe en los dos y marca la
  entrada con el **nivel** del que salió. El engine sólo traduce eso a
  `servedFrom` (`live` | `cache-l1` | `cache-l2`) y no sabe cuántos niveles hay;
  agregar un tercero no toca el pipeline de puertas.
- **Un hit de L2 rellena L1** con `TTL_DE_RELLENO_MS`. Ese TTL no pretende ser la
  vida que le quedaba en L2 —no se sabe desde ahí— y no hace falta que lo sea: la
  frescura la decide el lector contra el `asOf`, así que este número sólo acota
  cuánto ocupa un lugar la copia.
- **Dos redes de seguridad, no una**: `TieredStore` se defiende de su L2 porque
  sabe que la tiene; el engine envuelve sus dos puertas de caché en `try/catch`
  porque **no sabe qué implementación le pasaron**, y la garantía "ninguna
  consulta falla por la caché" no puede depender de eso. Una lectura que revienta
  cuenta como miss —se va a la base igual—.
- **Los fallos no viajan como excepción**: salen por el callback `alFallar` y se
  cuentan en `cacheErrors` por nivel. La caché no conoce la telemetría (recibe un
  callback), y como ninguna consulta falla por un nivel caído, sin ese contador
  un Redis muerto sería invisible hasta que alguien mirara la latencia.
- **La llave lleva la empresa en el texto**: `capa:{versión del catálogo}:{empresa}:{fuente}.{huella}:{queryId}`.
  El aislamiento no depende de ese texto —depende del hash, que ya lleva las dos
  cosas adentro—, pero en una caché compartida lo que no se ve no se puede
  auditar: con la empresa escrita, comprobar que ninguna entrada quedó sin dueño
  es un `SCAN`. El prefijo `capa` separa nuestras llaves de las de cualquier otro
  que comparta el Redis, y es inyectable para que los tests usen el suyo y limpien
  sólo lo suyo (nunca `FLUSHALL`).
- **La L2 es opcional** (`src/cache/index.js`): con `REDIS_URL` hay dos niveles,
  sin él sólo L1 y se dice en el log. No es una concesión: es la historia 35, y
  tenerlo así hace que el modo degradado sea el que corre cada vez que alguien
  levanta sólo la base.
- **Redis sin volumen** en el compose: una caché que sobrevive al reinicio no es
  una caché, es una base.

## Corrección posterior al plan (07-09): caso obligatorio

- La consulta tipo del caso lleva `segments: ['reviews.completed']` como filtro
  global. El SQL de referencia del enunciado aplica `status = 'completed'` a
  toda la consulta, así que el promedio se calcula solo sobre evaluaciones
  completadas; antes promediaba también pendientes y calibradas. El snapshot
  `test/snapshots/caso-obligatorio.sql` cambió por eso (la CTE de reviews
  lleva `AND status = $4`) y Ventas ya no aparece en el resultado del seed
  (no tiene completadas en 2025). Sin cambios en el engine ni el planificador:
  lo resolvió la regla 1 de `docs/semantica-de-filtros.md`.

## Corrección posterior al plan (07-09): cliente que se va

- `telemetria.registrarClienteSeFue({ consumer })` → `clientGone` por consumidor
  en `engine.telemetry()`. La capa HTTP escucha `close` de la respuesta y, si
  `writableFinished` es falso, lo cuenta; `crearServidor` recibe la misma
  `telemetria` del engine. Decisión del usuario: la consulta en curso NO se
  cancela (se termina y se cachea; el retry es un hit); `responder()` no
  escribe en una respuesta destruida. Test en `test/http.test.js` con un pool
  que duerme 1 s y un socket que se destruye a los 200 ms.

## Correcciones tras el abogado del diablo (08-09)

Revisión adversarial del repo antes de la entrega (informe completo en
`prueba-tecnica/discusiones/25-abogado-diablo-entrega.md`). Diez hallazgos
corregidos con TDD, un commit por hallazgo; los tres snapshots de SQL del repo
no cambiaron.

1. **Seed que contradecía a los tests** (`docker/init/02-seed.sql:24-48`). El
   encabezado documentaba los valores viejos del caso (Ingeniería 2025-04-01 avg
   3.40, filas de Ventas), de antes de que la consulta tipo llevara el segmento
   `completed` como filtro global. Ahora dice lo que el caso da —4.35/2 y 3.80/1
   en Ingeniería, Ventas sin filas— y explica por qué: el promedio es sólo sobre
   completadas, igual que el SQL de referencia del enunciado. Sin tocar una fila.
2. **`sum` sin SQL y `count_distinct` inexistente** (`src/planner.js:585`,
   `src/catalog.js:25`). `sum` se aceptaba al registrar y moría con un `Error`
   pelado al consultar (500). Ahora `sqlDeAgregado` emite `SUM` y
   `COUNT(DISTINCT …)`, y entró el tipo de medida `count_distinct` (columna
   obligatoria, sin exigencia de que sea numérica). Con él, la pregunta 2 del
   enunciado tiene respuesta: `reviews.completed_employees`
   (`src/definitions/reviews.js:43`) y la consulta tipo
   `empleados-que-completaron-por-trimestre`
   (`src/definitions/consultas-tipo.js:49`). Literales del seed: en 2025 la
   empresa 1 tiene 3 evaluaciones completadas de 2 empleados distintos. No hizo
   falta nada del dialecto: `COUNT(DISTINCT col) FILTER (WHERE …)` es estándar y
   un test lo comprueba contra SQLite.
3. **`equals`/`notEquals` con lista** (`src/planner.js:27`, `exigirOperador`).
   Se usaba `values[0]`: dos valores daban el número de uno solo y `values: []`
   daba `= NULL` —cero filas y un 200—. Ahora exigen exactamente un valor y
   mandan a `in`/`notIn` con `INVALID_OPERATOR`.
4. **La forma de la consulta no se validaba** → `INVALID_QUERY`
   (`src/planner.js:52`, `validarForma`; `src/http/codigos.js:41` → 400). Cubre
   `measures` ausente/vacío/no arreglo, las otras cuatro listas, la granularidad
   de una `timeDimension` (ausente o fuera de `GRANULARIDADES`), la dirección de
   orden y el `limit`. Antes eso salía como 500 con un mensaje que culpaba al
   servidor —`exigirFuenteConfigurada` disparándose por una consulta sin
   medidas— y el `Error` pelado de `dialect/postgres.js` por la granularidad ya
   no es alcanzable desde una consulta.
   **Cambiado el 09-09: `measures` dejó de ser obligatorio (ver ADR 0010).**
   Puede estar ausente o vacío si la consulta pide al menos una `dimension` o
   una `timeDimension` —es el `GROUP BY` sin agregados: los valores distintos de
   esas dimensiones—; sin ninguna de las tres sigue siendo `INVALID_QUERY` con
   `member` `measures`. La exigencia no era una decisión de diseño: era la forma
   de no chocar con la deducción de la entidad de hechos desde `medidas[0]`, que
   es lo que producía el 500 que este hallazgo convirtió en 400. El resto de la
   puerta de forma queda igual.
5. **Dry-run que regalaba el esquema físico** (`src/http/server.js:46-60`).
   `?dryRun=true` devolvía el `sql` —con las tablas y columnas reales— a
   cualquier token, mientras `/analytics/catalog` las esconde. Ahora devuelve
   `{ params, plan }` (el plan lógico, sólo nombres semánticos) y agrega `sql`
   sólo si la sesión del token trae `internal: true`
   (`src/http/tokens.js:12`, token de demo `demo-interno-empresa-a`). Anotado en
   `docs/adr/0008` y en el README.
6. **`timestamp` aceptado en silencio** (`src/dialect/postgres.js:101,242`;
   `src/catalog.js:303`). El mapa de tipos traducía los dos `timestamp` a `date`
   mientras el README y `docs/riesgos.md` decían que uno sin zona se rechaza.
   Los dos salieron del mapa y el dialecto declara ahora una **reserva** por
   tipo: `timestamp without time zone` bajo una dimensión `date` es
   `INVALID_DEFINITION`; `timestamptz` es advertencia de registro (el rango
   cerrado `<= día` pierde casi todo el último día). Quién conoce esos nombres
   sigue siendo el dialecto; el catálogo sólo aplica el nivel.
7. **"Empleado activo" sin definir** (`src/definitions/employees.js:22,31`).
   Es un ejemplo literal del enunciado y cada consumidor tenía que escribir el
   filtro. Ahora hay segmento `active` y medida `active_headcount`, y
   `headcount-por-departamento` pide las dos medidas lado a lado. Literales del
   seed: Ventas 2 empleados y 1 activo, Ingeniería 2 y 2.
8. **Operadores publicados pero no emitidos** (`src/vocabulary.js:35`,
   `src/catalog.js:466`). La vista pública ofrecía `inDateRange`, `beforeDate` y
   `afterDate`, que el planificador rechaza: un agente los leía del catálogo y
   fallaba en bucle. `operadoresEmitidos(tipo)` deriva de la misma tabla que
   `operadoresDe(tipo)` y es lo que `describe` publica; un test recorre la vista
   entera y planifica cada operador publicado.
9. **Documentos que contradecían al código.** El PRD lleva una nota fechada
   (`prds/prd-capa-semantica.md`, Fuera de Alcance) diciendo que SQLite entró
   como prueba del seam y no como feature, y que el servicio sigue con una sola
   fuente. El ADR 0008 y `CONTEXT.md` decían "vista pública filtrada por empresa
   y rol" y `describe` nunca miró el contexto: ahora dicen lo que hace —la vista
   es la misma para todos; lo que varía por consumidor es el presupuesto—. Y
   "nadie nombra un motor" quedó precisado como "salvo como valor por defecto
   inyectable" (`src/dialect/postgres.js:11`).
10. **Registro duplicado en silencio** (`src/catalog.js:549`). Registrar dos
    veces el mismo nombre de entidad pisaba la definición anterior. Ahora es
    `INVALID_DEFINITION` (member `entidad.name`) salvo que la definición sea
    exactamente la misma —comparada por serialización canónica—, en cuyo caso es
    idempotente.

Quedaron **fuera** a propósito, con respuesta preparada en vez de código: la
fuga de modelado del planificador que lee `catalog.entity()` (hallazgo 10, un
refactor que no cabía antes de la entrega), `many_to_one` verificado contra el
`unique` del snapshot (12) y el pool lleno que se reporta como
`SOURCE_UNAVAILABLE` (13).

## Log por consulta (08-09)

Un evento por consulta que el servicio escribe como línea JSON en stdout
(discusiones 09 y 17 del diseño: `docker compose logs api` no mostraba nada por
consulta). Complementa a la telemetría, no la reemplaza: los contadores dicen
cómo va todo, el evento dice qué acaba de pasar.

- **La costura es `createEngine({ observar, observarSql })`**
  (`src/engine.js:40`). `observar` es opcional y por defecto no hace nada; se
  llama **exactamente una vez** por `engine.run` (`src/engine.js:69`) y por
  `engine.plan` (`src/engine.js:49`), desde un `finally`, para que no exista un
  camino de salida que se olvide de emitir. Lo que la llamada va aprendiendo se
  acumula en un `registro` que las puertas rellenan.
- **Nada falla por observar** (`src/engine.js:86`, `emitir`): el `try/catch`
  está por la misma razón que el de la caché —el engine no sabe qué función le
  pasaron y una consulta ya respondida no puede morir por el log—. El fallo no
  se cuenta en ninguna parte: quien no logra observar tampoco se enteraría del
  contador.
- **El evento no lleva nombres físicos** (`src/engine.js:301`, `eventoDe`; el
  plan resumido en `resumenDelPlan`): entidad, joins por el **nombre de la
  relación**, medidas y dimensiones, la misma regla que la vista pública y el
  dry-run (ADR 0008). El `sql` entra sólo con `observarSql: true`.
- **Lo que no aplica no viaja**: un hit de caché no dice `dbMs: undefined` —que
  se leería como "tardó nada en la base"— sino que no habla de la base. Un
  rechazo antes de planificar no trae `queryId` ni `plan`, porque no llegaron a
  existir. `gate` se copia a mano: en el error es una propiedad **no
  enumerable** (`src/planner.js:132`).
- **El servicio lo cablea** con `escribirLinea` (`src/server.js:55`):
  `JSON.stringify({ t: new Date().toISOString(), ...evento })`, una línea sin
  saltos para `docker compose logs -f api`. `observarSql:
  process.env.LOG_SQL === 'true'`; en `docker-compose.yml` la variable está
  **comentada** como ejemplo. La demo no lo enciende: su salida es narrativa.
- **Tests**: `test/observador.test.js` (6, por los seams `engine.run` y
  `engine.plan` con un observador doble) y uno en `test/http.test.js:75` que
  comprueba que la consulta por HTTP emite el evento con la empresa y el
  consumidor del token. Que `src/server.js` cablea el observador no se prueba:
  se verificó corriendo el servicio y leyendo `docker compose logs api`.
- **README**, sección "Ver qué se hace, en vivo": las tres líneas reales (live,
  cache-l1 y rechazo), `LOG_SQL=true` y la receta de Postgres para ver el SQL
  por la marca `/* queryId consumer */` —con **dos `-c`**, porque psql mete
  varias sentencias de un mismo `-c` en una transacción y `ALTER SYSTEM` no
  corre dentro de una—.

## Demo agente (09-09)

`demo-agente/`, fases 1 a 3 cerradas. PRD `prds/prd-demo-agente.md`, plan
`plans/plan-demo-agente.md`, QA `demo-agente/docs/qa.md`.

- **Sesión nombrada de Claude Code**, no una llamada suelta: se crea una vez con
  `claude -p -n agente-buk --session-id <uuid>` y el prompt de creación (rol,
  catálogo público entero, reglas del vocabulario, contrato de salida), y cada
  clic la retoma con `--resume`. Así el catálogo se manda una vez y no por clic.
  El uuid no es configuración: se genera al arrancar y vive en `.sesion.json`.
- **Flags que hacen barata cada llamada**: `--tools ""` (sin herramientas, no
  explora el disco), `--setting-sources ""` (ignora settings del usuario y del
  repo) y `--system-prompt` con dos líneas que reemplazan el andamiaje de Claude
  Code. Medido: 62.037 → 9.201 → **515 tokens** de entrada por llamada; un clic
  real cuesta 0,002-0,004 USD y tarda 3-6 s, contra los milisegundos de la capa.
- **Huella del catálogo, no versión**: la sesión se recrea cuando cambia el
  sha256 canónico del catálogo público **entero**, guardado en `.sesion.json`
  junto a `version`. La versión de la capa es el hash de las definiciones más el
  esquema físico y **no cubre las consultas tipo** (decisión de la fase 4), así
  que guiarse por ella dejaría al agente hablando de un catálogo viejo.
- **Consultas tipo con `query` en la vista pública** (ADR 0008): `describe(ctx)`
  publica la plantilla declarativa tal cual se registró, con sus marcadores
  `:nombre` sin sustituir, y el prompt manda copiarla cuando la pregunta
  coincide. Sin eso el agente copiaba la forma pero no el `segments` de la
  consulta tipo del caso, y la pregunta 1 daba 3,4 en 2025-04-01 y filas de
  Ventas de más. Con eso da 4,35/2 y 3,8/1, igual que el seed. No cambia la
  versión del catálogo ni los snapshots de SQL.
- **Salto opcional de redacción** (10-09, discusión 24): la casilla "Redactar la
  respuesta" —al lado de "usar agente", deshabilitada sin ella— agrega un cuarto
  salto `agente — redacción` después de la consulta que trajo filas. Es el
  **mismo modelo en un segundo momento**: primero tradujo la pregunta a JSON,
  ahora recibe la pregunta original y las filas y escribe una o dos frases.
  `promptDeRedaccion(pregunta, filas, meta)` en `src/protocolo.js` (pura): la
  pregunta tal cual viajó en el salto 1, las filas como JSON con **tope de 50**
  (más allá dice "se muestran 50 de N"), `servedFrom`/`asOf` y el contrato
  (español, texto plano, los números tal cual sin redondear a más de dos
  decimales, nada inventado, sin nombrar SQL ni JSON, sin markdown, y decir si
  no hay filas). **Al LLM sólo llegan el catálogo público y filas agregadas por
  empresa**, nunca filas crudas ni columnas personales. La salida es texto y
  `ejecutar` NO la parsea; el adaptador es el mismo `crearAgente`. Sólo redacta
  si el último salto de consulta (el 3 o el corregido) terminó `ok` con `rows`;
  un rechazo, un `noPuedo` o un fallo no dejan nada que redactar. Nunca corta el
  rastro: fallo o texto vacío dejan el salto en `fallo` con las filas intactas.
  En la petición es `redactar` (POST) o `redactar=1` (GET), sólo con
  `usarAgente`, y suma 1 a `saltosPrevistos`. La frase se muestra arriba del
  resumen ("Respuesta del agente: …", con `textContent`). Cuesta ~0,003 USD y
  3-5 s por salto.
- **Estados del rastro**: `ok`, `rechazo`, `fallo`. Un `{"noPuedo": …}` del
  agente sale como `rechazo` igual que un 4xx de la capa —el `destino` del salto
  dice de quién viene—; un 5xx es `fallo`, porque ahí no hay JSON que corregir.
  Un JSON envuelto en un bloque de código se tolera a propósito; la prosa no.
- **Front estático y API NDJSON** (09-09, reemplaza al HTML del servidor): el
  mini back sirve `demo-agente/public/` (HTML, CSS y JS puro, sin frameworks ni
  build) y publica `GET /api/preguntas`, `GET /api/sesion` y
  `GET /api/rastro?…`. El rastro sale como **NDJSON en streaming**
  (`application/x-ndjson`, `chunked`): línea `inicio` con la petición y
  `saltosPrevistos` en milisegundos, una línea `salto` por cada aviso del
  observador `alSalto(salto, indice)` del seam, y `fin` con el total; la
  pregunta inexistente sale como `error`. El front lo lee con `fetch` +
  `ReadableStream` y pinta cada salto al llegar, con una tarjeta "en curso…"
  para el siguiente. `src/render.js` (el HTML armado en el servidor) se borró.
  El prompt de la sesión se ve en un modal `<dialog>` y también en
  `/agente/sesion`, que ahora es `public/sesion.html` alimentado por
  `/api/sesion`.
- **Selector de TOKEN, no de empresa** (09-09): arriba del formulario, antes de
  la pregunta preparada. En la capa la empresa viaja en el token (ADR 0002) y la
  consulta nunca lleva `companyId` (`FORBIDDEN_FIELD`), así que el selector
  ofrece `demo-agente-empresa-a` y `demo-agente-empresa-c` con su lectura al
  lado. Elegir uno elige el PAR: el de clase `agente` para la consulta y el
  interno de la **misma** empresa para el dry-run. Los datos viven en
  `src/consumidores.js` (nombres, etiquetas, rangos precargados y qué variable
  del `.env` trae cada valor) y bajan al front por `GET /api/consumidores`; el
  nombre del token se muestra en el chip de cada salto y en la URL
  (`?token=…`), y el **valor** sólo lo conoce el mini back. Token desconocido →
  400. `ejecutar` no cambió de firma: la petición lleva `token` y de ahí salen
  los dos nombres. `.env`: `TOKEN_AGENTE_A`, `TOKEN_INTERNO_A`, `TOKEN_AGENTE_C`,
  `TOKEN_INTERNO_C`, y `TOKEN_AGENTE`/`TOKEN_INTERNO` sin sufijo siguen siendo
  los de la A.
- **Empresa C, la de volumen** (`docker/init/03-seed-empresa-c.sql`): 1.750
  empleados en 12 departamentos, 15.477 evaluaciones y **1.062.283 filas de
  asistencia** (2024-2025 día a día). Existe para ver tiempos reales, la caché,
  el tope de 1.000 filas de la clase `agente` y la advertencia de índice de
  `attendance.date`; **ningún test depende de ella** y sus conteos NO están
  calculados a mano. El initdb de los tres archivos tarda **~8,8 s** (~8,6 s son
  este) y deja la base en **~104 MB**. Como el snapshot de la fase 4 fija los
  índices, este seed **no agrega ninguno**: la tabla grande se recorre entera, y
  eso es justamente lo que la demo enseña.
- **Una sola sesión para las dos empresas**: el catálogo público no depende del
  consumidor (ADR 0008), así que no hay sesión por empresa. `/api/sesion` lo
  dice (`catalogoUnicoParaTodasLasEmpresas`, `motivoCatalogoUnico`) y la tarjeta
  "Antes de todo" lo muestra cuando el token elegido no es el de la A.
- **Fechas opcionales y 8 preguntas** (09-09 noche, ADR 0009): el rango dejó de
  ser obligatorio para la clase `agent`, así que `desde` y `hasta` ya no son
  `required` en el formulario —siguen precargadas por pregunta y se pueden
  vaciar— y `prepararConsulta` deja la `timeDimension` con su granularidad pero
  sin `dateRange` cuando falta cualquiera de las dos fechas (un rango es un par).
  El prompt de creación dice que el rango es opcional y que el límite real es
  `QUERY_TIMEOUT` con su sugerencia; ya no nombra `MISSING_TIME_RANGE`. Las
  fechas viajan **una sola vez**: el texto de la pregunta ya no las lleva y la
  línea "Filtros:" las agrega sólo si existen (sin ningún filtro, no hay línea).
  `headcount-por-departamento` deja de ser "solo con token de otra clase" y se
  suma `cuantos-empleados-hay` (`employees.headcount` y `active_headcount`, sin
  dimensiones ni tiempo): son las dos que vienen con el rango precargado vacío.
- **Consultas sin medidas y 9 preguntas** (09-09 noche, ADR 0010): `measures`
  dejó de ser obligatorio en la capa, así que "cuáles departamentos hay" tiene
  traducción. El prompt de creación lo dice —para listar los valores de una
  dimensión se pide esa dimensión SIN medidas— y se suma la 9ª pregunta
  preparada `cuales-departamentos-hay` (`{"dimensions":["departments.name"],
  "order":{"departments.name":"asc"}}`), con rango precargado vacío en las dos
  empresas: no lleva `timeDimensions`. Antes de esto el agente escribía el JSON
  correcto y la capa se lo rechazaba con `INVALID_QUERY`.
- **Las tres preguntas del enunciado y 12 preguntas** (10-09, ADR 0011): las
  tres primeras de `preguntas.json` son las del enunciado con su **texto
  literal**, sin marcadores y sin cambiarle una palabra. La 1 (score promedio
  por departamento durante el último año) y la 3 (tasa de asistencia por
  departamento durante los últimos tres meses) llevan `dateRange` **sin**
  `granularity`: piden un período, no un corte por tiempo, así que son una fila
  por departamento. La 2 (cuántos empleados completaron cada trimestre) sí
  agrupa: es la consulta de `empleados-que-completaron` sin el filtro de
  departamento. Rangos precargados de la empresa A: 2025 entero para la 1 y la
  2, junio a agosto de 2025 para la 3 — en la demo "el último año" y "los
  últimos tres meses" son los del seed, y cada pregunta lo dice en su `nota`.
  El prompt de creación gana la viñeta del rango sin granularidad; las 9
  preguntas anteriores quedaron intactas, después de las tres.
- **Panel de presupuestos y telemetría** (09-09 noche): al pie del rastro,
  alimentado por `GET /api/telemetria?token=<nombre del token de consumidor>`
  del mini back (`src/servidor.js`), que llama a `GET /analytics/telemetry` de
  la capa con el token **interno** de esa empresa —la capa se la niega a un
  token de clase `agente` con 403— por `pedirTelemetria` (`src/capa.js`),
  cableado en `index.js`. Token de demo desconocido → 400; capa que no responde
  → 502. Dos tablas: "Presupuesto por clase" (timeout, filas, rango obligatorio
  y TTL de las tres clases, con la fila de la clase del token elegido resaltada
  —`clase: 'agent'` es un campo nuevo de `src/consumidores.js`—) y "Por
  consumidor" (ok, error, hits, misses, clientGone) con una línea de totales
  encima y el JSON crudo en un `<details>`. Se carga al abrir, se refresca al
  llegar el evento `fin` del rastro y con el botón "Actualizar"; **sin
  temporizador**: un refresco de fondo ensuciaría los contadores que el rastro
  acaba de producir. Todo con `textContent`, como el resto del front.
- **Regla de operación**: nunca abrir esa sesión de forma interactiva mientras
  el mini back la usa. Es el mismo uuid.

## Telemetría por HTTP (09-09)

`GET /analytics/telemetry` (`src/http/server.js`) devuelve
`{ telemetry: engine.telemetry(), budgets: <la tabla de src/budgets.js tal
cual>, process: { uptimeMs, startedAt } }`.

- **Sólo sesión interna**: la misma marca `internal` del token que abre el SQL
  del dry-run (ADR 0002, ADR 0008). Sin token conocido, `MISSING_TENANT` → 401,
  como cualquier otra ruta; con un token conocido que no es interno, código
  nuevo **`FORBIDDEN` → 403** (`src/http/codigos.js`). 403 y no 404: esconder la
  ruta le mentiría a una herramienta del equipo que sólo trae el token
  equivocado.
- **De lectura y nada más**: la telemetría es del proceso y **no se reinicia por
  HTTP**. Un reset expuesto dejaría a cualquiera borrando la única evidencia de
  lo que pasó, y con varias instancias ni siquiera se sabría a cuál se le borró.
- `budgets` sale de `src/budgets.js` sin recalcular ni resumir: lo que se lee es
  exactamente lo que aplica el planificador. `startedAt` se calcula una vez al
  cargar el módulo (`process.uptime()` se mueve a cada llamada y el instante de
  arranque no).
- Tests en `test/http.test.js` por el servidor de prueba: 401 sin token, 403 con
  el token `dashboard`, 200 con el interno y la forma de la respuesta
  (`telemetry.total` ≥ 1 después de una consulta, `budgets.agent.maxFilas` 1000).
- La consume la demo (`demo-agente`, `GET /api/telemetria`): ver "Demo agente".

## Estado

Rango sin granularidad (10-09 madrugada, ADR 0011): una `timeDimension` con
`dateRange` y sin `granularity` sólo filtra por fecha. La raíz corre **217 tests
en verde** con `DATABASE_URL` y `REDIS_URL`, y **133 sin nada** (1 se salta);
`demo-agente` corre sus **62** aparte (9 nuevos del salto de redacción). Snapshot nuevo
`test/snapshots/rango-sin-granularidad.sql`; los cuatro anteriores sin cambios.
Verificado contra Docker (`docker compose up -d --build api`): la tasa de
asistencia por departamento de junio a agosto de 2025 con `demo-agente-empresa-a`
devuelve 200 con dos filas (Ingeniería 92,59 y Ventas 91,55). La demo estrena
las tres preguntas del enunciado con su texto literal (12 en total) y el prompt
de creación gana la viñeta del rango sin granularidad; el agente la usó sin
ayuda en la 1 y en la 3 del QA del 10-09.

Identidad de la fuente en la llave de caché (09-09, discusión 26 P12-P16): la
llave pasó de `{versión}:{empresa}:{queryId}` a
`{versión}:{empresa}:{fuente}.{huella}:{queryId}`. Motivo: el `queryId`
identifica la consulta y no la base; dos despliegues con una fuente llamada
igual sobre bases distintas daban la misma llave. La huella (8 hex) sale de
`resolverIdentidad` en `src/engine.js`, por prioridad: `id` configurado en
`fuentes` → `dialecto.identificador(pool)` (Postgres: `system_identifier` de
`pg_control_system()`, que las réplicas físicas comparten; SQLite: el archivo)
→ host/puerto/base del pool sin credencial → nombre. `engine.identidadDeFuente`
la expone con su origen. `CACHE_PREFIX` separa ambientes en Redis
(`src/cache/index.js`, `server.js`, `demo.js`). Tests: 4 de identidad y 1 de
aislamiento entre bases en `cache.test.js`, la forma de la llave en
`redis.test.js`, archivo vs memoria en `sqlite.test.js`. Verificado: **179 tests
en verde** con `DATABASE_URL` y `REDIS_URL` (contra Docker, el rol `capa` sí
puede ejecutar `pg_control_system()`: origen `motor`), 114 sin nada (1 se
salta). Snapshots de SQL sin cambios.

Al cierre del 09-09 (query de consultas tipo en la vista pública, empresa C,
rango opcional ADR 0009, consultas sin medida ADR 0010, telemetría por HTTP): la
raíz corre **204 tests en verde** con `DATABASE_URL` y `REDIS_URL`, y **125 sin
nada** (1 se salta). `demo-agente` corre sus **52** aparte. Los tres snapshots
de SQL originales sin cambios; uno nuevo (`valores-de-dimension.sql`).

Log por consulta terminado (08-09): el engine emite un evento por `run` y por
`plan` por la costura `observar`, y el servicio `api` lo escribe como una línea
JSON en stdout. Verificado contra Docker: `docker compose logs api` muestra la
línea `live` con `dbMs`, la repetida con `servedFrom: "cache-l1"` y sin `dbMs`,
y el rechazo con `code`, `member` y `gate` y sin `queryId`; con `LOG_SQL=true`
la línea agrega el `sql`. **172 tests en verde** con `DATABASE_URL` y
`REDIS_URL`, **110 sin ninguna variable** (1 se salta), los tres snapshots de
SQL sin cambios.

Correcciones del abogado del diablo terminadas (08-09): los diez hallazgos
bloqueantes de la lista de arriba están corregidos con test, un commit cada uno.
Verificado: **165 tests en verde** con `DATABASE_URL` y `REDIS_URL`, **107 sin
ninguna variable** (1 se salta), los tres snapshots de SQL byte por byte iguales
y `npm run demo` respondiendo las tres preguntas con caché de dos niveles.
Códigos nuevos: `INVALID_QUERY` (400). Miembros nuevos:
`reviews.completed_employees`, `employees.active` (segmento) y
`employees.active_headcount`; consulta tipo nueva
`empleados-que-completaron-por-trimestre`.

Fase B terminada: SQLite es la segunda fuente y el seam del dialecto aguantó.
Las mismas definiciones y el mismo engine responden el caso obligatorio contra
los dos motores con las mismas filas; los cuatro pedazos de Postgres que
quedaban fuera del dialecto (`SET LOCAL`, `::numeric`, el nombre de la tabla
dentro de su CTE homónima y la asincronía del pool) están listados arriba con lo
que se hizo con cada uno. Se sumaron `SOURCE_UNAVAILABLE` (503 con
`Retry-After`) y la guardia de fuente no configurada. Verificado: 139 tests en
verde con `DATABASE_URL` y `REDIS_URL`, 87 sin ninguna variable (los 16 de
SQLite corren en los dos modos, en memoria), y `npm run demo` sigue respondiendo
las tres preguntas con caché de dos niveles.

Fase A terminada: el dialecto quedó como la única pieza que conoce un motor
(sintaxis, introspección, mapa de tipos y errores nativos), cada entidad declara
su fuente y el catálogo valida la compatibilidad entre el tipo declarado y el
físico. `SCHEMA_DRIFT` (503) reemplaza al error crudo de Postgres cuando el
esquema cambió debajo del catálogo. Verificado contra Docker: 117 tests en verde
y `npm run demo` responde las tres preguntas con caché de dos niveles. La fase B
puede agregar `src/dialect/sqlite.js` sin tocar catálogo, planificador ni engine.

Fase 8 terminada — **última del plan**. Caché L2 en Redis detrás de la misma
interfaz `CacheStore`, compuesta con la L1 por `TieredStore`. Verificado contra
Docker: dos POST iguales dan `live` y `cache-l1`; tras `docker compose restart
api` (que vacía la L1) el mismo POST vuelve `cache-l2` con el `asOf` de la
ejecución original; con `docker compose stop redis` una consulta nueva se sirve
`live` con HTTP 200 en 230 ms y la repetida en 2 ms desde L1. Las llaves reales
son `capa:{versión}:{empresa}:{fuente}.{huella}:{queryId}`. `npm run demo` levanta una segunda
instancia del engine que responde `cache-l2` y cierra con hits por nivel y
errores de caché. Fuera de alcance, documentado como evolución: invalidación por
escritura de los módulos, single-flight, pre-agregaciones y Parquet/S3.

Fase 7 terminada: caché L1 en memoria detrás de la interfaz `CacheStore`. La
segunda ejecución de la misma consulta vuelve con `servedFrom: 'cache-l1'`, las
mismas filas y el `asOf` de la ejecución original, y la telemetría muestra que la
base no se consultó (3 consultas para 6 respuestas en la demo, hit ratio 50 %).
La empresa B no recibe la entrada de la A, registrar una definición nueva
invalida todo por la versión del catálogo, la entrada expira según el TTL de la
clase de consumidor (probado con reloj inyectado), el store está acotado con
desalojo LRU y el dry-run no la toca. El servicio HTTP y la demo la usan.
Siguiente: fase 8 (caché L2 en Redis).

Fase 6 terminada: servicio HTTP (`POST /analytics/query`, `GET
/analytics/catalog`, `?dryRun=true`) con contexto derivado del token de demo y
mapa de códigos; telemetría en memoria por resultado, código, puerta y
consumidor; `queryId` reproducible con la versión del catálogo; módulo de
asistencia con `attendance_rate` (80 y 50 contra Postgres) registrado sin tocar
el engine; `npm run demo` con catálogo, tres preguntas y telemetría; servicio
`api` en docker-compose verificado con curl. Siguiente: fase 7 (según el plan).

Fase 5 terminada: medidas derivadas de tipo `ratio` calculadas sobre agregados
(el departamento con 3 completadas de 4 da 75 contra Postgres), orden topológico
y rechazo de ciclos al registrar, semántica de filtros escrita y aplicada con
advertencia en `meta.warnings` cuando un filtro global anula el denominador,
dry-run con plan lógico sin conexión, snapshot del SQL de `completion_rate`,
consulta tipo `completitud-por-departamento` y planificador partido en puertas.
Siguiente: fase 6 (según el plan).

Fase 4 terminada: el catálogo como contrato — validación de forma y de esquema
al registrar, advertencias, introspector con foto fija en el repo, vistas
pública e interna, versión por hash, `UNKNOWN_MEMBER` con sugerencia por
distancia de edición, `INVALID_OPERATOR`/`UNSUPPORTED_OPERATOR` contra la tabla
de operadores por tipo, filtros y segmentos de consulta y las consultas tipo
recorridas por un test que verifica el invariante de empresa en cada CTE.

Fase 3 terminada: guardarraíles del consumidor — presupuestos por clase,
`FORBIDDEN_FIELD` para `companyId`/`consumer` en el JSON, `MISSING_TIME_RANGE`
para el agente sin rango, límite efectivo, timeout transaccional con conexión
que vuelve limpia al pool y aislamiento verificado en cien consultas alternadas
sobre una sola conexión. Siguiente: fase 4 (catálogo validado, `describe()` y
sugerencias por distancia de edición).

Fase 2 terminada: el caso obligatorio de punta a punta —joins por relaciones,
CTE por entidad con su filtro de empresa, `timeDimensions` con granularidad y
rango, medida `avg`, medida filtrada por segmento con `COUNT(*) FILTER`,
`order`, `limit`, conversión de `int8`/`numeric` a número y error
`MULTI_ENTITY_MEASURES`.

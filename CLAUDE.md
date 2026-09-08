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
  Cube, 0008 catálogo en dos vistas).

## Estructura

```
src/
  definitions/reviews.js     evaluaciones: dimensiones, medidas, segmento y relación
  definitions/employees.js   empleados: puente hacia departamentos
  definitions/departments.js departamentos: dimensión name
  definitions/attendance.js  asistencia: dimensión temporal `date`, segmento
                             `present` y la derivada `attendance_rate`
  definitions/consultas-tipo.js  cinco plantillas del caso con parámetros `:nombre`
  definitions/index.js       composición: qué módulos y qué consultas tipo
                             existen, y `registrarModulos(catalog, snapshot)`
  dialect/postgres.js        el motor, entero: sintaxis (dateTrunc,
                             agregadoFiltrado y capacidades), introspección del
                             esquema, mapa de tipos físicos → semánticos y
                             traducción de errores nativos
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
  http/server.js             las dos rutas con node:http; token → ctx, techo de
                             64 KiB al cuerpo y delega
  http/codigos.js            mapa código de error → código HTTP (incluido 413)
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
  snapshots/caso-obligatorio.sql  SQL esperado del caso, comparado por igualdad
  snapshots/completion-rate.sql   SQL esperado de la derivada, con su etapa agregada
  fixtures/snapshot.json     foto del esquema generada desde la base del caso
docker/init/
  01-schema.sql            DDL del caso, copiado sin cambios
  02-seed.sql              seed determinista + conteos esperados en el encabezado
docs/
  adr/                     decisiones arquitectónicas numeradas
  semantica-de-filtros.md  qué filtra a qué y cuándo una razón queda en 100
docker-compose.yml         db (Postgres 16, host 5433), redis (host 6380) y api
                           (host 3000, espera a que db y redis estén sanos)
Dockerfile                 imagen del servicio api (node:24-alpine, USER node)
```

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
  (rechazar es mejor que aplicar un filtro a medias en silencio).
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

- La capa HTTP es `node:http` sin frameworks, con dos rutas y un solo trabajo:
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
- v1 **exige granularidad** en una `timeDimension`: no hay forma de acotar por
  fecha sin agrupar por ella. Por eso la consulta tipo de asistencia agrupa por
  departamento **y mes**, y de paso deja ver la tendencia. Un `dateRange` sin
  granularidad queda como evolución.
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
  nombran ninguno.
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
- **La llave lleva la empresa en el texto**: `capa:{versión del catálogo}:{empresa}:{queryId}`.
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

## Estado

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
son `capa:{versión}:{empresa}:{queryId}`. `npm run demo` levanta una segunda
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

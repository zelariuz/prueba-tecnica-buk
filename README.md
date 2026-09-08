# Capa Semántica de Analítica

Capa que expone los datos de cada módulo bajo nombres de negocio: un módulo
declara su **definición semántica**, el **catálogo** la registra y el **engine**
traduce una consulta declarativa a SQL, la ejecuta y devuelve filas con nombres
semánticos. El aislamiento por empresa es del motor, no del consumidor.

- Diseño y decisiones: `prds/prd-capa-semantica.md`, `docs/adr/`.
- Plan de construcción por fases: `plans/plan-capa-semantica.md`.
- Vocabulario: `CONTEXT.md`.

Estado actual: **fase 8, la última del plan** — el caso obligatorio de punta a punta, los
guardarraíles del consumidor (presupuesto por clase: timeout, máximo de filas,
rango temporal obligatorio), el catálogo como contrato (valida las definiciones
contra el esquema real, se describe en dos vistas, se versiona por hash y
registra consultas tipo), las medidas derivadas (razones calculadas sobre
agregados, con la semántica de filtros escrita y un dry-run que devuelve el plan
lógico sin tocar la base) y **el servicio HTTP**: `POST /analytics/query` y
`GET /analytics/catalog` con contexto derivado del token, telemetría en memoria,
un segundo módulo (asistencia, con `attendance_rate`) y una demo por consola.
Las dos últimas fases agregan la **caché de dos niveles**: la L1 en memoria del
proceso (fase 7) y la **L2 en Redis** compartida entre instancias (fase 8). La
segunda ejecución de una consulta no toca la base, y lo que calculó una instancia
le sirve a las demás. Si Redis no responde, la respuesta se sirve igual: ninguna
consulta falla por la caché.

Fuera de alcance, documentado como evolución con su costura: invalidación de la
caché por escrituras de los módulos, single-flight, pre-agregaciones y
Parquet/S3.

## Requisitos

- Node 24 o superior.
- Docker con Compose.

## Cómo correr

```bash
npm install
docker compose up -d --build     # db (Postgres 16 con esquema y seed), redis y api
cp .env.example .env             # referencia de variables

export DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica
export REDIS_URL=redis://localhost:6380
npm test                         # suite completa
npm run demo                     # las tres preguntas del caso, por consola
```

Si sólo quieres correr los tests, basta con `docker compose up -d db`: el
servicio `api` no hace falta para la suite.

El host publica Postgres en el puerto **5433** (no 5432) para no chocar con un
Postgres instalado localmente. La contraseña del compose es de juguete y sirve
solo para este entorno local.

Los tests que necesitan base leen `DATABASE_URL` y **se saltan con aviso** si no
está definida:

```
﹣ conteo de evaluaciones por estado # falta DATABASE_URL — levanta la base con `docker compose up -d db` (ver README)
```

Lo mismo con Redis y `REDIS_URL`: los tests de la caché L2 se saltan con aviso si
falta, y `npm test` **sin ninguna de las dos variables queda verde**. La caché L1
vive en el proceso y no necesita nada levantado.

## Base de datos

El compose no declara volumen para la base: `docker/init/01-schema.sql` (el
esquema del caso, sin cambios) y `docker/init/02-seed.sql` (seed determinista de
dos empresas) se aplican cuando el directorio de datos está vacío. Los conteos
esperados están calculados a mano en el encabezado del seed; los tests los usan
como literales.

```bash
docker compose up -d --force-recreate --renew-anon-volumes db   # vuelve a cero
```

`--renew-anon-volumes` no sobra: la imagen `postgres` declara un `VOLUME` para
su directorio de datos, así que Docker crea un volumen anónimo que **sobrevive**
a recrear el contenedor. Sin esa opción el contenedor es nuevo pero los datos son
los viejos, y el seed no se vuelve a aplicar.

### Fechas y zonas horarias (supuesto v1)

Las columnas temporales del caso (`hire_date`, `period`, `date`) son `DATE`: un
día calendario sin zona, que se asume **ya resuelto al día local de la empresa**
por quien lo escribió. La capa no convierte fechas y las devuelve como texto
`YYYY-MM-DD` desde SQL, así que la zona del proceso o del servidor (convención:
UTC-0) no cambia el resultado. Si una entidad futura trae un `timestamptz`, la
zona pasa a ser un dato de la empresa en el catálogo y el dialecto la aplica con
`AT TIME ZONE`; un `timestamp` sin zona se rechaza al registrar. Detalle en
`docs/riesgos.md`.

## Cómo se consulta

```js
const catalog = createCatalog();
catalog.register(reviews, await introspect(pool));
const engine = createEngine({ catalog, pool });

await engine.run(
  { measures: ['reviews.count'], dimensions: ['reviews.status'] },
  { companyId: 1, consumer: 'api' },
);
```

La empresa viaja en el contexto de sesión, nunca en la consulta, y aterriza como
parámetro dentro de la CTE de cada entidad (ADR 0003):

```sql
WITH reviews AS (
  SELECT status
  FROM performance_reviews
  WHERE company_id = $1
)
SELECT reviews.status AS "reviews.status", COUNT(*) AS "reviews.count"
FROM reviews
GROUP BY reviews.status
```

La consulta del caso —score promedio y evaluaciones completadas por
departamento y trimestre de 2025— se pide con los mismos nombres de negocio; el
engine encuentra el camino `reviews → employees → departments` recorriendo las
relaciones declaradas y emite una CTE por entidad, cada una con su filtro de
empresa:

```js
await engine.run(
  {
    measures: ['reviews.avg_score', 'reviews.completed_count'],
    dimensions: ['departments.name'],
    segments: ['reviews.completed'],
    timeDimensions: [
      { dimension: 'reviews.period', granularity: 'quarter', dateRange: ['2025-01-01', '2025-12-31'] },
    ],
    order: { 'reviews.period': 'asc' },
    limit: 500,
  },
  { companyId: 1, consumer: 'api' },
);
```

El SQL que genera está en `test/snapshots/caso-obligatorio.sql`, comparado por
igualdad en cada corrida de tests. El segmento `reviews.completed` va como
filtro global porque el SQL de referencia del caso aplica `status = 'completed'`
a toda la consulta: el promedio se calcula solo sobre evaluaciones completadas,
no sobre pendientes ni calibradas. Dentro de ese conjunto `completed_count`
cuenta lo mismo que `count`; se pide por su nombre de negocio (regla 2 de
`docs/semantica-de-filtros.md`). El rango temporal es cerrado en ambos
extremos (`>= $2 AND <= $3`, como el `dateRange` de Cube) y viaja dentro de la
CTE de las evaluaciones; el trimestre vuelve como texto ISO (`2025-01-01`) para
que no dependa de la zona horaria del proceso.

## Medidas derivadas: razones sobre agregados

`completion_rate` no se declara como una fórmula: se declara como la razón entre
dos medidas de la misma entidad.

```js
completion_rate: {
  type: 'ratio',
  numerator: 'completed_count',
  denominator: 'count',
  scale: 100,
  description: 'Porcentaje de evaluaciones completadas sobre el total de evaluaciones.',
}
```

El planificador agrega el numerador y el denominador en una consulta agregada y
escribe la fórmula **afuera, sobre sus alias**; así solo puede ver valores ya
agregados. `::numeric` evita la división entera (dos `COUNT` son enteros y 3/4
daría 0) y `NULLIF` convierte el denominador cero en NULL:

```sql
SELECT "departments.name",
       "reviews.completed_count"::numeric / NULLIF("reviews.count", 0) * 100 AS "reviews.completion_rate"
FROM (
  SELECT departments.name AS "departments.name",
         COUNT(*) FILTER (WHERE reviews.status = $4) AS "reviews.completed_count",
         COUNT(*) AS "reviews.count"
  …
) AS agregada
```

El SQL completo está en `test/snapshots/completion-rate.sql`. Las medidas base
que el consumidor no pidió se quedan en la etapa agregada y no salen en las
filas. Una derivada puede apoyarse en otra: el catálogo las ordena al registrar y
rechaza los círculos con `INVALID_DEFINITION`.

**Filtros y advertencias**: los filtros de la consulta y sus segmentos afectan a
todas las medidas; el filtro propio de una medida se suma al global. Si un filtro
global repite lo que distingue al numerador (`reviews.status = completed` junto a
`completion_rate`), la tasa vale 100 en todas las filas y la respuesta lo dice en
`meta.warnings`. La regla completa está en `docs/semantica-de-filtros.md`.

## Dry-run: el plan antes de gastar la base

```js
const { sql, params, plan } = engine.plan(consulta, { companyId: 1, consumer: 'agent' });
```

`plan` trae la entidad de hechos, el camino de joins, las dimensiones, las
medidas pedidas, las medidas base que hizo falta resolver, las derivadas con su
numerador y denominador, los filtros globales, los filtros de cada medida, el
presupuesto aplicado con el límite efectivo y las advertencias. No abre ninguna
conexión: un agente puede revisar la consulta antes de ejecutarla.

## El catálogo como contrato

Registrar una definición la valida contra el esquema real de la base. La foto
del esquema la produce el introspector y se puede inyectar, que es como corren
los tests del catálogo sin Postgres:

```js
const snapshot = await introspect(pool);          // information_schema + pg_indexes
const { ok, version, warnings } = catalog.register(reviews, snapshot);
// warnings: [{ member: 'reviews.period', warning: '…no tiene índice que la cubra…' }]
```

Una columna que no existe **falla al registrar**, no al consultar, y el error
trae el nombre correcto:

```
INVALID_DEFINITION (reviews.status.column):
  La columna statu no existe en performance_reviews. ¿Quisiste decir status?
```

Lo mismo vale al consultar: un miembro mal escrito vuelve como `UNKNOWN_MEMBER`
con la sugerencia calculada por distancia de edición
(`reviews.avg_scor` → `reviews.avg_score`).

`describe(ctx)` es lo que ve un dashboard o un agente: nombres de negocio,
tipos, descripciones, operadores válidos, granularidades y consultas tipo. Nunca
una tabla ni una columna (ADR 0008): `describe(ctx)` devuelve la vista pública
aunque el contexto pida lo contrario. El mapeo físico sale por otro método,
`describeInternal()`, que no recibe contexto de consumidor y vive del lado del
servidor.

## Consultas tipo

Plantillas con nombre y parámetros que el dueño del módulo registra; un
dashboard fijo no necesita armar JSON ni leer el catálogo:

```js
for (const consulta of consultasTipo) catalog.registerQuery(consulta);

await engine.run(
  catalog.query('evaluaciones-por-departamento-y-trimestre', {
    dateRange: ['2025-01-01', '2025-12-31'],
  }),
  { companyId: 1, consumer: 'api' },
);
```

Sirven también de test de regresión: un test las recorre todas, comprueba que
cada CTE de su SQL lleva `company_id = $1` y que todas devuelven filas.

## El servicio HTTP

Dos rutas, sin framework (`node:http`). La capa es delgada a propósito: traduce
el token a contexto de sesión `{ companyId, consumer }` (ADR 0002), delega en el
engine y traduce el error estructurado a su código HTTP. No valida miembros, no
arma SQL y no decide presupuestos.

| Ruta | Qué hace |
| --- | --- |
| `POST /analytics/query` | Ejecuta una consulta declarativa. Devuelve `{ rows, meta }`. |
| `POST /analytics/query?dryRun=true` | Devuelve `{ sql, params, plan }` sin tocar la base. |
| `GET /analytics/catalog` | Devuelve la vista **pública** del catálogo (nunca la interna). |

El `dryRun` viaja en la URL y no en el cuerpo a propósito: el cuerpo es la
consulta declarativa y nada más, así que pedirlo no cambia su forma ni, por lo
tanto, su `queryId`.

**Autenticación**: fuera de alcance (el PRD la deja a la aplicación). Para poder
ejercitar el contrato hay una tabla en memoria de tokens de demo, cargada de la
variable `DEMO_TOKENS` en JSON —`{ token → { companyId, consumer } }`, valores
falsos y públicos, ver `.env.example`—. En producción esa función se reemplaza
por el verificador de tokens de la plataforma y nada más cambia.

```bash
# Catálogo público
curl -s -H 'Authorization: Bearer demo-dashboard-empresa-a' \
  http://localhost:3000/analytics/catalog

# Una consulta
curl -s -X POST http://localhost:3000/analytics/query \
  -H 'Authorization: Bearer demo-api-empresa-a' \
  -H 'content-type: application/json' \
  -d '{"measures":["reviews.count"],"dimensions":["reviews.status"]}'
# → {"rows":[{"reviews.status":"calibrated","reviews.count":2}, …],
#    "meta":{"servedFrom":"live","asOf":"…","queryId":"4d6d9133c6203dec","warnings":[]}}

# Sin token
curl -s http://localhost:3000/analytics/catalog
# → {"code":"MISSING_TENANT","suggestion":"La petición necesita un token conocido…"}
```

### Códigos de estado

La tabla vive en `src/http/codigos.js`. Lo que no está en ella no es un error
del consumidor: sale como **500** con `{ code: 'INTERNAL_ERROR' }` y el detalle
queda en el log del servidor.

| HTTP | Códigos |
| --- | --- |
| 401 | `MISSING_TENANT` (sin token o token desconocido) |
| 400 | `FORBIDDEN_FIELD`, `UNKNOWN_MEMBER`, `NO_JOIN_PATH`, `INVALID_OPERATOR`, `UNSUPPORTED_OPERATOR`, `MULTI_ENTITY_MEASURES`, `MISSING_TIME_RANGE`, `INVALID_CONSUMER`, `UNKNOWN_QUERY`, `MISSING_PARAM`, `INVALID_JSON` |
| 413 | `PAYLOAD_TOO_LARGE` (el cuerpo pasó los 64 KiB) |
| 503 | `SCHEMA_DRIFT` (la base ya no calza con el catálogo), `SOURCE_UNAVAILABLE` (la base de la fuente no responde; la respuesta lleva `Retry-After: 5`) |
| 504 | `QUERY_TIMEOUT` |
| 500 | cualquier otro error, sin filtrar detalles internos |

`QUERY_TIMEOUT` es 504 y no 503 porque el servicio está sano: lo que se agotó es
el presupuesto de tiempo de esa consulta contra la base. 503 diría "vuelve más
tarde", y volver más tarde con la misma consulta no la haría terminar.

`SCHEMA_DRIFT` sí es 503: el dialecto lo devuelve cuando el motor se queja de
una tabla o una columna que ya no existe, y eso significa que el esquema cambió
debajo de un catálogo ya registrado. No es una consulta mal escrita —el
consumidor no puede arreglarla cambiando lo que pidió—, sino una dependencia
rota hasta que alguien vuelva a introspectar y re-registrar las definiciones.

`SOURCE_UNAVAILABLE` es el otro 503, y es el único que lleva `Retry-After`: la
conexión a la base de la fuente ni siquiera se pudo abrir (`ECONNREFUSED`, un
DNS que no resuelve, la clase 08 de SQLSTATE, el `57P01` con que el servidor
avisa que se apaga, o el timeout de conexión del pool, fijado en 2 s). A
diferencia del `QUERY_TIMEOUT`, aquí volver más tarde con la misma consulta sí
puede funcionar, y el servicio lo dice con la cabecera en vez de dejar que el
cliente lo adivine. Quien traduce esos errores es el dialecto, como cualquier
otro error nativo: el engine no conoce ni un código de socket ni un SQLSTATE.

## Segunda fuente: SQLite

El repo trae un segundo dialecto, `src/dialect/sqlite.js`, sobre el `node:sqlite`
que Node 24 incluye. **No está para producción**: está para probar que el seam
del dialecto aguanta. La prueba es que las mismas definiciones (`reviews`,
`employees`, `departments`), el mismo planificador y el mismo engine responden
el caso obligatorio contra SQLite con **exactamente las mismas filas** que
contra Postgres — Ingeniería 2025-01-01 con promedio 4.35 y 2 completadas,
Ingeniería 2025-04-01 con 3.8 y 1— y `completion_rate` con los mismos 75. Lo
único que cambia en una definición es una línea: `source: 'sqlite'`.

Todo lo que hubo que mover para que eso funcionara está listado en `CLAUDE.md`
("Decisiones de la fase B"): eran cuatro cosas que el planificador y el engine
tenían escritas en dialecto Postgres sin saberlo.

Lo que SQLite **no** puede prometer queda dicho en sus capacidades, no
escondido: `tiposGarantizados: false` (una incompatibilidad de tipo al registrar
es advertencia y no error, porque un tipo declarado es afinidad y no
restricción) y `timeoutDeSentencia: false` (**no hay forma de hacer cumplir el
presupuesto de tiempo**: SQLite no tiene `statement_timeout`, así que el engine
no emite ninguna sentencia de sesión contra esta fuente).

Sus tests no necesitan variables de entorno —la base es en memoria y se arma
desde `test/fixtures/caso-sqlite.sql`, con las mismas 16 evaluaciones del seed—,
así que corren siempre:

```bash
node --test test/sqlite.test.js
```

## Telemetría

El engine cuenta lo que pasó por él y lo expone con `engine.telemetry()`
(`src/telemetry.js`, inyectable y reinicializable). Responde tres preguntas de
plataforma: cuántas consultas se rechazan, con qué código y **en qué puerta**, y
dónde se va el tiempo de base — todo desglosado por consumidor.

```json
{
  "total": 4,
  "byResult": { "ok": 3, "error": 1 },
  "byErrorCode": { "UNKNOWN_MEMBER": 1 },
  "byGate": { "resolverMiembros": 1 },
  "byConsumer": { "dashboard": { "ok": 3, "error": 1, "cacheHits": 1, "cacheMisses": 2 } },
  "cache": { "hits": 1, "misses": 2, "hitRatio": 0.3333333333333333 },
  "database": { "count": 2, "totalMs": 5.4 },
  "clientGone": { "dashboard": 1 }
}
```

`clientGone` cuenta, por consumidor, los clientes que cerraron la conexión antes
de recibir la respuesta. La consulta **no se cancela**: lo que ya se formuló se
termina y se cachea, así el reintento siguiente es un hit y el cómputo no se
pierde (la deuda ya está acotada por el `statement_timeout` de la clase). Lo
que interesa es el indicador: un dashboard que refresca demasiado, o un timeout
del lado cliente más corto que el presupuesto, se ven aquí antes de que alguien
se queje. Cruzado con `database.totalMs / database.count` dice si el problema
es la consulta o el cliente.

`cache.hits` más `cache.misses` son las respuestas que pasaron por la caché, y
`hitRatio` es la proporción que se ahorró la base. Un engine sin caché no reporta
ninguno de los dos: sin caché no hay miss. Una respuesta servida desde la caché
cuenta como `ok` pero **no** suma a `database`, así que el promedio de tiempo de
base sigue siendo el de las consultas que de verdad se ejecutaron.

El SQL que sale a la base va marcado con `/* <queryId> <consumer> */` al inicio:
es lo que permite reconocer en los logs de Postgres a quién pertenece una
consulta lenta. El SQL de `plan()` no lleva la marca, así que el dry-run muestra
el SQL puro y los snapshots del repo no cambian.

`meta.queryId` es el hash de lo que realmente se va a ejecutar y de nada más: el
SQL sin su marca, sus parámetros (serializados de forma canónica, así que
reordenar las claves del JSON no lo cambia), la empresa y la versión del
catálogo. Sale del SQL y no del JSON pedido porque entre los dos hay decisiones
del engine que cambian el resultado sin cambiar la consulta —sobre todo el
**límite efectivo**, que lo pone el presupuesto de la clase de consumidor—: si la
identidad no lo mirara, el tablero (techo de 5000 filas) le dejaría servida a la
API (10000) una entrada recortada.

## Caché

Interfaz `CacheStore` (`src/cache/store.js`): `get(key)`, `set(key, value,
ttlMs)` y `delete(key)`, los tres **async** aunque `MemoryStore` no necesite
esperar nada — la L2 en Redis es otra implementación de la misma interfaz y la
forma la fija el más lento. El engine la recibe en `createEngine({ cache })` y
sin ella sirve todo en vivo.

Dos puertas nuevas en el pipeline: **buscar en caché** después de planificar
—una consulta inválida se rechaza igual, esté o no guardada— y **guardar en
caché** después de ejecutar en vivo.

- **La llave es el `queryId`**, no un valor aparte, con su procedencia escrita al
  lado: `capa:{versión del catálogo}:{empresa}:{queryId}`. La empresa dentro del
  hash hace imposible que una entrada de A sirva a B; la versión del catálogo
  invalida todo al cambiar una definición, sin recorrer nada. Que además esté en
  el **texto** de la llave es lo que permite auditar una caché compartida con un
  `SCAN` en vez de confiar en el hash.
- **`meta.servedFrom`** dice de dónde salió la respuesta:

  | valor | significa |
  | --- | --- |
  | `live` | se ejecutó contra la base |
  | `cache-l1` | estaba en memoria de este proceso |
  | `cache-l2` | estaba en Redis: la calculó otra instancia, o este mismo proceso antes de reiniciar |

  En un hit, `asOf` es el instante de la ejecución que produjo las filas —no el
  de ahora— y las `warnings` son las de esa ejecución.
- **TTL por clase de consumidor**, en la tabla de presupuestos: `dashboard` 60 s,
  `api` y `agent` 30 s. Cuánta antigüedad se tolera es parte de lo que la clase
  puede gastar, igual que el timeout; la consulta no puede elegírselo. **Lo
  evalúa quien lee**, contra el `asOf` de la entrada: una que el tablero dejó
  hace 50 s le sirve a él y la API la trata como miss. Compartir una entrada no
  puede significar heredar la tolerancia del otro.
- **Acotada** a 200 entradas con desalojo LRU y expiración perezosa (se borra al
  leerla vencida): una caché sin techo es una fuga de memoria con otro nombre, y
  un temporizador por entrada mantendría el proceso despierto para borrar algo
  que a nadie le importa.
- **Guarda una copia y entrega copias**: el consumidor que ordena o recorta las
  filas que recibió no puede cambiarle la respuesta al siguiente.
- **El dry-run nunca la toca**, ni para leer ni para escribir.

### Los dos niveles

La L1 vive en el proceso: cada instancia del servicio tiene la suya y se pierde
al reiniciar. La **L2** es Redis (`src/cache/redis-store.js`), compartida por
todas las instancias, y entra por esa misma costura sin que el engine cambie: es
otra implementación de `CacheStore`, con los valores en JSON y el vencimiento por
entrada con `PX`.

Quien las junta es `TieredStore` (`src/cache/tiered.js`), que **también** es un
`CacheStore`: lee L1 → L2, escribe en los dos, deja en L1 la copia de lo que
encontró en L2 y marca la entrada con el nivel del que salió. El engine sólo
traduce eso a `servedFrom` y no sabe cuántos niveles hay.

**Si Redis no responde, no pasa nada.** Cualquier error o timeout de la L2 —200
ms como techo por operación— degrada la respuesta a `cache-l1` o `live` y se
cuenta en `telemetry().cacheErrors` por nivel; ninguna consulta falla por la
caché. `REDIS_URL` es opcional: sin ella el servicio arranca con sólo L1 y lo
dice en el log.

Verlo en marcha:

```bash
Q='{"measures":["reviews.count"],"dimensions":["reviews.status"]}'
post() { curl -s -X POST http://localhost:3000/analytics/query \
  -H 'Authorization: Bearer demo-dashboard-empresa-a' \
  -H 'content-type: application/json' -d "$Q"; }

post; post                       # → servedFrom: live, después cache-l1
docker compose restart api       # reiniciar vacía la L1, no Redis
post                             # → servedFrom: cache-l2, con el asOf original

docker compose stop redis
post                             # → se sirve igual, con 200 y sin esperar
docker compose start redis

# Las llaves, con la empresa a la vista
docker compose exec redis redis-cli --scan --pattern 'capa:*'
# → capa:f711d8d2af20d291:1:265ed64157294826
```

## La demo

```bash
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica \
  REDIS_URL=redis://localhost:6380 npm run demo
```

Registra los módulos contra el esquema real, imprime el catálogo público y
responde las tres preguntas del caso mostrando, para cada una, el JSON de la
consulta, el SQL que generó el planificador y las filas que devolvió Postgres.
Cada pregunta se ejecuta dos veces, para ver `live` y después `cache-l1`.

Después levanta una **segunda instancia** del engine —otro proceso lógico, con su
propia L1 vacía y su propio cliente de Redis— y le pide lo mismo que ya respondió
la primera: sale `cache-l2`, con el `asOf` de la ejecución original. Sin
`REDIS_URL` lo dice y salta esa parte.

Termina con un error a propósito —para ver el error estructurado con su
sugerencia— y con la telemetría de lo que acaba de correr, incluidos los hits por
nivel y los fallos de caché:

```
Caché: 5 hits, 3 misses, hit ratio 63 % (5 de las 8 respuestas no tocaron la base)
Hits por nivel: {"cache-l1":4,"cache-l2":1}
Errores de caché por nivel: {}
```

El seed vive en 2025, así que "los últimos tres meses" de la tercera pregunta
son los últimos tres meses **de los datos** (junio a agosto de 2025), no los del
calendario de hoy.

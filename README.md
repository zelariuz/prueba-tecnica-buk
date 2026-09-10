# Capa Semántica de Analítica

Capa que expone los datos de cada módulo bajo nombres de negocio: un módulo
declara su **definición semántica**, el **catálogo** la registra y el **engine**
traduce una consulta declarativa a SQL, la ejecuta y devuelve filas con nombres
semánticos. El aislamiento por empresa es del motor, no del consumidor.

- **Mapa del repo y diagramas** (arquitectura, viaje de una consulta, caché en
  vivo, flujo del consumidor, agentes y MCP, demo del agente con capturas):
  [`docs/diagramas-y-demo.html`](docs/diagramas-y-demo.html), una sola página
  con pestañas; descargar y abrir en el navegador. La pestaña "Mapa del repo"
  es el plano de `src/` con sus cuatro operaciones HTTP.
- Diseño y decisiones: `prds/prd-capa-semantica.md`, `docs/adr/`.
- Plan de construcción por fases: `plans/plan-capa-semantica.md`.
- Vocabulario: `CONTEXT.md`.

Estado actual: **fase 8, la última del plan** — el caso obligatorio de punta a punta, los
guardarraíles del consumidor (presupuesto por clase: timeout, máximo de filas y
rango temporal exigible —ninguna clase lo exige desde el 09-09, ADR 0009—), el
catálogo como contrato (valida las definiciones
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

- Docker con Compose (Docker Desktop en Windows o Mac; en Linux, el paquete
  `docker` con el plugin `compose`). Con esto solo ya se puede ver el caso
  funcionando (sección siguiente).
- Node 24 o superior, sólo para correr la suite de tests y la demo desde el
  host. `npm` viene con Node. La forma más simple de tener la versión exacta
  es `nvm`:

  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
  # abrir una terminal nueva, y después:
  nvm install 24
  node -v      # v24.x
  npm -v
  ```

  En Windows sin WSL, `nvm-windows` o el instalador de <https://nodejs.org>
  (versión 24 LTS) hacen lo mismo. Sin dependencias globales: `npm install`
  en la raíz instala lo único que el proyecto usa (`pg` y `redis`).

## Cómo correrlo: dos caminos

Elige uno según lo que quieras ver:

- **A · Solo Docker**: ver el caso funcionando, sin instalar Node. Tres comandos.
- **B · Node en el host**: correr la suite de 217 tests y la demo por consola.
  Necesita Node 24 y los contenedores del camino A (al menos `db` y `redis`).
- **C · Con Claude Code**: dejar que Claude levante y explique el repo, y ver
  la demo del agente de IA consultando la capa. Necesita Claude Code con sesión
  iniciada.

### A · Solo Docker

```bash
git clone https://github.com/zelariuz/prueba-tecnica-buk.git && cd prueba-tecnica-buk
docker compose up -d --build              # Postgres 16 con esquema y seed, Redis y el servicio api en :3000
docker compose exec api node src/demo.js  # las tres preguntas del caso, caché L1 y L2, telemetría al final
```

Con eso el servicio ya responde por HTTP; los `curl` de "El servicio HTTP" más
abajo funcionan tal cual con los tokens de demo. Para bajar todo:
`docker compose down`. Si revisas el repo con Claude Code, abre la carpeta y
pide "corre la demo y explícame el caso obligatorio": `CLAUDE.md` trae el mapa
del repo, los comandos y qué mirar.

### B · Tests y demo desde el host (Node 24)

Con los contenedores del camino A arriba. Para la suite el servicio `api` no
hace falta: basta `docker compose up -d db`, y `redis` solo si quieres correr
también los tests de la caché L2 (sin `REDIS_URL` se saltan con aviso y la
suite queda verde con menos de 217):

```bash
npm install
export DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica
export REDIS_URL=redis://localhost:6380
npm test                         # suite completa, 217 tests
npm run demo                     # las tres preguntas del caso, por consola
```

Las dos variables apuntan a los puertos que el compose publica en el host.
`.env.example` las lista como referencia, pero los scripts **no leen `.env`**:
hay que exportarlas en la terminal (en PowerShell,
`$env:DATABASE_URL = "postgres://..."`).

### C · Con Claude Code

Dos usos distintos, ambos con Claude Code instalado y logueado (`claude` y
luego `/login`; `claude --version` debe imprimir un número seguido de
"(Claude Code)"):

1. **Que Claude levante y explique el repo.** Abre la carpeta con `claude` y
   pide "corre la demo y explícame el caso obligatorio". `CLAUDE.md` trae el
   mapa del repo, los comandos de los caminos A y B y qué mirar; Claude los
   ejecuta y comenta el SQL generado.
2. **La demo del agente de IA.** Con los contenedores del camino A arriba:

   ```bash
   cd demo-agente && npm install && npm start    # http://localhost:3100
   ```

   Una página muestra, por cada pregunta en lenguaje natural, lo que viaja
   entre una sesión de Claude Code como consumidor de clase `agent` y la capa:
   catálogo público, JSON, dry-run, consulta real y reintento. Probado con
   Claude Code 2.1.266 y 2.1.267, modelo `claude-sonnet-5`; cada clic gasta
   crédito del plan. Sin Claude logueado la página arranca igual y lo indica.
   Detalle, requisitos y qué mirar: `demo-agente/README.md`.

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

Un tercer archivo, `docker/init/03-seed-empresa-c.sql`, agrega la **empresa C**:
1.750 empleados en 12 departamentos, 15.477 evaluaciones y **1.062.283 filas de
asistencia** (2024 y 2025 día a día). Es la empresa de volumen y sólo eso: sirve
para ver tiempos reales, la caché, el tope de 1.000 filas de la clase `agente` y
la advertencia de índice sobre `attendance.date`, y **ningún test depende de
ella** —los números verificables a mano siguen siendo los de las empresas 1 y 2—.
Es determinista igual (`setseed(0.42)`) y con rangos de id propios. Con los tres
archivos, el initdb del contenedor tarda **~8,8 s** (~8,6 s son la empresa C) y
la base queda en **~104 MB**.

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
UTC-0) no cambia el resultado.

El código hace cumplir ese supuesto al registrar, y no lo deja escrito sólo aquí:
una dimensión `date` sobre una columna **`timestamp` sin zona** se **rechaza**
con `INVALID_DEFINITION` (un instante no es un día, y convertirlo a uno exige
saber la zona de la empresa, que el catálogo todavía no tiene), y sobre un
**`timestamptz`** se **acepta con advertencia de registro**: el rango de una
consulta es cerrado (`>= desde AND <= hasta`), así que comparar un instante
contra el día `hasta` pierde casi todo el último día. Los dos tipos salieron del
mapa de tipos del dialecto justamente para que no se acepten en silencio.
Evolución: `timestamptz` en base, zona declarada por empresa en el catálogo y
`AT TIME ZONE` en el dialecto. Detalle en `docs/riesgos.md`.

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

### Una consulta sin medidas: los valores distintos de una dimensión

`measures` puede omitirse si la consulta pide al menos una dimensión o una
dimensión temporal (ADR 0010). Una consulta así es un `GROUP BY` por esas
dimensiones sin ningún agregado: los **valores distintos** que tienen en la
empresa del contexto. Es lo que responde "cuáles departamentos hay".

```js
await engine.run(
  { dimensions: ['departments.name'], order: { 'departments.name': 'asc' } },
  { companyId: 1, consumer: 'dashboard' },
);
// → [{ 'departments.name': 'Ingeniería' }, { 'departments.name': 'Ventas' }]
```

```sql
WITH departments AS (
  SELECT name
  FROM departments
  WHERE company_id = $1
)
SELECT departments.name AS "departments.name"
FROM departments
GROUP BY departments.name
ORDER BY "departments.name" ASC
LIMIT $2
```

Sigue sin haber forma de pedir filas crudas: el `GROUP BY` colapsa las filas de
la tabla en una por combinación de valores, el filtro de empresa sigue dentro de
la CTE y el `LIMIT` de la clase de consumidor sigue siendo obligatorio. La
entidad de la que sale el `FROM` es la de la **primera** dimensión pedida (o la
de la primera dimensión temporal si no hay dimensiones), y al resto se llega por
las relaciones declaradas: `["employees.active", "departments.name"]` sale de
`employees` y llega a `departments`, mientras que el mismo par al revés corta
con `NO_JOIN_PATH`, porque `departments` no declara relaciones. El SQL está en
`test/snapshots/valores-de-dimension.sql`. Una consulta sin medidas **y** sin
dimensiones sigue siendo `INVALID_QUERY`.

### Un período que sólo filtra: `dateRange` sin `granularity`

`granularity` es opcional en una `timeDimension` (ADR 0011). Con `dateRange` y
sin ella, la fecha **sólo filtra**: acota el período dentro de la CTE de su
entidad y no aparece como columna. Es lo que pide una pregunta que nombra un
período pero no un corte por tiempo —"la tasa de asistencia por departamento
durante los últimos tres meses" es **una fila por departamento**—:

```js
await engine.run(
  {
    measures: ['attendance.attendance_rate'],
    dimensions: ['departments.name'],
    timeDimensions: [{ dimension: 'attendance.date', dateRange: ['2025-06-01', '2025-08-31'] }],
    order: { 'departments.name': 'asc' },
  },
  { companyId: 1, consumer: 'dashboard' },
);
// → [{ 'departments.name': 'Ingeniería', 'attendance.attendance_rate': 92.5925925925926 },
//    { 'departments.name': 'Ventas',     'attendance.attendance_rate': 91.54929577464789 }]
```

El SQL está en `test/snapshots/rango-sin-granularidad.sql`: el rango sigue
siendo `>= $2 AND <= $3` dentro de la CTE de `attendance`, y el `GROUP BY` lleva
sólo el departamento. Agregar `granularity: 'month'` devuelve la tendencia mes a
mes, que es la otra pregunta. Una `timeDimension` **sin** `dateRange` y **sin**
`granularity` es `INVALID_QUERY`: no filtra ni agrupa, así que no dice nada.

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

El plan lógico está escrito **en nombres semánticos**: no hay una tabla ni una
columna física en él. El `sql`, en cambio, las nombra todas, así que **por HTTP
sale sólo a una sesión interna** (`internal: true` en el token): es la misma
razón por la que el mapeo físico no está en la vista pública del catálogo (ADR
0008), y tenerla en un solo lado sería tener media regla. Dentro del proceso,
`engine.plan()` devuelve las dos cosas: quien llama es el servidor.

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
tipos, descripciones, operadores **que el planificador emite**, granularidades y
consultas tipo —cada una con su `query`, la plantilla declarativa tal cual se
registró, con los marcadores `:nombre` sin sustituir: son los ejemplos ya
resueltos que necesita quien sólo lee el catálogo—. Nunca
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

Tres rutas, sin framework (`node:http`). La capa es delgada a propósito: traduce
el token a contexto de sesión `{ companyId, consumer }` (ADR 0002), delega en el
engine y traduce el error estructurado a su código HTTP. No valida miembros, no
arma SQL y no decide presupuestos.

| Ruta | Qué hace |
| --- | --- |
| `POST /analytics/query` | Ejecuta una consulta declarativa. Devuelve `{ rows, meta }`. |
| `POST /analytics/query?dryRun=true` | Devuelve `{ params, plan }` sin tocar la base; agrega `sql` sólo si el token es de una sesión interna. |
| `GET /analytics/catalog` | Devuelve la vista **pública** del catálogo (nunca la interna). |
| `GET /analytics/telemetry` | Contadores del proceso, tabla de presupuestos y tiempo encendido. **Sólo con un token de sesión interna**; cualquier otro token conocido recibe 403. |

El `dryRun` viaja en la URL y no en el cuerpo a propósito: el cuerpo es la
consulta declarativa y nada más, así que pedirlo no cambia su forma ni, por lo
tanto, su `queryId`.

**Autenticación**: fuera de alcance (el PRD la deja a la aplicación). Para poder
ejercitar el contrato hay una tabla en memoria de tokens de demo, cargada de la
variable `DEMO_TOKENS` en JSON —`{ token → { companyId, consumer, internal? } }`,
valores falsos y públicos, ver `.env.example`—. En producción esa función se
reemplaza por el verificador de tokens de la plataforma y nada más cambia.
`internal` es opcional y por defecto falsa; sólo la trae `demo-interno-empresa-a`,
y lo que abre son el SQL del dry-run y `GET /analytics/telemetry`. Va en el
token y no en la consulta
justamente para que un consumidor no pueda pedírsela solo (ADR 0002).

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
| 403 | `FORBIDDEN` (el token se reconoció, pero su sesión no es interna) |
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

## Ver qué se hace, en vivo

La telemetría son contadores agregados: responden *cómo va todo*. Esto responde
*qué acaba de pasar*. El engine emite **un evento por consulta** —una llamada a
`run` o a `plan`, terminara bien o mal— por una costura inyectable,
`createEngine({ observar })` (`src/engine.js`). El servicio `api` la cablea con
una función que escribe **una línea JSON por consulta en stdout**
(`src/server.js`), así que `docker compose logs -f api` muestra en vivo qué se
planificó, si la respuesta salió de la caché o de la base y por qué se rechazó.

```bash
docker compose up -d --build api
docker compose logs -f --no-log-prefix api
```

Una consulta servida en vivo (línea real, cortada aquí sólo para que quepa):

```json
{"t":"2026-09-09T00:21:54.552Z","kind":"run","queryId":"3a5a574285fabfe9","companyId":1,
 "consumer":"dashboard","result":"ok","servedFrom":"live","rows":2,"dbMs":3.79,"warnings":0,
 "plan":{"entity":"reviews","joins":[{"from":"reviews","to":"employees","via":"employee"},
 {"from":"employees","to":"departments","via":"department"}],
 "measures":["reviews.avg_score"],"dimensions":["departments.name"]},"ms":52.16}
```

La misma consulta repetida, servida desde la caché — `servedFrom` cambia y
**`dbMs` no está**, porque no hubo base que consultar:

```json
{"t":"2026-09-09T00:22:06.303Z","kind":"run","queryId":"3a5a574285fabfe9","companyId":1,
 "consumer":"dashboard","result":"ok","servedFrom":"cache-l1","rows":2,"warnings":0,
 "plan":{…},"ms":0.83}
```

Y una rechazada, con la **puerta** que cortó y sin `queryId` —el rechazo ocurrió
antes de que la consulta llegara a tener identidad ni plan—:

```json
{"t":"2026-09-09T00:22:06.316Z","kind":"run","companyId":1,"consumer":"dashboard",
 "result":"error","code":"UNKNOWN_MEMBER","member":"reviews.avg_scor",
 "gate":"resolverMiembros","ms":1.72}
```

Los campos: `kind` (`run` o `plan`, y el dry-run se registra igual), `queryId`,
`companyId` y `consumer` del contexto de sesión, `result`; en un `ok` de `run`,
`servedFrom` (`live` | `cache-l1` | `cache-l2`), `rows`, `dbMs` **sólo si tocó la
base** y `warnings`; en un error, `code`, `member` y `gate`; el `plan` resumido y
`ms`. Lo que no aplica no viaja como `undefined`: no está.

**El evento no lleva nombres físicos.** El `plan` es el plan lógico resumido
—entidad, camino de joins por el *nombre de la relación*, medidas y
dimensiones—, la misma regla que la vista pública del catálogo y el dry-run (ADR
0008): un log se lee en una consola compartida. El SQL entra sólo si se pide a
propósito, con **`LOG_SQL=true`**, que en `docker-compose.yml` está escrito como
ejemplo pero **comentado**: descomentar esa línea y `docker compose up -d
--build api` agrega el campo `sql` a cada evento. Es para desarrollo.

Nada falla por observar: un observador que lanza no rompe la consulta, la misma
regla que la caché.

### El SQL de verdad, desde Postgres

Para ver el SQL tal como llegó al motor —con sus parámetros y su tiempo real—
la fuente es Postgres, no el servicio. La marca `/* queryId consumer */` que el
engine le pone al SQL es lo que permite reconocer cada consulta ahí:

```bash
# Dos `-c` y no uno: psql mete varias sentencias de un mismo `-c` en una
# transacción, y `ALTER SYSTEM` no corre dentro de una.
docker compose exec db psql -U capa -d capa_semantica \
  -c "ALTER SYSTEM SET log_min_duration_statement = 0;" -c "SELECT pg_reload_conf();"
docker compose logs -f --no-log-prefix db | grep -A12 "/\* "
```

Sale el SQL con su marca, su duración y sus parámetros:

```
LOG:  duration: 0.138 ms  execute <unnamed>: /* c2688196684ac270 agent */
	WITH reviews AS (
	  SELECT period
	  FROM performance_reviews
	  WHERE company_id = $1
	    AND period >= $2
	    AND period <= $3
	)
	 SELECT TO_CHAR(DATE_TRUNC('month', reviews.period), 'YYYY-MM-DD') AS "reviews.period", …
DETAIL:  parameters: $1 = '1', $2 = '2025-01-01', $3 = '2025-12-31', $4 = '1000'
```

Lo que se sirve **desde la caché no aparece ahí**: nunca tocó la base. Esa es
justamente la diferencia que el log del servicio sí muestra, con `servedFrom`.
Para dejarlo como estaba: `ALTER SYSTEM RESET log_min_duration_statement;` y
otro `SELECT pg_reload_conf();`.

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

### Leerla por HTTP

`GET /analytics/telemetry` publica los mismos contadores, la tabla de
presupuestos por clase y cuánto lleva encendido el proceso. **Sólo para una
sesión interna**: es la misma marca `internal` del token que abre el SQL del
dry-run, y por la misma razón —cada consumidor ve lo suyo; qué pide el resto es
información de operación—. Sin token conocido es 401 como todo lo demás; con un
token conocido que no es interno, 403 `FORBIDDEN`.

Es de lectura y nada más: **no hay reset por HTTP**. Los contadores viven
mientras viva el proceso, y reiniciarlos desde afuera dejaría a cualquiera
borrando la única evidencia de lo que pasó (con varias instancias, además, sin
saber a cuál se le borró).

```bash
curl -s -H 'Authorization: Bearer demo-interno-empresa-a' \
  http://localhost:3000/analytics/telemetry
# → {"telemetry":{"total":1,"byResult":{"ok":1,"error":0},…,
#                 "byConsumer":{"agent":{"ok":1,"error":0,"cacheHits":0,"cacheMisses":1}},
#                 "cache":{"hits":0,"misses":1,"porNivel":{},"hitRatio":0},
#                 "database":{"count":1,"totalMs":4.34},"clientGone":{}},
#    "budgets":{"dashboard":{"timeoutMs":5000,"maxFilas":5000,"rangoObligatorio":false,"cacheTtlMs":60000},
#               "api":{…,"maxFilas":10000},"agent":{"timeoutMs":10000,"maxFilas":1000,…}},
#    "process":{"uptimeMs":11180,"startedAt":"2026-09-10T01:46:41.375Z"}}

# Con un token de consumidor
curl -s -H 'Authorization: Bearer demo-agente-empresa-a' \
  http://localhost:3000/analytics/telemetry
# → {"code":"FORBIDDEN","suggestion":"La telemetría del servicio sale sólo para una sesión interna…"}
```

La `demo-agente/` la usa: su panel al pie del rastro muestra el presupuesto de
cada clase y los contadores por consumidor después de cada ejecución.

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
  lado: `capa:{versión del catálogo}:{empresa}:{fuente}.{huella}:{queryId}`. La
  empresa dentro del hash hace imposible que una entrada de A sirva a B; la
  versión del catálogo invalida todo al cambiar una definición, sin recorrer
  nada. Que además esté en el **texto** de la llave es lo que permite auditar
  una caché compartida con un `SCAN` en vez de confiar en el hash.
- **La fuente va con su huella** porque el `queryId` identifica la consulta, no
  la base: dos despliegues con una fuente que se llama igual (`postgres`) sobre
  bases distintas producen el mismo `queryId`, y si compartieran un Redis
  compartirían entradas. La huella son 8 hex de la identidad de la fuente, por
  prioridad: el `id` que configure quien despliega en el mapa `fuentes`; lo que
  el motor sabe de sí mismo (en Postgres, el `system_identifier` de
  `pg_control_system()`, que las réplicas físicas heredan: réplicas del mismo
  primario, misma huella); la conexión del pool (host, puerto y base, nunca la
  credencial); y por último el nombre. Se resuelve una vez por fuente y
  `engine.identidadDeFuente(nombre)` dice cuál origen ganó. Para separar
  ambientes que comparten un Redis existe además **`CACHE_PREFIX`** (por
  defecto `capa`).
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
dice en el log. `CACHE_PREFIX` (opcional, por defecto `capa`) es el prefijo de
las llaves en Redis: uno por ambiente cuando varios comparten el mismo Redis.

**Tamaño de una entrada y límites de Redis.** Redis admite hasta **512 MB por
valor** (un string, según su documentación); las llaves, 64 KB. Nuestras
entradas son el JSON de las filas agregadas más `meta`, así que el techo real
lo pone el presupuesto de filas por clase: unos 100-150 KB para `agent`
(1 000 filas), 0,5-0,8 MB para `dashboard` (5 000) y 1-1,5 MB para `api`
(10 000), con filas como las del caso; muchas dimensiones de texto pueden
duplicarlo. La capa no fija un tope de bytes por entrada: confía en el tope
de filas. El Redis del `docker-compose.yml` corre sin `maxmemory` y sin
política de desalojo (las entradas mueren sólo por TTL, 30-60 s); en
producción va `maxmemory` con `allkeys-lru`, como recomienda la sección de
riesgos.

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

## Demo agente

`demo-agente/` es una página aparte que muestra **lo que viaja** entre un
consumidor y la capa: el JSON de la consulta, el plan y el SQL del dry-run
interno, y las filas de la consulta real con el token de clase `agente`, salto
por salto y con el nombre del token en cada uno. Tiene dos caminos: la pregunta
preparada que va directo a la capa, y el mismo recorrido con el JSON escrito por
una sesión de Claude Code que **solo conoce el catálogo público**.

Habla con la capa solo por HTTP, no importa nada de `src/` y tiene sus propios
tests (`cd demo-agente && npm test`, sin Docker ni Claude Code). Con la capa
arriba se levanta con `cd demo-agente && npm start` y vive en
<http://localhost:3100/>.

Cómo levantarla, qué muestra cada salto y cuánto cuesta cada llamada al agente:
[`demo-agente/README.md`](demo-agente/README.md). El QA de las preguntas preparadas (hoy 12: las 3 del enunciado con su texto literal, las 3 del caso, otras 5 y la trampa) por
los dos caminos: [`demo-agente/docs/qa.md`](demo-agente/docs/qa.md).

## Riesgos que se cerraron con código

Los que valían un test, con lo que se hizo y por qué. El registro completo,
incluidos los que se resuelven con infraestructura o quedaron como evolución
(PgBouncer, réplicas, particiones, `EXPLAIN`, cola de trabajos), está en
[`docs/riesgos.md`](docs/riesgos.md).

**Nivel** (severidad, la misma escala del registro completo) = impacto × probabilidad **sin** la mitigación. *Alto*: un consumidor
recibe datos de otra empresa o un número falso sin aviso, o la base deja de
responder. *Medio*: el fallo es visible y acotado (un error claro, una
respuesta degradada). *Bajo*: cosmético.

| Nivel | Riesgo | Qué se hizo | Por qué así | Dónde se prueba |
|---|---|---|---|---|
| Alto | El consumidor manda un `companyId` propio o ajeno | El JSON no tiene ese campo; el contexto `{ companyId, consumer }` lo construye el servidor desde el token. Si viene en el cuerpo, `FORBIDDEN_FIELD` (400) | Un solo lugar decide la empresa; ninguna consulta puede elegirla | `test/http.test.js`, `test/plan.test.js` |
| Alto | Un JOIN arrastra filas de otra empresa | `company_id = $1` dentro de la CTE de **cada** entidad, no sólo en la de hechos | El aislamiento no depende del camino de joins ni de que alguien se acuerde; la evaluación 1010 del seed (empresa 1, empleado de la 2) lo demuestra | invariante sobre todas las consultas tipo; 100 consultas alternadas A/B en una sola conexión (`test/run.test.js`) |
| Medio | El catálogo público revela tablas o columnas | Dos vistas; la pública no contiene ningún nombre físico, ni siquiera dentro de una descripción | Es el contexto que lee un agente: lo que no se publica no existe para él | test de fuga en `test/catalog.test.js` (rechazó la palabra `score` en minúscula dentro de una descripción el 10-09) |
| Alto | `completion_rate` = 0 por división entera | Derivadas tipo `ratio` sobre agregados con `::numeric` y `NULLIF`; la fórmula se escribe fuera de la subconsulta agregada | La fórmula no puede ver una fila; 3 de 4 da 75, no 0 | `test/run.test.js`, snapshot `completion-rate.sql`, y contra SQLite |
| Alto | Fan-out al mezclar medidas de dos entidades | Medidas de una sola entidad por consulta: `MULTI_ENTITY_MEASURES` | Un headcount junto a un promedio de evaluaciones multiplica el headcount por evaluaciones; mejor rechazar que mentir | `test/plan.test.js` |
| Alto | Una consulta que no termina | `SET LOCAL statement_timeout` por clase dentro de la transacción, `LIMIT` siempre, `QUERY_TIMEOUT` (504) con sugerencia; la conexión vuelve limpia al pool | El presupuesto lo fija la clase del token, nunca la consulta. Medido con 1 062 283 filas: la consulta por departamento y día de dos años devuelve 1 000 filas justas en 640 ms | `test/run.test.js` (doble de pool con `pg_sleep`), `test/plan.test.js` (LIMIT efectivo) |
| Medio | Redis se cae o se cuelga | `TieredStore` traga los fallos de la L2, 200 ms de tope por operación, y el engine envuelve sus dos puertas de caché en `try/catch` | Una caché que tumba el servicio es peor que no tener caché; medido: con Redis parado, 200 en 230 ms y la repetida en 2 ms desde L1 | `test/cache-l2.test.js`, `test/redis.test.js` |
| Medio | El esquema cambia debajo del catálogo | `register(def, snapshot)` valida contra la introspección real al arrancar; en ejecución, `42703`/`42P01` se traducen a `SCHEMA_DRIFT` (503) | Un servicio que arranca con un contrato roto es peor que uno que no arranca; y un error crudo del motor no le sirve a nadie | `test/catalog.test.js`, `test/run.test.js` |
| Medio | Un agente inventa un miembro | `UNKNOWN_MEMBER` con sugerencia por distancia de edición; el agente de la demo responde `noPuedo` si el catálogo no lo publica | Errores con qué hacer, no sólo qué falló: es lo que permite el reintento | `test/catalog.test.js`, `demo-agente/docs/qa.md` (la trampa del sueldo, por los dos caminos) |

## Anexo: fuente alterna (SQLite)

Esta sección va al final porque no es parte del servicio: el `api` corre con
una sola fuente, Postgres. SQLite entró como **prueba del seam del dialecto**
(¿aguanta un motor de verdad distinto?) y vive sólo en la suite; se deja aquí
como referencia de qué hay que escribir para sumar un motor.

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

## Diagramas y demo en una sola página

[`docs/diagramas-y-demo.html`](docs/diagramas-y-demo.html) (≈10 MB, sin
dependencias externas salvo Mermaid desde cdnjs para dos páginas) reúne en
pestañas los diagramas de diseño, arquitectura y flujos, la tabla de riesgos y
cambios, el registro de tests y la página de la demo del agente con capturas
reales. GitHub no renderiza HTML: hay que descargarlo y abrirlo en el
navegador. Se genera con `generar-artefacto-unico.py --repo` desde la carpeta
de diagramas del proyecto, fuera de este repo.

## Autoría y uso de IA

Autor: **Bastián Hermosilla N.** Construido con Claude Code (Claude Fable 5.1)
como asistente de diseño, código y tests; las decisiones de diseño, el corte de
alcance, la revisión y la defensa son del autor. El enunciado permite el uso de
IA explícitamente; se declara aquí porque la forma de trabajo es parte de la
solución.

Cómo se hizo, en orden: interrogatorio de diseño con una pregunta por turno y
una decisión por respuesta (registrado en el glosario `CONTEXT.md` y en los
ADRs de `docs/adr/`); PRD con diagrama de flujo y plan en fases verticales;
construcción fase por fase con TDD estricto (test primero, un agente por fase);
revisión cruzada entre fases (estándares del repo y fidelidad al plan); un pase
adversarial completo antes del cierre, con sus hallazgos corregidos uno por
commit; QA registrado en `docs/qa.md`. Cada decisión no obvia tiene un ADR con
sus alternativas descartadas, y cada garantía del enunciado tiene un test que
ejecuta contra Postgres real.

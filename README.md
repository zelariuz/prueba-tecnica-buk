# Capa Semántica de Analítica

Capa que expone los datos de cada módulo bajo nombres de negocio: un módulo
declara su **definición semántica**, el **catálogo** la registra y el **engine**
traduce una consulta declarativa a SQL, la ejecuta y devuelve filas con nombres
semánticos. El aislamiento por empresa es del motor, no del consumidor.

- Diseño y decisiones: `prds/prd-capa-semantica.md`, `docs/adr/`.
- Plan de construcción por fases: `plans/plan-capa-semantica.md`.
- Vocabulario: `CONTEXT.md`.

Estado actual: **fase 6** — el caso obligatorio de punta a punta, los
guardarraíles del consumidor (presupuesto por clase: timeout, máximo de filas,
rango temporal obligatorio), el catálogo como contrato (valida las definiciones
contra el esquema real, se describe en dos vistas, se versiona por hash y
registra consultas tipo), las medidas derivadas (razones calculadas sobre
agregados, con la semántica de filtros escrita y un dry-run que devuelve el plan
lógico sin tocar la base) y **el servicio HTTP**: `POST /analytics/query` y
`GET /analytics/catalog` con contexto derivado del token, telemetría en memoria,
un segundo módulo (asistencia, con `attendance_rate`) y una demo por consola.

## Requisitos

- Node 24 o superior.
- Docker con Compose.

## Cómo correr

```bash
npm install
docker compose up -d --build     # db (Postgres 16 con esquema y seed), redis y api
cp .env.example .env             # referencia de variables

export DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica
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

`docker compose up -d redis` deja levantada la caché L2; todavía no la usa nadie
(entra en la última fase del plan).

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
igualdad en cada corrida de tests. El rango temporal es cerrado en ambos
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
| 504 | `QUERY_TIMEOUT` |
| 500 | cualquier otro error, sin filtrar detalles internos |

`QUERY_TIMEOUT` es 504 y no 503 porque el servicio está sano: lo que se agotó es
el presupuesto de tiempo de esa consulta contra la base. 503 diría "vuelve más
tarde", y volver más tarde con la misma consulta no la haría terminar.

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
  "byConsumer": { "dashboard": { "ok": 3, "error": 1 } },
  "database": { "count": 3, "totalMs": 8.0 }
}
```

El SQL que sale a la base va marcado con `/* <queryId> <consumer> */` al inicio:
es lo que permite reconocer en los logs de Postgres a quién pertenece una
consulta lenta. El SQL de `plan()` no lleva la marca, así que el dry-run muestra
el SQL puro y los snapshots del repo no cambian.

`meta.queryId` es el hash de tres cosas y de ninguna más: la forma de la consulta
con sus parámetros (serializada de forma canónica, así que reordenar las claves
del JSON no lo cambia), la empresa y la versión del catálogo.

## La demo

```bash
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica npm run demo
```

Registra los módulos contra el esquema real, imprime el catálogo público y
responde las tres preguntas del caso mostrando, para cada una, el JSON de la
consulta, el SQL que generó el planificador y las filas que devolvió Postgres.
Termina con un error a propósito —para ver el error estructurado con su
sugerencia— y con la telemetría de lo que acaba de correr.

El seed vive en 2025, así que "los últimos tres meses" de la tercera pregunta
son los últimos tres meses **de los datos** (junio a agosto de 2025), no los del
calendario de hoy.

# Capa Semántica de Analítica

Capa que expone los datos de cada módulo bajo nombres de negocio: un módulo
declara su **definición semántica**, el **catálogo** la registra y el **engine**
traduce una consulta declarativa a SQL, la ejecuta y devuelve filas con nombres
semánticos. El aislamiento por empresa es del motor, no del consumidor.

- Diseño y decisiones: `prds/prd-capa-semantica.md`, `docs/adr/`.
- Plan de construcción por fases: `plans/plan-capa-semantica.md`.
- Vocabulario: `CONTEXT.md`.

Estado actual: **fase 4** — el caso obligatorio de punta a punta, los
guardarraíles del consumidor (presupuesto por clase: timeout, máximo de filas,
rango temporal obligatorio) y el catálogo como contrato: valida las definiciones
contra el esquema real, se describe en dos vistas, se versiona por hash y
registra consultas tipo.

## Requisitos

- Node 24 o superior.
- Docker con Compose.

## Cómo correr

```bash
npm install
docker compose up -d db          # Postgres 16 con el esquema del caso y el seed
cp .env.example .env             # opcional: referencia de variables

export DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica
npm test
```

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

La base es **efímera a propósito**: el compose no monta volumen persistente, así
que recrear el contenedor vuelve a aplicar `docker/init/01-schema.sql` (el
esquema del caso, sin cambios) y `docker/init/02-seed.sql` (seed determinista de
dos empresas). Los conteos esperados están calculados a mano en el encabezado
del seed; los tests los usan como literales.

```bash
docker compose up -d --force-recreate db   # vuelve a cero: esquema + seed
```

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
una tabla ni una columna (ADR 0008); el mapeo físico solo sale con
`describe({ ...ctx, internal: true })`, del lado del servidor.

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

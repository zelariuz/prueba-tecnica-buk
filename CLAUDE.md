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
  dialect/postgres.js        capacidades del motor (dateTrunc, agregadoFiltrado)
  catalog.js                 registro de definiciones en memoria
  engine.js                  planificación (BFS de joins + CTE + agregación) y ejecución
  errors.js                  SemanticError { code, member, suggestion }
test/
  plan.test.js               seam engine.plan — sin base
  run.test.js                seam engine.run — contra Postgres, se salta sin DATABASE_URL
  snapshots/caso-obligatorio.sql  SQL esperado del caso, comparado por igualdad
docker/init/
  01-schema.sql            DDL del caso, copiado sin cambios
  02-seed.sql              seed determinista + conteos esperados en el encabezado
docker-compose.yml         db (Postgres 16, host 5433) y redis (host 6380)
```

## Comandos

```bash
npm install
docker compose up -d db                       # base con esquema y seed
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica npm test
docker compose up -d --force-recreate db      # re-aplicar esquema y seed
```

## Convenciones

- Rama de trabajo `desarrollo`; commits `[<parte>] descripción` en español, uno
  al cierre de cada fase con los tests en verde.
- TDD estricto: un test de comportamiento por vez, red → green → refactor.
  Los tests entran solo por los seams acordados en el PRD: `engine.run`,
  `engine.plan`, `catalog.register` y `catalog.describe`.
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

## Estado

Fase 2 terminada: el caso obligatorio de punta a punta —joins por relaciones,
CTE por entidad con su filtro de empresa, `timeDimensions` con granularidad y
rango, medida `avg`, medida filtrada por segmento con `COUNT(*) FILTER`,
`order`, `limit`, conversión de `int8`/`numeric` a número y error
`MULTI_ENTITY_MEASURES`. Siguiente: fase 3 (guardarraíles: presupuestos por
consumidor, `UNKNOWN_MEMBER` con sugerencia, `MISSING_TIME_RANGE`).

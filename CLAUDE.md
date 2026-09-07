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
  definitions/consultas-tipo.js  tres plantillas del caso con parámetros `:nombre`
  dialect/postgres.js        capacidades del motor (dateTrunc, agregadoFiltrado)
  budgets.js                 presupuesto por clase de consumidor (timeout, filas, rango)
  catalog.js                 registro y validación de definiciones, resolución de
                             miembros, vistas pública e interna, versión y
                             consultas tipo
  introspect.js              snapshot del esquema desde information_schema/pg_indexes
  suggest.js                 distancia de edición y sugerencia del nombre más parecido
  vocabulary.js              operadores por tipo de dimensión y granularidades
  engine.js                  planificación (BFS de joins + CTE + agregación) y ejecución
                             transaccional con SET LOCAL statement_timeout
  errors.js                  SemanticError { code, member, suggestion }
test/
  plan.test.js               seam engine.plan — sin base
  run.test.js                seam engine.run — contra Postgres, se salta sin DATABASE_URL
  catalog.test.js            seams catalog.register y catalog.describe — sin base
                             salvo el único test del introspector
  snapshots/caso-obligatorio.sql  SQL esperado del caso, comparado por igualdad
  fixtures/snapshot.json     foto del esquema generada desde la base del caso
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

## Estado

Fase 4 terminada: el catálogo como contrato — validación de forma y de esquema
al registrar, advertencias, introspector con foto fija en el repo, vistas
pública e interna, versión por hash, `UNKNOWN_MEMBER` con sugerencia por
distancia de edición, `INVALID_OPERATOR`/`UNSUPPORTED_OPERATOR` contra la tabla
de operadores por tipo, filtros y segmentos de consulta y tres consultas tipo
recorridas por un test que verifica el invariante de empresa en cada CTE.
Siguiente: fase 5 (medidas derivadas ratio, semántica de filtros y dry-run).

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

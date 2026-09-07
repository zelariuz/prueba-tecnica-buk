# Plan: Capa Semántica de Analítica

> PRD de origen: `prds/prd-capa-semantica.md`. Vocabulario: `CONTEXT.md`.
> Decisiones: `docs/adr/`. Cada fase es una rebanada vertical: entra por el
> seam público, atraviesa definiciones, catálogo, engine y base, y se
> demuestra con tests que ejecutan contra Postgres.

## Decisiones arquitectónicas

Duraderas; aplican a todas las fases.

- **Esquema de datos**: el DDL del caso, sin cambios, sin tablas nuevas. Seed
  determinista de dos empresas con nombres de departamento repetidos entre
  ambas, un empleado inactivo, evaluaciones `pending`, `completed` y
  `calibrated` en 2024 y 2025, una evaluación cuya empresa no coincide con la
  de su empleado, un departamento con 3 evaluaciones completadas de 4, y
  asistencia de dos meses. Números esperados calculables a mano.
- **Modelos clave** (formas, no archivos): definición de entidad (tabla,
  clave, columna de empresa, dimensión temporal, descripción, dimensiones,
  medidas con filtros declarativos, segmentos, relaciones `many_to_one`,
  derivadas `ratio`); consulta declarativa con vocabulario Cube; contexto de
  sesión `{ companyId, consumer }`; error estructurado `{ code, member,
  suggestion }`; respuesta `{ rows, meta: { servedFrom, asOf, queryId } }`.
- **Seams de test**: `engine.run(consulta, ctx)`, `engine.plan(consulta, ctx)`,
  `catalog.register(def, snapshot)` y `catalog.describe(ctx)`.
- **Rutas HTTP**: `POST /analytics/query`, `GET /analytics/catalog`. La capa
  HTTP deriva el contexto del token y delega; sin lógica de negocio.
- **Autenticación**: fuera de alcance; la aplicación entrega usuario autenticado.
- **Tenancy**: por columna `company_id`, dentro de la CTE de cada entidad (ADR 0003).
- **Estructura de módulos**: definiciones, catálogo, engine (puertas), dialecto,
  caché, http, demo. Cada uno con interfaz pequeña; el engine no conoce
  módulos concretos.
- **Runtime y herramientas**: JavaScript puro, Node 24, `node:test`,
  node-postgres, docker-compose con `db` (`postgres:16`), `redis` y `api`.
  Variables `DATABASE_URL` y `REDIS_URL`; los tests que las necesitan se
  saltan con aviso si faltan.
- **Comandos**: `docker compose up -d db redis`, `npm test`, `npm run demo`.
- **Git**: `main` recibe merges; trabajo en rama `desarrollo` (desde
  `investigacion`); commits `[<parte>] descripción` en español; un commit al
  cierre de cada fase con los tests en verde.
- **Orden de riesgo**: las fases 1 a 6 son el núcleo evaluado; 7 y 8 son la
  caché. Si el tiempo no alcanza, se entrega hasta donde los tests estén verdes
  y lo restante se documenta como evolución con su costura.

---

## Fase 1: Entorno y primera consulta de punta a punta

**Historias de usuario**: 1, 12, 28, 32
**Bloqueada por**: Ninguna — puede empezar de inmediato

### Qué construir

El tracer bullet más angosto que atraviesa todo: base en Docker con el
esquema y el seed, infraestructura de tests, una definición mínima de la
entidad de evaluaciones (tabla, clave, columna de empresa, descripción, una
medida `count` y una dimensión `status`), un catálogo que la registra en
memoria, y un engine que ejecuta `{ measures: ['reviews.count'],
dimensions: ['reviews.status'] }` para una empresa: genera una CTE con
`company_id = $1`, ejecuta con parámetros y devuelve filas con nombres
semánticos. Sin joins, sin tiempo, sin validación elaborada.

### Criterios de aceptación

- [ ] `docker compose up -d db` levanta Postgres 16 con el esquema del caso y el seed de dos empresas.
- [ ] `npm test` corre con `node:test`; los tests con base se saltan con aviso si falta `DATABASE_URL`.
- [ ] Conteo de evaluaciones por estado para la empresa A coincide con el seed; el mismo JSON para la empresa B da otros números.
- [ ] El SQL generado contiene una CTE sobre `performance_reviews` con `company_id = $1` y ningún valor de empresa interpolado.
- [ ] Faltar el contexto produce `MISSING_TENANT`.

---

## Fase 2: Caso obligatorio con joins, tiempo y medidas filtradas

**Historias de usuario**: 2, 3, 10, 11, 21
**Bloqueada por**: Fase 1

### Qué construir

La consulta del caso: score promedio y evaluaciones completadas por
departamento y trimestre de 2025. Relaciones `many_to_one` desde evaluaciones
hacia empleados y de empleados hacia departamentos; el engine encuentra el
camino y emite una CTE por entidad, cada una con su filtro de empresa;
`timeDimensions` con granularidad y rango; medida `avg`; medida `count` con
filtro declarativo expresado como segmento `completed`; `order` y `limit`;
dialecto Postgres con `DATE_TRUNC` y `COUNT(*) FILTER`; conversión de `int8` y
`numeric` a número en la respuesta.

### Criterios de aceptación

- [ ] La consulta declarativa del caso devuelve, por departamento y trimestre, los valores calculados a mano desde el seed.
- [ ] Toda CTE sobre una tabla con `company_id` contiene `company_id = $1`; el rango temporal viaja como parámetros.
- [ ] La empresa B, con departamentos del mismo nombre, obtiene sus propios números y nunca los de A.
- [ ] Snapshot del SQL generado del caso obligatorio.
- [ ] `COUNT` y `AVG` llegan como número; una fila inconsistente entre tablas queda excluida y un test lo muestra.

---

## Fase 3: Guardarraíles del consumidor

**Historias de usuario**: 20, 23, 26, 27, 29, 30
**Bloqueada por**: Fase 2

### Qué construir

Lo que impide que un consumidor dañe la base o vea otra empresa. Contexto
con clase de consumidor y presupuestos por clase: timeout fijado con
`SET LOCAL` dentro de una transacción, límite máximo de filas, rango temporal
obligatorio para el agente. Rechazos: `FORBIDDEN_FIELD` si el JSON trae
`companyId` o `consumer`; `MULTI_ENTITY_MEASURES` si las medidas vienen de
dos entidades; `MISSING_TIME_RANGE` cuando el presupuesto lo exige. La
conexión vuelve limpia al pool tras un error.

### Criterios de aceptación

- [ ] `companyId` o `consumer` en el JSON → `FORBIDDEN_FIELD`.
- [ ] Medidas de evaluaciones y de empleados en la misma consulta → `MULTI_ENTITY_MEASURES` con mensaje que nombra ambas entidades.
- [ ] Consumidor `agent` sin rango temporal → `MISSING_TIME_RANGE`; `dashboard` con la misma consulta ejecuta.
- [ ] Una consulta que excede el timeout del consumidor termina con error estructurado y la conexión queda usable (pool de tamaño 1, siguiente consulta funciona).
- [ ] Pool de tamaño 1 con empresas A y B alternadas: ningún cruce en cien iteraciones.
- [ ] El `limit` pedido nunca supera el máximo del consumidor.

---

## Fase 4: Catálogo validado, descubrible y con consultas tipo

**Historias de usuario**: 5, 6, 7, 8, 13, 14, 15, 16, 22, 24, 33
**Bloqueada por**: Fase 2

### Qué construir

El catálogo como contrato. `register(def, snapshot)` valida forma,
descripción obligatoria y columna de empresa, comprueba tablas y columnas
contra un snapshot del esquema físico y devuelve advertencias (dimensión
temporal sin índice); un introspector produce el snapshot desde
`information_schema` y `pg_indexes`. `describe(ctx)` entrega la vista pública
sin nombres físicos. Consultas tipo con nombre y parámetros. Errores con
sugerencia: `UNKNOWN_MEMBER` por distancia de edición, `NO_JOIN_PATH`,
`INVALID_OPERATOR`. Versión del catálogo como hash.

### Criterios de aceptación

- [ ] Registrar una definición con columna inexistente en el snapshot falla al registrar, no al consultar.
- [ ] Definición sin descripción o sin columna de empresa se rechaza.
- [ ] El introspector contra la base de Docker produce un snapshot con el que las definiciones del caso registran sin error.
- [ ] `describe(ctx)` no contiene ningún nombre de tabla ni columna física, y lista entidades, dimensiones con tipo y operadores, medidas, segmentos y granularidades.
- [ ] `avg_scor` → `UNKNOWN_MEMBER` con sugerencia `reviews.avg_score`; dos entidades sin relación → `NO_JOIN_PATH`.
- [ ] Cada consulta tipo registrada genera su SQL esperado y devuelve filas; un test las recorre todas y verifica el invariante de `company_id = $1`.
- [ ] Todos los tests del catálogo corren sin base, con snapshot inyectado.

---

## Fase 5: Medidas derivadas, semántica de filtros y dry-run

**Historias de usuario**: 4, 18, 25
**Bloqueada por**: Fase 4

### Qué construir

`completion_rate` como derivada `ratio` calculada sobre agregados:
numerador y denominador se resuelven como medidas base en la consulta
agregada y la fórmula se emite sobre sus alias con conversión a numérico y
división segura. Orden topológico al registrar; ciclos rechazados. Semántica
de filtros escrita y aplicada: los globales afectan a todas las medidas, el
filtro propio de una medida se suma; advertencia en `meta` cuando un filtro
global anula el denominador de una razón. `engine.plan` devuelve
`{ sql, params, plan }` sin tocar la base.

### Criterios de aceptación

- [ ] Departamento con 3 completadas de 4 → `completion_rate` = 75, ejecutado contra Postgres.
- [ ] Derivada que se referencia en círculo → rechazo al registrar.
- [ ] Consulta con filtro global `status = completed` y `completion_rate` → filas con 100 y advertencia en `meta`; la misma consulta sin filtro global → 75.
- [ ] `engine.plan` devuelve SQL, parámetros y plan lógico sin abrir conexión; una consulta inválida devuelve el error estructurado.
- [ ] Snapshot del SQL de `completion_rate` junto al del caso obligatorio.

---

## Fase 6: Servicio HTTP, demo, telemetría y módulo de asistencia

**Historias de usuario**: 9, 17, 19, 31
**Bloqueada por**: Fases 3 y 5

### Qué construir

La capa que usan los consumidores reales. `POST /analytics/query` y
`GET /analytics/catalog`: derivan el contexto de un token simple, delegan y
devuelven `{ rows, meta }` o el error estructurado con su código HTTP.
Telemetría en memoria por resultado, código de error, puerta y duración de
base, expuesta por el engine. Un segundo módulo, asistencia, con su
definición y `attendance_rate`, registrado sin tocar el engine. `npm run
demo` registra definiciones, imprime el catálogo público y responde las tres
preguntas del caso mostrando JSON, SQL y filas, y al final la telemetría.
El servicio `api` corre en docker-compose.

### Criterios de aceptación

- [ ] Prueba de humo HTTP: consulta válida → 200 con filas; sin token → 401; `UNKNOWN_MEMBER` → 400 con el cuerpo estructurado.
- [ ] Tasa de asistencia por departamento de los últimos tres meses responde con los valores del seed, sin cambios en el engine.
- [ ] `npm run demo` imprime las tres preguntas con JSON, SQL y filas, y los contadores de telemetría cuadran con lo ejecutado.
- [ ] `docker compose up` levanta `db` y `api`, y el endpoint responde.
- [ ] `meta` incluye `servedFrom`, `asOf` y `queryId` reproducible para la misma forma y empresa.

---

## Fase 7: Caché L1 en memoria

**Historias de usuario**: 34
**Bloqueada por**: Fase 6

### Qué construir

Interfaz de caché con una implementación en memoria del proceso, acotada y
con vida corta. Dos puertas nuevas: buscar antes de ejecutar y guardar
después. Llave: hash de la forma con parámetros, empresa y versión del
catálogo. `servedFrom` distingue `live` de `cache-l1`; `asOf` conserva el
instante de la ejecución original. La telemetría reporta el hit ratio. La
demo ejecuta cada pregunta dos veces.

### Criterios de aceptación

- [ ] Segunda ejecución de la misma consulta → `cache-l1`, mismas filas, sin consulta a la base (verificable por telemetría).
- [ ] La empresa B con la misma forma no recibe la entrada de la A.
- [ ] Cambiar la versión del catálogo invalida las entradas.
- [ ] La entrada expira según el TTL configurado.
- [ ] El dry-run nunca toca la caché.

---

## Fase 8: Caché L2 en Redis

**Historias de usuario**: 35
**Bloqueada por**: Fase 7

### Qué construir

Segunda implementación de la misma interfaz, sobre Redis, con TTL por
entrada. Lectura L1, luego L2, luego base; escritura en ambos. Si Redis no
responde, el engine sigue con L1 y lo registra en telemetría; ninguna
consulta falla por la caché. Servicio `redis` en docker-compose. La demo
muestra una segunda instancia del engine respondiendo `cache-l2`.

### Criterios de aceptación

- [ ] Con Redis disponible, una segunda instancia del engine responde `cache-l2` a una consulta ya ejecutada por la primera.
- [ ] Con Redis caído, la consulta se sirve (`live` o `cache-l1`) y la telemetría registra el fallo.
- [ ] Las llaves en Redis incluyen la empresa; un test verifica que no existe entrada sin ella.
- [ ] Los tests de Redis se saltan con aviso si falta `REDIS_URL`.
- [ ] `docker compose up` levanta `db`, `redis` y `api`.

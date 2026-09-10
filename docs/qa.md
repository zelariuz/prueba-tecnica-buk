# Registro de QA

Registro público del QA de la capa semántica (discusión 20 del diseño: una fila por criterio, qué se probó, cómo y el resultado). Corrida del 08-09-2026 sobre la rama `desarrollo` contra Docker (Postgres 16, Redis 7 y el servicio `api` reconstruido), con `npm test` en 165/165.

Convención de la columna Resultado: **OK (auto)** = verificado con tests, demo o curl en esta corrida, con la evidencia anotada; **OK (usuario)** = verificado a mano por Bastián; **Pendiente** = falta la revisión manual.

## Criterios de aceptación del plan (43)

| # | Fase | Criterio | Cómo se probó | Resultado |
|---|---|---|---|---|
| 1 | Fase 1 | `docker compose up -d db` levanta Postgres 16 con el esquema del caso y el seed de dos empresas. | `docker compose ps`: db, redis y api running; seed de dos empresas visible en las consultas | OK (auto) |
| 2 | Fase 1 | `npm test` corre con `node:test`; los tests con base se saltan con aviso si falta `DATABASE_URL`. | `npm test` sin variables: 107 tests, 106 pasan, 1 se salta con aviso | OK (auto) |
| 3 | Fase 1 | Conteo de evaluaciones por estado para la empresa A coincide con el seed; el mismo JSON para la empresa B da otros números. | demo 08-09: conteo por estado A ≠ B; test `run.test.js` | OK (auto) |
| 4 | Fase 1 | El SQL generado contiene una CTE sobre `performance_reviews` con `company_id = $1` y ningún valor de empresa interpolado. | snapshot `caso-obligatorio.sql`; dry-run interno muestra `company_id = $1` en cada CTE | OK (auto) |
| 5 | Fase 1 | Faltar el contexto produce `MISSING_TENANT`. | curl sin token → 401 MISSING_TENANT | OK (auto) |
| 6 | Fase 2 | La consulta declarativa del caso devuelve, por departamento y trimestre, los valores calculados a mano desde el seed. | curl caso A: Ingeniería 2025-01-01 4.35/2 y 2025-04-01 3.8/1; test `run.test.js` | OK (auto) |
| 7 | Fase 2 | Toda CTE sobre una tabla con `company_id` contiene `company_id = $1`; el rango temporal viaja como parámetros. | dry-run: params [1, 2025-01-01, 2025-12-31, completed, completed, 5000] | OK (auto) |
| 8 | Fase 2 | La empresa B, con departamentos del mismo nombre, obtiene sus propios números y nunca los de A. | curl caso B: Ingeniería 4.1/1 y 3.3/1, sin filas de A | OK (auto) |
| 9 | Fase 2 | Snapshot del SQL generado del caso obligatorio. | `test/snapshots/*.sql` comparados por igualdad en cada corrida | OK (auto) |
| 10 | Fase 2 | `COUNT` y `AVG` llegan como número; una fila inconsistente entre tablas queda excluida y un test lo muestra. | tests de la fase (`npm test`) | OK (auto: tests) |
| 11 | Fase 3 | `companyId` o `consumer` en el JSON → `FORBIDDEN_FIELD`. | curl body con companyId → 400 FORBIDDEN_FIELD | OK (auto) |
| 12 | Fase 3 | Medidas de evaluaciones y de empleados en la misma consulta → `MULTI_ENTITY_MEASURES` con mensaje que nombra ambas entidades. | tests de la fase (`npm test`) | OK (auto: tests) |
| 13 | Fase 3 | Consumidor `agent` sin rango temporal → `MISSING_TIME_RANGE`; `dashboard` con la misma consulta ejecuta. **Superado el 09-09 por el ADR 0009:** el rango es opcional para `agent`; el mecanismo sigue probado por presupuesto inyectado (`test/plan.test.js`, `test/run.test.js`) y `agent` sin rango ejecuta (headcount por departamento: Ingeniería 2/2, Ventas 2/1). | curl agente sin rango → 200 (09-09) | OK (auto, re-verificado 09-09) |
| 14 | Fase 3 | Una consulta que excede el timeout del consumidor termina con error estructurado y la conexión queda usable (pool de tamaño 1, siguiente consulta funciona). | test `run.test.js` con pool que duerme → QUERY_TIMEOUT; conexión vuelve limpia (pool max 1) | OK (auto) |
| 15 | Fase 3 | Pool de tamaño 1 con empresas A y B alternadas: ningún cruce en cien iteraciones. | test de 100 alternancias A/B sobre una conexión (`run.test.js`) | OK (auto) |
| 16 | Fase 3 | El `limit` pedido nunca supera el máximo del consumidor. | dry-run: LIMIT como último parámetro (5000 dashboard, 10000 api) | OK (auto) |
| 17 | Fase 4 | Registrar una definición con columna inexistente en el snapshot falla al registrar, no al consultar. | `test/snapshots/*.sql` comparados por igualdad en cada corrida | OK (auto) |
| 18 | Fase 4 | Definición sin descripción o sin columna de empresa se rechaza. | tests de la fase (`npm test`) | OK (auto: tests) |
| 19 | Fase 4 | El introspector contra la base de Docker produce un snapshot con el que las definiciones del caso registran sin error. | `test/snapshots/*.sql` comparados por igualdad en cada corrida | OK (auto) |
| 20 | Fase 4 | `describe(ctx)` no contiene ningún nombre de tabla ni columna física, y lista entidades, dimensiones con tipo y operadores, medidas, segmentos y granularidades. | curl catálogo: 4 entidades, 6 consultas tipo, sin nombres físicos, operadores publicados = equals, in, notEquals | OK (auto) |
| 21 | Fase 4 | `avg_scor` → `UNKNOWN_MEMBER` con sugerencia `reviews.avg_score`; dos entidades sin relación → `NO_JOIN_PATH`. | curl `reviews.avg_scor` → UNKNOWN_MEMBER "¿Quisiste decir reviews.avg_score?" | OK (auto) |
| 22 | Fase 4 | Cada consulta tipo registrada genera su SQL esperado y devuelve filas; un test las recorre todas y verifica el invariante de `company_id = $1`. | catálogo publica 6 consultas tipo; demo las ejecuta | OK (auto) |
| 23 | Fase 4 | Todos los tests del catálogo corren sin base, con snapshot inyectado. | `test/snapshots/*.sql` comparados por igualdad en cada corrida | OK (auto) |
| 24 | Fase 5 | Departamento con 3 completadas de 4 → `completion_rate` = 75, ejecutado contra Postgres. | curl: Ingeniería 75, Ventas 0; demo; test SQLite = 75 | OK (auto) |
| 25 | Fase 5 | Derivada que se referencia en círculo → rechazo al registrar. | tests de la fase (`npm test`) | OK (auto: tests) |
| 26 | Fase 5 | Consulta con filtro global `status = completed` y `completion_rate` → filas con 100 y advertencia en `meta`; la misma consulta sin filtro global → 75. | curl: Ingeniería 75, Ventas 0; demo; test SQLite = 75 | OK (auto) |
| 27 | Fase 5 | `engine.plan` devuelve SQL, parámetros y plan lógico sin abrir conexión; una consulta inválida devuelve el error estructurado. | tests de la fase (`npm test`) | OK (auto: tests) |
| 28 | Fase 5 | Snapshot del SQL de `completion_rate` junto al del caso obligatorio. | `test/snapshots/*.sql` comparados por igualdad en cada corrida | OK (auto) |
| 29 | Fase 6 | Prueba de humo HTTP: consulta válida → 200 con filas; sin token → 401; `UNKNOWN_MEMBER` → 400 con el cuerpo estructurado. | tests de la fase (`npm test`) | OK (auto: tests) |
| 30 | Fase 6 | Tasa de asistencia por departamento de los últimos tres meses responde con los valores del seed, sin cambios en el engine. | curl catálogo lista attendance; consulta tipo asistencia-por-departamento; tests 80/50 | OK (auto) |
| 31 | Fase 6 | `npm run demo` imprime las tres preguntas con JSON, SQL y filas, y los contadores de telemetría cuadran con lo ejecutado. | demo: 9 consultas, 8 ok, 1 error, hit ratio 63 %, hits por nivel {l1:4, l2:1} | OK (auto) |
| 32 | Fase 6 | `docker compose up` levanta `db` y `api`, y el endpoint responde. | servicio api reconstruido con --build y verificado con curl | OK (auto) |
| 33 | Fase 6 | `meta` incluye `servedFrom`, `asOf` y `queryId` reproducible para la misma forma y empresa. | tests de la fase (`npm test`) | OK (auto: tests) |
| 34 | Fase 7 | Segunda ejecución de la misma consulta → `cache-l1`, mismas filas, sin consulta a la base (verificable por telemetría). | demo: 9 consultas, 8 ok, 1 error, hit ratio 63 %, hits por nivel {l1:4, l2:1} | OK (auto) |
| 35 | Fase 7 | La empresa B con la misma forma no recibe la entrada de la A. | curl caso B: Ingeniería 4.1/1 y 3.3/1, sin filas de A | OK (auto) |
| 36 | Fase 7 | Cambiar la versión del catálogo invalida las entradas. | catálogo: version 219f834021759c19 (hash); cambia al registrar | OK (auto) |
| 37 | Fase 7 | La entrada expira según el TTL configurado. | tests `cache.test.js` con reloj inyectado | OK (auto) |
| 38 | Fase 7 | El dry-run nunca toca la caché. | dry-run dashboard: {params, plan} sin sql ni columnas físicas; token interno: con sql | OK (auto) |
| 39 | Fase 8 | Con Redis disponible, una segunda instancia del engine responde `cache-l2` a una consulta ya ejecutada por la primera. | restart api → misma consulta servedFrom cache-l2 con asOf original | OK (auto) |
| 40 | Fase 8 | Con Redis caído, la consulta se sirve (`live` o `cache-l1`) y la telemetría registra el fallo. | demo: 9 consultas, 8 ok, 1 error, hit ratio 63 %, hits por nivel {l1:4, l2:1} | OK (auto) |
| 41 | Fase 8 | Las llaves en Redis incluyen la empresa; un test verifica que no existe entrada sin ella. | `docker compose stop redis` → consulta estrenada HTTP 200 en 0,42 s; demo: errores de caché contados | OK (auto) |
| 42 | Fase 8 | Los tests de Redis se saltan con aviso si falta `REDIS_URL`. | `docker compose stop redis` → consulta estrenada HTTP 200 en 0,42 s; demo: errores de caché contados | OK (auto) |
| 43 | Fase 8 | `docker compose up` levanta `db`, `redis` y `api`. | servicio api reconstruido con --build y verificado con curl | OK (auto) |

## Criterios agregados después del plan (07 y 08-09)

| # | Origen | Criterio | Cómo se probó | Resultado |
|---|---|---|---|---|
| A1 | Caso obligatorio | El promedio del caso se calcula solo sobre completadas, como el SQL de referencia del enunciado | curl caso A/B; snapshot; seed documentado | OK (auto) |
| A2 | Telemetría | Un cliente que cierra el socket antes de la respuesta se cuenta en `clientGone` y la consulta se termina y se cachea | test `http.test.js` con socket destruido a los 200 ms | OK (auto) |
| A3 | Fase A | El dialecto es la única pieza que conoce el motor (sintaxis, introspección, tipos, errores); el engine no contiene códigos de Postgres | `grep 57014 src/engine.js` vacío; tests de SCHEMA_DRIFT | OK (auto) |
| A4 | Fase A | Incompatibilidad de tipo declarado vs físico se rechaza al registrar (o advierte si el dialecto no garantiza tipos) | tests `catalog.test.js` | OK (auto) |
| A5 | Fase A | Una consulta que mezcla entidades de dos fuentes se rechaza con NO_JOIN_PATH nombrando las fuentes | test `plan.test.js` | OK (auto) |
| A6 | Fase B | Las mismas definiciones y la misma consulta JSON devuelven las mismas filas en SQLite que en Postgres (caso obligatorio, completion_rate = 75) | `test/sqlite.test.js` (16 tests, sin variables) | OK (auto) |
| A7 | Fase B | Un origen que no responde da SOURCE_UNAVAILABLE 503 con Retry-After y no cuelga el pool | tests `run.test.js` (ECONNREFUSED, ETIMEDOUT, 08xxx, 57P01) y `http.test.js` (Retry-After: 5) | OK (auto) |
| A8 | Disc. 25 | `sum` emite SUM; `count_distinct` existe; `completed_employees` responde la pregunta 2 del enunciado (3 evaluaciones, 2 empleados) | curl: completed_count 3, completed_employees 2 en 2025 empresa A | OK (auto) |
| A9 | Disc. 25 | `equals`/`notEquals` con lista de largo ≠ 1 se rechazan | curl → 400 INVALID_OPERATOR con sugerencia hacia `in` | OK (auto) |
| A10 | Disc. 25 | Consulta sin medidas, granularidad inválida, `order` mal escrito o `limit` inválido dan 400 INVALID_QUERY, nunca 500 | curl sin measures → 400; granularidad `quarterly` → 400 con la lista | OK (auto) |
| A11 | Disc. 25 | El dry-run no expone el esquema físico a un token normal; el SQL solo sale con token interno | curl dry-run dashboard: claves params y plan, sin columnas físicas (corregido en el QA: joins por relación); token interno: con sql | OK (auto) |
| A12 | Disc. 25 | `timestamp` sin zona se rechaza al registrar; `timestamptz` advierte | tests `catalog.test.js` con snapshot modificado | OK (auto) |
| A13 | Disc. 25 | Existe el segmento `active` y `active_headcount`; la regla del enunciado escrita una vez | curl: Ingeniería 2/2, Ventas 2/1 | OK (auto) |
| A14 | Disc. 25 | La vista pública publica solo operadores que el planificador emite | curl catálogo: operadores = equals, in, notEquals | OK (auto) |
| A15 | Disc. 25 | Registrar dos veces la misma entidad con otra definición es INVALID_DEFINITION; con la misma, idempotente | tests `catalog.test.js` | OK (auto) |
| A16 | QA 08-09 | El plan lógico del dry-run describe los joins por relación (`via`) y no por columnas | hallazgo del QA; corregido con test; curl posterior sin employee_id ni department_id | OK (auto) |

## Revisión manual de Bastián

| # | Qué mirar | Resultado |
|---|---|---|
| M1 | `npm run demo`: las tres preguntas se leen y los números coinciden con el seed | Pendiente |
| M2 | README: se puede seguir de arriba abajo y correr todo sin conocimiento previo | Pendiente |
| M3 | Catálogo público (`GET /analytics/catalog`): las descripciones sirven como contexto para un agente | Pendiente |
| M4 | Mensajes de error: las sugerencias dicen qué hacer, no solo qué falló | Pendiente |
| M5 | Cambio de comportamiento: re-registrar una entidad con otra definición ahora es INVALID_DEFINITION (se arma un catálogo nuevo) | Pendiente |

## Hallazgos del QA

| Fecha | Hallazgo | Cómo se replicó | Commit |
|---|---|---|---|
| 08-09 | El plan lógico del dry-run traía `employee_id` y `department_id` en los joins, aunque el SQL ya no salía a un token normal | curl `?dryRun=true` con token dashboard y grep de columnas físicas | `[planner.js] el plan lógico describe los joins por la relación declarada` |

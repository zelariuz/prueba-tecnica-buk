# CONTEXT.md — lenguaje compartido del proyecto

Glosario de la Capa Semántica de Analítica. Los términos se usan igual en el
código, los tests, los ADRs y el documento técnico. Cuando un término tenga
equivalente en Cube, se indica para facilitar la lectura al equipo.

## Dominio

- **Empresa (tenant)**: cliente de la plataforma; una fila de `companies`,
  identificada por `company_id`. No es el usuario: el usuario pertenece a una
  empresa. Toda fila de datos pertenece a exactamente una empresa.
- **Aislamiento de empresa**: garantía de que una consulta de la empresa A
  nunca devuelve, cuenta ni promedia filas de la empresa B.
- **Contexto de sesión**: `{ companyId, consumer }` que la aplicación deriva
  del usuario autenticado y pasa al engine *aparte* de la consulta. El
  consumidor no puede expresarlo en el JSON. Equivalente Cube: `securityContext`.
- **Consumidor**: quien pide datos: `dashboard`, `api` o `agent` (agente de IA).
  Cada clase tiene un presupuesto (timeout, límite de filas, rango obligatorio).

## Definiciones semánticas

- **Definición semántica**: lo que un módulo registra para exponer sus datos
  bajo nombres de negocio. Une el esquema físico con el diccionario.
- **Entidad**: concepto de negocio respaldado por una tabla (`performance_reviews`).
  Declara clave, columna de empresa, dimensión temporal y descripción.
  Equivalente Cube: `cube`.
- **Dimensión**: atributo por el que se agrupa o filtra (`department.name`,
  `reviews.period`). Tiene tipo (`string`, `number`, `date`) y descripción.
- **Medida**: agregación sobre una entidad (`avg_score` = AVG(score),
  `completed_count` = COUNT con filtro). Equivalente Cube: `measure`.
- **Segmento**: filtro con nombre que fija una regla de negocio una sola vez
  (`completed` = `status = 'completed'`). Se declara de forma declarativa,
  nunca como SQL.
- **Medida base**: la que se agrega directamente sobre las filas (`count`,
  `sum`, `avg`). Es lo contrario de una derivada, y lo que una derivada combina.
- **Medida derivada**: se calcula a partir de otras medidas ya agregadas.
  En v1 solo el tipo `ratio`: `{ numerator, denominator, scale }`. Sus medidas
  base entran a la consulta agregada aunque el consumidor no las pida, y no
  salen en las filas si no las pidió.
- **Orden de cálculo de las derivadas**: el orden topológico en que pueden
  calcularse las derivadas de una entidad, cada una después de aquellas de las
  que depende. El catálogo lo resuelve al registrar y rechaza los círculos.
- **Relación**: arista tipada entre entidades (`reviews.employee → employees`,
  `many_to_one`). El engine resuelve los JOIN recorriendo relaciones; el
  consumidor nunca las nombra. Equivalente Cube: `join`.
- **Entidad de hechos**: la entidad de la que salen las medidas de una
  consulta. En v1 hay exactamente una por consulta.

## Catálogo

- **Catálogo**: registro central de definiciones. Valida al registrar, arma el
  grafo de relaciones y expone `describe()`.
- **Esquema físico**: foto descubierta de tablas, columnas, tipos, llaves e
  índices (`information_schema`, `pg_indexes`). Se descubre, no se declara.
- **Snapshot del esquema**: la foto ya materializada que produce
  `introspect(pool)` y contra la que el catálogo valida al registrar:
  `{ schema, tables: { <tabla>: { columns: { <columna>: <tipo> }, indexes:
  [{ name, columns, unique }] } } }`. Inyectarlo permite probar el catálogo sin
  base.
- **Advertencia de registro**: `{ member, warning }` que `register` devuelve sin
  impedir el registro (por ejemplo, dimensión temporal sin índice).
- **Versión del catálogo**: hash sha256 de la serialización canónica de las
  definiciones registradas más el snapshot. Cambia si cambia cualquiera de los
  dos; es lo que invalidará la caché.
- **Diccionario semántico**: significado declarado por humanos de cada
  entidad, dimensión y medida (`description`, valores permitidos, escala).
  No se infiere del nombre.
- **Vista pública del catálogo**: lo que ve un consumidor: nombres semánticos,
  tipos, descripciones, operadores permitidos, consultas tipo. Filtrada por
  empresa y rol. Nunca incluye nombres de tablas ni columnas.
- **Vista interna del catálogo**: mapeo físico completo. Solo del lado del servidor.
- **Consulta tipo**: consulta declarativa con nombre y parámetros, registrada
  por el dueño del módulo. Sirve de plantilla, ejemplo y test de regresión.

## Engine

- **Consulta declarativa**: JSON con `measures`, `dimensions`, `timeDimensions`,
  `filters`, `segments`, `order`, `limit`. Mismo vocabulario que la API de Cube.
- **Puerta**: etapa del pipeline del engine: validar, planificar, ejecutar,
  post-procesar. Cada puerta recibe un contexto y lo devuelve enriquecido, o
  corta con una respuesta. Patrón middleware.
- **Plan lógico**: resultado de planificar sin ejecutar: entidad de hechos,
  camino de joins, dimensiones, medidas pedidas, medidas base resueltas,
  derivadas, filtros globales, filtros por medida, presupuesto aplicado y
  advertencias. Es lo que devuelve el dry-run (`plan(consulta, ctx)`), sin abrir
  conexión.
- **Filtro global**: el que afecta a todas las medidas de la consulta —los
  `filters` del JSON y los `segments` que la consulta nombra—. Se aplica dentro
  de la CTE de la entidad de su dimensión, antes de agregar.
- **Filtro propio de una medida**: el que su dueño le declaró como segmento; se
  suma al global dentro del `FILTER` de esa medida. La regla completa está en
  `docs/semantica-de-filtros.md`.
- **Advertencia de consulta**: `{ member, warning }` que la respuesta trae en
  `meta.warnings` (y el plan lógico en `warnings`) cuando el resultado es
  correcto pero engañoso; por ejemplo, un filtro global que deja una razón en
  100 %. Nunca impide devolver las filas.
- **Error estructurado**: `{ code, member?, suggestion? }`. Códigos:
  `UNKNOWN_MEMBER`, `NO_JOIN_PATH`, `MISSING_TENANT`, `FORBIDDEN_FIELD`,
  `MULTI_ENTITY_MEASURES`, `MISSING_TIME_RANGE`, `INVALID_OPERATOR`,
  `INVALID_CONSUMER` (clase de consumidor desconocida o ausente en el contexto),
  `QUERY_TIMEOUT` (la ejecución superó el timeout del presupuesto),
  `INVALID_DEFINITION` (la definición no cumple la forma o nombra algo que el
  esquema físico no tiene), `UNSUPPORTED_OPERATOR` (operador válido para el tipo
  de la dimensión que el planificador todavía no emite), `UNKNOWN_QUERY`
  (consulta tipo inexistente), `MISSING_PARAM` (falta un parámetro declarado
  por la consulta tipo) y `PAYLOAD_TOO_LARGE` (el cuerpo de la petición superó
  el techo de la capa HTTP).
- **Sugerencia**: el campo `suggestion` de un error. Cuando el problema es un
  nombre, sale de la **distancia de edición** (Levenshtein) contra los miembros
  conocidos, y solo se propone si el candidato está a menos de un tercio del
  largo de lo escrito: una sugerencia lejana confunde más que ninguna.
- **Vocabulario de consulta**: la tabla de operadores válidos por tipo de
  dimensión y la lista de granularidades. Vive en un solo lugar porque el
  catálogo la publica y el engine la aplica.
- **Forma de la consulta**: la consulta con sus valores literales reemplazados
  por parámetros. Dos consultas con la misma forma generan el mismo SQL.
- **Fuente**: conexión física a una base: motor, versión, dialecto, presupuesto.
- **Dialecto**: tabla de capacidades del motor (`agregadoFiltrado`,
  `dateTrunc`, …) que consulta el planificador para elegir la sintaxis.
- **Telemetría**: señales de monitoreo del engine. Se dice "telemetría" y no
  "métrica" para no confundir con las medidas de negocio. Vive en memoria del
  proceso, se lee con `engine.telemetry()` y cuenta, por consumidor: consultas
  servidas y rechazadas, código de error, **puerta que rechazó** y tiempo de
  base (suma y cuenta). Es reinicializable; exportarla está fuera de alcance.
- **Identidad de la consulta (`queryId`)**: hash de la forma de la consulta con
  sus parámetros, más la empresa, más la versión del catálogo. La serialización
  es canónica, así que reordenar las claves del JSON no lo cambia. Viaja en
  `meta.queryId`, marca el SQL que se ejecuta (`/* queryId consumer */`) y será
  la llave de la caché.

## Capa HTTP

- **Token de demo**: entrada de la tabla en memoria `{ token → { companyId,
  consumer } }` que la capa HTTP usa para construir el contexto de sesión. Se
  carga de la variable `DEMO_TOKENS` en JSON. Existe sólo porque la
  autenticación está fuera de alcance: son valores falsos y públicos, y en
  producción los reemplaza el verificador de tokens de la plataforma. Sin token
  conocido no hay empresa que consultar: `MISSING_TENANT`.
- **Mapa de códigos HTTP**: la tabla que traduce el código del error
  estructurado al código de estado (`src/http/codigos.js`). Lo que no está en
  ella es un error del servidor: 500 sin detalles. `INVALID_JSON` y
  `PAYLOAD_TOO_LARGE` son los códigos que nacen en la capa HTTP —el cuerpo no
  llegó a ser una consulta declarativa, o no llegó a leerse entero— y salen como
  400 y 413; `QUERY_TIMEOUT` sale como 504.
- **Techo del cuerpo**: los 64 KiB (`LIMITE_DE_CUERPO`) que la capa HTTP acepta
  como máximo en el cuerpo de una petición. Se cuentan bytes mientras se lee,
  así que un cuerpo sin fin nunca llega a crecer en memoria: al pasarse, la
  lectura se corta con `PAYLOAD_TOO_LARGE` sin que el engine vea nada, y la
  conexión se cierra una vez que la respuesta salió.
- **Dry-run por la API**: `POST /analytics/query?dryRun=true` devuelve
  `{ sql, params, plan }` sin tocar la base. Va en la URL y no en el cuerpo
  porque el cuerpo es la consulta declarativa y nada más.

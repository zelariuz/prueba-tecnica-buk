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
  `count_distinct`, `sum`, `avg`). Es lo contrario de una derivada, y lo que una
  derivada combina. `count` cuenta filas y no nombra columna; las otras tres la
  nombran, y `sum` y `avg` además exigen que sea numérica.
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
  grafo de relaciones y expone `describe()`. Una entidad se registra **una sola
  vez**: volver a registrar ese nombre con otra definición es
  `INVALID_DEFINITION`; con exactamente la misma definición es idempotente.
- **Esquema físico**: foto descubierta de tablas, columnas, tipos, llaves e
  índices (`information_schema`, `pg_indexes`). Se descubre, no se declara.
- **Snapshot del esquema**: la foto ya materializada que produce el
  `introspect(pool)` del dialecto de la fuente, y contra la que el catálogo
  valida al registrar:
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
  tipos, descripciones, operadores emitidos, consultas tipo. Nunca incluye
  nombres de tablas ni columnas. **Es la misma para todo contexto**: `describe`
  recibe el contexto de sesión porque es parte del contrato, pero no lo usa —lo
  que varía por consumidor es el presupuesto, no el catálogo—. Una vista que
  dependiera de un campo del contexto sería una vista que el consumidor puede
  pedirse solo.
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
  `INVALID_QUERY` (la consulta no tiene forma de consulta: sin `measures`, una
  lista que no es lista, una `timeDimension` sin granularidad de la lista, una
  dirección de orden que no es `asc`/`desc` o un `limit` que no es entero
  positivo. Es la puerta de forma, antes de mirar el catálogo),
  `INVALID_CONSUMER` (clase de consumidor desconocida o ausente en el contexto),
  `QUERY_TIMEOUT` (la ejecución superó el timeout del presupuesto),
  `SCHEMA_DRIFT` (el SQL nombró una tabla o columna que la base ya no tiene: el
  esquema cambió debajo del catálogo y hay que re-registrar las definiciones),
  `SOURCE_UNAVAILABLE` (la base de la fuente no respondió: la conexión ni
  siquiera se pudo abrir. Sale como 503 con `Retry-After`, porque reintentar sí
  puede funcionar),
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
  catálogo la publica y el engine la aplica. Se lee de dos formas, derivadas de
  la misma tabla: los **operadores del tipo** (los que tienen sentido sobre una
  dimensión así, y contra los que el engine decide `INVALID_OPERATOR`) y los
  **operadores emitidos** (los del tipo que además tienen SQL). La vista pública
  publica los emitidos: el catálogo no ofrece lo que el planificador rechaza.
- **Forma de la consulta**: la consulta con sus valores literales reemplazados
  por parámetros. Dos consultas con la misma forma generan el mismo SQL.
- **CacheStore**: la interfaz de caché del engine —`get(key)`, `set(key, value,
  ttlMs)`, `delete(key)`, los tres async—. `MemoryStore` es su implementación L1,
  en memoria del proceso; `RedisStore` (L2, compartida entre instancias) es la
  misma interfaz; `TieredStore` **también** es la misma interfaz y no guarda
  nada: compone las otras dos. El engine recibe una caché y no sabe cuántos
  niveles tiene.
- **Llave de caché**: **es** el `queryId`. No hay dos hashes: lo que se va a
  ejecutar —el SQL, sus parámetros, la empresa y la versión del catálogo— es
  exactamente lo que decide si dos consultas son la misma consulta, tanto para
  identificarla como para reusar su resultado. Nace del SQL y no del JSON pedido
  porque entre los dos hay decisiones del engine que cambian el resultado sin
  cambiar la consulta: sobre todo el **límite efectivo**, que lo pone el
  presupuesto de la clase de consumidor y viaja en los parámetros. La llave con
  la que se guarda escribe al lado la procedencia que el hash ya lleva adentro:
  `{versión del catálogo}:{empresa}:{queryId}`, y en Redis con el prefijo del
  servicio: `capa:{versión}:{empresa}:{queryId}`. El aislamiento no depende de
  ese texto —depende del hash—, pero en una caché compartida lo que no se ve no
  se puede auditar: con la empresa escrita, comprobar que ninguna entrada quedó
  sin dueño es un `SCAN`.
- **`servedFrom`**: de dónde salió la respuesta: `live` (se ejecutó contra la
  base), `cache-l1` (estaba guardada en memoria de este proceso) o `cache-l2`
  (estaba en la caché compartida: la calculó otra instancia, o este mismo
  proceso antes de reiniciar). Viaja en `meta.servedFrom`.
- **L1 y L2**: los dos niveles de la caché. **L1** vive en memoria del proceso:
  rapidísima, acotada, y se pierde al reiniciar. **L2** es Redis, compartida por
  todas las instancias del servicio: sobrevive al reinicio y es lo que hace que
  lo que calculó una instancia le sirva a otra. Se lee L1, luego L2, luego la
  base; se escribe en los dos; un hit de L2 deja la copia en L1.
- **Degradación de la caché**: el fallo de un nivel nunca es el fallo de la
  consulta. Si la L2 no responde —Redis caído, red cortada, timeout de 200 ms—,
  la respuesta se sirve igual (`cache-l1` o `live`) y el fallo se cuenta en
  `cacheErrors` por nivel. La caché existe para abaratar, no para poner en
  riesgo.
- **`asOf`**: instante en que se ejecutó la consulta que produjo estas filas. En
  un hit es el de la ejecución original, no el de ahora: es lo que le permite al
  consumidor mostrar la antigüedad del dato.
- **TTL**: cuánta antigüedad tolera una respuesta. Lo fija la clase de consumidor
  en su presupuesto (`cacheTtlMs`), como el timeout y el límite de filas: cuánta
  antigüedad se tolera es parte de lo que esa clase puede gastar. **Lo evalúa
  quien lee**, comparando el `asOf` de la entrada contra su propio TTL: una
  entrada que el tablero (60 s) dejó hace 50 s le sirve a él y la API (30 s) la
  trata como miss. Si se decidiera sólo al escribir, el primero en llegar le
  impondría su frescura a todos los demás. El store además le pone su propio
  vencimiento a la entrada, que es lo que le permite desalojarla.
- **Hit ratio**: proporción de respuestas servidas desde la caché sobre las que
  la consultaron. Sale de `cache.hits` y `cache.misses` de la telemetría; un
  engine sin caché no reporta ninguno de los dos.
- **Fuente**: la base contra la que se ejecuta, con nombre propio: `{ dialecto,
  pool }`. **Cada entidad pertenece a una fuente** —la declara con `source`, y
  sin declararla es `postgres`— y una fuente tiene exactamente un dialecto. El
  catálogo la guarda por entidad y la muestra sólo en la vista interna: el
  consumidor pide nombres de negocio y no sabe en qué base viven. Una consulta
  vive entera dentro de una fuente: la de su entidad de hechos decide el
  dialecto que escribe el SQL y el pool contra el que se ejecuta, y alcanzar
  una entidad de otra fuente —por una dimensión, un filtro o el camino de
  joins— es `NO_JOIN_PATH`, porque dos bases no se cruzan con un JOIN.
- **Dialecto**: la única pieza que conoce un motor. Tiene cuatro
  responsabilidades, y ninguna otra pieza puede tener una de ellas:
  1. **Sintaxis SQL**: lo que varía entre motores y el planificador pregunta
     (`dateTrunc`, `agregadoFiltrado`, `aNumerico` para forzar aritmética no
     entera y `tablaFisica` para nombrar la tabla dentro de una CTE que se
     llama igual), más las sentencias con que el engine abre la sesión de una
     consulta (`sentenciasDeSesion`, opcional) y la tabla de **capacidades**
     (`tiposGarantizados`, `timeoutDeSentencia`, …).
  2. **Introspección del esquema**: cómo se descubre el snapshot en este motor
     (`introspect(pool)`). La *forma* del snapshot es del catálogo; de dónde
     salen los datos, del motor.
  3. **Mapa de tipos**: `tipoSemantico(tipoFísico)` traduce el tipo de la
     columna al del vocabulario (`number`, `string`, `date`, `boolean`), o
     `undefined` si no lo reconoce. Es contra lo que el catálogo valida el tipo
     declarado de una dimensión y el de la columna que agrega una medida.
  4. **Traducción de errores nativos**: `traducirError(error, presupuesto)`
     convierte el código del motor en un error semántico (`QUERY_TIMEOUT`,
     `SCHEMA_DRIFT`, `SOURCE_UNAVAILABLE`) y deja pasar tal cual lo que no
     reconoce. Ninguna otra pieza nombra un código de error de un motor, ni el
     texto de uno: SQLite no tiene SQLSTATE y sus errores se distinguen por el
     mensaje, que es un detalle que vive dentro de su dialecto.

  Hay **dos dialectos**: `postgres` (el motor del caso) y `sqlite`
  (`node:sqlite`, sin dependencias), que existe para probar que el seam aguanta
  —las mismas definiciones y el mismo engine dan las mismas filas contra los dos
  motores— y para que lo que un motor no puede prometer tenga dónde decirse.
- **Capacidad del dialecto**: lo que el motor puede prometer, y de lo que
  dependen decisiones del catálogo y del planificador. `tiposGarantizados`
  significa que el motor declara y hace cumplir el tipo de cada columna: con
  ella, un tipo declarado que no calza con el físico es un error de definición;
  sin ella (un motor de tipos laxos), la misma incompatibilidad es sólo una
  advertencia de registro. `timeoutDeSentencia` significa que el motor puede
  cortar una consulta por tiempo; sin ella —SQLite no tiene `statement_timeout`—
  el dialecto no ofrece `sentenciasDeSesion`, el engine no emite ninguna y el
  presupuesto de tiempo de la clase de consumidor **no se hace cumplir en esa
  fuente**. Una capacidad es el lugar donde una promesa que el motor no puede
  sostener se dice en voz alta, en vez de quedar como un `if` escondido en el
  engine o, peor, como una promesa falsa.
- **Telemetría**: señales de monitoreo del engine. Se dice "telemetría" y no
  "métrica" para no confundir con las medidas de negocio. Vive en memoria del
  proceso, se lee con `engine.telemetry()` y cuenta, por consumidor: consultas
  servidas y rechazadas, código de error, **puerta que rechazó**, hits y misses
  de caché —con los hits desglosados por nivel— y tiempo de base (suma y
  cuenta), los **clientes que se fueron** antes de la respuesta (`clientGone`,
  por consumidor: la consulta se termina y se cachea igual; se cuenta lo que
  nadie leyó), más los **fallos de caché por nivel** (`cacheErrors`), que son la
  única señal de que un nivel está caído: como ninguna consulta falla por eso,
  sin ese contador sería invisible. Una respuesta servida desde la
  caché cuenta como servida pero no suma al tiempo de base. Es reinicializable;
  exportarla está fuera de alcance.
- **Identidad de la consulta (`queryId`)**: hash del SQL que se va a ejecutar
  (sin su marca de comentario), sus parámetros, la empresa y la versión del
  catálogo. La serialización es canónica, así que reordenar las claves del JSON
  no lo cambia. Dos JSON iguales que producen SQL o parámetros distintos son dos
  consultas distintas; dos JSON distintos que producen exactamente lo mismo son
  la misma. Viaja en `meta.queryId`, marca el SQL que se ejecuta
  (`/* queryId consumer */`) y **es** la llave de la caché.

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
  400 y 413; `QUERY_TIMEOUT` sale como 504 y `SCHEMA_DRIFT` como 503 —una
  dependencia rota que el consumidor no puede arreglar cambiando lo que pidió—.
- **Techo del cuerpo**: los 64 KiB (`LIMITE_DE_CUERPO`) que la capa HTTP acepta
  como máximo en el cuerpo de una petición. Se cuentan bytes mientras se lee,
  así que un cuerpo sin fin nunca llega a crecer en memoria: al pasarse, la
  lectura se corta con `PAYLOAD_TOO_LARGE` sin que el engine vea nada, y la
  conexión se cierra una vez que la respuesta salió.
- **Dry-run por la API**: `POST /analytics/query?dryRun=true` devuelve
  `{ sql, params, plan }` sin tocar la base. Va en la URL y no en el cuerpo
  porque el cuerpo es la consulta declarativa y nada más.

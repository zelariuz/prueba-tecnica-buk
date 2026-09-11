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
- `docs/semantica-de-filtros.md` — filtros globales, propios de medida y la
  advertencia de la razón anulada.
- `docs/bitacora-de-fases.md` — decisiones y correcciones por fase (2 a 8, A, B,
  abogado del diablo, log por consulta, demo del agente, telemetría). Leer
  sólo cuando haga falta el porqué de algo.
- `docs/adr/` — decisiones arquitectónicas (0001 tres piezas, 0002 contexto de
  sesión separado, 0003 CTE por entidad con empresa, 0004 derivadas ratio,
  0005 segmentos sin SQL, 0006 medidas de una sola entidad, 0007 vocabulario
  Cube, 0008 catálogo en dos vistas, 0009 rango opcional para el agente,
  0010 consultas sin medida, 0011 rango sin granularidad, 0012 relleno de
  series densas, 0013 truncado visible y total de filas, 0014 rangos relativos
  con vocabulario cerrado).

## Estructura

```
src/
  definitions/reviews.js     evaluaciones: dimensiones, medidas, segmento y relación
  definitions/employees.js   empleados: puente hacia departamentos
  definitions/departments.js departamentos: dimensión name
  definitions/attendance.js  asistencia: dimensión temporal `date`, segmento
                             `present` y la derivada `attendance_rate`
  definitions/consultas-tipo.js  seis plantillas del caso con parámetros `:nombre`
  definitions/index.js       composición: qué módulos y qué consultas tipo
                             existen, y `registrarModulos(catalog, snapshot)`
  dialect/postgres.js        el motor, entero: sintaxis (dateTrunc,
                             serieDeFechas, agregadoFiltrado, aNumerico,
                             tablaFisica, sentenciasDeSesion y capacidades),
                             introspección del esquema, mapa de tipos físicos →
                             semánticos y traducción de errores nativos
  dialect/sqlite.js          el segundo motor, con las mismas cuatro
                             responsabilidades sobre `node:sqlite`: dateTrunc con
                             strftime/printf, introspección por PRAGMA, tipos por
                             afinidad y errores por texto. Declara lo que no
                             puede prometer (tiposGarantizados: false,
                             timeoutDeSentencia: false, serieDeFechas: false —
                             sin generate_series no hay serie que calce con
                             dateTrunc en las cinco granularidades, ADR 0012)
  dialect/sqlite-pool.js     adaptador de DatabaseSync al contrato mínimo de pool
                             (connect → { query, release }); traduce los
                             parámetros posicionales $n a los nombrados de SQLite
  budgets.js                 presupuesto por clase de consumidor (timeout, filas,
                             rango y TTL de caché)
  cache/store.js             interfaz CacheStore (get/set/delete async) y
                             MemoryStore: L1 acotada, LRU, TTL por entrada y
                             reloj inyectable
  cache/redis-store.js       RedisStore: la L2 sobre node-redis, prefijo de
                             llave, TTL con PX, timeout de 200 ms, listener de
                             error y reconexión con tope
  cache/tiered.js            TieredStore: compone L1 y L2 detrás de la misma
                             interfaz; marca de qué nivel salió la entrada y se
                             traga los fallos de la L2
  cache/index.js             cómo arma su caché un proceso según REDIS_URL
                             (L1+L2, o sólo L1 con aviso)
  catalog.js                 registro y validación de definiciones (forma,
                             esquema físico y tipos), fuente por entidad,
                             resolución de miembros, vistas pública e interna,
                             versión y consultas tipo
  rangos-relativos.js        el vocabulario cerrado de rangos relativos
                             (`last 6 months`, `this quarter`) y su resolución a
                             un par de fechas en la zona pedida; valida la zona
                             con `Intl` (ADR 0014)
  suggest.js                 distancia de edición y sugerencia del nombre más parecido
  vocabulary.js              operadores por tipo de dimensión y granularidades
  planner.js                 el planificador: pipeline de puertas (resolver rangos
                             relativos, validar, resolver miembros, filtros,
                             joins, agregación y derivadas, emitir SQL, describir
                             el plan lógico). Única pieza que escribe SQL
  engine.js                  plan() y run(): dry-run y ejecución transaccional con
                             SET LOCAL statement_timeout, más las puertas
                             buscarEnCache y guardarEnCache
  errors.js                  SemanticError { code, member, suggestion }
  telemetry.js               contadores en memoria por resultado, código, puerta,
                             consumidor, hits/misses de caché (hits por nivel),
                             fallos de caché por nivel y tiempo de base;
                             inyectable y reiniciable
  canonical.js               serialización canónica compartida (versión del
                             catálogo y queryId)
  http/server.js             las tres rutas con node:http (query, catalog y la
                             telemetría interna); token → ctx, techo de
                             64 KiB al cuerpo y delega
  http/codigos.js            mapa código de error → código HTTP (incluidos 403 y
                             413) y cabeceras por código (Retry-After del 503)
  http/tokens.js             tabla de tokens de demo desde DEMO_TOKENS
  server.js                  bin del servicio `api`: introspecta, registra con
                             snapshot y escucha
  demo.js                    `npm run demo`: catálogo, tres preguntas, telemetría
test/
  plan.test.js               seam engine.plan — sin base
  run.test.js                seam engine.run — contra Postgres, se salta sin DATABASE_URL
  catalog.test.js            seams catalog.register y catalog.describe — sin base
                             salvo el único test del introspector
  http.test.js               prueba de humo HTTP contra un servidor en puerto
                             efímero, contra Postgres
  telemetry.test.js          contadores por el seam engine.run
  cache.test.js              caché L1 por el seam engine.run (contra Postgres) y
                             el dry-run sin caché por engine.plan (sin base)
  cache-l2.test.js           los dos niveles por engine.run con dos MemoryStore:
                             cache-l2, relleno de L1, hits por nivel y las dos
                             redes de seguridad (contra Postgres)
  redis.test.js              caché L2 contra Redis de verdad: dos instancias,
                             llaves con empresa por SCAN y Redis inalcanzable;
                             se salta sin REDIS_URL
  rangos-relativos.test.js   el vocabulario forma por forma con reloj fijo, los
                             bordes de mes/trimestre/año, las zonas, y la prueba
                             que más importa: dos "hoy" distintos dan queryId
                             distintos y no comparten caché (contra Postgres)
  sqlite.test.js             la segunda fuente por los seams engine.run,
                             engine.plan y catalog.register; base en memoria, sin
                             variables de entorno
  snapshots/caso-obligatorio.sql  SQL esperado del caso, comparado por igualdad
  snapshots/caso-obligatorio-sqlite.sql  el mismo caso, emitido por el dialecto
                             SQLite: mismas CTE, mismos $n, otra sintaxis
  snapshots/completion-rate.sql   SQL esperado de la derivada, con su etapa agregada
  snapshots/valores-de-dimension.sql  SQL esperado de la consulta sin medidas:
                             GROUP BY sin agregados (ADR 0010)
  snapshots/rango-sin-granularidad.sql  SQL esperado del rango que sólo filtra:
                             el dateRange en la CTE y sin la fecha en el
                             SELECT ni en el GROUP BY (ADR 0011)
  snapshots/relleno-de-serie.sql  SQL esperado del relleno de serie densa: las
                             CTE serie, ejes y agregada, el CROSS JOIN y el
                             LEFT JOIN por bucket (ADR 0012)
  fixtures/snapshot.json     foto del esquema generada desde la base del caso
  fixtures/caso-sqlite.sql   el mismo esquema y las mismas 16 evaluaciones,
                             escritos para SQLite
docker/init/
  01-schema.sql            DDL del caso, copiado sin cambios
  02-seed.sql              seed determinista + conteos esperados en el encabezado
  03-seed-empresa-c.sql    empresa C: 1,06 M de filas de asistencia, para volumen
docs/
  adr/                     decisiones arquitectónicas numeradas
  semantica-de-filtros.md  qué filtra a qué y cuándo una razón queda en 100
  bitacora-de-fases.md     historial: decisiones y correcciones por fase (antes vivía en CLAUDE.md)
docker-compose.yml         db (Postgres 16, host 5433), redis (host 6380) y api
                           (host 3000, espera a que db y redis estén sanos)
Dockerfile                 imagen del servicio api (node:24-alpine, USER node)
demo-agente/               demo web del rastro de llamadas: paquete aparte, con su
                           package.json, su README y sus tests. NO importa nada de
                           `src/`; habla con la capa solo por HTTP (:3000). Dos
                           caminos: pregunta preparada directa, o el mismo camino
                           con el JSON escrito por una sesión de Claude Code que
                           sólo conoce el catálogo público.
  index.js                 arranque: catálogo, sesión y escucha en :3100
  src/ejecutar.js          seam 1: petición → rastro de saltos
  src/sesion.js            seam 2: crear/conservar/recrear la sesión, prompt de
                           creación y huella del catálogo
  src/protocolo.js         las palabras del agente: prompt del clic, prompt de
                           corrección y lectura del JSON que devuelve
  src/servidor.js          estáticos de public/ y los endpoints JSON (incluida
                           la telemetría de la capa); el rastro sale como
                           NDJSON, una línea por salto
  public/                  el front estático: index.html, app.js, estilo.css y
                           sesion.html (sin frameworks, sin build)
  docs/qa.md               QA del 09-09: las 7 preguntas × 2 caminos, de verdad
```

**Comandos de la demo** (con la capa arriba):
`cp demo-agente/.env.example demo-agente/.env` y
`cd demo-agente && npm start` → <http://localhost:3100/>.
**Sus tests corren aparte**: `cd demo-agente && npm test` (sin Postgres, sin
Docker, sin Claude Code y sin variables). El `npm test` de la raíz **no** los
corre: sólo mira `test/`.

## Si te abren con un prompt de revisor

Un revisor puede abrir este repo con Claude Code y pedir "levanta la capa,
corre la demo y explícame el caso obligatorio; después corre los tests". Orden:

1. `docker compose up -d --build` y esperar a que `db` y `redis` estén sanos
   (`docker compose ps`); el `api` arranca solo después. El primer arranque
   carga el seed (incluida la empresa C, ~1 M de filas de asistencia).
2. `docker compose exec api node src/demo.js` y explicar la salida: las tres
   preguntas del caso, el SQL con una CTE por entidad y `company_id = $1`, la
   derivada calculada fuera de la subconsulta, `cache-l1` y `cache-l2`, el
   error con sugerencia y la telemetría. Filas esperadas de la empresa A:
   Ingeniería 4.35/2 y 3.80/1; `completion_rate` 75.
3. Tests: `npm install` y `npm test` con `DATABASE_URL` y `REDIS_URL` de la
   sección Comandos → 251 en verde (153 + 1 saltado sin variables).
4. La demo del agente, si el prompt la pide (el del README la pide):
   `cd demo-agente && npm install && npm start` en segundo plano, con la capa
   arriba; no va en el compose. Di la URL (`http://localhost:3100`), que usa la
   sesión de Claude Code del revisor y que cada clic gasta crédito de su plan.
   Si `claude --version` no responde o no hay sesión, la demo arranca igual y
   lo indica en la página.
5. Al terminar, ofrece bajar todo con `docker compose down` (y Ctrl+C a la
   demo del agente si corre); no lo hagas sin preguntar, el revisor puede
   querer seguir con los `curl` del README.

## Comandos

```bash
npm install
docker compose up -d db                       # base con esquema y seed
docker compose up -d --build                  # todo: db, redis y api (host 3000)
# `npm test` sin variables corre y queda verde: los tests de base se saltan sin
# DATABASE_URL y los de Redis sin REDIS_URL.
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica \
  REDIS_URL=redis://localhost:6380 npm test
DATABASE_URL=postgres://capa:capa@localhost:5433/capa_semantica \
  REDIS_URL=redis://localhost:6380 npm run demo   # la segunda instancia da cache-l2

# Re-aplicar esquema y seed. `--renew-anon-volumes` NO sobra: la imagen
# postgres declara un VOLUME anónimo que sobrevive a recrear el contenedor,
# así que sin esa opción el contenedor es nuevo y los datos son los viejos.
docker compose up -d --force-recreate --renew-anon-volumes db

curl -s -H 'Authorization: Bearer demo-dashboard-empresa-a' \
  http://localhost:3000/analytics/catalog
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

## Estado

Rangos relativos (11-09, ADR 0014): el `dateRange` de una dimensión temporal
acepta, además del par de fechas, **una frase de un vocabulario cerrado** que la
capa resuelve a ese par. Quince formas, en minúsculas y escritas exactamente
así: `today`, `yesterday`, `this week|month|quarter|year`,
`last week|month|quarter|year` y `last N days|weeks|months|quarters|years` (N
entero positivo, unidad siempre en plural). **No hay intérprete de lenguaje
natural** —Cube usa Chrono; aquí no—: cualquier otra cadena es `INVALID_QUERY`
con `member` `timeDimensions[i].dateRange` y la lista entera en la sugerencia,
por la misma razón por la que las granularidades son una lista cerrada. Un rango
mal interpretado no falla: devuelve los datos de otro período con un 200.
**Definición elegida y escrita: `last month` es el mes calendario anterior
COMPLETO**, no los últimos 30 días, y ninguna frase `last …` incluye hoy (las
formas cortas son el caso N=1 de las largas); las `this …` van del comienzo del
período en curso **a hoy**. La semana empieza el lunes, como el
`DATE_TRUNC('week')` de Postgres y como `bucketsDelRango`. La zona es
`timezone`, propiedad **de la consulta** (como en Cube), por defecto `UTC`,
validada con la API `Intl` del runtime y no con una lista propia; **no reabre el
supuesto v1**: las columnas siguen siendo `DATE` y la capa no convierte nada, la
zona sólo decide qué día es hoy. **Lo crítico es cuándo se resuelve**: en la
**primera puerta** del planificador, antes de validar la forma, antes de que las
fechas entren como parámetros `$n` y, por lo tanto, antes del `queryId` —que
nace del SQL ejecutado y sus parámetros—. Comprobado ejecutando, no razonando:
la misma frase `last 7 days` con "hoy" en agosto y en septiembre da
`ada38a495c69039d` y `d5ae1b4eefe8ebe6`, las dos `live`, mientras con el mismo
"hoy" la segunda sale `cache-l1` con el mismo id (test con TTL inmenso inyectado
para que un vencimiento no pueda ser la explicación alternativa). El "hoy" sale
del **reloj inyectable que el engine ya tenía** para el `asOf` y el TTL, leído
una sola vez por consulta. El plan lógico del dry-run estrena `timeDimensions`
—con el rango ya resuelto y la frase original en `dateRangeExpression`— y
`timezone`. La raíz corre **266 tests en verde** con `DATABASE_URL` y
`REDIS_URL`, y **167 sin nada** (1 se salta). Los seis SQL de referencia de
`test/snapshots/` quedaron byte por byte iguales. Evoluciones anotadas en el
ADR: publicar el vocabulario por `describe()` y enseñárselo al agente en el
prompt de creación de la demo.

Truncado visible y total de filas (11-09, ADR 0013): cierra la evolución que el
ADR 0012 había dejado anotada. Tres cosas. **(1)** Cuando las filas devueltas
alcanzan el límite efectivo de la clase, la respuesta suma una advertencia a
`meta.warnings` —misma forma `{ member, warning }` que la razón anulada, `member`
`limit`— diciendo que puede venir truncada y sugiriendo acotar el rango, subir la
granularidad o pedir menos dimensiones. Vale para **toda** consulta, no sólo para
las que rellenan; vive en el engine porque antes de ejecutar no hay filas que
contar, y viaja también en la entrada de caché. No se pide una fila de más para
saber si sobraban: eso le cobraría a todas las consultas el precio de unas pocas.
**(2)** Con `fillMissing`, los buckets se cuentan **sin tocar la base** desde el
`dateRange` y la `granularity` (`bucketsDelRango` en `src/planner.js`, verificada
contra `generate_series` en las cinco granularidades); si los buckets solos ya
pasan el límite, ni un eje cabría y la consulta se rechaza en la puerta
`resolverMiembros` con `INVALID_QUERY` (400) y una sugerencia que nombra buckets,
tope y salidas. Los ejes **no** se estiman: exigiría consultar la base. Una fecha
que no viene en `YYYY-MM-DD` no se convierte en rechazo: el guardarraíl falla
abierto. **(3)** `total: true` (la propiedad de Cube: filas del resultado
ignorando límite y desplazamiento, **no** el gran total de una medida) devuelve
`meta.total`. Es una **segunda sentencia sobre el mismo cuerpo**, sin `ORDER BY`
ni `LIMIT` (`SELECT COUNT(*) FROM (<cuerpo>) AS t`), armada antes de pedir el
parámetro del `LIMIT` para no mover la numeración de los `$n`; por eso vale igual
con derivadas y con relleno —ahí da `buckets × ejes`— sin una regla propia. Corre
en la **misma transacción** que la consulta (misma foto de los datos, una
conexión, mismo `statement_timeout`) y su tiempo entra en el `dbMs` de la
telemetría, que no estrena contador. **Dry-run no ejecuta el total**: devuelve la
sentencia y el plan lógico con `total: true`. **Desde caché el total viene
guardado con la entrada**, no se recalcula, y el `queryId` incorpora la segunda
sentencia para que una consulta con total y otra sin él no compartan entrada (la
clave sólo entra al hash si existe: los queryId anteriores no se movieron). La
raíz corre **251 tests en verde** con `DATABASE_URL` y `REDIS_URL`, y **154 sin
nada** (1 se salta). Los seis SQL de referencia de `test/snapshots/` quedaron
byte por byte iguales. Verificado contra Postgres real: la asistencia por día y
departamento del 8 al 14 de agosto da 10 filas y `total` 10 sin relleno, y 14 y
`total` 14 con relleno; con `limit: 3` da 3 filas, `total` 10 y la advertencia de
truncado. Fila del tope de filas de `docs/riesgos.md` actualizada: ya no dice que
el truncado es silencioso.

Relleno de series densas (11-09, ADR 0012): una `timeDimension` con
`granularity`, `dateRange` y `fillMissing: true` devuelve **todos** los buckets
del rango, también los vacíos, para que un gráfico no salte días. La bandera vive
en la consulta y no en la definición del módulo: la serie densa la necesita quien
dibuja, no la entidad. Qué se rellena con qué lo decide el **tipo de la medida**:
`count`, `count_distinct` y `sum` → `COALESCE(…, 0)`; `avg` y `ratio` quedan
**nulos** (un promedio de cero valores no es cero). Las derivadas se siguen
calculando afuera, sobre el resultado ya denso, y su denominador rellenado en 0
las anula solo por el `NULLIF` que ya estaba. El SQL agrega tres CTE —`serie`,
`ejes` y `agregada`— y afuera `serie CROSS JOIN ejes LEFT JOIN agregada`; sin
dimensiones no temporales no hay `ejes` ni `CROSS JOIN`. Rellenar **no agrega ni
un parámetro**: la serie usa los mismos `$2`/`$3` que ya filtran la CTE.
Capacidad nueva del dialecto `serieDeFechas`: Postgres la declara y la emite con
`generate_series` truncando el inicio (si no, un rango que parte el 15 de enero
con granularidad `month` daría 15/01, 15/02…); SQLite la declara `false` y pedir
`fillMissing` sobre esa fuente sale con `UNSUPPORTED_OPERATOR` (400). La raíz
corre **230 tests en verde** con `DATABASE_URL` y `REDIS_URL`, y **142 sin nada**
(1 se salta). Snapshot nuevo `test/snapshots/relleno-de-serie.sql`; los cinco
anteriores byte por byte iguales. Verificado contra Postgres real: la asistencia
de la empresa A entre el 8 y el 14 de agosto pasa de 10 filas a 14, con los
cuatro días sin registro de Ventas en `count: 0` y `attendance_rate: null`.
Riesgo nuevo registrado en `docs/riesgos.md`: densificar multiplica filas contra
el tope de la clase (medido en la empresa C, por día × departamento sobre dos
años: de 4.392 filas con 12 departamentos a las 5.000 del tope con 7).

Rango sin granularidad (10-09 madrugada, ADR 0011): una `timeDimension` con
`dateRange` y sin `granularity` sólo filtra por fecha. La raíz corre **217 tests
en verde** con `DATABASE_URL` y `REDIS_URL`, y **133 sin nada** (1 se salta);
`demo-agente` corre sus **62** aparte (9 nuevos del salto de redacción). Snapshot nuevo
`test/snapshots/rango-sin-granularidad.sql`; los cuatro anteriores sin cambios.
Verificado contra Docker (`docker compose up -d --build api`): la tasa de
asistencia por departamento de junio a agosto de 2025 con `demo-agente-empresa-a`
devuelve 200 con dos filas (Ingeniería 92,59 y Ventas 91,55). La demo estrena
las tres preguntas del enunciado con su texto literal (12 en total) y el prompt
de creación gana la viñeta del rango sin granularidad; el agente la usó sin
ayuda en la 1 y en la 3 del QA del 10-09.

Identidad de la fuente en la llave de caché (09-09, discusión 26 P12-P16): la
llave pasó de `{versión}:{empresa}:{queryId}` a
`{versión}:{empresa}:{fuente}.{huella}:{queryId}`. Motivo: el `queryId`
identifica la consulta y no la base; dos despliegues con una fuente llamada
igual sobre bases distintas daban la misma llave. La huella (8 hex) sale de
`resolverIdentidad` en `src/engine.js`, por prioridad: `id` configurado en
`fuentes` → `dialecto.identificador(pool)` (Postgres: `system_identifier` de
`pg_control_system()`, que las réplicas físicas comparten; SQLite: el archivo)
→ host/puerto/base del pool sin credencial → nombre. `engine.identidadDeFuente`
la expone con su origen. `CACHE_PREFIX` separa ambientes en Redis
(`src/cache/index.js`, `server.js`, `demo.js`). Tests: 4 de identidad y 1 de
aislamiento entre bases en `cache.test.js`, la forma de la llave en
`redis.test.js`, archivo vs memoria en `sqlite.test.js`. Verificado: **179 tests
en verde** con `DATABASE_URL` y `REDIS_URL` (contra Docker, el rol `capa` sí
puede ejecutar `pg_control_system()`: origen `motor`), 114 sin nada (1 se
salta). Snapshots de SQL sin cambios.

Al cierre del 09-09 (query de consultas tipo en la vista pública, empresa C,
rango opcional ADR 0009, consultas sin medida ADR 0010, telemetría por HTTP): la
raíz corre **204 tests en verde** con `DATABASE_URL` y `REDIS_URL`, y **125 sin
nada** (1 se salta). `demo-agente` corre sus **52** aparte. Los tres snapshots
de SQL originales sin cambios; uno nuevo (`valores-de-dimension.sql`).

Log por consulta terminado (08-09): el engine emite un evento por `run` y por
`plan` por la costura `observar`, y el servicio `api` lo escribe como una línea
JSON en stdout. Verificado contra Docker: `docker compose logs api` muestra la
línea `live` con `dbMs`, la repetida con `servedFrom: "cache-l1"` y sin `dbMs`,
y el rechazo con `code`, `member` y `gate` y sin `queryId`; con `LOG_SQL=true`
la línea agrega el `sql`. **172 tests en verde** con `DATABASE_URL` y
`REDIS_URL`, **110 sin ninguna variable** (1 se salta), los tres snapshots de
SQL sin cambios.

Correcciones del abogado del diablo terminadas (08-09): los diez hallazgos
bloqueantes de la lista de arriba están corregidos con test, un commit cada uno.
Verificado: **165 tests en verde** con `DATABASE_URL` y `REDIS_URL`, **107 sin
ninguna variable** (1 se salta), los tres snapshots de SQL byte por byte iguales
y `npm run demo` respondiendo las tres preguntas con caché de dos niveles.
Códigos nuevos: `INVALID_QUERY` (400). Miembros nuevos:
`reviews.completed_employees`, `employees.active` (segmento) y
`employees.active_headcount`; consulta tipo nueva
`empleados-que-completaron-por-trimestre`.

Fase B terminada: SQLite es la segunda fuente y el seam del dialecto aguantó.
Las mismas definiciones y el mismo engine responden el caso obligatorio contra
los dos motores con las mismas filas; los cuatro pedazos de Postgres que
quedaban fuera del dialecto (`SET LOCAL`, `::numeric`, el nombre de la tabla
dentro de su CTE homónima y la asincronía del pool) están listados arriba con lo
que se hizo con cada uno. Se sumaron `SOURCE_UNAVAILABLE` (503 con
`Retry-After`) y la guardia de fuente no configurada. Verificado: 139 tests en
verde con `DATABASE_URL` y `REDIS_URL`, 87 sin ninguna variable (los 16 de
SQLite corren en los dos modos, en memoria), y `npm run demo` sigue respondiendo
las tres preguntas con caché de dos niveles.

Fase A terminada: el dialecto quedó como la única pieza que conoce un motor
(sintaxis, introspección, mapa de tipos y errores nativos), cada entidad declara
su fuente y el catálogo valida la compatibilidad entre el tipo declarado y el
físico. `SCHEMA_DRIFT` (503) reemplaza al error crudo de Postgres cuando el
esquema cambió debajo del catálogo. Verificado contra Docker: 117 tests en verde
y `npm run demo` responde las tres preguntas con caché de dos niveles. La fase B
puede agregar `src/dialect/sqlite.js` sin tocar catálogo, planificador ni engine.

Fase 8 terminada — **última del plan**. Caché L2 en Redis detrás de la misma
interfaz `CacheStore`, compuesta con la L1 por `TieredStore`. Verificado contra
Docker: dos POST iguales dan `live` y `cache-l1`; tras `docker compose restart
api` (que vacía la L1) el mismo POST vuelve `cache-l2` con el `asOf` de la
ejecución original; con `docker compose stop redis` una consulta nueva se sirve
`live` con HTTP 200 en 230 ms y la repetida en 2 ms desde L1. Las llaves reales
son `capa:{versión}:{empresa}:{fuente}.{huella}:{queryId}`. `npm run demo` levanta una segunda
instancia del engine que responde `cache-l2` y cierra con hits por nivel y
errores de caché. Fuera de alcance, documentado como evolución: invalidación por
escritura de los módulos, single-flight, pre-agregaciones y Parquet/S3.

Fase 7 terminada: caché L1 en memoria detrás de la interfaz `CacheStore`. La
segunda ejecución de la misma consulta vuelve con `servedFrom: 'cache-l1'`, las
mismas filas y el `asOf` de la ejecución original, y la telemetría muestra que la
base no se consultó (3 consultas para 6 respuestas en la demo, hit ratio 50 %).
La empresa B no recibe la entrada de la A, registrar una definición nueva
invalida todo por la versión del catálogo, la entrada expira según el TTL de la
clase de consumidor (probado con reloj inyectado), el store está acotado con
desalojo LRU y el dry-run no la toca. El servicio HTTP y la demo la usan.
Siguiente: fase 8 (caché L2 en Redis).

Fase 6 terminada: servicio HTTP (`POST /analytics/query`, `GET
/analytics/catalog`, `?dryRun=true`) con contexto derivado del token de demo y
mapa de códigos; telemetría en memoria por resultado, código, puerta y
consumidor; `queryId` reproducible con la versión del catálogo; módulo de
asistencia con `attendance_rate` (80 y 50 contra Postgres) registrado sin tocar
el engine; `npm run demo` con catálogo, tres preguntas y telemetría; servicio
`api` en docker-compose verificado con curl. Siguiente: fase 7 (según el plan).

Fase 5 terminada: medidas derivadas de tipo `ratio` calculadas sobre agregados
(el departamento con 3 completadas de 4 da 75 contra Postgres), orden topológico
y rechazo de ciclos al registrar, semántica de filtros escrita y aplicada con
advertencia en `meta.warnings` cuando un filtro global anula el denominador,
dry-run con plan lógico sin conexión, snapshot del SQL de `completion_rate`,
consulta tipo `completitud-por-departamento` y planificador partido en puertas.
Siguiente: fase 6 (según el plan).

Fase 4 terminada: el catálogo como contrato — validación de forma y de esquema
al registrar, advertencias, introspector con foto fija en el repo, vistas
pública e interna, versión por hash, `UNKNOWN_MEMBER` con sugerencia por
distancia de edición, `INVALID_OPERATOR`/`UNSUPPORTED_OPERATOR` contra la tabla
de operadores por tipo, filtros y segmentos de consulta y las consultas tipo
recorridas por un test que verifica el invariante de empresa en cada CTE.

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

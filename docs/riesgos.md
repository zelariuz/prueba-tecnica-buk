# Registro de riesgos

Cada riesgo con su mitigación y dónde vive: **código** (implementado y
probado en este repo), **documento** (explicado con su costo/beneficio) o
**evolución** (extensión futura con su costura ya prevista).

**Nivel** (severidad; la misma escala del registro de riesgos de la discusión 16) = impacto × probabilidad sin la mitigación. *Alto*: un consumidor
recibe datos de otra empresa o un número falso sin aviso, o la base deja de
responder. *Medio*: el fallo es visible y acotado. *Bajo*: cosmético.

## Aislamiento entre empresas

| Nivel | Riesgo | Mitigación | Dónde |
|---|---|---|---|
| Alto | El consumidor envía un `company_id` propio o ajeno | El JSON no tiene el campo; el contexto lo construye el servidor desde el token; si aparece, `FORBIDDEN_FIELD` | código |
| Alto | Un JOIN trae filas de otra empresa | Filtro dentro de la CTE de cada entidad; invariante probada sobre todas las consultas tipo | código |
| Alto | Estado de sesión pegado a la conexión en un pool (PgBouncer en modo transacción) | Siempre `SET LOCAL` dentro de una transacción, nunca `SET`; `ROLLBACK` antes de devolver la conexión si hubo error | código |
| Medio | El catálogo público revela tablas y columnas | Dos vistas; la pública no contiene nombres físicos ni datos de otra empresa | código |
| Medio | RLS como red no aplica al dueño de la tabla ni a vistas materializadas | `FORCE ROW LEVEL SECURITY`, rol no propietario, vistas materializadas tratadas como entidades | documento |
| Medio | Resultados pesados o trabajos accesibles por otra empresa | Trabajo ligado a la empresa y verificado en cada lectura; URLs firmadas de vida corta | evolución |

## Correctitud del SQL

| Nivel | Riesgo | Mitigación | Dónde |
|---|---|---|---|
| Alto | División entera en `completion_rate` | Derivadas tipo `ratio` con `::numeric` y `NULLIF`; test que ejecuta 3 de 4 = 75 | código |
| Alto | Fan-out al mezclar medidas de dos entidades | Medidas de una sola entidad en v1; `MULTI_ENTITY_MEASURES` | código |
| Medio | Un filtro global sobre `status` deja el denominador igual al numerador (tasa 100 %) | Semántica escrita: filtros globales aplican a todas las medidas; el filtro propio de una medida se suma; advertencia al consumidor | código |
| Medio | SQL crudo en segmentos o fórmulas declaradas por módulos | Segmentos y derivadas declarativos; el único emisor de SQL es el planificador | código |
| Medio | Enteros y numéricos grandes llegan como texto desde el driver | Conversión explícita en el post-proceso; test con `COUNT` grande y `AVG` | código |
| Medio | Una definición apunta a una columna que ya no existe | `register(def, snapshot)` valida contra el esquema físico al arrancar | código |
| Bajo | Filtrar la empresa en tres tablas excluye filas inconsistentes que el SQL de referencia incluiría | Comportamiento deliberado y documentado; test que lo muestra | código |
| Medio | Fechas multi país: una columna `timestamp` truncada en UTC corre un día los reportes nocturnos de otra zona | Supuesto v1: las columnas temporales son `DATE`, ya resueltas al día calendario local de la empresa, y la capa las devuelve como texto sin pasar por la zona del proceso. El dialecto **no traduce** ningún `timestamp` a `date`: una dimensión `date` sobre `timestamp without time zone` se rechaza al registrar (`INVALID_DEFINITION`) y sobre `timestamptz` se acepta con advertencia (el rango cerrado `<= día` pierde casi todo el último día). Evolución: `timestamptz` en base, zona declarada por empresa en el catálogo, `AT TIME ZONE $z` en el dialecto, zona en la llave de caché | código |

## Disponibilidad de la base

| Nivel | Riesgo | Mitigación | Dónde |
|---|---|---|---|
| Alto | Consulta que no termina | `statement_timeout` por clase de consumidor dentro de la transacción; `LIMIT`; rango temporal obligatorio para la clase que lo exija (ninguna lo exige desde el 09-09: el guardarraíl es reactivo, `QUERY_TIMEOUT` con sugerencia de acotar — ADR 0009) | código |
| Medio | La base corta la sesión a mitad de consulta (`pg_terminate_backend`, reinicio, caída de socket); sin manejo, el driver emite `error` sin oyente y tumba el proceso entero | El cliente se libera con el error y el pool lo destruye; oyente de `error` en el cliente prestado y `pool.on('error')` para los ociosos; el error se traduce a `SOURCE_UNAVAILABLE` (503 con `Retry-After`); sin reintentos en la capa. Test en `run.test.js` que mata el backend a mitad de consulta; probado contra el contenedor `api` (sin reinicio) | código |
| Alto | Un rol de base de datos no limita recursos (`statement_timeout` es modificable por la sesión) | El rol limita privilegios (solo lectura); el límite de tiempo lo pone el engine; en producción, límite externo en el pooler | documento |
| Alto | Memoria: `work_mem` por operación × operaciones × conexiones | Tope global de conexiones con PgBouncer y `work_mem` bajo por rol | documento |
| Medio | Una empresa grande ocupa el pool | Tope de concurrencia por empresa además de por consumidor; circuit breaker por empresa | evolución |
| Medio | Estimar costo con `EXPLAIN` clasifica mal a empresas pequeñas y consume planificador | Solo para consumidores no interactivos; llave por forma, rango y empresa | evolución |
| Medio | Estampida al invalidar caché; caché caído; reintentos que amplifican | Servir lo viejo mientras se refresca; fallar abierto bajando límites; no reintentar timeouts | evolución |
| Medio | Vistas materializadas: no se pueden refrescar en una réplica física; el refresco concurrente exige índice único | Viven en el primario o en réplica lógica; refresco fuera de ventana | documento |

## Volumen de datos

| Nivel | Riesgo | Mitigación | Dónde |
|---|---|---|---|
| Medio | Asistencia: una fila por empleado y día, miles de millones de filas | Particiones por fecha y empresa; el filtro dentro de la CTE permite poda; pre-agregaciones como camino normal | documento |
| Medio | Postgres deja de ser el motor analítico adecuado | La fuente es un objeto de primera clase: cambiar el motor no toca definiciones ni consumidores | evolución |
| Medio | El `LIMIT` de la clase corta el resultado **en silencio**: la respuesta sale con 200 y un gráfico dibujado con ella se ve completo. `fillMissing` lo agrava, porque densificar multiplica las filas por `buckets × ejes` y el resultado cortado ni siquiera muestra huecos | Cerrado con código (ADR 0013), en dos mitades. **Aviso**: cuando las filas devueltas alcanzan el límite efectivo, `meta.warnings` trae una advertencia que lo dice y sugiere acotar el rango, subir la granularidad o pedir menos dimensiones; vale para toda consulta, no sólo para las que rellenan, y viaja también en la entrada de caché. **Rechazo**: con `fillMissing`, los buckets se cuentan sin tocar la base desde el rango y la granularidad, y si solos ya pasan el límite —ni un eje cabría— la consulta se rechaza al planificar con `INVALID_QUERY` y una sugerencia concreta. Los ejes no se estiman: exigiría consultar la base. Medido sobre la empresa C (1,06 M de filas de asistencia): por día y departamento sobre dos años la consulta pasaba de 4.392 filas con 12 departamentos a las 5.000 del tope de `dashboard`, con **7 de 12** departamentos y la serie cortada a mitad. Quien necesita el número exacto de filas del resultado completo lo pide con `total: true` (`meta.total`) | código |

## Entrega

| Nivel | Riesgo | Mitigación | Dónde |
|---|---|---|---|
| Alto | Construir la evolución antes que el núcleo | El repo implementa definiciones, catálogo, engine y tests; el resto se documenta con su costura | código |
| Medio | Reimplementar lo que Cube ya hace | La consulta y las definiciones usan el vocabulario de Cube; lo propio es la validación contra el esquema físico y el catálogo como contexto del agente | documento |

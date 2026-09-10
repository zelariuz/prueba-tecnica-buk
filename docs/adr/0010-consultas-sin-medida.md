# ADR 0010 — Una consulta sin medidas devuelve los valores distintos de sus dimensiones

Supersede la parte de la corrección 4 del abogado del diablo (08-09) que dejaba
`measures` como lista obligatoria de toda consulta. El resto de esa corrección
—la puerta de forma, `INVALID_QUERY` como error del consumidor, las listas, la
granularidad, la dirección de orden y el `limit`— queda igual.

## Contexto
Hasta el 09-09, `validarForma` exigía `measures` no vacío y cortaba con
`INVALID_QUERY` cualquier consulta que sólo pidiera dimensiones.

La restricción no se decidió: se heredó. En la fase 2 la **entidad de hechos**
—de qué tabla sale el `FROM`, qué fuente y qué dialecto escriben el SQL— se
dedujo de la primera medida (`medidas[0].entidad`), porque una consulta con
medidas siempre tiene una. Sin medidas, `catalog.source(undefined)` no resolvía
ninguna fuente y la consulta moría en `exigirFuenteConfigurada` con un `Error`
pelado: un 500 que decía que el servidor estaba mal armado. La corrección 4 del
abogado del diablo convirtió ese 500 en un 400 honesto, que era lo urgente, pero
no implementó el camino: dejó dicho "una consulta necesita al menos una medida"
como si fuera una decisión de diseño, cuando era la forma de no chocar con la
deducción de la entidad de hechos.

El costo apareció en la demo con el agente (09-09). "Cuáles departamentos hay"
es una pregunta que el catálogo puede contestar —`departments.name` es una
dimensión publicada— y no tiene traducción: el agente escribe
`{"dimensions":["departments.name"]}`, que es exactamente el JSON correcto, y la
capa se lo rechaza. Su único camino era `{"noPuedo": …}` sobre una pregunta que
la capa sabe responder, o inventarse una medida que nadie pidió para poder
preguntar. Es el mismo patrón del ADR 0009: un guardarraíl que cuesta preguntas
legítimas.

Y en SQL la consulta existe hace décadas: un `GROUP BY` por las dimensiones sin
ningún agregado en el `SELECT` son los **valores distintos** de esas
dimensiones.

## Decisión
`measures` puede estar ausente o vacío **si la consulta pide al menos una
`dimension` o una `timeDimension`**. Sin ninguna de las tres —una consulta que
no pide nada— sigue siendo `INVALID_QUERY` con `member` `measures`.

La entidad de hechos de una consulta sin medidas es **la entidad de la primera
dimensión**, o la de la primera `timeDimension` si no hay dimensiones. De ahí
sale el `FROM`, la fuente y el dialecto, y desde ahí arranca el BFS por
relaciones `many_to_one` que alcanza al resto (ADR 0006): una dimensión que no
sea alcanzable desde ella corta con `NO_JOIN_PATH`, igual que hoy. El plan
lógico lo publica en `plan.entity`, con `measures` y `baseMeasures` vacíos.

El SQL es el de siempre, sin la etapa agregada ni las derivadas: un `WITH` por
entidad con `company_id = $1`, un `SELECT` de las dimensiones con sus alias
`"entidad.miembro"`, un `GROUP BY` por ellas, el `ORDER BY` pedido y el `LIMIT`
de la clase de consumidor. `test/snapshots/valores-de-dimension.sql` lo fija
letra por letra.

## Alternativas
- **Publicar una medida `count` en cada entidad y pedir "cuáles departamentos
  hay" como `departments.count`**: obliga a cada módulo a declarar una medida
  que nadie quiere ver para poder listar sus valores, y la respuesta traería una
  columna de más que el consumidor tiene que aprender a ignorar. El vocabulario
  se ensuciaría para esquivar un límite del planificador. Descartada.
- **Un endpoint aparte, tipo `GET /analytics/members/:dimension`**: sería una
  segunda forma de pedir datos, con su propio aislamiento por empresa, su propio
  presupuesto y su propia caché que mantener en línea con la primera. Dos
  caminos a la base es exactamente lo que la capa existe para evitar (ADR 0001).
  Descartada.
- **Deducir la entidad de hechos de todo lo que la consulta nombra —dimensiones
  y filtros— y elegir la más "central"**: cualquier heurística de ese tipo hace
  que agregar un filtro cambie el `FROM` en silencio, y con él los joins y el
  número de filas. La regla tiene que ser una que el consumidor pueda predecir
  leyendo su propio JSON. Descartada a favor de "la primera dimensión manda".
- **Emitir `SELECT DISTINCT` en vez de `GROUP BY`**: da las mismas filas, pero
  serían dos formas de emitir la misma consulta según haya medidas o no, y la
  segunda no sabría crecer (una medida que se agrega después obliga a reescribir
  la emisión entera). El `GROUP BY` sin agregados es el mismo camino de siempre
  con una lista vacía. Descartada.

## Consecuencias
- **Lo que no cambia**: la capa sigue devolviendo **sólo agregados y nunca filas
  crudas** —un `GROUP BY` por las dimensiones colapsa las filas de la tabla en
  una por combinación de valores; no hay forma de pedir la fila de un empleado—.
  Tampoco cambian el aislamiento por empresa (`company_id = $1` dentro de la CTE
  de cada entidad, ADR 0003), los joins por relaciones declaradas (ADR 0006), el
  `LIMIT` obligatorio de la clase de consumidor, el `queryId` ni la caché: una
  consulta sin medidas es una consulta como cualquier otra para todas ellas.
- **Los tres snapshots de SQL del repo no se movieron**: ninguna consulta con
  medidas emite un carácter distinto. El cuarto snapshot,
  `valores-de-dimension.sql`, es nuevo.
- **El orden de las dimensiones pasa a importar** cuando no hay medidas:
  `{"dimensions":["employees.active","departments.name"]}` sale de `employees` y
  llega a `departments` por la relación `department`, mientras que el mismo par
  al revés sale de `departments` —que no declara ninguna relación— y corta con
  `NO_JOIN_PATH`. Es el precio de una regla predecible; el error nombra la
  entidad inalcanzable y el consumidor corrige invirtiendo el par.
- **Una dimensión de cardinalidad alta puede tocar el techo de filas** (un
  `GROUP BY` por el nombre de 1.750 empleados con el tope de 1.000 de la clase
  `agente`). Se defiende sola con el `LIMIT` y con `QUERY_TIMEOUT`, igual que
  cualquier consulta grande desde el ADR 0009.
- **El agente de la demo gana una pregunta**: "cuáles departamentos hay" y "qué
  estados de evaluación existen" tienen JSON, y el prompt de creación lo dice.
  La 9ª pregunta preparada (`cuales-departamentos-hay`) la deja a un clic.

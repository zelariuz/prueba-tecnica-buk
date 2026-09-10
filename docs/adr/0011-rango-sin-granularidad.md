# ADR 0011 — Una dimensión temporal con `dateRange` y sin `granularity` sólo filtra

Supersede la regla "v1 exige granularidad en toda `timeDimension`" que la fase 6
dejó anotada en `CLAUDE.md` y en el comentario de la consulta tipo
`asistencia-por-departamento`. El resto de la puerta de forma —las listas, la
lista cerrada de granularidades, la dirección de orden y el `limit`— queda
igual.

## Contexto
La tercera pregunta del enunciado es literal: **"¿Cuál es la tasa de asistencia
por departamento durante los últimos tres meses?"**. Pide un número por
departamento y nombra un período. No pide una tendencia mes a mes.

Hasta el 10-09 la capa no sabía escribir eso. `validarForma` exigía
`granularity` en toda `timeDimension`, así que el rango sólo podía entrar
acompañado de un corte por tiempo, y la consulta tipo del caso terminaba
agrupando por departamento **y mes**: tres filas por departamento donde la
pregunta pedía una. El comentario de la consulta tipo lo decía sin disimulo
("la granularidad mensual es obligatoria —v1 no admite un rango sin
granularidad— y de paso deja ver la tendencia"): la respuesta se acomodó a lo
que la capa podía emitir.

La restricción tampoco era una decisión de diseño. Nació de que el rango y la
granularidad llegaban juntos en el mismo objeto y se resolvían en la misma
línea: la dimensión temporal se empujaba a `dimensiones` con
`dialect.dateTrunc(temporal.granularity, …)` y de ahí salían la columna del
`SELECT` y la del `GROUP BY`. Sin granularidad, ese `dateTrunc` moría con un
`Error` del servidor, así que la puerta de forma lo cortaba antes. Nadie decidió
que acotar sin agrupar no tuviera sentido; lo que no había era código.

En el vocabulario que la capa copió (ADR 0007) las dos cosas ya están
separadas: en Cube, `granularity` de una `timeDimension` es **opcional** y
`dateRange` sin ella filtra sin agrupar. Un agente que conozca Cube escribe ese
JSON, y hasta hoy la capa se lo rechazaba con `INVALID_QUERY` — el mismo patrón
del ADR 0009 y del ADR 0010: un guardarraíl que cuesta preguntas legítimas.

## Decisión
Una `timeDimension` puede traer `dateRange` y **no** traer `granularity`. En ese
caso la fecha **sólo filtra**: el rango sigue viviendo dentro de la CTE de su
entidad (`>= $n AND <= $m`, cerrado en los dos extremos, ADR 0003 y fase 2) y la
dimensión **no** aparece como columna del `SELECT`, ni en el `GROUP BY`, ni en
las filas, ni en `plan.dimensions`.

- Con `granularity` (con rango o sin él) no cambia nada: es la consulta de
  siempre, con el mismo SQL.
- Con `granularity` **y** `dateRange`, tampoco: es el caso obligatorio.
- Sin `granularity` **y sin** `dateRange` sigue siendo `INVALID_QUERY`, con
  `member` `timeDimensions[i].granularity`: una dimensión temporal que ni filtra
  ni agrupa no dice nada. La sugerencia ahora nombra las dos salidas —la lista
  de granularidades, o `dateRange` sin `granularity`—.
- Una consulta que **no trae más que** una dimensión temporal que sólo filtra no
  pide nada, y sale con el mismo `INVALID_QUERY` con `member` `measures` del ADR
  0010: sin columna de salida no hay SQL que emitir.

La entidad de un rango que sólo filtra entra al **camino de joins** igual que la
de un filtro: toda entidad con condiciones necesita su CTE. Antes eso salía
gratis, porque la dimensión temporal siempre estaba en `dimensiones`; ahora el
planificador arma los destinos del BFS con las entidades de las dimensiones más
las que tienen condiciones. Sin eso, un rango sobre una entidad inalcanzable se
habría perdido en silencio y la consulta habría devuelto un número mayor que el
pedido; con eso, sigue siendo el mismo `NO_JOIN_PATH` que daba con granularidad.

## Alternativas
- **Dejarlo como estaba y responder la pregunta con granularidad `month`, como
  hasta hoy**: es una respuesta a otra pregunta. "Por departamento durante los
  últimos tres meses" son dos filas en el seed chico; con `month` son seis, y
  quien preguntó tiene que promediarlas él —mal, porque el promedio de tres
  tasas mensuales no es la tasa del trimestre salvo que los tres meses tengan
  los mismos días registrados—. La capa existe justamente para que nadie tenga
  que hacer esa cuenta afuera. Descartada.
- **Un campo aparte, tipo `dateFilters`, separado de `timeDimensions`**: sería
  una segunda forma de escribir el mismo rango sobre la misma columna, con su
  propia validación y su propio lugar en el orden de los parámetros `$n`. Y
  rompería el vocabulario Cube del ADR 0007 justo donde Cube ya tiene una
  respuesta. Descartada.
- **Expresar el período como un `filter` con operador `inDateRange` sobre la
  dimensión de fecha**: es lo que el vocabulario ya insinúa (`inDateRange` está
  en la tabla de operadores de `date`), pero ese operador **no está emitido** —la
  vista pública sólo publica los que el planificador escribe (corrección 8 del
  abogado del diablo)— y agregarlo dejaría dos maneras de acotar el tiempo: una
  en `timeDimensions` y otra en `filters`, con reglas distintas de dónde cae el
  rango. Queda como evolución posible; no es esta decisión.
- **Aceptar `granularity: null` o `granularity: 'none'` como "no agrupes"**:
  agrega un valor centinela al vocabulario para decir lo que la ausencia del
  campo ya dice, y obliga a cada consumidor a aprenderlo. Cube no lo hace.
  Descartada.

## Consecuencias
- **Con granularidad no cambia nada.** Los tres snapshots de SQL originales y
  `valores-de-dimension.sql` quedaron byte por byte iguales: ninguna consulta
  que ya existía emite un carácter distinto. El snapshot nuevo es
  `test/snapshots/rango-sin-granularidad.sql`, la tasa de asistencia por
  departamento con el rango dentro de la CTE de `attendance` y una sola columna
  de agrupación.
- **Las consultas tipo registradas no se movieron.**
  `asistencia-por-departamento` sigue agrupando por mes: es una plantilla útil
  —la tendencia— y cambiarla habría cambiado las filas que devuelve un nombre ya
  publicado en el catálogo. La forma sin granularidad se pide escribiendo el
  JSON; la demo la lleva en sus tres preguntas del enunciado.
- **El `queryId` y la caché no se enteran**: la consulta sin granularidad es una
  consulta como cualquier otra para la identidad, el TTL y el aislamiento por
  empresa.
- **La respuesta pierde la columna de fecha, y eso es lo pedido**: quien quiera
  la tendencia agrega `granularity` y la recupera. No hay forma de tener las dos
  cosas en una sola consulta, y no debería haberla: son dos preguntas.
- **El agente gana la traducción de dos preguntas del enunciado.** El prompt de
  creación de la demo lo dice en una viñeta ("úsala cuando la pregunta pide un
  período pero no un corte por tiempo"), porque el catálogo publica
  `granularities` sin decir que la granularidad es opcional: sin esa línea, el
  agente sigue agrupando por mes lo que nadie pidió.

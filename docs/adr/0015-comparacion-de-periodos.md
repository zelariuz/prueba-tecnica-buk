# ADR 0015 — Comparar períodos son varias consultas, no un `UNION ALL`

Extiende el ADR 0007 (vocabulario Cube), el ADR 0012 (relleno), el ADR 0013
(truncado y total) y el ADR 0014 (rangos relativos). No supersede nada: una
consulta sin `compareDateRange` devuelve exactamente la respuesta de siempre, y
los seis archivos de `test/snapshots/` quedaron byte por byte iguales.

## Contexto

"Este mes contra el mes pasado" es la pregunta que sigue a cualquier número que
alguien mira en un tablero. Hasta hoy se respondía con **dos peticiones**, y el
consumidor quedaba a cargo de tres cosas que no son suyas: calcular las dos
ventanas (el ADR 0014 ya le quitó esa parte), pedirlas en paralelo, y juntarlas
sabiendo cuál era cuál.

Cube lo resuelve con `compareDateRange` dentro de la dimensión temporal, **en
lugar de** `dateRange`, con un arreglo de rangos. Este ADR adopta esa propiedad
—y, como todo lo demás, adopta el vocabulario pero no la implementación.

```json
{ "measures": ["attendance.count"],
  "dimensions": ["departments.name"],
  "timeDimensions": [{ "dimension": "attendance.date", "granularity": "month",
                       "compareDateRange": ["this month", "last month"] }] }
```

Cada rango es un par de fechas **o una frase del vocabulario del ADR 0014**, y
ése es el caso de uso real: quien compara períodos no quiere escribir cuatro
fechas que mañana están viejas.

## Decisión

### 1 · Una planificación y una ejecución por rango

`compareDateRange` se expande en **N consultas normales** —la misma consulta con
`dateRange` donde venía la lista— y cada una recorre el camino que ya existe:
su plan, su SQL, su `queryId`, su entrada de caché, su `meta`. No hay un segundo
motor ni una sintaxis nueva: hay N vueltas por el mismo. Lo único que la capa
agrega encima es el rótulo que dice a qué ventana corresponde cada resultado y
el orden.

La alternativa obvia era un `UNION ALL` que trajera todos los rangos en una sola
sentencia. Se descarta por dos razones, y las dos son estructurales:

- **Cada rango tiene su propia vida de caché.** El mes pasado ya terminó y no va
  a cambiar nunca más; este mes cambia todo el rato. Con `UNION ALL` los dos
  comparten una llave y un TTL, así que cada vez que alguien mira el tablero se
  recalcula también la mitad que estaba congelada. Separados, la mitad estable
  sale de la caché y sólo se paga la que se mueve. Comprobado ejecutando: la
  misma comparación tarda 95,4 ms la primera vez y 1,1 ms la segunda (las dos
  entradas en `cache-l1`); cambiando **sólo el primer rango**, 26,1 ms — el
  segundo sigue saliendo de caché, con el mismo `queryId` de antes.
- **`UNION ALL` obligaría a una columna que dijera de qué rango viene cada
  fila**, y esa columna no sería un miembro declarado por ninguna entidad.
  Rompería la invariante que sostiene el contrato de esta capa: toda columna de
  salida tiene nombre semántico y sale del catálogo (ADR 0008). Una columna
  `__rango` inventada por el planificador es exactamente el tipo de fuga que el
  resto del diseño evita.

Hay un tercer efecto, menor pero real: con N consultas separadas, los
guardarraíles que ya existen —el tope de filas de la clase, la advertencia de
truncado (ADR 0013), el chequeo de buckets de `fillMissing`— se aplican **por
rango**, sin una sola regla nueva. Con `UNION ALL` habría que reescribirlos
todos para que supieran repartirse entre ventanas.

La expansión vive en `src/comparacion.js` y la llama el **engine**, no el
planificador: lo que decide no es cómo se traduce una consulta, sino **cuántas
consultas hay**, y ésa es una pregunta anterior a planificar. Sus rechazos
llevan igual la anotación de puerta no enumerable (`gate:
'expandirComparacion'`) que el planificador le pone a los suyos, para no ser el
único rechazo invisible en la telemetría por puerta (historia 31).

### 2 · La respuesta cambia de forma, y sólo para esta consulta

```jsonc
{ "results": [
    { "dateRange": ["2025-08-01", "2025-08-15"], "dateRangeExpression": "this month",
      "rows": [ … ], "meta": { "servedFrom": "live", "asOf": "…", "queryId": "…", "warnings": [] } },
    { "dateRange": ["2025-07-01", "2025-07-31"], "dateRangeExpression": "last month",
      "rows": [ … ], "meta": { "servedFrom": "cache-l1", "asOf": "…", "queryId": "…", "warnings": [] } } ] }
```

Tres propiedades, y cada una es una decisión:

- **Cada elemento dice a qué rango corresponde, ya resuelto**, y conserva la
  frase al lado en `dateRangeExpression` si la hubo — el mismo nombre que estrenó
  el plan lógico del ADR 0014, y sale del mismo lugar: el plan, no la consulta.
  Sin el rango resuelto, el consumidor no puede rotular su gráfico; sin la
  frase, no puede distinguir una ventana fija de una que se mueve sola.
- **El orden de `results` es el de los rangos pedidos, siempre.** Se ejecutan en
  serie y se acumulan en orden; no hay ninguna carrera que pueda alterarlo.
- **Un consumidor que no usa `compareDateRange` recibe la respuesta de hoy, byte
  por byte**: `{ rows, meta }`, sin `results` y sin rótulo. La forma la decide la
  **presencia de la propiedad**, no otra cosa. Hay tests que lo fijan.

No hay `rows` ni `meta` de primer nivel. Ponerlos obligaría a elegir cuál de los
rangos es "el" resultado y cuál el accesorio, y eso es una opinión que la capa
no tiene: comparar es simétrico. Tampoco hay un `meta` global: cada rango se
sirvió de un lugar distinto, en un instante distinto y con sus propias
advertencias, y un `servedFrom` único tendría que mentir en la mitad de los
casos.

Por la misma razón, **la propiedad decide la forma aunque haya un solo rango**.
`compareDateRange: ["last month"]` devuelve un `results` de un elemento: quien
arma la lista desde una UI —un selector de períodos— no tiene que cambiar de
rama cuando el usuario deja uno solo marcado. La lista **vacía sí se rechaza**:
no pide ninguna ventana, y un `results: []` con un 200 al lado es la peor manera
de decir que no se entendió la pregunta.

### 3 · El tope es cuatro rangos

N rangos son N consultas contra la base. **El tope de rangos es la única cosa que
acota lo que una petición puede gastar cuando compara**, y por eso existe:
`compareDateRange` con más de **cuatro** rangos es `INVALID_QUERY` con la salida
en la sugerencia.

Cuatro, y no tres como en los ejemplos de Cube, porque cuatro es donde caen las
comparaciones que la gente pide de verdad: un período contra el anterior (2), los
cuatro trimestres de un año, un mes contra el mismo mes de los tres años
anteriores. El peor caso del tablero son 4 × 5 s de `statement_timeout`, todavía
debajo del medio minuto que tolera cualquier proxy delante del servicio. Y de
cinco en adelante ya no se está comparando: se está pidiendo una **serie**, que
esta capa responde mucho mejor con `granularity` sobre el rango que las cubre a
todas —una sentencia, un recorrido— y así lo dice la sugerencia del rechazo.

### 4 · El presupuesto no se reparte: cada rango recibe el de su clase entero

Un rango de la comparación se ejecuta con el mismo `timeoutMs`, el mismo
`maxFilas` y el mismo `cacheTtlMs` que si fuera la consulta entera. Repartirlo
entre los rangos fue considerado y descartado:

- **El tope de filas dice cuántas filas puede manejar el consumidor por serie.**
  Dividirlo haría que la misma consulta devolviera la mitad de las filas por
  período al comparar dos, y un tercio al comparar tres: el resultado de cada
  ventana cambiaría según con cuántas otras se la compara, que es exactamente el
  tipo de sorpresa que esta capa existe para que nadie tenga.
- **El timeout es un guardarraíl por sentencia**, el `SET LOCAL
  statement_timeout` de la transacción. Dividirlo haría que una consulta que
  funciona sola fallara dentro de una comparación, y el consumidor no tendría
  cómo saber por qué.

Lo que sí se multiplica es el costo total, y eso se acota donde corresponde: en
el **tope de rangos** (punto 3), que es el presupuesto de la comparación.

### 5 · Un solo "hoy" para toda la comparación

Los rangos se planifican por separado, pero **el reloj se lee una sola vez** y el
mismo instante viaja a la puerta 0 de cada planificación (`planificar(query, ctx,
{ ahora })`). No es una prolijidad: si el día cambiara entre un rango y el
siguiente —el 31 de agosto a las 23:59—, `this month` resolvería a agosto y
`last month`, ya en septiembre, **también a agosto**. La comparación sería contra
sí misma, con dos series idénticas, un 200 y ninguna advertencia. Es el mismo
modo de fallar que el ADR 0014 evita dentro de una consulta, un nivel más
arriba. Hay un test con un reloj que cruza esa medianoche a propósito.

### 6 · Qué se rechaza

Todo con `INVALID_QUERY` (400), `member` apuntando a lo que el consumidor
escribió y sugerencia con la salida:

| Rechazo | Por qué |
|---|---|
| `dateRange` y `compareDateRange` en la misma dimensión temporal | Declaran lo mismo —qué ventana mirar— y pedir las dos deja ambiguo cuál manda |
| `compareDateRange` que no es una lista | Es una lista de rangos, como en Cube |
| Lista vacía | No pide ninguna ventana |
| Más de 4 rangos | Punto 3 |
| Dos dimensiones temporales comparando | Sería el producto de las dos listas, y ningún resultado podría decir a qué combinación corresponde |
| Un rango inválido | Se valida como cualquier `dateRange`, frases incluidas (ADR 0014) |

El último tiene un detalle que importa: el resto del sistema ve una consulta con
`dateRange` —para eso se expandió—, así que su rechazo señalaría
`timeDimensions[0].dateRange`, una propiedad que **quien preguntó no escribió en
ninguna parte**. Ese miembro, y sólo ése, se reescribe a
`timeDimensions[0].compareDateRange[1]`. Un `UNKNOWN_MEMBER` o un rechazo de
presupuesto no tienen nada que ver con el rango y salen tal cual.

## Alternativas

- **`UNION ALL` en una sola sentencia.** Una ida a la base en vez de N, que es
  su único argumento. Pierde la caché por rango —la mitad estable se recalcula
  en cada consulta— y obliga a una columna discriminadora que no es un miembro
  declarado. Descartada; es la decisión central de este ADR.
- **Los N rangos en paralelo.** Reduciría la latencia de una comparación de la
  suma al máximo. A cambio, una sola petición toma N conexiones del pool, que
  comparten todos los consumidores: bajo carga, un tablero que compara cuatro
  períodos desplaza a cuatro consultas de otros. Con la caché por rango, la
  segunda vuelta ya cuesta milisegundos (1,1 ms medidos), así que lo que se
  ganaría es latencia en la primera. Descartada para v1; es la evolución natural
  si alguna vez se mide que duele, y no cambia ni la forma de la respuesta ni una
  sola validación.
- **Dejar la comparación al consumidor, con dos peticiones.** Es el estado
  anterior. Funciona, y reparte en cada tablero la aritmética de las ventanas y
  el armado del resultado. Descartada; es el motivo del ADR.
- **Una `dimension` sintética "período" que distinga las ventanas.** Es lo que
  haría el `UNION ALL` disfrazado de miembro. Obligaría al catálogo a declarar
  una dimensión que no existe en ninguna tabla y que cambia de dominio en cada
  consulta. Descartada.
- **Resolver `compareDateRange` en el planificador, como una puerta más.** El
  planificador traduce **una** consulta a **un** SQL, y ésa es su definición
  entera (ADR 0005). Devolver N planes desde una puerta lo convertiría en otra
  cosa. Descartada: la pregunta "cuántas consultas hay" es anterior a planificar,
  y el engine es quien la puede responder.
- **Aceptar un `results` vacío para la lista vacía.** Simétrico y prolijo, y la
  peor manera de fallar: un 200 con cero resultados se dibuja como un gráfico
  vacío, que es indistinguible de un período sin datos. Descartada.
- **Repartir el presupuesto entre los rangos.** Punto 4. Descartada.

## Consecuencias

- **Sin `compareDateRange` no cambia nada.** Ni el SQL, ni los parámetros, ni el
  `queryId`, ni la caché, ni la forma de la respuesta. Los seis archivos de
  `test/snapshots/` quedaron byte por byte iguales, y hay un test que fija que el
  SQL de un rango es, byte por byte, el de la misma consulta con ese `dateRange`.
- **Una comparación son N líneas de log, no una.** El observador emite un evento
  por consulta ejecutada, y aquí se ejecutan N: es lo honesto, porque N consultas
  pegaron a la base. La telemetría cuenta lo mismo: N respuestas servidas. Quien
  mire el `hitRatio` de un tablero que compara verá subir hits y misses de a dos.
- **El dry-run devuelve un plan por rango**, en la misma forma `{ results: [...] }`
  y con el mismo rótulo. Sigue sin tocar la base: N planes, cero sentencias.
  Por HTTP, el SQL se sigue escondiendo en cada uno de ellos salvo para una
  sesión interna (ADR 0008).
- **`fillMissing`, `total` y el truncado funcionan por rango sin una línea
  nueva.** Cada resultado trae su serie densa, su `meta.total` y sus
  advertencias. El chequeo de buckets del ADR 0013 cuenta los buckets **de cada
  rango**, no los de la unión.
- **El agente todavía no sabe que existe.** El prompt de creación de
  `demo-agente` no nombra `compareDateRange`, así que seguirá pidiendo dos
  consultas cuando quiera comparar —que funciona igual—. Queda anotado como
  evolución, junto con la viñeta del vocabulario relativo que el ADR 0014 dejó
  pendiente.
- **`compareDateRange` no se publica en el catálogo**, como tampoco el
  vocabulario de rangos relativos. Vive en la documentación y en la sugerencia
  de sus rechazos. La misma evolución natural: sacarlo por `describe()`.

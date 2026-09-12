# ADR 0012 — El relleno de series densas es una bandera de la consulta, no una propiedad del módulo

Extiende el ADR 0011 (rango sin granularidad) y el ADR 0007 (vocabulario Cube).
No supersede nada: sin la bandera nueva, el SQL emitido es byte por byte el de
antes.

> **Corregido el 2026-09-11.** La CTE `ejes` de «Forma del SQL» y su bullet «Los
> ejes salen de los mismos datos ya filtrados» **ya no son lo que se emite**: los
> ejes dependían del `dateRange` y no debían. Lee la sección «Corrección» del
> final antes de creerle a esas dos líneas; se dejan escritas a propósito.

## Contexto
Una serie temporal agregada sólo trae los buckets que **tienen filas**. La tasa
de asistencia de Ventas del 8 al 14 de agosto del seed devuelve tres días —el
8, el 9 y el 10—, porque a partir del 11 no hay registros. Un gráfico de líneas
dibujado con esas tres filas no muestra un hueco: muestra una línea continua que
salta del 10 al 14 como si nada hubiera pasado entre medio. El consumidor no
puede distinguir "no hubo datos" de "no pasó nada", y la forma de la curva miente.

El arreglo clásico es que cada consumidor rellene los buckets faltantes en su
propio código. Eso repite la misma lógica en cada tablero, cada uno con su
criterio sobre qué poner en el hueco, y el criterio equivocado —rellenar un
promedio con cero— es fácil y silencioso. Es exactamente el tipo de cuenta que
esta capa existe para que nadie haga afuera.

## Decisión

### Dónde vive la bandera
En la **dimensión temporal de la consulta**, no en la definición del módulo:

```json
{ "dimension": "attendance.date", "granularity": "day",
  "dateRange": ["2025-06-01", "2025-06-30"], "fillMissing": true }
```

La razón es de propiedad, no de comodidad. Que una serie deba venir densa **no
es un hecho sobre la entidad**: la tabla `attendance` no cambia de naturaleza
según quién la mire. Es una necesidad de quien dibuja. El mismo módulo alimenta
un gráfico que necesita la serie densa, una exportación a CSV que no la quiere
(catorce filas donde había diez, la mitad vacías) y un agente que cuenta filas.
Si la bandera viviera en la definición, el módulo tendría que elegir por los
tres, y cambiarla obligaría a redesplegar el catálogo —y a invalidar su versión,
y con ella toda la caché— para atender a un solo consumidor. En la consulta, la
elige quien la necesita y no le cuesta nada a nadie más.

Es la misma frontera que ya marcan el ADR 0002 (el presupuesto es del consumidor,
no de la consulta) y el ADR 0008 (la vista pública es del catálogo, no del
consumidor), leída en el otro sentido: lo que depende de quién pregunta viaja
con la pregunta.

### Qué exige
`fillMissing: true` exige **granularity y dateRange** en la misma dimensión
temporal. Sin granularidad no hay bucket que repetir; sin rango no hay desde
dónde ni hasta dónde. Falta cualquiera de los dos → `INVALID_QUERY` con `member`
`timeDimensions[i].fillMissing`. Un valor que no es booleano, lo mismo. Se
rechaza en vez de ignorar la bandera en silencio, que dejaría al consumidor
creyendo que su gráfico ya viene denso.

### Qué se rellena con cero y qué queda nulo
**Lo decide el tipo de la medida, que el catálogo ya conoce.** Nunca la consulta:
no hay un `fillWith` que el consumidor pueda elegir.

| Tipo | En un bucket sin filas | Por qué |
|---|---|---|
| `count`, `count_distinct`, `sum` | `COALESCE(…, 0)` | Hubo **cero eventos**. El 0 es el valor verdadero, no un relleno. |
| `avg` | nulo | El promedio de cero valores **no existe**. Un 0 hunde la línea del gráfico justo donde no hubo datos: es un número falso. |
| `ratio` (derivada) | nulo, **solo** | Se calcula afuera sobre el resultado ya denso; su denominador rellenado en 0 la anula por el `NULLIF` que ya estaba (ADR 0004). No hay una regla nueva. |

Que la razón se anule sola es la consecuencia bonita de que las derivadas se
sigan calculando **fuera** de la etapa agregada: el relleno no tuvo que aprender
nada sobre ellas.

### Qué capacidad necesita la fuente
Una capacidad nueva del dialecto, `serieDeFechas`:

- `capabilities.serieDeFechas` (booleana).
- `serieDeFechas(granularidad, desdeSql, hastaSql)` → el SQL de una sola columna
  llamada `bucket`, con **el mismo formato de texto que `dateTrunc`**. El JOIN
  del relleno une serie y agregada por igualdad de texto: un formato distinto no
  falla, devuelve todos los buckets vacíos, que es la peor forma de fallar.
  `desdeSql` y `hastaSql` llegan como marcadores (`$2`, `$3`), nunca como valores.

**Postgres** la declara `true` y la emite con `generate_series`, **truncando el
inicio**: sin `DATE_TRUNC` en el extremo de partida, un rango que arranca el 15
de enero con granularidad `month` produciría 15/01, 15/02, 15/03 —fechas que
`dateTrunc` nunca emite— y ningún bucket calzaría. El paso sale de una tabla y
no del nombre de la granularidad: `DATE_TRUNC` entiende `'quarter'` pero
`INTERVAL '1 quarter'` no existe en Postgres y hay que escribirlo como tres meses.

**SQLite la declara `false`.** `generate_series` es una extensión opcional que
`node:sqlite` no trae, y la alternativa —una CTE recursiva— tendría que avanzar
desde un inicio truncado que en este dialecto no siempre es una fecha: para el
trimestre, `dateTrunc` devuelve el texto de un `PRINTF`, sobre el que
`DATE(…, '+3 months')` no opera. Se puede hacer; lo que no se puede es
**prometer** que el texto calce carácter por carácter en las cinco
granularidades, y una serie que no calza devuelve todo vacío sin avisar.
Declararlo `false` es la respuesta honesta, y es exactamente lo que ya se hizo
con `tiposGarantizados` y `timeoutDeSentencia` (fase B): lo que un motor no
puede prometer se declara, no se esconde en un `if` del engine.

Pedir `fillMissing` sobre una fuente que no la declara sale con
**`UNSUPPORTED_OPERATOR`** (400), el código que el vocabulario ya usa para "esto
es parte del contrato, pero esta fuente no lo sabe escribir". Es un 400 y no un
500 porque quien consulta puede arreglarlo quitando la bandera. No se inventó un
código nuevo: el que hay está mapeado en `src/http/codigos.js` y significa esto.

### Forma del SQL
Con relleno aparecen tres CTE nuevas después de las de entidad, y el cuerpo pasa
a leer de ellas:

```sql
WITH <ctes por entidad de siempre>,
serie    AS (<serieDeFechas: una columna `bucket`>),
ejes     AS (SELECT DISTINCT <dimensiones NO temporales> FROM <raíz + joins>),
agregada AS (<exactamente la etapa agregada de siempre>)
SELECT ejes."<dim>" AS "<dim>", serie.bucket AS "<miembro temporal>",
       COALESCE(agregada."<medida>", 0) AS "<medida>"
FROM serie CROSS JOIN ejes
LEFT JOIN agregada ON agregada."<miembro temporal>" = serie.bucket
                  AND agregada."<dim>" = ejes."<dim>"
ORDER BY … LIMIT $n
```

- **Sin dimensiones no temporales** no hay `ejes` ni `CROSS JOIN`: la serie sola
  es el esqueleto y el cuerpo es `FROM serie LEFT JOIN agregada ON …`.
- **Los ejes salen de los mismos datos ya filtrados**, dentro de las CTE con su
  `company_id = $1`: se rellena el tiempo de los ejes que **existen**, no se
  inventan departamentos que la empresa no tiene ni se cruzan los de otra.
- **Rellenar no agrega ni un parámetro.** La serie se genera con los mismos `$2`
  y `$3` que ya filtran la CTE de la entidad temporal, así que la numeración de
  los `$n` —que depende del orden de las puertas— no se mueve.
- **Sin `fillMissing` no se emite nada de esto.** Los cinco archivos de SQL de
  referencia que ya existían en `test/snapshots/` quedaron byte por byte iguales.

## Alternativas
- **Que cada consumidor rellene sus huecos.** Es el estado anterior. Repite la
  lógica en cada tablero y deja que cada uno elija qué poner en el hueco; el
  error caro —cero en un promedio— es el más fácil de cometer y no se ve. La capa
  ya conoce el tipo de cada medida; el consumidor, no. Descartada.
- **`fillMissing` en la definición del módulo.** Convierte una necesidad de quien
  dibuja en una propiedad de la entidad, obliga al módulo a elegir por todos sus
  consumidores y hace que cambiarla cueste un redespliegue del catálogo y toda
  la caché. Descartada; es el centro de este ADR.
- **Un `fillWith` que el consumidor elija** (`0`, `null`, `previous`). Deja al
  consumidor decidir que un promedio vale 0, que es justo el número falso que
  esto evita. `previous` (last-observation-carried-forward) además **inventa
  datos**: dice que el 12 de agosto hubo la misma asistencia que el 10, y eso no
  se sabe. Queda como evolución si algún consumidor la justifica; hoy la regla la
  pone el tipo de la medida. Descartada.
- **Una tabla de calendario en la base** (`dim_date`), unida como una entidad
  más. Es la solución de almacén de datos clásica y es más rápida en rangos
  largos, pero agrega una tabla física que mantener, con su empresa y su relleno
  a futuro, y la haría obligatoria para cualquier fuente nueva. `generate_series`
  no necesita nada en la base. Descartada para v1; la costura es la misma
  (`serieDeFechas` del dialecto), así que un motor podría implementarla así.
- **Rellenar en el post-proceso del engine, en JavaScript**, sobre las filas ya
  devueltas. Evita tocar el SQL, pero rellena **después del `LIMIT`**: la base
  corta la serie dispersa y el relleno completa una serie que ya venía
  incompleta, sin manera de saberlo. Descartada.

## Consecuencias
- **Sin la bandera no cambia nada**, ni el SQL, ni los parámetros, ni la caché.
  El snapshot nuevo es `test/snapshots/relleno-de-serie.sql`.
- **El `queryId` y la caché la ven como lo que es**: `fillMissing` forma parte
  de la consulta, así que la versión rellenada y la dispersa son dos entradas
  distintas de caché. Es lo correcto: devuelven filas distintas.
- **Densificar multiplica filas contra el tope de la clase de consumidor**, y el
  corte es silencioso. Medido sobre la empresa C: la misma consulta por día y
  departamento sobre un rango de dos años pasa de 4.392 filas (12 departamentos
  completos) a las 5.000 del tope de `dashboard`, con **7 de 12 departamentos**
  en la respuesta y la serie cortada a mitad de camino. Queda registrado en
  `docs/riesgos.md` con su mitigación y su evolución. **Cerrado por el ADR
  0013**: una serie cuyos buckets solos ya no caben se rechaza al planificar, y
  cualquier resultado que llegue al tope de su clase sale con una advertencia en
  `meta.warnings`.
- **Los nombres `serie`, `ejes` y `agregada` son de la capa.** Una entidad
  registrada con uno de esos nombres chocaría con su CTE. Hoy no existe —y
  `agregada` ya corría el mismo riesgo desde el ADR 0004—, pero es una deuda
  conocida: el día que importe, los tres alias se prefijan.

## Corrección · 2026-09-11 · Los ejes no dependen del rango

Esta sección no reescribe el ADR: lo corrige a la vista. La decisión de arriba
tenía un error de especificación, y el valor de dejarlo escrito es que se vea
cuál fue y por qué cambió.

### Qué decía

En «Forma del SQL», la CTE de los ejes era

```sql
ejes AS (SELECT DISTINCT <dimensiones NO temporales> FROM <raíz + joins>)
```

y el ADR lo justificaba así: «**Los ejes salen de los mismos datos ya
filtrados**, dentro de las CTE con su `company_id = $1`: se rellena el tiempo de
los ejes que **existen**, no se inventan departamentos que la empresa no tiene ni
se cruzan los de otra».

### Por qué estaba mal

La frase era verdadera a medias. Los ejes salían de la **entidad de hechos**, y
su CTE lleva —además del `company_id`— la condición del `dateRange`. Así que los
ejes no eran «los valores que existen» sino «los valores que **tienen datos en el
período**». El período tiene que decidir el eje x, no qué series existen.

Reproducido contra Postgres real, empresa A, `attendance.attendance_rate` por
`departments.name`, granularidad `day`, entre el 01 y el 31 de enero de 2025 con
`fillMissing: true`: **`rows: []` y `warnings: []`**. El seed sólo tiene
asistencia de junio a agosto, así que `ejes` quedaba vacía y el producto cruzado
no producía nada.

Dos consecuencias, la segunda peor que la primera:

- Un valor de dimensión sin datos en el período **desaparecía** en vez de salir
  con su serie en cero. En un gráfico falta una línea entera, y quien lo mira no
  tiene cómo notarlo: es exactamente el fallo que este ADR vino a corregir, una
  vuelta más abajo.
- Si **ninguno** tenía datos, la respuesta era cero filas **en silencio**, que es
  lo contrario de lo que la bandera promete.

El código hacía lo que decía la especificación. La especificación estaba mal.

### Qué dice ahora

**1 · Los ejes se arman desde las entidades de las dimensiones, sin pasar por la
entidad de hechos.** Esas CTE ya llevan su `company_id` y sus propios filtros
—un segmento de empleados activos, por ejemplo—, así que los ejes siguen
respetando lo que deben respetar y dejan de respetar el recorte de fechas, que no
era suyo. El ejemplo del snapshot pasa de

```sql
FROM attendance JOIN employees JOIN departments   -- antes
FROM departments                                   -- ahora
```

Una entidad intermedia entra sólo si aporta: o trae condiciones propias que los
ejes tienen que respetar, o hace de puente entre dos que sí entran. Pasar por una
entidad que no aporta nada **no es gratis**: `FROM employees JOIN departments`
borra los departamentos sin ningún empleado, que existen igual. Con el segmento
`employees.active` en la consulta, en cambio, los ejes vuelven a pasar por
`employees` y son los departamentos con empleados activos, porque eso es lo que
la consulta pidió.

**No se arma una segunda copia de la CTE de hechos sin el filtro de fecha.**
Escanear un millón de filas de asistencia para averiguar qué departamentos hay es
justo lo que el rango existe para evitar; la tabla de hechos se sigue leyendo una
sola vez y siempre acotada.

**2 · Una dimensión no temporal de la propia entidad de hechos rechaza el
relleno.** `attendance.present` agrupando junto con `fillMissing` no tiene
dominio conocible barato: saber qué valores tiene exige recorrer `attendance`
entera **sin** el rango que la acota. Sale `INVALID_QUERY` (400) nombrando la
dimensión, con una sugerencia que explica por qué y da las dos salidas: agrupar
por una dimensión de otra entidad, o pedir la consulta sin relleno. El mismo
rechazo cubre el caso simétrico —que la entidad necesaria para los ejes sea la
que aplica el `dateRange` de la dimensión rellenada—, porque es el mismo problema
por la puerta de atrás.

Se eligió **rechazar** y no degradar con advertencia, y la razón es la coherencia
del repo: el ADR 0013 ya rechaza la serie que no cabe («el error se reserva para
lo que con certeza no puede responderse») y el ADR 0012 ya descartó la
alternativa de «desactivar el relleno por encima de un número de filas» porque
convierte una serie densa en una dispersa sin avisar. Degradar aquí sería eso
mismo: devolver 200 con una serie que el consumidor pidió densa. Antes rechazar
que responder mal o carísimo.

Lo que **no** cambia: una consulta con `fillMissing` y **sin** dimensiones no
temporales no tiene ejes, y sigue emitiendo `FROM serie LEFT JOIN agregada`.

**3 · Un relleno que vuelve vacío lo dice.** Corregidos los ejes, la rejilla ya
no puede vaciarse porque el período no tenga datos; sólo puede vaciarse si la
empresa no tiene ningún valor de esa dimensión. Cuando pasa, `meta.warnings` trae
una advertencia con la forma `{ member, warning }` de siempre. Una función que
existe para que nada falte no puede fallar callada. Nace en el engine y no en el
planificador, por lo mismo que el aviso de truncado del ADR 0013: antes de
ejecutar no hay filas que contar.

### Consecuencias de la corrección

- **El SQL de referencia `test/snapshots/relleno-de-serie.sql` cambió**, y es el
  único que cambió: su CTE `ejes` pasó de `FROM attendance JOIN employees JOIN
  departments` a `FROM departments`. Los otros cinco siguen byte por byte
  iguales, y una consulta sin `fillMissing` no cambió ni un carácter.
- **Una consulta que antes devolvía menos filas ahora devuelve más**, y ése es el
  arreglo: los ejes son todos los que existen. La aceptación es la consulta que
  reprodujo el defecto: dos departamentos × 31 días = 62 filas, con la tasa en
  nulo y el conteo en cero.
- **El tope del ADR 0013 mide la rejilla nueva sin una regla propia.** El rechazo
  por buckets no se movió —cuenta buckets, no ejes—, el aviso de truncado cuenta
  filas de verdad y `total: true` cuenta el mismo cuerpo que produce las filas.
  Con el tope en 40 filas, la consulta de la aceptación devuelve 40, advierte el
  corte y `meta.total` dice 62.
- **Un test cambió de expectativa a propósito**: «el relleno no cruza empresas»
  esperaba que la empresa B devolviera sólo Ingeniería, porque Ventas no tenía
  asistencia en el rango. Ahora devuelve sus dos departamentos, uno de ellos con
  la serie entera en cero. Lo que el test prueba —que no se cruzan las empresas—
  sigue en pie: son sus dos departamentos, no los cuatro del seed.

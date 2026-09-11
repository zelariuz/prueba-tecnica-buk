# ADR 0012 — El relleno de series densas es una bandera de la consulta, no una propiedad del módulo

Extiende el ADR 0011 (rango sin granularidad) y el ADR 0007 (vocabulario Cube).
No supersede nada: sin la bandera nueva, el SQL emitido es byte por byte el de
antes.

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
  `docs/riesgos.md` con su mitigación y su evolución.
- **Los nombres `serie`, `ejes` y `agregada` son de la capa.** Una entidad
  registrada con uno de esos nombres chocaría con su CTE. Hoy no existe —y
  `agregada` ya corría el mismo riesgo desde el ADR 0004—, pero es una deuda
  conocida: el día que importe, los tres alias se prefijan.

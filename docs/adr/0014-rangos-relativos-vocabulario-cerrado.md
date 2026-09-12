# ADR 0014 — El rango relativo es un vocabulario cerrado, resuelto a fechas antes de que la consulta tenga identidad

Extiende el ADR 0007 (vocabulario Cube) y el ADR 0011 (rango sin granularidad).
No supersede nada: un `dateRange` escrito como par de fechas se comporta igual
que siempre y los seis archivos de `test/snapshots/` quedaron byte por byte
iguales.

## Contexto

Hasta hoy el `dateRange` de una dimensión temporal era siempre un par de fechas
absolutas. Quien pregunta "la tasa de asistencia de los últimos seis meses"
—la tercera pregunta del enunciado, literal— tiene que calcular esas dos fechas
antes de escribir la consulta, y volver a calcularlas mañana. Cada consumidor
arrastra entonces su propia aritmética de calendario: el tablero, la
exportación, el agente. Es exactamente el tipo de cuenta que esta capa existe
para que nadie haga afuera, y la que más fácil se hace mal (¿"el mes pasado"
incluye el mes en curso? ¿cuándo empieza la semana?).

Cube resuelve esto con **Chrono**, una librería de lenguaje natural: cualquier
frase que un humano escriba se interpreta como se pueda.

## Decisión

### 1 · Un vocabulario cerrado, no un analizador de frases

`dateRange` acepta, además del par de fechas, **una cadena de una lista
cerrada**. Nada más. Quince formas, escritas exactamente así, en minúsculas:

| Forma | Significa |
|---|---|
| `today`, `yesterday` | el día de hoy; el día de ayer |
| `this week`, `this month`, `this quarter`, `this year` | del comienzo del período en curso **a hoy** |
| `last week`, `last month`, `last quarter`, `last year` | el período calendario anterior **completo** |
| `last N days`, `last N weeks`, `last N months`, `last N quarters`, `last N years` | los N períodos anteriores completos |

`N` es un entero positivo sin ceros a la izquierda, y la unidad va **siempre en
plural**, también con N=1: una sola escritura por rango. Cualquier otra cadena
—`Last 6 Months`, `last 6 month`, `últimos seis meses`, `previous month`, una
con un espacio de más— es `INVALID_QUERY` (400) con `member`
`timeDimensions[i].dateRange` y **la lista entera en la sugerencia**, igual que
una granularidad inválida.

Es la misma razón por la que las granularidades son una lista cerrada (ADR
0007). Una capa que promete determinismo no puede depender de cómo alguien
escriba una frase, y el modo en que falla un intérprete de lenguaje natural es
el peor posible: no falla. Devuelve **los datos de otro período**, con 200, sin
una advertencia, y el gráfico se ve perfectamente bien. Un rechazo con la lista
al lado es corregible en un reintento —el agente ya tiene ese bucle, el mismo
con el que corrige un `UNKNOWN_MEMBER`—; un trimestre equivocado que nadie nota,
no.

Que la lista sea cerrada también la hace publicable y comprobable: son quince
casos, todos con test.

### 2 · `last month` es el mes calendario anterior completo

La ambigüedad clásica de esta función, decidida y escrita: **`last month` es el
mes del calendario anterior entero —del día 1 al último día— y no los últimos 30
días.** `last 1 months` es la misma ventana; `last 6 months` son los seis meses
calendario anteriores completos.

De ahí sale la regla que ordena todo el vocabulario: **ninguna frase `last …`
incluye hoy.** Terminan el día anterior al comienzo del período en curso.

- Porque un período a medio transcurrir hunde el último punto de cualquier
  gráfico: un "mes" con nueve días de datos parece una caída, no un mes
  incompleto.
- Porque la comparación contra el período anterior —para qué se pide "el mes
  pasado"— sólo tiene sentido entre períodos completos.
- Porque "el mes pasado" es, para quien pregunta, un mes del calendario: agosto.
  No "desde el 12 de agosto".

Y las frases `this …` son la otra pregunta, la que sí incluye hoy: van del
comienzo del período en curso **a hoy**, no al final del período. Un rango que
llegara al 31 de diciembre incluiría días que todavía no ocurrieron, y con
`fillMissing` (ADR 0012) eso son buckets vacíos del futuro dibujados como datos
faltantes.

Las formas cortas son exactamente el caso N=1 de las largas: `last month` es
`last 1 months`, `last week` es `last 1 weeks` y `yesterday` es `last 1 days`.
No hay dos definiciones que mantener sincronizadas; hay una, `ultimosN`.

**La semana empieza el lunes**, el mismo criterio del `DATE_TRUNC('week', …)` de
Postgres y el de `bucketsDelRango` (ADR 0013). Importa que las tres cuentas
coincidan: `fillMissing` genera la serie desde el inicio truncado del rango que
esta resolución produjo.

### 3 · La zona horaria es una propiedad de la consulta

Para saber cuándo empieza "hoy" hace falta una zona. Es una propiedad nueva
**de la consulta**, `timezone`, como en Cube, y por defecto `UTC`:

```json
{ "measures": ["attendance.count"],
  "timeDimensions": [{ "dimension": "attendance.date", "granularity": "day",
                       "dateRange": "last 7 days" }],
  "timezone": "America/Santiago" }
```

Va en la consulta y no en el catálogo ni en el presupuesto por la misma frontera
del ADR 0012: **lo que depende de quién pregunta viaja con la pregunta.** La
zona en que alguien quiere leer "hoy" no es un hecho sobre la entidad
—`attendance` no cambia de naturaleza según quién la mire— ni un límite de
gasto; es del consumidor, y dos tableros de la misma empresa pueden querer
zonas distintas sin redesplegar nada.

**Se valida con la API `Intl` del runtime, no con una lista propia**: mantener
una lista de zonas es mantener la base de datos IANA a mano, y el runtime ya la
trae y la actualiza. Lo que `Intl.DateTimeFormat` no acepta es `INVALID_QUERY`
con `member` `timezone`. Se valida **aunque la consulta no traiga ninguna frase
que resolver**: aceptar en silencio una zona desconocida sería dejar pasar un
error que reaparecería recién el día que alguien agregue un rango relativo.

**Esto no reabre el supuesto v1 de fechas y zonas** (`README.md`,
`docs/riesgos.md`). Las columnas siguen siendo `DATE` —días ya resueltos— y la
capa **sigue sin convertir nada**: no hay `AT TIME ZONE` en ninguna parte, y con
un `dateRange` absoluto la zona no cambia absolutamente nada. Lo único que hace
`timezone` es decidir qué día es hoy al resolver una frase. Está dicho en el
comentario de `zonaValida` en `src/rangos-relativos.js` justamente para que nadie
lea el campo y crea que la capa empezó a convertir datos.

### 4 · Se resuelve antes de que la consulta tenga identidad

La frase se cambia por el par de fechas en la **primera puerta** del
planificador (`resolverRangosRelativos`, `src/planner.js`), antes de validar la
forma, antes de resolver miembros y antes de que las fechas se pidan como
parámetros `$n`. De ahí en adelante nadie vuelve a ver la frase: el resto del
planificador sigue siendo la misma traducción determinista de una consulta con
fechas absolutas.

Ése es el punto crítico. El `queryId` —la identidad de la consulta, y con ella
la llave de caché— nace del **SQL ejecutado y sus parámetros** (`src/engine.js`).
Como las fechas resueltas viajan como parámetros, "los últimos siete días" de
hoy y los de mañana son dos consultas distintas con dos entradas distintas, sin
que la caché tenga que aprender nada sobre el tiempo. Si la identidad naciera de
la frase, la caché serviría siempre la primera ventana y el gráfico se quedaría
congelado en agosto sin que nadie se entere — el peor modo de fallar otra vez.

No se dio por supuesto: está comprobado ejecutando (`test/rangos-relativos.test.js`,
"la misma frase con dos «hoy» distintos da queryId distintos y no comparte
caché"), con un TTL de caché inmenso inyectado a propósito para que un
vencimiento no pueda ser la explicación alternativa del fallo de caché.

El "hoy" sale del **reloj inyectable que el engine ya tenía** para fechar el
`asOf` y medirle la edad a una entrada de caché; el engine se lo pasa ahora
también al planificador. Sin esa costura no habría forma de fijar un "hoy" en un
test, y el plan no sería reproducible. Se lee **una sola vez por consulta**: dos
dimensiones temporales con frases tienen que caer en el mismo día aunque el
reloj avance entre una y otra.

### 5 · El plan lógico muestra el rango ya resuelto

El dry-run gana `timeDimensions` y `timezone` en el plan lógico:

```json
{ "timeDimensions": [{ "dimension": "attendance.date", "granularity": "day",
                       "dateRange": ["2025-08-08", "2025-08-14"],
                       "dateRangeExpression": "last 7 days" }],
  "timezone": "UTC" }
```

El rango sale **resuelto**, que es lo que el consumidor necesita comprobar: a
qué ventana le tocó responder. Y **la frase se conserva al lado**, en
`dateRangeExpression`: el par de fechas solo no deja distinguir una ventana fija
de una que se mueve sola, y quien pide un plan para revisar su consulta quiere
ver las dos cosas, lo que escribió y en qué se convirtió. El nombre es de la
capa, no de Cube. Sale del registro de la puerta 0 y no de la consulta, así que
un `dateRangeExpression` escrito a mano por el consumidor no puede aparecer en el
plan diciendo que hubo una frase donde no la hubo.

## Alternativas

- **Chrono, como Cube.** Acepta lo que sea que alguien escriba, y ahí está el
  problema: interpreta en vez de rechazar. "last 6 month", "6 meses atrás" o
  "last months 6" devuelven *algún* rango, y un rango equivocado no se ve en la
  respuesta. Además convierte la superficie pública de la capa en el
  comportamiento de una librería de terceros, que cambia entre versiones: el
  mismo JSON podría devolver otra ventana después de un `npm update`.
  Descartada.
- **Que el consumidor siga calculando las fechas.** Es el estado anterior.
  Funciona, y repite la aritmética de calendario —con sus bordes de mes
  bisiesto, trimestre y lunes— en cada tablero, cada uno con su criterio sobre
  si "el mes pasado" incluye el mes en curso. Descartada; es el motivo del ADR.
- **`last month` = los últimos 30 días.** Es defendible para un gráfico móvil y
  es lo que muchos productos hacen, pero rompe la comparación contra el período
  anterior, no coincide con lo que alguien quiere decir cuando dice "el mes
  pasado", y obliga a explicar por qué `last month` no es un mes. Si algún
  consumidor necesita la ventana móvil, la escribe: `last 30 days`. Descartada.
- **Las frases `this …` hasta el final del período** (`this month` = todo el mes
  calendario). Incluye días que no ocurrieron; con `fillMissing` los dibuja como
  huecos. Descartada.
- **La zona en el catálogo, por empresa.** Es la evolución correcta el día que
  las columnas dejen de ser `DATE` y haya que convertir de verdad
  (`docs/riesgos.md`), y ahí será una decisión del dueño del dato. Hoy sería
  ponerle al catálogo una propiedad que no usa ningún dato: la zona no toca ni
  una columna, sólo decide qué día es hoy. Descartada para v1.
- **Resolver la frase en el engine, antes de llamar al planificador.** Deja al
  planificador sin reloj, que es atractivo, pero saca el rechazo del pipeline de
  puertas: el error perdería su `gate` y no entraría en la telemetría de
  rechazos por puerta (historia 31), que es donde plataforma mira para saber si
  los rechazos vienen del vocabulario o del presupuesto. La puerta 0 da lo mismo
  —resolver antes que todo— sin perder nada. Descartada.
- **Meter la frase en el `queryId`.** Sería más "fiel" a lo que se pidió y es
  exactamente el error que este ADR evita: la misma llave para dos ventanas
  distintas. Descartada.

## Consecuencias

- **Sin frases no cambia nada.** El SQL, los parámetros, el `queryId` y la caché
  son los de siempre; los seis archivos de `test/snapshots/` quedaron byte por
  byte iguales. Lo único que gana toda consulta es `timeDimensions` y `timezone`
  en el plan lógico del dry-run, que es información nueva sobre un
  comportamiento viejo.
- **Una consulta con rango relativo no es cacheable entre ventanas, y así debe
  ser.** Cada día nuevo estrena entrada; la vieja muere por TTL. El costo es una
  ejecución en vivo por ventana y por consumidor, no una por consulta.
- **Los guardarraíles que dependen del rango operan sobre las fechas ya
  resueltas**, porque la resolución va antes: el conteo de buckets de
  `fillMissing` (ADR 0013) rechaza `last 5 years` por día nombrando los 1.826
  buckets que pidió, con la sugerencia de siempre.
- **Las consultas tipo aceptan una frase en su parámetro `:dateRange`** sin
  cambiar una línea: la sustitución de parámetros del catálogo copia el valor tal
  cual, y la puerta 0 lo resuelve después.
- **El agente todavía no sabe que existe.** El prompt de creación de
  `demo-agente` no nombra los rangos relativos, así que seguirá escribiendo
  fechas absolutas —que funcionan igual—. Queda anotado como evolución: una
  viñeta en el prompt, como la que ganó el ADR 0011.
- **El vocabulario no se publica en el catálogo.** Hoy vive en la sugerencia del
  error y en la documentación, igual que vivían las granularidades antes de que
  el catálogo las publicara. Evolución natural: sacarlo por `describe()`.

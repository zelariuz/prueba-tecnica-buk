# ADR 0013 — El truncado se avisa, la serie que no cabe se rechaza, y el total de filas es una segunda sentencia

Cierra la evolución que el ADR 0012 dejó anotada y que `docs/riesgos.md` tenía
registrada como riesgo abierto. No supersede nada: sin `total`, el SQL que
devuelve las filas es byte por byte el de antes.

## Contexto

Toda consulta sale con `LIMIT`: el tope de filas de la clase de consumidor
(ADR 0002). Cuando el resultado lo alcanza, la base recorta y la respuesta sale
con 200, sin una palabra. El consumidor sólo podría deducir el corte comparando
`rows.length` con el `rowLimit` de su presupuesto, que ni siquiera recibe salvo
en un dry-run.

El relleno de series densas (ADR 0012) convirtió ese agujero en un problema
medible: densificar multiplica las filas por `buckets × ejes`. Sobre la empresa
C, por día y departamento en un rango de dos años, la misma consulta pasa de
4.392 filas con 12 departamentos a las 5.000 del tope de `dashboard`, con **7 de
12** departamentos y la serie cortada a mitad de camino. Y densificada, esa
respuesta **se ve entera**: siete departamentos con todos sus días, ningún hueco
a la vista. Un gráfico truncado que parece completo miente peor que uno con
huecos, que es exactamente lo que el ADR 0012 vino a arreglar.

Aparte, y por lo mismo: quien pagina necesita saber cuántas filas tiene el
resultado completo, y hoy no hay forma de preguntarlo.

## Decisión

### 1 · El truncado se advierte, en cualquier consulta

Cuando el número de filas devueltas alcanza el límite efectivo, la respuesta
suma una advertencia a `meta.warnings`, con la misma forma `{ member, warning }`
que ya usa la razón anulada (`docs/semantica-de-filtros.md`): ningún consumidor
tiene que aprender un campo nuevo.

Es una advertencia y no un error porque el resultado **sirve**: son filas
verdaderas, sólo que puede que no sean todas. Y es una advertencia y no una
certeza porque saber si sobraban filas exige pedirlas. **No se pide una fila de
más** para averiguarlo: el tope de la clase es el tope, y cobrarle a todas las
consultas una fila extra para adornar un aviso es pagar el precio de unos pocos
en cada una. Quien necesite el número exacto lo pide con `total: true`.

Vive en el engine y no en el planificador porque antes de ejecutar no hay filas
que contar: es una propiedad del **resultado**, no del plan. Viaja también en la
entrada de caché, junto a las filas que describe.

Vale para **toda** consulta, no sólo para las que rellenan. El relleno lo hizo
visible; el agujero ya estaba.

### 2 · La serie que no cabe se rechaza al planificar

Los buckets de una serie se cuentan **sin tocar la base**: salen del `dateRange`
y de la `granularity`, que ya están en la consulta. Con `fillMissing: true` el
resultado tiene exactamente `buckets × ejes` filas, así que si los buckets solos
ya pasan el límite efectivo, **ni con un único eje** cabría la serie: la
respuesta saldría cortada con seguridad. Se rechaza antes de gastar la base, con
`INVALID_QUERY` (400) y una sugerencia que dice cuántos buckets pidió, cuántas
filas permite su clase y las tres salidas: subir la granularidad, acortar el
rango o pedir la serie por tramos.

`INVALID_QUERY` y no un código nuevo: es el que ya usa la puerta de forma, es un
400 porque quien consulta puede arreglarlo, y es el que `docs/riesgos.md` había
dejado anotado para este caso. Un código nuevo habría que mapearlo en
`src/http/codigos.js` y documentarlo para no decir nada que éste no diga.

**Los ejes no se estiman.** Cuántos departamentos tiene una empresa sólo lo sabe
la base, y preguntárselo sería gastar una consulta para decidir si vale la pena
hacer la otra —con el agravante de que la estimación envejece—. El rechazo se
queda con lo que se sabe **con certeza y gratis**; todo lo que pasa por debajo de
ese umbral lo cubre el aviso del punto 1, que cuenta filas de verdad.

Contar buckets vive en el planificador y no en el dialecto: cuántos lunes o
cuántos trimestres hay entre dos fechas es calendario, no sintaxis de motor. Lo
que sí es del dialecto —cómo se **escribe** la serie— sigue en `serieDeFechas`.
La cuenta replica lo que genera `generate_series` desde el inicio truncado, y
está verificada contra Postgres en las cinco granularidades. Un extremo que no
viene en `YYYY-MM-DD` no se convierte en rechazo: el guardarraíl **falla
abierto** y deja opinar a la base, que es quien interpreta el literal de verdad.

### 3 · `total: true` es una segunda sentencia sobre el mismo cuerpo

La propiedad de Cube: el número de filas del resultado **ignorando límite y
desplazamiento**, para paginar. **No** es el gran total de ninguna medida. Sale
en `meta.total` y sólo si se pidió.

Se implementa envolviendo el cuerpo ya armado:

```sql
WITH <las mismas CTE>
SELECT COUNT(*) AS total FROM (
  <el mismo cuerpo, sin ORDER BY y sin LIMIT>
) AS t
```

Así y no con un camino aparte, y ésa es la decisión: contar lo que la consulta
**devolvería sin techo** es correcto por construcción en las tres formas que la
capa emite hoy —los grupos de una agregación, la etapa de afuera de una derivada
y la rejilla `buckets × ejes` de un relleno— y lo seguirá siendo en la que se
agregue mañana. Un contador propio tendría que aprender cada forma por separado
y se equivocaría justo en la nueva. Verificado contra el seed: la misma semana
da 10 filas sin relleno y 14 con relleno, y el total dice 10 y 14.

Se arma **antes** de pedir el parámetro del `LIMIT`, así que sus `$n` son los del
cuerpo sin el último y la numeración no se mueve.

**Se ejecuta en la misma transacción** que la consulta: cuenta sobre la misma
foto de los datos que produjo las filas —si no, una escritura entre las dos daría
un total que no corresponde a lo que el consumidor tiene en la mano—, gasta una
conexión y no dos, y queda bajo el mismo `statement_timeout` de la clase. Su
tiempo entra en el `dbMs` de la telemetría, que es donde el consumidor lo esperó;
no estrena contador propio.

**En dry-run no se ejecuta nada.** Un dry-run es el plan sin tocar la base
(historia 25), y contar filas la toca —tan caro como la consulta, porque recorre
lo mismo sin el `LIMIT` que la acota—: pedir el plan para revisar una consulta
antes de gastar la base no puede gastar la base. Lo que el dry-run entrega es la
segunda sentencia, para poder leerla, y el plan lógico con `total: true`.

**Desde caché, el total viene guardado con la entrada.** Recalcularlo sería ir a
la base justo en el camino que existe para no ir, y daría un número de ahora
pegado a filas de antes: dos instantes distintos en la misma respuesta.
Guardado, el total es tan viejo como el `asOf` que está a su lado. Para que no
pueda faltar, el `queryId` incorpora la segunda sentencia: el SQL de las filas es
idéntico se haya pedido o no el conteo, así que sin eso una consulta con total y
otra sin él compartirían entrada y la segunda en llegar recibiría una respuesta a
la que le sobra —o le falta— el campo. La clave sólo entra al hash cuando hay
segunda sentencia: el `queryId` de todas las consultas anteriores no se movió.

## Alternativas

- **Pedir `LIMIT n + 1` y descartar la última fila** para saber si había más. Es
  la técnica clásica de paginación y responde "hay más" sin una segunda
  sentencia, pero le cobra a **toda** consulta el costo de una fila extra por un
  aviso que casi ninguna necesita, y sigue sin decir cuántas filas hay. El total
  explícito lo pide quien lo quiere. Descartada.
- **Desactivar el relleno por encima de un número de filas**, como hace Cube a
  las 10.000. Convierte una serie densa en una dispersa sin avisar, que es el
  fallo exacto que el ADR 0012 vino a corregir. Descartada.
- **Truncar con error en vez de advertencia.** Una consulta cuyo resultado se
  pasa del tope sigue devolviendo filas útiles, y muchos consumidores sólo
  quieren las primeras. Rechazarlas todas por precaución rompe casos legítimos.
  Descartada: el error se reserva para lo que con certeza no puede responderse
  (el punto 2).
- **Estimar `buckets × ejes` consultando la cardinalidad de las dimensiones.**
  Daría un rechazo más preciso, pero exige una consulta a la base antes de la
  consulta, y la estimación envejece entre una y otra. Descartada; el umbral por
  buckets es gratis y certero, y el aviso cubre el resto.
- **Contar en JavaScript sobre las filas devueltas.** Cuenta lo que llegó, que es
  justamente lo que puede estar cortado: diría `total: 5000` para un resultado de
  8.000 filas. Descartada.
- **El total en su propia transacción o su propia conexión.** Dos fotos de los
  datos en la misma respuesta y el doble de conexiones por consulta. Descartada.

## Consecuencias

- **Sin `total` no cambia nada**: el SQL de las filas, sus parámetros y el
  `queryId` son los de antes, y los seis archivos de `test/snapshots/` quedaron
  byte por byte iguales.
- **`meta.warnings` puede traer una advertencia donde antes no traía ninguna**,
  en cualquier consulta que llegue al tope. Es información nueva sobre un
  comportamiento viejo, no un cambio de comportamiento.
- **Una consulta con `fillMissing` sobre un rango demasiado grande ahora
  falla** donde antes devolvía filas cortadas. Es el cambio visible de esta
  decisión y es deliberado: esas filas mentían.
- **Con `total: true` cada `run` ejecuta dos sentencias.** El conteo recorre lo
  mismo que la consulta sin el `LIMIT`, así que sobre tablas grandes puede costar
  más que ella. Queda a la vista en `dbMs` y acotado por el `statement_timeout`
  de la clase; quien pagina lo pide una vez y reusa el número.
- **`offset` no existe todavía.** `total` es la mitad de la paginación que la
  capa puede ofrecer hoy; la otra mitad es una extensión con su propia costura
  (un parámetro más en la puerta que emite el `LIMIT`).

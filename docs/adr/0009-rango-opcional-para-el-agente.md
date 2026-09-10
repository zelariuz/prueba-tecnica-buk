# ADR 0009 — El rango temporal deja de ser obligatorio para la clase `agent`

Supersede parcialmente la decisión de la fase 3 sobre el presupuesto de la clase
`agent`: el resto de ese presupuesto (10 s de timeout, 1.000 filas, 30 s de
caché) queda igual.

## Contexto
La clase `agent` exigía `timeDimensions` con `dateRange` en toda consulta. La
regla nació como guardarraíl preventivo: un agente que pide en lenguaje natural
podía fabricar sin querer una consulta que recorre toda la historia.

El costo apareció al usarla. Con un token de clase `agent`, "cuántos empleados
hay" y la consulta tipo `headcount-por-departamento` no se pueden responder:
`employees` no publica dimensión temporal y no hay camino de joins hacia una
(`NO_JOIN_PATH`), así que no existe rango que ponerle. La consulta terminaba en
`MISSING_TIME_RANGE` y el agente no tenía corrección posible: su único camino
era `{"noPuedo": …}` sobre una pregunta que la capa sabe contestar.

## Decisión
`agent.rangoObligatorio` pasa a `false`. El guardarraíl deja de ser preventivo y
pasa a ser reactivo: los límites de la clase son el timeout (10 s) y el tope de
filas (1.000). Una consulta que no termina se corta con `QUERY_TIMEOUT`, cuya
sugerencia dice justamente que acote el rango temporal, suba la granularidad o
pida menos dimensiones — y el agente ya tiene el bucle que convierte ese error
en un JSON corregido, el mismo con el que corrige un `UNKNOWN_MEMBER`.

El mecanismo `rangoObligatorio` y el código `MISSING_TIME_RANGE` se conservan:
cualquier clase inyectada por `createEngine({ presupuestos })` puede seguir
exigiendo rango, y los tests entran por esa costura.

## Medición
09-09, empresa C del seed (1.750 empleados, 15.477 evaluaciones y **1.062.283
filas de asistencia**, sin índice en `attendance.date` a propósito): un barrido
completo sin rango tarda **300-640 ms**, muy por debajo del timeout de 10 s, y
el tope de 1.000 filas recorta la salida. Con este volumen el rango obligatorio
no evitaba ningún daño; evitaba una sorpresa con tablas mucho mayores, y para
esa sorpresa ya está el timeout.

## Alternativas
- **Dejarlo obligatorio y exceptuar las entidades sin dimensión temporal**: la
  puerta pasaría a preguntarle al catálogo qué entidad tiene tiempo y cuál no,
  y el consumidor tendría que adivinar cuándo la regla aplica. Un guardarraíl
  con excepciones es un guardarraíl que nadie puede explicar. Descartada.
- **Dejarlo obligatorio y responder headcount con otra clase de consumidor**:
  es lo que hacía la demo, y convierte un límite de presupuesto en un límite del
  vocabulario. La clase decide cuánto se puede gastar, no qué se puede
  preguntar. Descartada.
- **Bajarle el timeout a la clase `agent`**: cambia el síntoma, no la decisión;
  el timeout ya cumple su papel con los 10 s medidos.

## Consecuencias
- La clase `agent` responde preguntas sin dimensión temporal:
  `headcount-por-departamento` es ejecutable con contexto `agent` y devuelve los
  literales del seed (Ingeniería 2/2, Ventas 2/1).
- Una consulta sin rango sobre una tabla enorme puede terminar en
  `QUERY_TIMEOUT` en vez de en `MISSING_TIME_RANGE`: el consumidor se entera
  después de gastar el presupuesto, no antes. Es el precio explícito de la
  decisión, y la sugerencia del error lo hace corregible en un reintento.
- La demo del agente deja de precargar el rango como obligatorio: las fechas del
  formulario son opcionales y el prompt de creación lo dice.
- Nada cambia para `dashboard` ni para `api`, que nunca exigieron rango, ni para
  el SQL: los snapshots no se movieron.

# QA de la demo agente — 09-09

Las 7 preguntas preparadas por los **dos caminos** (sin agente y con agente),
contra la capa real en Docker y contra Claude Code real. No hay dobles acá: los
tests con dobles viven en `demo-agente/test/`.

## Cómo se corrió

- Capa levantada con `docker compose up -d --build` en la raíz (api en `:3000`,
  Postgres en `:5433`, Redis en `:6380`), con el catálogo que ya publica el
  `query` de cada consulta tipo (versión `219f834021759c19`).
- `.sesion.json` borrado antes de empezar, para que la sesión naciera con ese
  catálogo. El arranque lo confirmó:
  `Sesión agente-buk creada (no había sesión guardada) — 9120f719-…, catálogo
  versión 219f834021759c19, huella 7fd5af9d5d201a73.`
- Claude Code **2.1.267** (`claude --version`), modelo `claude-sonnet-5`. La
  medición de flags y costo de la fase 2 se hizo con 2.1.266.
- Rangos: **2025-01-01 … 2025-12-31** para evaluaciones, completitud, empleados
  que completaron, conteo por estado, headcount y la trampa;
  **2025-06-01 … 2025-08-31** para asistencia. Departamento **vacío** (todos) en
  las 14.
- Cada URL se pidió **dos veces** seguidas, para ver `servedFrom` pasar de
  `live` a `cache-l1`.

## Las 7 × 2

Filas clave = lo que devolvió `POST /analytics/query` con el token de clase
`agente`. "Igual que sin agente" quiere decir fila por fila, mismos números.

| # | Pregunta | Camino | Filas clave | ¿Seed? | Reintento | 2.ª llamada | Salto 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Evaluaciones por depto. y trimestre | sin agente | Ingeniería Q1 `4.35` / `2`; Q2 `3.8` / `1` | sí | — | `cache-l1` | — |
| 1 | Evaluaciones por depto. y trimestre | con agente | idénticas: `4.35` / `2` y `3.8` / `1`, **sin filas de Ventas** | sí | no | `cache-l1` | 3,6 s · 0,0027 USD |
| 2 | Completitud por departamento | sin agente | Ingeniería `75`; Ventas `0` | sí | — | `cache-l1` | — |
| 2 | Completitud por departamento | con agente | iguales | sí | no | `cache-l1` | 3,5 s · 0,0030 USD |
| 3 | Asistencia por depto. y mes | sin agente | Ing. `96,67` / `96,77` / `80`; Ventas `96,67` / `100` / `50` | sí | — | `cache-l1` | — |
| 3 | Asistencia por depto. y mes | con agente | iguales | sí | no | `cache-l1` | 3,9 s · 0,0030 USD |
| 4 | Empleados que completaron por trimestre | sin agente | Q1 `2`; Q2 `1`; Q3 `0` | sí | — | `cache-l1` | — |
| 4 | Empleados que completaron por trimestre | con agente | iguales | sí | no | `cache-l1` | 3,7 s · 0,0030 USD |
| 5 | Conteo de evaluaciones por estado | sin agente | completed `3`; pending `3`; calibrated `1` | sí | — | `cache-l1` | — |
| 5 | Conteo de evaluaciones por estado | con agente | iguales, **después de una corrección** | sí | **sí**: `MISSING_TIME_RANGE` → JSON corregido → ok | `cache-l1` | 6,2 s + 3,4 s · 0,0056 + 0,0043 USD |
| 6 | Headcount por departamento | sin agente | ninguna: `MISSING_TIME_RANGE` | n/a | — | mismo rechazo | — |
| 6 | Headcount por departamento | con agente | ninguna: `MISSING_TIME_RANGE` y después `noPuedo` | n/a | **sí**, y termina en `noPuedo` | `noPuedo` directo | 4,8 s + 3,3 s · 0,0043 + 0,0035 USD |
| 7 | Sueldo promedio por departamento (trampa) | sin agente | ninguna: `UNKNOWN_MEMBER (employees.salary_avg)` con sugerencia | n/a | — | mismo rechazo | — |
| 7 | Sueldo promedio por departamento (trampa) | con agente | ninguna: `noPuedo` sin tocar la capa | n/a | no (no hay nada que corregir) | `noPuedo` | 3,3 s · 0,0025 USD |

Las 14 corrieron; ninguna terminó en `fallo` ni colgó la demo. Los saltos a la
capa midieron entre **2 y 17 ms**; los saltos al agente, entre **3,2 y 6,2 s**.

### Qué se comparó contra el seed

La columna "¿Seed?" dice que las filas coinciden con los conteos calculados a
mano en el encabezado de `docker/init/02-seed.sql`, empresa 1:

- **1** — Ingeniería 2025-01-01 avg `4.35` / `2` completadas y 2025-04-01 avg
  `3.80` / `1`; Ventas no aparece. Literal del seed.
- **2** — Ingeniería `75`, Ventas `0`. Literal del seed.
- **3** — agosto de 2025: Ingeniería `80`, Ventas `50`. Literal del seed. Junio
  y julio (`96,67`, `96,77`, `100`) no están calculados a mano en el encabezado:
  de esos solo se comprobó que los dos caminos dan lo mismo.
- **4** — Q1 `2`, Q2 `1`, Q3 `0` empleados distintos. Literal del seed.
- **5** — `completed: 3` en 2025 es literal del seed; `pending: 3` y
  `calibrated: 1` de ese año no están desglosados en el encabezado (el seed
  desglosa el total de las dos anualidades: 5 / 4 / 2). De esos dos solo se
  comprobó que los dos caminos dan lo mismo.

## Lo que hay que mirar en cada una

### 1 — La pregunta del caso: el `query` de la consulta tipo se copia entero

Es la que motivó publicar el `query` en la vista pública. En la fase 2 el agente
no veía el `segments` de la consulta tipo, lo omitía, y la pregunta daba `3.4`
en 2025-04-01 y filas de Ventas de más. Ahora el catálogo lo trae y el agente
escribe exactamente la plantilla con el rango puesto:

```json
{"measures":["reviews.avg_score","reviews.completed_count"],
 "dimensions":["departments.name"],
 "segments":["reviews.completed"],
 "timeDimensions":[{"dimension":"reviews.period","granularity":"quarter",
                    "dateRange":["2025-01-01","2025-12-31"]}],
 "order":{"reviews.period":"asc"},"limit":500}
```

Resultado: `4.35` / `2` en Q1 y `3.8` / `1` en Q2, sin Ventas — las mismas filas
que por el camino sin agente y las mismas que valida la suite de la capa.

### 5 — El reintento, en vivo

El agente copió el `query` de la consulta tipo `conteo-de-evaluaciones-por-estado`
tal cual… y esa consulta tipo **no lleva rango** (`params: []`): quien la llama
por nombre es un dashboard, que no tiene rango obligatorio. La clase `agente` sí:
la capa contestó `MISSING_TIME_RANGE` con su sugerencia, el salto 3b se la
devolvió, y el segundo intento agregó `timeDimensions` con granularidad `year` y
salió bien. Es el mejor salto de la demo: **la sugerencia de la capa es lo que
hace posible el reintento**.

### 6 — El hallazgo de headcount

`headcount-por-departamento` **no es ejecutable por la clase `agente`**:
`employees` no publica dimensión temporal ni tiene camino de joins hacia una, así
que no hay `timeDimensions` posible y la capa responde `MISSING_TIME_RANGE` por
los dos caminos. El dry-run interno sí pasa (el token interno no tiene rango
obligatorio), y por eso el rastro muestra el plan y el SQL de algo que la
consulta real después rechaza — que es exactamente lo que hay que ver.

Con agente, el rastro es: JSON correcto → rechazo de la capa → corrección →
`noPuedo`, con el motivo bien dicho:

```json
{"noPuedo":"La entidad employees no publica una dimensión temporal en el catálogo, no puedo agregar timeDimensions"}
```

En la **segunda** pasada el agente contestó `noPuedo` de una, sin intentar el
JSON: la sesión es la misma y ya había aprendido el rechazo anterior. No es un
bug; es lo que significa tener sesión.

### 7 — La trampa

`employees.salary_avg` no existe. Sin agente, la capa lo dice con sugerencia
(`UNKNOWN_MEMBER`) en los dos saltos. Con agente, el rastro tiene **un solo
salto**: el agente no inventa el miembro y contesta
`{"noPuedo":"El catálogo no publica una medida de sueldo"}` sin tocar la capa.

## Caché

`servedFrom` pasó a `cache-l1` en la segunda llamada de cada pregunta que
devuelve filas (1 a 5). En las que se rechazan (6 y 7) no hay nada que cachear y
el segundo intento repite el mismo rechazo. El TTL de la clase `agente` es de 30
s (`src/budgets.js`), así que una pasada más lenta que eso vuelve a ver `live`.

Detalle honesto: en la corrida, la pregunta 1 ya salió `cache-l1` en su **primera**
llamada porque una petición de prueba anterior había calentado la caché con la
misma consulta; las preguntas 2 a 5 sí mostraron el `live` → `cache-l1` limpio.

## Lo que este registro NO cubre

- La página se verificó mirándola; no hay tests de HTML (decisión del plan).
- No se probó la demo con Claude Code caído (la casilla apagada y su motivo):
  eso se vio en la fase 2, no se repitió acá.
- Un solo modelo (`claude-sonnet-5`) y una sola corrida por combinación (más la
  segunda pasada para la caché). No es una medición estadística del modelo.

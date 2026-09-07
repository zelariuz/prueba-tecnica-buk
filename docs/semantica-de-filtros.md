# Semántica de filtros

Qué filtra a qué cuando una consulta mezcla filtros globales, segmentos y
medidas que traen su propio filtro. Es la regla que decide el número que ve el
consumidor, así que se escribe una vez y el planificador la aplica tal cual.

## La regla

1. **Los filtros globales afectan a todas las medidas.** Son los `filters` de la
   consulta y los `segments` que la consulta nombra: para el planificador no hay
   diferencia entre unos y otros —un segmento es la lista de filtros que su
   dueño declaró—. Se aplican dentro de la CTE de la entidad de su dimensión,
   junto al filtro de empresa, es decir **antes** de agregar.
2. **El filtro propio de una medida se suma al global.** `reviews.completed_count`
   es un `COUNT` con el segmento `completed`: se emite como
   `COUNT(*) FILTER (WHERE …)` sobre las filas que ya pasaron los filtros
   globales. Nunca los reemplaza ni los anula.
3. **Una derivada hereda los filtros de sus medidas base.** No tiene filtros
   propios: se calcula con las expresiones de su numerador y su denominador, que
   ya llegan filtradas.

En una frase: el global manda sobre todo el conjunto de filas; el propio de la
medida distingue, dentro de ese conjunto, lo que esa medida cuenta.

## El caso engañoso: el filtro global que anula el denominador

Pedir `reviews.completion_rate` con el filtro global `reviews.status = completed`
deja la consulta así:

- denominador (`reviews.count`): cuenta las filas del conjunto global, que ahora
  son solo las completadas;
- numerador (`reviews.completed_count`): cuenta, dentro de ese mismo conjunto,
  las completadas.

Los dos cuentan lo mismo y la tasa vale 100 % en todas las filas. El número está
bien calculado: está mal pedido. Como es indistinguible de una empresa con
completitud perfecta, la respuesta lo dice:

```json
{
  "rows": [{ "departments.name": "Ingeniería", "reviews.completion_rate": 100 }],
  "meta": {
    "warnings": [
      {
        "member": "reviews.completion_rate",
        "warning": "El filtro global reviews.status equals completed es el mismo que distingue al numerador de reviews.completion_rate: aplicado a toda la consulta, numerador y denominador cuentan las mismas filas y la razón vale 100 en cada fila. Quita ese filtro de la consulta para ver la tasa real."
      }
    ]
  }
}
```

`meta.warnings` está siempre presente, vacío cuando no hay nada que advertir.
El dry-run trae la misma lista en `plan.warnings`, así que un agente puede verla
antes de ejecutar.

**Cómo se detecta**: se comparan los filtros propios del numerador con los del
denominador; lo que los distingue es lo que hace que la razón no sea 1. Si todo
eso aparece también entre los filtros globales —mismo miembro, mismo operador,
mismos valores—, la razón queda clavada en su escala y se advierte. Un filtro
global que no toca esa diferencia (por ejemplo, filtrar por departamento) no
genera advertencia: la tasa sigue siendo informativa.

**Límite conocido**: la comparación es por igualdad exacta del filtro. Un filtro
global escrito de otra forma pero equivalente (`in ['completed']` en vez de
`equals 'completed'`) produce el mismo 100 sin advertencia. Ampliar la
equivalencia es evolución; no se adivina más de lo que se puede comprobar.

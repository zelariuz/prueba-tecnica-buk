# ADR 0003 — Una CTE por entidad con el filtro de empresa adentro

## Contexto
El SQL de referencia filtra `company_id` una vez, al final del WHERE. Con
varios JOIN, un error de planificación podría dejar una tabla sin filtrar.

## Decisión
Cada entidad que participa en la consulta se materializa como una CTE que
incluye su propio filtro:
```sql
WITH reviews AS (SELECT … FROM performance_reviews WHERE company_id = $1),
     employees AS (SELECT … FROM employees WHERE company_id = $1), …
```
El filtro viaja con la entidad, en el único lugar donde se nombra la tabla.

## Alternativas
- Filtro único al final del WHERE: más corto, pero la garantía depende de que
  el planificador recuerde cada tabla. Descartada.
- Solo Row Level Security en Postgres: no aplica al dueño de la tabla sin
  `FORCE`, no cubre vistas materializadas y exige estado de sesión que se
  pega a la conexión en un pool. Queda como red adicional, no como mecanismo.

## Consecuencias
Invariante verificable por test: toda CTE sobre una tabla con `company_id`
contiene `company_id = $1`. El filtro dentro de la CTE también habilita la poda
de particiones si las tablas se particionan por empresa y fecha. El SQL es más
estricto que el de referencia: filas inconsistentes entre tablas quedan fuera.

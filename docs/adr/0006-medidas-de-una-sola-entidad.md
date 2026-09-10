# ADR 0006 — En v1, las medidas de una consulta salen de una sola entidad

## Contexto
Pedir `headcount` (de empleados) y `avg_score` (de evaluaciones) agrupados por
departamento en un solo SELECT con JOIN multiplica el headcount por la cantidad
de evaluaciones de cada empleado. Es el problema clásico de fan-out.

## Decisión
Toda medida de una consulta pertenece a la misma entidad de hechos. Las
dimensiones pueden venir de otras entidades alcanzables por relaciones
`many_to_one` desde la entidad de hechos, porque no multiplican filas. Si se
piden medidas de dos entidades, el engine responde `MULTI_ENTITY_MEASURES`.

## Alternativas
- Agregar cada entidad por separado y unir los resultados (como hace Wren con
  subconsultas): correcto, pero duplica el trabajo del planificador. Queda como
  extensión documentada.
- Permitirlo y confiar en el consumidor: produce números incorrectos en
  silencio. Descartada.

## Consecuencias
El caso obligatorio y las derivadas quedan cubiertos. El límite es explícito y
se comunica con un error con sugerencia; el panel puede verificarlo con un test.

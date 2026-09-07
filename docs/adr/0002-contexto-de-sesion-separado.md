# ADR 0002 — El contexto de empresa viaja separado de la consulta

## Contexto
Todos los datos tienen `company_id`. El consumidor no debe incluirlo en su
consulta y la capa debe garantizar que solo accede a los datos de su empresa.

## Decisión
`engine.run(consulta, ctx)`. El contexto `{ companyId, consumer }` lo construye
la capa HTTP a partir del token de autenticación. El JSON de consulta no tiene
campo para ninguno de los dos; si aparecen, el engine rechaza con
`FORBIDDEN_FIELD`. Si falta el contexto, `MISSING_TENANT`. Nunca se lee de una
variable global ni del cuerpo de la petición.

## Alternativas
- `company_id` como filtro que el consumidor agrega: viola el requisito y
  depende de disciplina. Descartada.
- Leerlo de una variable global de la petición: difícil de testear, fácil de
  filtrar entre peticiones concurrentes. Descartada.

## Consecuencias
La centralización es por tipo, no por convención: no existe forma de expresar
otra empresa en la consulta. Un consumidor tampoco puede elegir su propia clase
(`consumer`) para obtener un presupuesto mayor.

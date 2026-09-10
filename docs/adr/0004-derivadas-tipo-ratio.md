# ADR 0004 — Medidas derivadas de tipo ratio, calculadas sobre agregados

## Contexto
Se pide `completion_rate = completadas / totales * 100` y garantizar que se
calcula sobre valores agregados, no por fila. Dos `COUNT` en Postgres son
enteros: `3 / 4 * 100` da `0`.

## Decisión
Las derivadas se declaran con tipo explícito. En v1 solo `ratio`:
`{ type: 'ratio', numerator, denominator, scale }`. El planificador calcula las
medidas base en la consulta agregada y emite la fórmula sobre esos alias con
`numerator::numeric / NULLIF(denominator, 0) * scale`. Las dependencias se
resuelven en orden topológico al registrar; un ciclo rechaza la definición.

## Alternativas
- Expresión libre en texto (`"a / b * 100"`): requiere parser y abre la puerta
  a SQL arbitrario en las definiciones. Descartada para v1.
- Calcular la derivada en el cliente: duplica lógica en cada consumidor,
  justo lo que la capa quiere evitar. Descartada.

## Consecuencias
La garantía "sobre agregados" es estructural: la fórmula solo ve alias de
medidas ya agregadas. El test ejecuta contra Postgres y comprueba que 3 de 4 da 75.

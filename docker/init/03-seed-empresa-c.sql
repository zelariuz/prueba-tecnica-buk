-- Empresa C: la empresa de VOLUMEN. Existe para ver en la demo lo que un seed
-- de seis empleados no puede mostrar —tiempos reales, caché que se nota, el
-- tope de filas de la clase `agente` y la advertencia de índice sobre
-- `attendance.date`—, no para verificar números.
--
-- NO hay conteos calculados a mano en este archivo, y NINGÚN test de `test/`
-- depende de él: los literales verificables siguen siendo los de `02-seed.sql`
-- (empresas 1 y 2), que este archivo no toca. Los conteos de abajo se leyeron
-- con `SELECT count(*)` DESPUÉS de aplicar el seed, y están para que se note si
-- algún día dejan de salir.
--
-- FILAS (empresa 3, medidas tras aplicar este archivo):
--   companies             1
--   departments          12
--   employees         1.750  (1.607 activos, 143 inactivos)
--   performance_reviews  15.477  (9.651 completed, 4.222 pending, 1.604 calibrated)
--   attendance        1.062.283
--
-- Aplicar los tres archivos de `docker/init` (initdb del contenedor) tarda ~8,8 s
-- en total, de los cuales ~8,6 s son este archivo, y deja la base en ~104 MB.
--
-- Determinista: `setseed(0.42)` fija la secuencia de `random()` de la sesión, y
-- todo lo aleatorio de este archivo sale de ahí, en el orden en que están
-- escritas las sentencias. Los identificadores van por rangos fijos y no se
-- cruzan con los de `02-seed.sql`: departamentos 30..41, empleados 3000..,
-- evaluaciones 300000.., asistencia 3000000...
-- Supuesto declarado: la reproducibilidad exacta de los VALORES depende además
-- de que el plan de ejecución no cambie el orden de las llamadas a `random()`.
-- `random()` es `parallel restricted`, así que estos planes no se paralelizan;
-- con la misma versión de Postgres (16) el resultado se repite.
--
-- Nada de nombres reales: los empleados son "Empleado C0001"… y los
-- departamentos son los genéricos de una empresa grande.
--
-- Cada elección aleatoria consume UNA sola llamada a `random()` por fila y por
-- decisión: los tramos se eligen con `width_bucket` sobre un arreglo de
-- umbrales, en vez de un `CASE` que nombre el mismo `random()` dos veces (dos
-- menciones son dos sorteos distintos, y el reparto dejaría de ser el pedido).

SELECT setseed(0.42);

INSERT INTO companies (id, name) VALUES (3, 'Empresa C');

-- Doce departamentos genéricos. "Ingeniería" y "Ventas" se repiten a propósito
-- con las empresas 1 y 2, igual que entre ellas: el aislamiento por empresa se
-- tiene que notar también con volumen.
INSERT INTO departments (id, company_id, name) VALUES
  (30, 3, 'Ingeniería'),
  (31, 3, 'Ventas'),
  (32, 3, 'Soporte'),
  (33, 3, 'Marketing'),
  (34, 3, 'Finanzas'),
  (35, 3, 'Personas'),
  (36, 3, 'Operaciones'),
  (37, 3, 'Legal'),
  (38, 3, 'Producto'),
  (39, 3, 'Datos'),
  (40, 3, 'Calidad'),
  (41, 3, 'Administración');

-- 1.750 empleados. El reparto por departamento NO es uniforme: pesa
-- Ingeniería 18 %, Ventas 15 %, Soporte 12 %, Operaciones 11 %, Marketing 8 %,
-- Producto 7 %, Finanzas 6 %, Datos 6 %, Personas 5 %, Calidad 5 %,
-- Administración 4 %, Legal 3 %. Los umbrales de abajo son esos pesos
-- acumulados, en el orden de los ids 30..41.
--
-- 1.750 y no 1.400: la asistencia sólo cubre a los activos (~92 %) y sólo desde
-- su `hire_date`, así que 1.400 se quedaba en ~850.000 filas. Con 1.750 la
-- tabla pasa el millón, que es el punto del ejercicio.
INSERT INTO employees (id, company_id, department_id, name, hire_date, active)
SELECT
  3000 + n,
  3,
  (ARRAY[30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41])[
    1 + width_bucket(
      random()::numeric,
      ARRAY[0.18, 0.33, 0.45, 0.53, 0.59, 0.64, 0.75, 0.78, 0.85, 0.91, 0.96]::numeric[]
    )
  ],
  'Empleado C' || lpad(n::text, 4, '0'),
  -- 4.017 días: de 2015-01-01 a 2025-12-31, ambos incluidos.
  DATE '2015-01-01' + (random() * 4017)::int,
  -- ~8 % inactivos.
  random() >= 0.08
FROM generate_series(1, 1750) AS n;

-- Evaluaciones: un período por trimestre de 2023, 2024 y 2025 (último día del
-- trimestre) por empleado, saltando ~15 % al azar y sin evaluar a nadie antes
-- de su `hire_date`.
--   score  → NUMERIC(4,2) entre 1.00 y 5.00, sesgado a 3.5-4.5: la suma de tres
--            uniformes se acerca a una normal, centrada en 3.95 con desviación
--            0.55, y los extremos se recortan a los límites del caso.
--   status → completed 0.7 / pending 0.2 / calibrated 0.1, salvo 2025-Q3 y
--            2025-Q4, donde la mayoría queda pendiente (0.3 / 0.6 / 0.1): son
--            los trimestres "en curso" del seed.
--   id     → 300000 + posición del empleado * 12 + índice del trimestre. Deja
--            huecos donde el trimestre se saltó, y eso está bien: el id sólo
--            tiene que ser único y estable.
WITH trimestres AS (
  SELECT (gs + INTERVAL '3 month - 1 day')::date AS periodo, orden::int - 1 AS indice
  FROM generate_series(DATE '2023-01-01', DATE '2025-10-01', INTERVAL '3 month')
    WITH ORDINALITY AS t(gs, orden)
)
INSERT INTO performance_reviews (id, employee_id, company_id, period, score, status)
SELECT
  300000 + (e.id - 3000) * 12 + t.indice,
  e.id,
  3,
  t.periodo,
  LEAST(5.00, GREATEST(1.00,
    round((3.95 + ((random() + random() + random()) - 1.5) * 1.10)::numeric, 2)
  )),
  (ARRAY['completed', 'pending', 'calibrated'])[
    1 + width_bucket(
      random()::numeric,
      CASE
        WHEN t.periodo IN (DATE '2025-09-30', DATE '2025-12-31') THEN ARRAY[0.30, 0.90]
        ELSE ARRAY[0.70, 0.90]
      END::numeric[]
    )
  ]
FROM employees e
CROSS JOIN trimestres t
WHERE e.company_id = 3
  AND t.periodo >= e.hire_date
  AND random() >= 0.15;

-- Asistencia: un registro por empleado ACTIVO y por cada día de 2024-01-01 a
-- 2025-12-31 (731 días), desde su `hire_date`. Es el millón de filas.
--
-- Una sola sentencia `INSERT … SELECT … FROM generate_series … CROSS JOIN …`:
-- fila por fila esto tardaría minutos, y el initdb del contenedor lo paga cada
-- vez que se renueva el volumen.
--
-- `present` con probabilidad ~0.93, salvo Soporte (32) y Operaciones (36) con
-- ~0.85: dos departamentos que se despegan del resto para que la tasa de
-- asistencia por departamento no salga plana.
INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT
  3000000 + (e.id - 3000) * 731 + (d.dia - DATE '2024-01-01'),
  e.id,
  3,
  d.dia,
  random() < CASE WHEN e.department_id IN (32, 36) THEN 0.85 ELSE 0.93 END
FROM employees e
CROSS JOIN (
  SELECT gs::date AS dia
  FROM generate_series(DATE '2024-01-01', DATE '2025-12-31', INTERVAL '1 day') AS gs
) d
WHERE e.company_id = 3
  AND e.active
  AND d.dia >= e.hire_date;

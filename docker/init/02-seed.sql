-- Seed determinista. Todos los identificadores son fijos y los conteos están
-- calculados a mano más abajo: los tests usan esos literales, no los
-- recalculan desde los datos.
--
-- Lo que este seed ejercita a propósito:
--   * Dos empresas con los mismos nombres de departamento ("Ingeniería",
--     "Ventas"): un resultado sin aislamiento se nota de inmediato.
--   * Un empleado inactivo (103).
--   * Evaluaciones en 2024 y 2025 con los tres estados del caso.
--   * Una evaluación (1010) cuya empresa NO coincide con la de su empleado:
--     pertenece a la empresa 1, pero su empleado (200) es de la empresa 2.
--     Cuenta para la empresa 1 mientras no haya join; al unir con empleados
--     bajo el filtro por empresa, desaparece.
--   * El departamento 10 tiene en 2025 cuatro evaluaciones, tres completadas
--     (75 % de completitud).
--   * Asistencia de dos meses corridos (junio y julio de 2025), más un mes
--     (agosto de 2025) con conteos redondos por departamento para la tasa de
--     asistencia.
--
-- CONTEOS ESPERADOS (evaluaciones por empresa y estado, sin joins):
--   empresa 1 → completed: 5, pending: 4, calibrated: 2   (total 11)
--   empresa 2 → completed: 3, pending: 1, calibrated: 1   (total 5)
--
-- CASO OBLIGATORIO (score promedio y evaluaciones completadas por departamento
-- y trimestre de 2025; el trimestre se nombra por su primer día):
--   empresa 1 → Ingeniería 2025-01-01: avg 4.35 (1000, 1002), completadas 2
--               Ingeniería 2025-04-01: avg 3.40 (1001, 1003), completadas 1
--               Ventas     2025-01-01: avg 3.50 (1004),       completadas 0
--               Ventas     2025-04-01: avg 2.90 (1005),       completadas 0
--   empresa 2 → Ingeniería 2025-01-01: avg 4.10 (2000), completadas 1
--               Ingeniería 2025-04-01: avg 3.30 (2004), completadas 1
--               Ventas     2025-01-01: avg 3.20 (2001), completadas 0
--
-- COMPLETITUD (completion_rate = completadas / evaluaciones * 100) de la
-- empresa 1 por departamento, con las evaluaciones de 2025:
--   Ingeniería → 4 evaluaciones (1000, 1001, 1002, 1003), 3 completadas → 75
--   Ventas     → 2 evaluaciones (1004, 1005),             0 completadas → 0
--   Con el filtro global `status = completed` la misma consulta da Ingeniería
--   100 y Ventas desaparece: sin filas completadas no queda grupo que agrupar.
--
-- TASA DE ASISTENTES (attendance_rate = presentes / días registrados * 100) de
-- la empresa 1 por departamento, con la asistencia de agosto de 2025:
--   Ingeniería → 20 días registrados (empleado 100), 16 presentes → 80
--   Ventas     → 10 días registrados (empleado 102),  5 presentes → 50
--   empresa 2  → Ingeniería 4 días, 3 presentes → 75
-- Junio y julio quedan como estaban; agosto es un bloque aparte para que los
-- números de la tasa se puedan verificar a mano.
--
-- FILA INCONSISTENTE (evaluación 1010), evaluaciones de 2025 por trimestre de
-- la empresa 1:
--   sin join  → 2025-01-01: 3, 2025-04-01: 3, 2025-07-01: 1 (la 1010)
--   con join a empleados y departamentos → 2025-01-01: 3, 2025-04-01: 3

INSERT INTO companies (id, name) VALUES
  (1, 'Empresa A'),
  (2, 'Empresa B');

-- Nombres de departamento repetidos entre empresas, a propósito.
INSERT INTO departments (id, company_id, name) VALUES
  (10, 1, 'Ingeniería'),
  (11, 1, 'Ventas'),
  (20, 2, 'Ingeniería'),
  (21, 2, 'Ventas');

INSERT INTO employees (id, company_id, department_id, name, hire_date, active) VALUES
  (100, 1, 10, 'Empleado A1', DATE '2022-03-01', TRUE),
  (101, 1, 10, 'Empleado A2', DATE '2023-07-15', TRUE),
  (102, 1, 11, 'Empleado A3', DATE '2021-11-02', TRUE),
  (103, 1, 11, 'Empleado A4', DATE '2020-01-20', FALSE),
  (200, 2, 20, 'Empleado B1', DATE '2022-05-10', TRUE),
  (201, 2, 21, 'Empleado B2', DATE '2024-02-01', TRUE);

-- Empresa 1: 11 evaluaciones (5 completed, 4 pending, 2 calibrated).
-- Departamento 10 en 2025: 1000, 1001, 1002, 1003 → 4 evaluaciones, 3 completadas.
INSERT INTO performance_reviews (id, employee_id, company_id, period, score, status) VALUES
  (1000, 100, 1, DATE '2025-03-31', 4.20, 'completed'),
  (1001, 100, 1, DATE '2025-06-30', 3.80, 'completed'),
  (1002, 101, 1, DATE '2025-03-31', 4.50, 'completed'),
  (1003, 101, 1, DATE '2025-06-30', 3.00, 'pending'),
  (1004, 102, 1, DATE '2025-03-31', 3.50, 'calibrated'),
  (1005, 103, 1, DATE '2025-06-30', 2.90, 'pending'),
  (1006, 102, 1, DATE '2024-12-31', 4.00, 'completed'),
  (1007, 102, 1, DATE '2024-06-30', 3.10, 'calibrated'),
  (1008, 100, 1, DATE '2024-12-31', 3.90, 'completed'),
  (1009, 101, 1, DATE '2024-06-30', 2.50, 'pending'),
  -- Inconsistente a propósito: empresa 1, empleado de la empresa 2.
  (1010, 200, 1, DATE '2025-09-30', 5.00, 'pending');

-- Empresa 2: 5 evaluaciones (3 completed, 1 pending, 1 calibrated).
INSERT INTO performance_reviews (id, employee_id, company_id, period, score, status) VALUES
  (2000, 200, 2, DATE '2025-03-31', 4.10, 'completed'),
  (2001, 201, 2, DATE '2025-03-31', 3.20, 'pending'),
  (2002, 201, 2, DATE '2024-12-31', 2.80, 'calibrated'),
  (2003, 200, 2, DATE '2024-06-30', 4.60, 'completed'),
  (2004, 200, 2, DATE '2025-06-30', 3.30, 'completed');

-- Asistencia: junio y julio de 2025 completos (61 días por empleado).
--   empleado 100 (empresa 1): 61 días, 2 ausencias → 59 presentes
--   empleado 102 (empresa 1): 61 días, 1 ausencia  → 60 presentes
--   empleado 200 (empresa 2): 61 días, 3 ausencias → 58 presentes
INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT 30000 + (gs::date - DATE '2025-06-01'), 100, 1, gs::date,
       gs::date NOT IN (DATE '2025-06-10', DATE '2025-07-04')
FROM generate_series(DATE '2025-06-01', DATE '2025-07-31', INTERVAL '1 day') AS gs;

INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT 30100 + (gs::date - DATE '2025-06-01'), 102, 1, gs::date,
       gs::date NOT IN (DATE '2025-06-23')
FROM generate_series(DATE '2025-06-01', DATE '2025-07-31', INTERVAL '1 day') AS gs;

INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT 30200 + (gs::date - DATE '2025-06-01'), 200, 2, gs::date,
       gs::date NOT IN (DATE '2025-06-05', DATE '2025-06-06', DATE '2025-07-21')
FROM generate_series(DATE '2025-06-01', DATE '2025-07-31', INTERVAL '1 day') AS gs;

-- Agosto de 2025: bloque corto con conteos redondos, para la tasa de asistencia
-- por departamento. Cada empleado está en un departamento distinto, así que la
-- tasa del departamento es la del empleado.
--   empleado 100 (empresa 1, Ingeniería): 20 días, 4 ausencias → 16 presentes
INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT 31000 + (gs::date - DATE '2025-08-01'), 100, 1, gs::date,
       gs::date NOT IN (DATE '2025-08-04', DATE '2025-08-11', DATE '2025-08-18', DATE '2025-08-20')
FROM generate_series(DATE '2025-08-01', DATE '2025-08-20', INTERVAL '1 day') AS gs;

--   empleado 102 (empresa 1, Ventas): 10 días, 5 ausencias → 5 presentes
INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT 31100 + (gs::date - DATE '2025-08-01'), 102, 1, gs::date,
       gs::date NOT IN (DATE '2025-08-02', DATE '2025-08-04', DATE '2025-08-06',
                        DATE '2025-08-08', DATE '2025-08-10')
FROM generate_series(DATE '2025-08-01', DATE '2025-08-10', INTERVAL '1 day') AS gs;

--   empleado 200 (empresa 2, Ingeniería): 4 días, 1 ausencia → 3 presentes.
--   Está para que la empresa 2 tenga su propia tasa y el aislamiento se note.
INSERT INTO attendance (id, employee_id, company_id, date, present)
SELECT 31200 + (gs::date - DATE '2025-08-01'), 200, 2, gs::date,
       gs::date NOT IN (DATE '2025-08-03')
FROM generate_series(DATE '2025-08-01', DATE '2025-08-04', INTERVAL '1 day') AS gs;

-- El mismo caso que docker/init/, escrito para SQLite. Existe para probar que
-- cambiar el motor no toca ni las definiciones ni los consumidores: las filas
-- son las mismas y los literales de los tests son los mismos.
--
-- Qué cambió respecto del DDL de Postgres, y por qué:
--   * `DATE '2025-03-31'` → `'2025-03-31'`. SQLite no tiene literal de fecha:
--     guarda el texto ISO, que se compara y se ordena igual.
--   * `NUMERIC(4,2)` se conserva como tipo declarado —SQLite lo acepta y la
--     introspección lo devuelve tal cual—, pero es afinidad, no restricción:
--     el motor no impide guardar un texto ahí (por eso el dialecto declara
--     `tiposGarantizados: false`).
--   * `generate_series` no existe: la asistencia queda sin filas. Ninguna
--     consulta de esta suite la usa; el módulo de asistencia sigue viviendo en
--     la fuente Postgres.
--   * `id BIGINT PRIMARY KEY` no es alias de rowid (sólo `INTEGER PRIMARY KEY`
--     lo es), así que SQLite crea un índice único por cada clave primaria y el
--     snapshot queda con los mismos índices que el de Postgres.

CREATE TABLE companies (
  id   BIGINT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE departments (
  id         BIGINT PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id),
  name       TEXT NOT NULL
);

CREATE TABLE employees (
  id            BIGINT PRIMARY KEY,
  company_id    BIGINT NOT NULL REFERENCES companies(id),
  department_id BIGINT NOT NULL REFERENCES departments(id),
  name          TEXT NOT NULL,
  hire_date     DATE NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE performance_reviews (
  id          BIGINT PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  company_id  BIGINT NOT NULL,
  period      DATE NOT NULL,
  score       NUMERIC(4,2) NOT NULL,
  status      TEXT NOT NULL
);

CREATE TABLE attendance (
  id          BIGINT PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  company_id  BIGINT NOT NULL,
  date        DATE NOT NULL,
  present     BOOLEAN NOT NULL
);

INSERT INTO companies (id, name) VALUES
  (1, 'Empresa A'),
  (2, 'Empresa B');

INSERT INTO departments (id, company_id, name) VALUES
  (10, 1, 'Ingeniería'),
  (11, 1, 'Ventas'),
  (20, 2, 'Ingeniería'),
  (21, 2, 'Ventas');

INSERT INTO employees (id, company_id, department_id, name, hire_date, active) VALUES
  (100, 1, 10, 'Empleado A1', '2022-03-01', TRUE),
  (101, 1, 10, 'Empleado A2', '2023-07-15', TRUE),
  (102, 1, 11, 'Empleado A3', '2021-11-02', TRUE),
  (103, 1, 11, 'Empleado A4', '2020-01-20', FALSE),
  (200, 2, 20, 'Empleado B1', '2022-05-10', TRUE),
  (201, 2, 21, 'Empleado B2', '2024-02-01', TRUE);

-- Las mismas 16 evaluaciones del seed de Postgres, con los mismos ids, fechas,
-- scores y estados. Incluida la 1010, cuya empresa no coincide con la de su
-- empleado.
INSERT INTO performance_reviews (id, employee_id, company_id, period, score, status) VALUES
  (1000, 100, 1, '2025-03-31', 4.20, 'completed'),
  (1001, 100, 1, '2025-06-30', 3.80, 'completed'),
  (1002, 101, 1, '2025-03-31', 4.50, 'completed'),
  (1003, 101, 1, '2025-06-30', 3.00, 'pending'),
  (1004, 102, 1, '2025-03-31', 3.50, 'calibrated'),
  (1005, 103, 1, '2025-06-30', 2.90, 'pending'),
  (1006, 102, 1, '2024-12-31', 4.00, 'completed'),
  (1007, 102, 1, '2024-06-30', 3.10, 'calibrated'),
  (1008, 100, 1, '2024-12-31', 3.90, 'completed'),
  (1009, 101, 1, '2024-06-30', 2.50, 'pending'),
  (1010, 200, 1, '2025-09-30', 5.00, 'pending'),
  (2000, 200, 2, '2025-03-31', 4.10, 'completed'),
  (2001, 201, 2, '2025-03-31', 3.20, 'pending'),
  (2002, 201, 2, '2024-12-31', 2.80, 'calibrated'),
  (2003, 200, 2, '2024-06-30', 4.60, 'completed'),
  (2004, 200, 2, '2025-06-30', 3.30, 'completed');

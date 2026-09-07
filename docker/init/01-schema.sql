-- Esquema del caso, copiado tal cual del enunciado: sin tablas nuevas y sin
-- cambios de tipos, claves o restricciones.

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

-- Un registro por evaluación de desempeño.
-- Puede existir más de una evaluación por empleado durante un año.
CREATE TABLE performance_reviews (
  id          BIGINT PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  company_id  BIGINT NOT NULL,
  period      DATE NOT NULL,
  score       NUMERIC(4,2) NOT NULL,
  status      TEXT NOT NULL -- 'pending', 'completed', 'calibrated'
);

-- Un registro por día y empleado.
CREATE TABLE attendance (
  id          BIGINT PRIMARY KEY,
  employee_id BIGINT NOT NULL REFERENCES employees(id),
  company_id  BIGINT NOT NULL,
  date        DATE NOT NULL,
  present     BOOLEAN NOT NULL
);

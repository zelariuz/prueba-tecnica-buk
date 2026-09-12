WITH attendance AS (
  SELECT date, present, employee_id
  FROM attendance
  WHERE company_id = $1
    AND date >= $2
    AND date <= $3
),
employees AS (
  SELECT id, department_id
  FROM employees
  WHERE company_id = $1
),
departments AS (
  SELECT name, id
  FROM departments
  WHERE company_id = $1
),
serie AS (
  SELECT TO_CHAR(g.bucket, 'YYYY-MM-DD') AS bucket
  FROM generate_series(
    DATE_TRUNC('day', $2::date),
    $3::date,
    INTERVAL '1 day'
  ) AS g(bucket)
),
ejes AS (
  SELECT DISTINCT departments.name AS "departments.name"
  FROM departments
),
agregada AS (
  SELECT departments.name AS "departments.name", TO_CHAR(DATE_TRUNC('day', attendance.date), 'YYYY-MM-DD') AS "attendance.date", COUNT(*) AS "attendance.count", COUNT(*) FILTER (WHERE attendance.present = $4) AS "attendance.present_count"
  FROM attendance
  JOIN employees ON attendance.employee_id = employees.id
  JOIN departments ON employees.department_id = departments.id
  GROUP BY departments.name, TO_CHAR(DATE_TRUNC('day', attendance.date), 'YYYY-MM-DD')
)
SELECT ejes."departments.name" AS "departments.name", serie.bucket AS "attendance.date", COALESCE(agregada."attendance.count", 0) AS "attendance.count", COALESCE(agregada."attendance.present_count", 0)::numeric / NULLIF(COALESCE(agregada."attendance.count", 0), 0) * 100 AS "attendance.attendance_rate"
FROM serie
CROSS JOIN ejes
LEFT JOIN agregada ON agregada."attendance.date" = serie.bucket
  AND agregada."departments.name" = ejes."departments.name"
ORDER BY "departments.name" ASC, "attendance.date" ASC
LIMIT $5

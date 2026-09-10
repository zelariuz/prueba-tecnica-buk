WITH attendance AS (
  SELECT present, employee_id
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
)
SELECT "departments.name", "attendance.present_count"::numeric / NULLIF("attendance.count", 0) * 100 AS "attendance.attendance_rate"
FROM (
  SELECT departments.name AS "departments.name", COUNT(*) FILTER (WHERE attendance.present = $4) AS "attendance.present_count", COUNT(*) AS "attendance.count"
  FROM attendance
  JOIN employees ON attendance.employee_id = employees.id
  JOIN departments ON employees.department_id = departments.id
  GROUP BY departments.name
) AS agregada
LIMIT $5

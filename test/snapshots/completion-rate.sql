WITH reviews AS (
  SELECT period, status, employee_id
  FROM performance_reviews
  WHERE company_id = $1
    AND period >= $2
    AND period <= $3
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
SELECT "departments.name", "reviews.period", "reviews.completed_count"::numeric / NULLIF("reviews.count", 0) * 100 AS "reviews.completion_rate"
FROM (
  SELECT departments.name AS "departments.name", TO_CHAR(DATE_TRUNC('year', reviews.period), 'YYYY-MM-DD') AS "reviews.period", COUNT(*) FILTER (WHERE reviews.status = $4) AS "reviews.completed_count", COUNT(*) AS "reviews.count"
  FROM reviews
  JOIN employees ON reviews.employee_id = employees.id
  JOIN departments ON employees.department_id = departments.id
  GROUP BY departments.name, TO_CHAR(DATE_TRUNC('year', reviews.period), 'YYYY-MM-DD')
) AS agregada
ORDER BY "departments.name" ASC
LIMIT $5

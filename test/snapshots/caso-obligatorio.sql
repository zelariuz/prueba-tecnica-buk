WITH reviews AS (
  SELECT period, score, status, employee_id
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
SELECT departments.name AS "departments.name", TO_CHAR(DATE_TRUNC('quarter', reviews.period), 'YYYY-MM-DD') AS "reviews.period", AVG(reviews.score) AS "reviews.avg_score", COUNT(*) FILTER (WHERE reviews.status = $4) AS "reviews.completed_count"
FROM reviews
JOIN employees ON reviews.employee_id = employees.id
JOIN departments ON employees.department_id = departments.id
GROUP BY departments.name, TO_CHAR(DATE_TRUNC('quarter', reviews.period), 'YYYY-MM-DD')
ORDER BY "reviews.period" ASC
LIMIT $5

WITH reviews AS (
  SELECT period, score, status, employee_id
  FROM main.performance_reviews
  WHERE company_id = $1
    AND period >= $2
    AND period <= $3
    AND status = $4
),
employees AS (
  SELECT id, department_id
  FROM main.employees
  WHERE company_id = $1
),
departments AS (
  SELECT name, id
  FROM main.departments
  WHERE company_id = $1
)
SELECT departments.name AS "departments.name", PRINTF('%s-%02d-01', STRFTIME('%Y', reviews.period), (CAST(STRFTIME('%m', reviews.period) AS INTEGER) - 1) / 3 * 3 + 1) AS "reviews.period", AVG(reviews.score) AS "reviews.avg_score", COUNT(*) FILTER (WHERE reviews.status = $5) AS "reviews.completed_count"
FROM reviews
JOIN employees ON reviews.employee_id = employees.id
JOIN departments ON employees.department_id = departments.id
GROUP BY departments.name, PRINTF('%s-%02d-01', STRFTIME('%Y', reviews.period), (CAST(STRFTIME('%m', reviews.period) AS INTEGER) - 1) / 3 * 3 + 1)
ORDER BY "reviews.period" ASC
LIMIT $6

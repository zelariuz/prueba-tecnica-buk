WITH departments AS (
  SELECT name
  FROM departments
  WHERE company_id = $1
)
SELECT departments.name AS "departments.name"
FROM departments
GROUP BY departments.name
ORDER BY "departments.name" ASC
LIMIT $2

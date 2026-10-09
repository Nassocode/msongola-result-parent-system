USE msongola_results;

INSERT INTO users (name, email, password_hash, role)
VALUES
  ('Msongola Admin', 'admin@msongola.com', '$2b$10$ZNGX1b.CU6qKnd01w.q4EeLjC87Et8426zeHzvBR3yvuC7PH9Wa5i', 'admin')
ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = VALUES(role);

INSERT INTO parents (full_name, phone_number, phone_number_normalized)
VALUES
  ('Mary Ndlovu', '+263771234567', '+263771234567')
ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), phone_number = VALUES(phone_number);

INSERT INTO students (external_student_id, name, admission_number, class_name, year)
VALUES
  ('DEMO-ST-101', 'Asha Moyo', 'ST-101', 'Grade 8', 2026),
  ('DEMO-ST-102', 'Liam Ndlovu', 'ST-102', 'Grade 9', 2026)
ON DUPLICATE KEY UPDATE external_student_id = VALUES(external_student_id), name = VALUES(name), class_name = VALUES(class_name), year = VALUES(year);

INSERT INTO parent_students (parent_id, student_id, relationship, is_primary)
SELECT p.id, s.id, 'Parent', TRUE
FROM parents p
CROSS JOIN students s
WHERE p.phone_number_normalized = '+263771234567'
  AND s.admission_number IN ('ST-101', 'ST-102')
ON DUPLICATE KEY UPDATE relationship = VALUES(relationship), is_primary = VALUES(is_primary);

INSERT INTO result_records (external_result_id, student_id, subject, score, grade, term, year, comment)
SELECT seeded.external_result_id, s.id, seeded.subject, seeded.score, seeded.grade, seeded.term, seeded.year, seeded.comment
FROM (
  SELECT 'DEMO-R-101-MATH-2026-T1' AS external_result_id, 'ST-101' AS admission_number, 'Mathematics' AS subject, 92 AS score, 'A' AS grade, 'Term 1' AS term, 2026 AS year, 'Excellent performance and strong problem solving.' AS comment
  UNION ALL SELECT 'DEMO-R-101-ENG-2026-T1', 'ST-101', 'English', 88, 'A', 'Term 1', 2026, 'Consistent and well-structured work.'
  UNION ALL SELECT 'DEMO-R-101-SCI-2026-T1', 'ST-101', 'Science', 90, 'A', 'Term 1', 2026, 'Very good understanding of scientific concepts.'
  UNION ALL SELECT 'DEMO-R-102-MATH-2026-T1', 'ST-102', 'Mathematics', 81, 'B', 'Term 1', 2026, 'Good progress with careful revision.'
  UNION ALL SELECT 'DEMO-R-102-ENG-2026-T1', 'ST-102', 'English', 79, 'B', 'Term 1', 2026, 'Good improvement in reading and writing.'
  UNION ALL SELECT 'DEMO-R-102-SCI-2026-T1', 'ST-102', 'Science', 84, 'B', 'Term 1', 2026, 'Shows strong curiosity and focus.'
) AS seeded
JOIN students s ON s.admission_number = seeded.admission_number
ON DUPLICATE KEY UPDATE score = VALUES(score), grade = VALUES(grade), term = VALUES(term), year = VALUES(year), comment = VALUES(comment);

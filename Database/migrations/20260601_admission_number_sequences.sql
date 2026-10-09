CREATE TABLE IF NOT EXISTS admission_number_sequences (
    academic_year SMALLINT UNSIGNED PRIMARY KEY,
    last_number INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO admission_number_sequences (academic_year, last_number)
SELECT CAST(SUBSTRING(admission_number, 5, 4) AS UNSIGNED) AS academic_year,
       MAX(CAST(SUBSTRING(admission_number, 10) AS UNSIGNED)) AS last_number
FROM students
WHERE admission_number REGEXP '^MSS-[0-9]{4}-[0-9]{4,}$'
GROUP BY CAST(SUBSTRING(admission_number, 5, 4) AS UNSIGNED)
ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number));

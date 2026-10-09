USE msongola_results;

ALTER TABLE users
    MODIFY role ENUM('admin', 'academic_master', 'parent') NOT NULL DEFAULT 'academic_master';

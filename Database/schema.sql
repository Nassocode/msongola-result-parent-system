CREATE DATABASE IF NOT EXISTS msongola_results
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE msongola_results;

CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin', 'academic_master') NOT NULL DEFAULT 'academic_master',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS students (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    external_student_id VARCHAR(100) NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    admission_number VARCHAR(50) NOT NULL UNIQUE,
    class_name VARCHAR(80) NOT NULL,
    year INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admission_number_sequences (
    academic_year SMALLINT UNSIGNED PRIMARY KEY,
    last_number INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS parents (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(120) NOT NULL,
    phone_number VARCHAR(30) NOT NULL,
    phone_number_normalized VARCHAR(30) NOT NULL UNIQUE,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS parent_students (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    parent_id INT UNSIGNED NOT NULL,
    student_id INT UNSIGNED NOT NULL,
    relationship VARCHAR(50) NOT NULL DEFAULT 'Parent',
    is_primary BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_parent_student (parent_id, student_id),
    KEY idx_parent_students_student (student_id),
    CONSTRAINT fk_parent_students_parent
        FOREIGN KEY (parent_id) REFERENCES parents(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_parent_students_student
        FOREIGN KEY (student_id) REFERENCES students(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS result_import_batches (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source_system VARCHAR(100) NOT NULL,
    source_batch_id VARCHAR(150) NOT NULL UNIQUE,
    exam_name VARCHAR(150) NOT NULL,
    term VARCHAR(50) NOT NULL,
    year INT NOT NULL,
    status ENUM('PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
    received_records INT UNSIGNED NOT NULL DEFAULT 0,
    imported_records INT UNSIGNED NOT NULL DEFAULT 0,
    duplicate_records INT UNSIGNED NOT NULL DEFAULT 0,
    queued_messages INT UNSIGNED NOT NULL DEFAULT 0,
    missing_contacts INT UNSIGNED NOT NULL DEFAULT 0,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    KEY idx_import_batches_received_at (received_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS result_records (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    external_result_id VARCHAR(150) NULL UNIQUE,
    import_batch_id INT UNSIGNED NULL,
    student_id INT UNSIGNED NOT NULL,
    subject VARCHAR(120) NOT NULL,
    score DECIMAL(5,2) NOT NULL,
    grade VARCHAR(10) NOT NULL,
    term VARCHAR(50) NOT NULL,
    year INT NOT NULL,
    comment TEXT NULL,
    division VARCHAR(30) NULL,
    total_points INT UNSIGNED NULL,
    class_position INT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_result_records_batch (import_batch_id),
    KEY idx_result_records_student (student_id),
    KEY idx_result_records_term (term, year),
    CONSTRAINT fk_result_records_student
        FOREIGN KEY (student_id) REFERENCES students(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_result_records_batch
        FOREIGN KEY (import_batch_id) REFERENCES result_import_batches(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sms_outbox (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    import_batch_id INT UNSIGNED NOT NULL,
    parent_id INT UNSIGNED NOT NULL,
    student_id INT UNSIGNED NOT NULL,
    recipient_phone VARCHAR(30) NOT NULL,
    message_text TEXT NOT NULL,
    status ENUM('PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    provider_message_id VARCHAR(150) NULL,
    last_error TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processing_started_at DATETIME NULL,
    sent_at DATETIME NULL,
    delivered_at DATETIME NULL,
    UNIQUE KEY uq_sms_batch_parent_student (import_batch_id, parent_id, student_id),
    KEY idx_sms_outbox_status_created (status, created_at),
    CONSTRAINT fk_sms_outbox_batch
        FOREIGN KEY (import_batch_id) REFERENCES result_import_batches(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_sms_outbox_parent
        FOREIGN KEY (parent_id) REFERENCES parents(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_sms_outbox_student
        FOREIGN KEY (student_id) REFERENCES students(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB;

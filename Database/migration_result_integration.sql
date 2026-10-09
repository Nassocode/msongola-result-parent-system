USE msongola_results;

ALTER TABLE students
    ADD COLUMN external_student_id VARCHAR(100) NULL UNIQUE;

CREATE TABLE IF NOT EXISTS parents (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(120) NOT NULL,
    phone_number VARCHAR(30) NOT NULL,
    phone_number_normalized VARCHAR(30) NOT NULL UNIQUE,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS parent_students (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    parent_id INT NOT NULL,
    student_id INT NOT NULL,
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
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
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

ALTER TABLE result_records
    ADD COLUMN external_result_id VARCHAR(150) NULL UNIQUE,
    ADD COLUMN import_batch_id INT NULL,
    ADD KEY idx_result_records_batch (import_batch_id),
    ADD CONSTRAINT fk_result_records_batch
        FOREIGN KEY (import_batch_id) REFERENCES result_import_batches(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS sms_outbox (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    import_batch_id INT NOT NULL,
    parent_id INT NOT NULL,
    student_id INT NOT NULL,
    recipient_phone VARCHAR(30) NOT NULL,
    message_text TEXT NOT NULL,
    status ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    provider_message_id VARCHAR(150) NULL,
    last_error TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processing_started_at DATETIME NULL,
    sent_at DATETIME NULL,
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

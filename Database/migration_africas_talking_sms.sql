USE msongola_results;

ALTER TABLE sms_outbox
    MODIFY COLUMN status ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    ADD COLUMN processing_started_at DATETIME NULL AFTER created_at;

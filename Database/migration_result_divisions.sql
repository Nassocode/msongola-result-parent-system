USE msongola_results;

ALTER TABLE result_records
    ADD COLUMN division VARCHAR(30) NULL AFTER comment;

ALTER TABLE result_records
    ADD COLUMN class_position INT UNSIGNED NULL AFTER division;

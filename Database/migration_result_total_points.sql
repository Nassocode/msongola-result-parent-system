USE msongola_results;

ALTER TABLE result_records
    ADD COLUMN total_points INT UNSIGNED NULL AFTER division;

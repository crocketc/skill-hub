ALTER TABLE skill_lineage ADD COLUMN origin_display_name TEXT;

UPDATE skill_lineage
SET origin_display_name = (
    SELECT display_name FROM skills WHERE skills.id = skill_lineage.origin_skill_id
);

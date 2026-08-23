CREATE VIRTUAL TABLE skills_fts_v2 USING fts5(
    skill_id UNINDEXED,
    display_name,
    runtime_name,
    original_description,
    translated_description,
    user_note,
    tags,
    author,
    license,
    requirements,
    markdown,
    tokenize = 'trigram'
);

INSERT INTO skills_fts_v2
    (skill_id, display_name, runtime_name, original_description,
     translated_description, user_note, tags, author, license,
     requirements, markdown)
SELECT skill_id, display_name, runtime_name, original_description,
       translated_description, user_note, tags, author, license,
       requirements, markdown
FROM skills_fts;

DROP TABLE skills_fts;
ALTER TABLE skills_fts_v2 RENAME TO skills_fts;

CREATE TABLE search_display_names (
    skill_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL
);

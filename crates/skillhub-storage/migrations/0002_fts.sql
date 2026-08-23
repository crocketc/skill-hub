CREATE VIRTUAL TABLE skills_fts USING fts5(
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
    markdown
);

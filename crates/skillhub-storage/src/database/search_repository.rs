use super::Database;
use rusqlite::{params, OptionalExtension};
use skillhub_core::search::{
    DuplicateCandidate, SearchDocument, SearchField, SearchHit, SearchQuery,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};

const FIELD_NAMES: [&str; 10] = [
    "display_name",
    "runtime_name",
    "original_description",
    "translated_description",
    "user_note",
    "tags",
    "author",
    "license",
    "requirements",
    "markdown",
];

pub struct SearchRepository<'a> {
    database: &'a Database,
}

impl<'a> SearchRepository<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn reindex_skill(&self, document: &SearchDocument) -> AppResult<()> {
        let conn = &self.database.connection;
        let tx = conn.unchecked_transaction().map_err(error)?;
        tx.execute(
            "DELETE FROM skills_fts WHERE skill_id = ?1",
            [document.skill_id.to_string()],
        )
        .map_err(error)?;
        tx.execute(
            "INSERT INTO skills_fts (skill_id, display_name, runtime_name, original_description, translated_description, user_note, tags, author, license, requirements, markdown) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                document.skill_id.to_string(),
                normalize(&document.display_name),
                normalize(&document.runtime_name),
                normalize(&document.original_description),
                normalize(document.translated_description.as_deref().unwrap_or_default()),
                normalize(document.user_note.as_deref().unwrap_or_default()),
                normalize(&document.tags.join(" ")),
                normalize(document.author.as_deref().unwrap_or_default()),
                normalize(document.license.as_deref().unwrap_or_default()),
                normalize(&document.requirements.join(" ")),
                normalize(&document.markdown),
            ],
        ).map_err(error)?;
        tx.commit().map_err(error)
    }

    pub fn index_revision(&self, skill_id: &SkillId) -> AppResult<i64> {
        self.database
            .connection
            .query_row(
                "SELECT rowid FROM skills_fts WHERE skill_id=?1",
                [skill_id.to_string()],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?
            .ok_or_else(|| AppError::new(ErrorCode::ObjectNotFound, Severity::Error))
    }

    pub fn search(&self, query: impl Into<SearchQuery>) -> AppResult<Vec<SearchHit>> {
        let query = query.into();
        let text = normalize(&query.text);
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        let match_query = fts_query(&text);
        let mut statement = self.database.connection.prepare(
            "SELECT skill_id, display_name, bm25(skills_fts, 10.0, 8.0, 3.0, 3.0, 4.0, 2.0, 2.0, 1.0, 2.0, 1.0) AS rank FROM skills_fts WHERE skills_fts MATCH ?1 ORDER BY rank ASC, skill_id ASC LIMIT ?2"
        ).map_err(error)?;
        let rows = statement
            .query_map(params![match_query, query.limit as i64], |row| {
                let id: String = row.get(0)?;
                let skill_name: String = row.get(1)?;
                let rank: f64 = row.get(2)?;
                Ok((id, skill_name, rank))
            })
            .map_err(error)?;
        let mut hits = Vec::new();
        for row in rows {
            let (id, skill_name, rank) = row.map_err(error)?;
            let skill_id = id
                .parse()
                .map_err(|_| AppError::new(ErrorCode::InternalError, Severity::Error))?;
            hits.push(SearchHit {
                skill_id,
                skill_name,
                rank,
                highlighted_fields: self.matching_fields(&id, &text)?,
            });
        }
        if hits.is_empty() {
            let pattern = format!("%{}%", text);
            let mut fallback = self.database.connection.prepare("SELECT skill_id, display_name FROM skills_fts WHERE display_name LIKE ?1 OR runtime_name LIKE ?1 OR original_description LIKE ?1 OR translated_description LIKE ?1 OR user_note LIKE ?1 OR tags LIKE ?1 OR author LIKE ?1 OR license LIKE ?1 OR requirements LIKE ?1 OR markdown LIKE ?1 ORDER BY skill_id ASC LIMIT ?2").map_err(error)?;
            let rows = fallback
                .query_map(params![pattern, query.limit as i64], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(error)?;
            for row in rows {
                let (id, skill_name) = row.map_err(error)?;
                let skill_id = id.parse().map_err(|_| bad_id())?;
                hits.push(SearchHit {
                    skill_id,
                    skill_name,
                    rank: 0.0,
                    highlighted_fields: self.matching_fields(&id, &text)?,
                });
            }
        }
        Ok(hits)
    }

    pub fn duplicate_candidates(&self) -> AppResult<Vec<DuplicateCandidate>> {
        let mut statement = self.database.connection.prepare("SELECT skill_id, display_name, runtime_name, original_description, translated_description, user_note, tags, author, license, requirements, markdown FROM skills_fts ORDER BY skill_id ASC").map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(error)?;
        let docs: Vec<_> = rows.map(|r| r.map_err(error)).collect::<AppResult<_>>()?;
        let mut result = Vec::new();
        for left in 0..docs.len() {
            for right in left + 1..docs.len() {
                let matched = matching_doc_fields(&docs[left], &docs[right]);
                if matched.is_empty() {
                    continue;
                }
                let score = ((matched.len() as u32) * 10_000) / 10;
                let meaningful = matched
                    .iter()
                    .filter(|field| {
                        matches!(
                            field,
                            SearchField::DisplayName
                                | SearchField::RuntimeName
                                | SearchField::OriginalDescription
                                | SearchField::TranslatedDescription
                                | SearchField::UserNote
                                | SearchField::Tags
                                | SearchField::Markdown
                        )
                    })
                    .count();
                if score >= 2_000 && (matched.contains(&SearchField::Markdown) || meaningful >= 2) {
                    result.push(DuplicateCandidate {
                        left_skill_id: docs[left].0.parse().map_err(|_| bad_id())?,
                        right_skill_id: docs[right].0.parse().map_err(|_| bad_id())?,
                        similarity_basis_points: score,
                        matched_fields: matched,
                    });
                }
            }
        }
        result.sort_by_key(|candidate| {
            (
                candidate.left_skill_id.to_string(),
                candidate.right_skill_id.to_string(),
            )
        });
        Ok(result)
    }

    fn matching_fields(&self, skill_id: &str, query: &str) -> AppResult<Vec<SearchField>> {
        let mut result = Vec::new();
        for (index, field) in FIELD_NAMES.iter().enumerate() {
            let sql = format!(
                "SELECT EXISTS(SELECT 1 FROM skills_fts WHERE skill_id=?1 AND {field} LIKE ?2)"
            );
            let matched: bool = self
                .database
                .connection
                .query_row(&sql, params![skill_id, format!("%{}%", query)], |row| {
                    row.get(0)
                })
                .map_err(error)?;
            if matched {
                result.push(field_code(index));
            }
        }
        Ok(result)
    }
}

fn matching_doc_fields(
    left: &(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ),
    right: &(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ),
) -> Vec<SearchField> {
    let mut matched = Vec::new();
    for (index, (a, b)) in [
        (&left.1, &right.1),
        (&left.2, &right.2),
        (&left.3, &right.3),
        (&left.4, &right.4),
        (&left.5, &right.5),
        (&left.6, &right.6),
        (&left.7, &right.7),
        (&left.8, &right.8),
        (&left.9, &right.9),
        (&left.10, &right.10),
    ]
    .iter()
    .enumerate()
    {
        if !a.is_empty() && a == b {
            matched.push(field_code(index));
        }
    }
    matched
}

fn field_code(index: usize) -> SearchField {
    [
        SearchField::DisplayName,
        SearchField::RuntimeName,
        SearchField::OriginalDescription,
        SearchField::TranslatedDescription,
        SearchField::UserNote,
        SearchField::Tags,
        SearchField::Author,
        SearchField::License,
        SearchField::Requirements,
        SearchField::Markdown,
    ][index]
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            let code = character as u32;
            if (0xFF01..=0xFF5E).contains(&code) {
                char::from_u32(code - 0xFEE0)
                    .into_iter()
                    .collect::<Vec<_>>()
            } else if code == 0x3000 {
                vec![' ']
            } else {
                character.to_lowercase().collect()
            }
        })
        .collect()
}

fn fts_query(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| format!("\"{}\"", token.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn bad_id() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
}
fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}

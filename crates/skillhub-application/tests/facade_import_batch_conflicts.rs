//! W2-2（FB-007 第一期）：批内冲突分析与独立导入的验收回归。
//!
//! 覆盖：
//! ① 同内容同来源 → 合并建议（保留候选键字典序最小者、其余建议跳过）；
//! ② 同名不同内容未显式处置（既不跳过也未独立导入）→ 提交拒绝；
//! ③ 同名不同内容选择独立导入 → 两候选保留原名，以不同 SkillId 入库；
//! ⑤ 提交期批内组成与决策时不一致（新增候选 / 签名不符）→ 拒绝并要求
//!    重新分析；
//! ⑥ 纯函数边界（空批/单候选/同内容异源/签名）由 core
//!    `import::conflict::batch_tests` 覆盖；这里补批分析入口的空批边界。
//! ⑦ 来源文件保持不变；库内同名 Skill 以独立身份保存。
//!
//! 全部通过公开 Facade（AnalyzeImportBatch/PrepareImport/CommitImport）
//! 驱动，无手工 SQL；内容指纹由真实文件树计算。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode,
    ImportCandidate, ImportDecision, PrepareImport, SourceDescriptor, SourceKind, SourceLocator,
};
use skillhub_storage::{CentralLibrary, Database};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

fn facade_with(workspace: &std::path::Path) -> LocalApplicationFacade {
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("initialize library");
    LocalApplicationFacade::new_with_library(database, &library_root)
}

fn write_skill(root: &std::path::Path, body: &str) {
    std::fs::create_dir_all(root).expect("create skill dir");
    std::fs::write(root.join("SKILL.md"), body).expect("write SKILL.md");
}

/// 同一批次来源下的候选：relative_root 即目录名，与发现产物一致。
fn candidate_for(workspace: &std::path::Path, dir: &str, runtime_name: &str) -> ImportCandidate {
    ImportCandidate::detected(
        SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path(workspace.to_path_buf()),
        ),
        workspace.join(dir).to_string_lossy(),
        dir,
        "SKILL.md",
        runtime_name,
    )
}

/// 与应用层 `candidate_key_for` 同一公式（acquisition identity 哈希 +
/// 规范化 relative root），保证测试拿到的键与应用层完全一致。
fn expected_candidate_key(candidate: &ImportCandidate) -> String {
    let identity = serde_json::to_string(&candidate.source).unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    identity.hash(&mut hasher);
    format!(
        "{:016x}|{}",
        hasher.finish(),
        skillhub_core::deployment::observed_path_key(&candidate.relative_root)
    )
}

async fn analyze_batch(
    facade: &LocalApplicationFacade,
    batch_id: Option<&str>,
    candidates: Vec<ImportCandidate>,
) -> skillhub_core::ImportBatchConflictAnalysis {
    let result = facade
        .query(AppQuery::AnalyzeImportBatch(
            skillhub_core::AnalyzeImportBatch {
                batch_id: batch_id.map(str::to_owned),
                candidates,
            },
        ))
        .await
        .expect("analyze import batch");
    let AppQueryResult::ImportBatchAnalysis(analysis) = result else {
        panic!("expected import batch analysis");
    };
    analysis
}

async fn prepare(
    facade: &LocalApplicationFacade,
    candidate: ImportCandidate,
) -> Box<skillhub_core::PreparedImport> {
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    prepared
}

/// 全参数提交：返回 Err 时透传错误供调用方断言错误码。
async fn commit_full(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::PreparedImport,
    decision: ImportDecision,
    batch_id: Option<&str>,
    candidate_key: Option<&str>,
    batch_signature: Option<&str>,
) -> Result<Box<skillhub_core::ImportSummary>, skillhub_core::AppError> {
    let committed = facade
        .execute(AppCommand::CommitImport(skillhub_core::CommitImport {
            prepared_import_id: prepared.id,
            decision,
            governance_decision: skillhub_core::ImportGovernanceDecision {
                group_actions: prepared
                    .analysis
                    .governance_groups
                    .iter()
                    .map(|group| (group.group_id.clone(), group.default_action))
                    .collect(),
                item_overrides: Default::default(),
            },
            batch_id: batch_id.map(str::to_owned),
            candidate_key: candidate_key.map(str::to_owned),
            batch_signature: batch_signature.map(str::to_owned),
            security_decision: None,
        }))
        .await;
    match committed {
        Ok(AppCommandResult::ImportSummary(summary)) => Ok(summary),
        Ok(other) => panic!("expected import summary, got {other:?}"),
        Err(error) => Err(error),
    }
}

async fn listed_runtime_names(facade: &LocalApplicationFacade) -> Vec<String> {
    let result = facade
        .query(AppQuery::ListSkills(skillhub_core::api::ListSkills {
            text: String::new(),
            page: 1,
            page_size: 50,
            filters: Default::default(),
            sort: Default::default(),
        }))
        .await
        .expect("list skills");
    let AppQueryResult::SkillPage(page) = result else {
        panic!("expected skill page");
    };
    page.items
        .into_iter()
        .map(|item| item.runtime_name)
        .collect()
}

async fn current_markdown_and_versions(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> (String, Vec<skillhub_core::api::VersionResult>) {
    let detail = facade
        .query(AppQuery::GetSkill(skillhub_core::api::GetSkill {
            skill_id,
        }))
        .await
        .expect("get imported skill");
    let AppQueryResult::Skill(detail) = detail else {
        panic!("expected skill detail");
    };
    let current_version = detail.current_version.expect("imported current version");

    let markdown = facade
        .query(AppQuery::ReadMarkdownFile(
            skillhub_core::api::ReadMarkdownFile {
                skill_id,
                path: "SKILL.md".into(),
                version_id: Some(current_version.clone()),
            },
        ))
        .await
        .expect("read imported version content");
    let AppQueryResult::MarkdownFile(markdown) = markdown else {
        panic!("expected markdown file content");
    };

    let versions = facade
        .query(AppQuery::ListVersions(skillhub_core::api::ListVersions {
            skill_id,
        }))
        .await
        .expect("list imported skill versions");
    let AppQueryResult::Versions(versions) = versions else {
        panic!("expected versions");
    };

    (markdown.markdown, versions)
}

/// ① 同内容同来源：建议保留候选键字典序最小者，其余建议跳过；
/// 不同内容/同内容不同来源不进该组。
#[tokio::test]
async fn same_content_same_source_suggests_merge_with_deterministic_keep() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    write_skill(&workspace.path().join("dup_a"), "# Same\n");
    write_skill(&workspace.path().join("dup_b"), "# Same\n");
    write_skill(&workspace.path().join("beta"), "# Other\n");

    let candidates = vec![
        candidate_for(workspace.path(), "dup_b", "Alpha"),
        candidate_for(workspace.path(), "dup_a", "Alpha"),
        candidate_for(workspace.path(), "beta", "Beta"),
    ];
    let key_a = expected_candidate_key(&candidates[1]);
    let key_b = expected_candidate_key(&candidates[0]);
    let analysis = analyze_batch(&facade, Some("batch-merge"), candidates).await;

    assert!(
        analysis.same_name_groups.is_empty(),
        "identical content is not a same-name conflict: {:?}",
        analysis.same_name_groups
    );
    assert_eq!(analysis.same_content_groups.len(), 1);
    let group = &analysis.same_content_groups[0];
    let expected_keep = key_a.clone().min(key_b.clone());
    let expected_skip = key_a.max(key_b);
    assert_eq!(group.keep_candidate_key, expected_keep);
    assert_eq!(group.skip_candidate_keys, vec![expected_skip]);
    assert!(!analysis.signature.is_empty());
}

/// ② 同名不同内容：未显式处置（CopyIntoLibrary）→ 提交拒绝，
/// 错误码 import.same_name_disposition_required。
#[tokio::test]
async fn same_name_different_content_requires_explicit_disposition() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    write_skill(&workspace.path().join("one"), "# Alpha v1\n");
    write_skill(&workspace.path().join("two"), "# Alpha v2\n");

    let candidates = vec![
        candidate_for(workspace.path(), "one", "Alpha"),
        candidate_for(workspace.path(), "two", "Alpha"),
    ];
    let key_one = expected_candidate_key(&candidates[0]);
    let analysis = analyze_batch(&facade, Some("batch-samename"), candidates).await;
    assert!(analysis.same_content_groups.is_empty());
    assert_eq!(analysis.same_name_groups.len(), 1);
    let group = &analysis.same_name_groups[0];
    assert_eq!(group.normalized_runtime_name, "alpha");
    assert_eq!(group.candidate_keys.len(), 2);
    assert!(group.candidate_keys.contains(&key_one));

    let prepared = prepare(&facade, candidate_for(workspace.path(), "one", "Alpha")).await;
    let error = commit_full(
        &facade,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        Some("batch-samename"),
        Some(&key_one),
        Some(&analysis.signature),
    )
    .await
    .expect_err("un-dispositioned same-name commit must be rejected");
    assert_eq!(error.code, ErrorCode::ImportSameNameDispositionRequired);
}

/// 独立导入只需明确选择处置方式；同名候选保留原名并以不同 SkillId 入库。
#[tokio::test]
async fn independent_import_preserves_duplicate_runtime_names_and_skill_identity() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let source_one = "# Alpha v1\n";
    let source_two = "# Alpha v2\n";
    write_skill(&workspace.path().join("one"), source_one);
    write_skill(&workspace.path().join("two"), source_two);

    let candidates = vec![
        candidate_for(workspace.path(), "one", "Alpha"),
        candidate_for(workspace.path(), "two", "Alpha"),
    ];
    let key_one = expected_candidate_key(&candidates[0]);
    let key_two = expected_candidate_key(&candidates[1]);
    let analysis =
        analyze_batch(&facade, Some("batch-independent-original-name"), candidates).await;
    assert_eq!(analysis.same_name_groups.len(), 1);

    let prepared_one = prepare(&facade, candidate_for(workspace.path(), "one", "Alpha")).await;
    let prepared_two = prepare(&facade, candidate_for(workspace.path(), "two", "Alpha")).await;
    let summary_one = commit_full(
        &facade,
        &prepared_one,
        ImportDecision::KeepIndependent,
        Some("batch-independent-original-name"),
        Some(&key_one),
        Some(&analysis.signature),
    )
    .await
    .expect("first independent import retains its name");
    let summary_two = commit_full(
        &facade,
        &prepared_two,
        ImportDecision::KeepIndependent,
        Some("batch-independent-original-name"),
        Some(&key_two),
        Some(&analysis.signature),
    )
    .await
    .expect("second independent import retains its name");

    let skill_one = summary_one.items[0].skill_id.expect("first skill id");
    let skill_two = summary_two.items[0].skill_id.expect("second skill id");
    assert_ne!(skill_one, skill_two);

    let (content_one, versions_one) = current_markdown_and_versions(&facade, skill_one).await;
    let (content_two, versions_two) = current_markdown_and_versions(&facade, skill_two).await;
    assert_eq!(content_one, source_one);
    assert_eq!(content_two, source_two);
    assert_eq!(versions_one.len(), 1);
    assert_eq!(versions_two.len(), 1);
    assert!(versions_one[0].current);
    assert!(versions_two[0].current);
    assert_ne!(versions_one[0].version_id, versions_two[0].version_id);

    let repeated_commit = commit_full(
        &facade,
        &prepared_one,
        ImportDecision::KeepIndependent,
        Some("batch-independent-original-name"),
        Some(&key_one),
        Some(&analysis.signature),
    )
    .await
    .expect_err("a completed prepare operation cannot be submitted twice");
    assert_eq!(repeated_commit.code, ErrorCode::ObjectNotFound);

    let mut names = listed_runtime_names(&facade).await;
    names.sort();
    assert_eq!(names, vec!["Alpha".to_owned(), "Alpha".to_owned()]);
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("one/SKILL.md")).unwrap(),
        source_one
    );
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("two/SKILL.md")).unwrap(),
        source_two
    );
}

/// ⑤ 提交期批内组成与决策时不一致：未分析的候选提交（新增）或回传签名
/// 与暂存分析不符（过期分析）→ 拒绝 import.batch_composition_changed；
/// 重新分析后同一批次即可继续提交。
#[tokio::test]
async fn commit_rejects_batch_composition_change() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    write_skill(&workspace.path().join("one"), "# Alpha v1\n");
    write_skill(&workspace.path().join("two"), "# Beta v1\n");

    let only_alpha = vec![candidate_for(workspace.path(), "one", "Alpha")];
    let key_alpha = expected_candidate_key(&only_alpha[0]);
    let key_beta = expected_candidate_key(&candidate_for(workspace.path(), "two", "Beta"));
    let stale = analyze_batch(&facade, Some("batch-comp"), only_alpha).await;

    let prepared_alpha = prepare(&facade, candidate_for(workspace.path(), "one", "Alpha")).await;
    let prepared_beta = prepare(&facade, candidate_for(workspace.path(), "two", "Beta")).await;

    // 新增候选：Beta 不在已分析组成里 → 拒绝。
    let error = commit_full(
        &facade,
        &prepared_beta,
        ImportDecision::CopyIntoLibrary,
        Some("batch-comp"),
        Some(&key_beta),
        Some(&stale.signature),
    )
    .await
    .expect_err("unanalyzed candidate must be rejected");
    assert_eq!(error.code, ErrorCode::ImportBatchCompositionChanged);

    // 过期签名：决策依据与暂存分析不符 → 拒绝。
    let error = commit_full(
        &facade,
        &prepared_alpha,
        ImportDecision::CopyIntoLibrary,
        Some("batch-comp"),
        Some(&key_alpha),
        Some("deadbeef"),
    )
    .await
    .expect_err("stale signature must be rejected");
    assert_eq!(error.code, ErrorCode::ImportBatchCompositionChanged);

    // 重新分析全批后，同一批次继续提交成功。
    let fresh = analyze_batch(
        &facade,
        Some("batch-comp"),
        vec![
            candidate_for(workspace.path(), "one", "Alpha"),
            candidate_for(workspace.path(), "two", "Beta"),
        ],
    )
    .await;
    // 两次被拒绝的提交已经结算其准备记录；采用新组成重试时重新准备候选。
    let prepared_alpha = prepare(&facade, candidate_for(workspace.path(), "one", "Alpha")).await;
    let prepared_beta = prepare(&facade, candidate_for(workspace.path(), "two", "Beta")).await;
    commit_full(
        &facade,
        &prepared_alpha,
        ImportDecision::CopyIntoLibrary,
        Some("batch-comp"),
        Some(&key_alpha),
        Some(&fresh.signature),
    )
    .await
    .expect("alpha commits after re-analysis");
    commit_full(
        &facade,
        &prepared_beta,
        ImportDecision::CopyIntoLibrary,
        Some("batch-comp"),
        Some(&key_beta),
        Some(&fresh.signature),
    )
    .await
    .expect("beta commits after re-analysis");

    let mut names = listed_runtime_names(&facade).await;
    names.sort();
    assert_eq!(names, vec!["Alpha".to_owned(), "Beta".to_owned()]);
}

/// ⑥（入口边界）空批分析：不产组，签名仍确定可用。
#[tokio::test]
async fn empty_batch_analysis_yields_empty_groups() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    let analysis = analyze_batch(&facade, Some("batch-empty"), Vec::new()).await;
    assert!(analysis.same_content_groups.is_empty());
    assert!(analysis.same_name_groups.is_empty());
    assert!(!analysis.signature.is_empty());
}

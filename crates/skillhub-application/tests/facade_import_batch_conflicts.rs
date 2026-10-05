//! W2-2（FB-007 第一期）：批内冲突分析与独立命名的验收回归。
//!
//! 覆盖：
//! ① 同内容同来源 → 合并建议（保留候选键字典序最小者、其余建议跳过）；
//! ② 同名不同内容未显式处置（既不跳过也未独立命名）→ 提交拒绝；
//! ③ 独立导入＋互不冲突的覆盖名 → 两候选都成功入库且覆盖名生效；
//! ④ 覆盖名与库内 runtime 名冲突（含大小写/空白形态）→ 提交拒绝；
//! ⑤ 提交期批内组成与决策时不一致（新增候选 / 签名不符）→ 拒绝并要求
//!    重新分析；
//! ⑥ 纯函数边界（空批/单候选/同内容异源/签名）由 core
//!    `import::conflict::batch_tests` 覆盖；这里补批分析入口的空批边界。
//! ⑦ 覆盖名必须与 prepare 一致；Skip 携带覆盖名无效。
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

async fn prepare_with_override(
    facade: &LocalApplicationFacade,
    candidate: ImportCandidate,
    runtime_name_override: Option<&str>,
) -> Box<skillhub_core::PreparedImport> {
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
            runtime_name_override: runtime_name_override.map(str::to_owned),
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    prepared
}

/// 全参数提交：返回 Err 时透传错误供调用方断言错误码。
#[allow(clippy::too_many_arguments)]
async fn commit_full(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::PreparedImport,
    decision: ImportDecision,
    batch_id: Option<&str>,
    candidate_key: Option<&str>,
    runtime_name_override: Option<&str>,
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
            runtime_name_override: runtime_name_override.map(str::to_owned),
            batch_signature: batch_signature.map(str::to_owned),
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

/// ② 同名不同内容：未显式处置（CopyIntoLibrary 且无覆盖名）→ 提交拒绝，
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

    let prepared = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "one", "Alpha"),
        None,
    )
    .await;
    let error = commit_full(
        &facade,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        Some("batch-samename"),
        Some(&key_one),
        None,
        Some(&analysis.signature),
    )
    .await
    .expect_err("un-dispositioned same-name commit must be rejected");
    assert_eq!(error.code, ErrorCode::ImportSameNameDispositionRequired);
}

/// ③ 同名不同内容：各自独立命名（携带互不冲突的覆盖名，导入决策仍走
/// CopyIntoLibrary）→ 两个候选都成功入库，且库内 runtime 名就是覆盖名。
#[tokio::test]
async fn independent_dispositions_with_distinct_overrides_import_both() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    write_skill(&workspace.path().join("one"), "# Alpha v1\n");
    write_skill(&workspace.path().join("two"), "# Alpha v2\n");

    let candidates = vec![
        candidate_for(workspace.path(), "one", "Alpha"),
        candidate_for(workspace.path(), "two", "Alpha"),
    ];
    let key_one = expected_candidate_key(&candidates[0]);
    let key_two = expected_candidate_key(&candidates[1]);
    let analysis = analyze_batch(&facade, Some("batch-independent"), candidates).await;
    assert_eq!(analysis.same_name_groups.len(), 1);

    // 两个准备都在任何提交之前完成：prepare 的库内分析是"准备时刻"的
    // 事实，先到先得，不随后续提交滚动。
    let prepared_one = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "one", "Alpha"),
        Some("Alpha One"),
    )
    .await;
    let prepared_two = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "two", "Alpha"),
        Some("Alpha Two"),
    )
    .await;
    let summary_one = commit_full(
        &facade,
        &prepared_one,
        ImportDecision::CopyIntoLibrary,
        Some("batch-independent"),
        Some(&key_one),
        Some("Alpha One"),
        Some(&analysis.signature),
    )
    .await
    .expect("first independent import");
    assert!(summary_one.items[0].skill_id.is_some());

    let summary_two = commit_full(
        &facade,
        &prepared_two,
        ImportDecision::CopyIntoLibrary,
        Some("batch-independent"),
        Some(&key_two),
        Some("Alpha Two"),
        Some(&analysis.signature),
    )
    .await
    .expect("second independent import");
    assert!(summary_two.items[0].skill_id.is_some());

    let mut names = listed_runtime_names(&facade).await;
    names.sort();
    assert_eq!(names, vec!["Alpha One".to_owned(), "Alpha Two".to_owned()]);
}

/// ④ 覆盖名与库内 runtime 名冲突（大小写/空白按规范化比较）→ 提交拒绝，
/// 错误码 import.runtime_name_conflict；库内容不受影响。
#[tokio::test]
async fn override_conflicting_with_library_runtime_name_is_rejected() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    write_skill(&workspace.path().join("notes"), "# Notes v1\n");
    write_skill(&workspace.path().join("diary"), "# Diary v1\n");

    let seeded = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "notes", "Notes"),
        None,
    )
    .await;
    commit_full(
        &facade,
        &seeded,
        ImportDecision::CopyIntoLibrary,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("seed library skill");

    let prepared = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "diary", "Diary"),
        Some(" notes "),
    )
    .await;
    let error = commit_full(
        &facade,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        Some("batch-implicit-no-analysis"),
        None,
        Some(" notes "),
        None,
    )
    .await
    .expect_err("override colliding with library runtime name must be rejected");
    assert_eq!(error.code, ErrorCode::ImportRuntimeNameConflict);

    let names = listed_runtime_names(&facade).await;
    assert_eq!(names, vec!["Notes".to_owned()]);
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

    let prepared_alpha = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "one", "Alpha"),
        None,
    )
    .await;
    let prepared_beta = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "two", "Beta"),
        None,
    )
    .await;

    // 新增候选：Beta 不在已分析组成里 → 拒绝。
    let error = commit_full(
        &facade,
        &prepared_beta,
        ImportDecision::CopyIntoLibrary,
        Some("batch-comp"),
        Some(&key_beta),
        None,
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
        None,
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
    commit_full(
        &facade,
        &prepared_alpha,
        ImportDecision::CopyIntoLibrary,
        Some("batch-comp"),
        Some(&key_alpha),
        None,
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
        None,
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

/// ⑦ 覆盖名契约：提交覆盖名必须与 prepare 一致（改口拒绝）；Skip 携带
/// 覆盖名拒绝；一致时按覆盖名落库。
#[tokio::test]
async fn override_must_match_prepare_and_skip_rejects_override() {
    let workspace = tempfile::tempdir().expect("workspace");
    let facade = facade_with(workspace.path());
    write_skill(&workspace.path().join("one"), "# Alpha v1\n");

    let prepared = prepare_with_override(
        &facade,
        candidate_for(workspace.path(), "one", "Alpha"),
        Some("One"),
    )
    .await;

    let error = commit_full(
        &facade,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        None,
        None,
        Some("Two"),
        None,
    )
    .await
    .expect_err("changed override must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let error = commit_full(
        &facade,
        &prepared,
        ImportDecision::Skip,
        None,
        None,
        Some("One"),
        None,
    )
    .await
    .expect_err("skip with override must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    commit_full(
        &facade,
        &prepared,
        ImportDecision::CopyIntoLibrary,
        None,
        None,
        Some("One"),
        None,
    )
    .await
    .expect("consistent override imports");
    assert_eq!(listed_runtime_names(&facade).await, vec!["One".to_owned()]);
}

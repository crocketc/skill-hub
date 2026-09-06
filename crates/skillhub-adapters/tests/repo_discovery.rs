use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;

use skillhub_adapters::source::{cleanup_stale_downloads, RepoDiscoveryProvider};
use skillhub_core::source::SkillRepo;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

fn repo(owner: &str, name: &str, branch: &str, enabled: bool) -> SkillRepo {
    SkillRepo {
        owner: owner.into(),
        name: name.into(),
        branch: branch.into(),
        enabled,
    }
}

fn skill_zip(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        for (name, body) in entries {
            if body.is_empty() {
                zip.add_directory(name, SimpleFileOptions::default())
                    .unwrap();
            } else {
                zip.start_file(name, SimpleFileOptions::default()).unwrap();
                zip.write_all(&body).unwrap();
            }
        }
        zip.finish().unwrap();
    }
    cursor.into_inner()
}

fn skill_entry(dir: &str, name: &str, description: &str) -> (String, Vec<u8>) {
    let path = if dir.is_empty() {
        "SKILL.md".to_string()
    } else {
        format!("{dir}/SKILL.md")
    };
    (
        path,
        format!("---\nname: {name}\ndescription: {description}\n---\nbody").into_bytes(),
    )
}

fn sample_repo_entries() -> Vec<(String, Vec<u8>)> {
    vec![
        skill_entry("pdf", "PDF", "Handle PDF files"),
        ("pdf/reference.md".into(), b"ref".to_vec()),
        skill_entry("tools/deploy", "Deploy", "Deploy tools"),
        ("notes/readme.txt".into(), b"not a skill".to_vec()),
    ]
}

/// 多请求 fixture 服务器：按路径前缀返回内容；路径未命中返回 404。
/// 请求处理在后台线程循环，直到 listener 被 drop。
fn routing_server(routes: Vec<(&'static str, u16, Vec<u8>)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let routes: Arc<Vec<(String, u16, Vec<u8>)>> = Arc::new(
        routes
            .into_iter()
            .map(|(p, s, b)| (p.to_string(), s, b))
            .collect(),
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let routes = routes.clone();
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let route = routes
                    .iter()
                    .find(|(candidate, _, _)| path.starts_with(candidate.as_str()));
                let (status, body) = match route {
                    Some((_, status, body)) => (*status, body.clone()),
                    None => (404, b"not found".to_vec()),
                };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(&body);
            });
        }
    });
    format!("http://{address}")
}

fn test_provider(base: &str) -> RepoDiscoveryProvider {
    RepoDiscoveryProvider::with_archive_base_for_tests(base)
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

#[test]
fn discovers_skills_from_zip_with_front_matter() {
    let zip = skill_zip(sample_repo_entries());
    let base = routing_server(vec![("/o/r/archive/refs/heads/main.zip", 200, zip)]);
    let provider = test_provider(&base);
    let report = block_on(provider.discover(vec![repo("o", "r", "main", true)]));

    assert!(
        report.failures.is_empty(),
        "failures: {:?}",
        report.failures
    );
    let mut names: Vec<&str> = report.skills.iter().map(|s| s.name.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["Deploy", "PDF"]);
    let pdf = report.skills.iter().find(|s| s.name == "PDF").unwrap();
    assert_eq!(pdf.key, "o/r:pdf");
    assert_eq!(pdf.description, "Handle PDF files");
    assert_eq!(
        pdf.readme_url.as_deref(),
        Some("https://github.com/o/r/blob/main/pdf/SKILL.md")
    );
    let deploy = report.skills.iter().find(|s| s.name == "Deploy").unwrap();
    assert_eq!(deploy.directory, "tools/deploy");
}

#[test]
fn root_level_skill_md_uses_repo_name_as_directory() {
    // 仓库根目录就是 skill：展平包装后 directory 用仓库名（规格 §6.4）
    let zip = skill_zip(vec![
        skill_entry("", "RootSkill", "root"),
        (
            "docs/notes.txt".into(),
            b"nested file of the root skill".to_vec(),
        ),
    ]);
    let base = routing_server(vec![("/o/r/archive/refs/heads/main.zip", 200, zip)]);
    let provider = test_provider(&base);
    let report = block_on(provider.discover(vec![repo("o", "r", "main", true)]));

    assert!(
        report.failures.is_empty(),
        "failures: {:?}",
        report.failures
    );
    assert_eq!(report.skills.len(), 1);
    assert_eq!(report.skills[0].directory, "r");
    assert_eq!(report.skills[0].name, "RootSkill");
}

#[test]
fn falls_back_from_main_to_master_and_reports_resolved_branch() {
    // 归档 "s/" 是 GitHub 包装目录，内含 skill 子目录 "sub"。
    let zip = skill_zip(vec![skill_entry("s/sub", "S", "d")]);
    let base = routing_server(vec![("/o/mas/archive/refs/heads/master.zip", 200, zip)]);
    let provider = test_provider(&base);
    let report = block_on(provider.discover(vec![repo("o", "mas", "main", true)]));

    assert!(
        report.failures.is_empty(),
        "failures: {:?}",
        report.failures
    );
    assert_eq!(report.skills.len(), 1);
    assert_eq!(report.skills[0].repo_branch, "master");
    assert_eq!(report.skills[0].directory, "sub");
    assert_eq!(
        report.skills[0].readme_url.as_deref(),
        Some("https://github.com/o/mas/blob/master/sub/SKILL.md")
    );
}

#[test]
fn single_repo_failure_is_reported_without_dropping_others() {
    let zip = skill_zip(vec![skill_entry("s", "S", "d")]);
    let base = routing_server(vec![("/good/r/archive/refs/heads/main.zip", 200, zip)]);
    let provider = test_provider(&base);
    let repos = vec![
        repo("good", "r", "main", true),
        repo("gone", "missing", "main", true),
    ];
    let report = block_on(provider.discover(repos));

    assert_eq!(report.skills.len(), 1);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].0, "gone");
    assert_eq!(report.failures[0].1, "missing");
    assert!(report.failures[0].2.contains("DOWNLOAD_FAILED"));
}

#[test]
fn invalid_repo_coordinates_fail_before_any_request_and_disabled_repos_are_skipped() {
    // 空路由：任何 HTTP 请求都会得到 404 → DOWNLOAD_FAILED。
    let base = routing_server(vec![]);
    let provider = test_provider(&base);
    let repos = vec![
        repo("o", "r", "main", false),
        repo("bad.owner", "r", "main", true),
    ];
    let report = block_on(provider.discover(repos));

    assert!(report.skills.is_empty());
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].0, "bad.owner");
    assert!(
        report.failures[0].2.contains("INVALID_REPO_REF"),
        "actual: {}",
        report.failures[0].2
    );
}

#[test]
fn download_skill_directory_copies_only_requested_dir() {
    let zip = skill_zip(sample_repo_entries());
    let base = routing_server(vec![("/o/r/archive/refs/heads/main.zip", 200, zip)]);
    let provider = test_provider(&base);
    let dest = tempfile::tempdir().unwrap();
    let path = block_on(provider.download_skill_directory(
        &repo("o", "r", "main", true),
        "pdf",
        dest.path(),
    ))
    .unwrap();
    assert!(path.is_absolute());
    assert!(path.join("SKILL.md").is_file(), "path: {}", path.display());
    assert_eq!(path.file_name().unwrap(), "pdf");
    assert!(!dest.path().join("tools").exists());
}

#[test]
fn download_skill_directory_rejects_traversal_and_missing_dirs() {
    let zip = skill_zip(sample_repo_entries());
    let base = routing_server(vec![("/o/r/archive/refs/heads/main.zip", 200, zip)]);
    let provider = test_provider(&base);
    let dest = tempfile::tempdir().unwrap();

    let error = block_on(provider.download_skill_directory(
        &repo("o", "r", "main", true),
        "../evil",
        dest.path(),
    ))
    .unwrap_err();
    assert!(error.to_string().contains("INVALID_SKILL_DIRECTORY"));

    let missing = block_on(provider.download_skill_directory(
        &repo("o", "r", "main", true),
        "no-such-dir",
        dest.path(),
    ))
    .unwrap_err();
    assert!(missing.to_string().contains("INVALID_SKILL_DIRECTORY"));
}

#[test]
fn cleanup_stale_downloads_removes_only_expired_entries() {
    // Windows 下目录 mtime 不能用 std 直接回改，因此过期项用文件验证，
    // 新鲜项用目录验证，覆盖同一判定条件的两个分支。
    let root = tempfile::tempdir().unwrap();
    let fresh_dir = root.path().join("fresh-dir");
    let stale_file = root.path().join("stale-file");
    std::fs::create_dir_all(&fresh_dir).unwrap();
    std::fs::write(&stale_file, b"old").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    set_mtime(Path::new(&stale_file), old);
    cleanup_stale_downloads(root.path(), std::time::Duration::from_secs(60));
    assert!(fresh_dir.exists());
    assert!(!stale_file.exists());
}

fn set_mtime(path: &Path, time: std::time::SystemTime) {
    let file = std::fs::File::options().write(true).open(path).unwrap();
    file.set_modified(time).unwrap();
}
#[test]
fn download_repo_skill_with_empty_directory_copies_the_repo_root() {
    // lock 文件条目常无 skill_path：整个仓库就是一个 Skill（cc-switch 语义）。
    let zip = skill_zip(vec![
        skill_entry("", "WholeRepo", "root skill"),
        ("docs/notes.txt".into(), b"nested".to_vec()),
    ]);
    let base = routing_server(vec![("/o/r/archive/refs/heads/main.zip", 200, zip)]);
    let provider = test_provider(&base);
    let dest = tempfile::tempdir().unwrap();
    let path =
        block_on(provider.download_skill_directory(&repo("o", "r", "main", true), "", dest.path()))
            .unwrap();
    // 空 directory = 仓库根整体：SKILL.md 与子目录都被复制
    assert!(path.join("SKILL.md").is_file(), "path: {}", path.display());
    assert!(path.join("docs").is_dir());
}

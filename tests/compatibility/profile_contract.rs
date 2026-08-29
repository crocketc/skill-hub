use skillhub_core::agent::{OperatingSystem, ProfileCatalog};

fn expand(template: &str, home: &str, project: &str) -> String {
    template
        .replace("{user_home}", home)
        .replace("{project_root}", project)
}

#[test]
fn every_builtin_client_has_bounded_windows_and_macos_profile_facts() {
    let catalog = ProfileCatalog::builtin();
    assert!(!catalog.profiles.is_empty());

    let mut upload_only_clients = 0;
    for profile in catalog.profiles {
        assert!(!profile.official_references.is_empty());
        for client in profile.clients {
            assert!(client
                .supported_os
                .iter()
                .any(|os| matches!(os, OperatingSystem::Windows)));
            assert!(client
                .supported_os
                .iter()
                .any(|os| matches!(os, OperatingSystem::Macos)));

            if client.path_candidates.is_empty() {
                upload_only_clients += 1;
                assert!(!client.deployment.copy);
                assert!(!client.deployment.symlink);
                assert!(!client.deployment.junction);
                continue;
            }

            for candidate in client.path_candidates {
                assert!(!candidate.path.contains(".."));
                assert!(!candidate.path.contains("**"));
                assert!(!candidate.marker.trim().is_empty());
                for (platform, home, project) in [
                    (
                        "windows",
                        r"C:\Users\skillhub-fixture",
                        r"C:\skillhub-project",
                    ),
                    ("macos", "/Users/skillhub-fixture", "/tmp/skillhub-project"),
                ] {
                    let expanded = expand(&candidate.path, home, project);
                    assert!(
                        !expanded.contains('{'),
                        "unexpanded placeholder for {platform}: {expanded}"
                    );
                    assert!(
                        expanded.starts_with(home) || expanded.starts_with(project),
                        "profile path escapes declared roots on {platform}: {expanded}"
                    );
                }
            }
        }
    }

    assert!(
        upload_only_clients > 0,
        "the catalog must preserve clients without writable local targets"
    );
}

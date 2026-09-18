use crate::VersionId;

/// Windows rejects `:` inside a path component, and every version id is
/// `sha256:<hex>`.  The deployment staging tree under
/// `.skillhub/deployment-trees/<skill_id>/` is private storage, so its
/// directory name may safely drop the algorithm prefix.  Deployed artifacts
/// keep using `runtime_name`, which the planner validates separately.
pub fn deployment_tree_dir_name(version_id: &VersionId) -> &str {
    version_id
        .as_str()
        .strip_prefix("sha256:")
        .unwrap_or(version_id.as_str())
}

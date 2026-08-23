use serde_json::to_vec;
use sha2::{Digest, Sha256};

use skillhub_core::{FileEntry, VersionId, VersionManifest};

pub fn digest_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

pub fn canonical_manifest(manifest: &VersionManifest) -> Vec<u8> {
    to_vec(manifest).expect("version manifest is serializable")
}

pub fn version_id(manifest: &VersionManifest) -> VersionId {
    VersionId::parse(&digest_bytes(&canonical_manifest(manifest))).expect("valid digest")
}

pub fn tree_hash(entries: &[FileEntry]) -> String {
    digest_bytes(&to_vec(entries).expect("file entries are serializable"))
}

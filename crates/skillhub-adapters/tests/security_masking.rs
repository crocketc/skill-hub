//! Deterministic evidence masking: lines the basic ruleset flag as plaintext
//! credentials lose their values before any text leaves the device.

use skillhub_adapters::security::{has_plaintext_credential, mask_credentials};

#[test]
fn flagged_lines_lose_their_values_but_keep_their_keys() {
    let evidence = "API_TOKEN=sk-live-abcdef123456\nclean line\n";
    let masked = mask_credentials(evidence);
    assert!(!masked.contains("sk-live-abcdef123456"));
    assert!(masked.contains("API_TOKEN"));
    assert!(masked.contains("[REDACTED]"));
    assert!(masked.contains("clean line"));
    assert!(!has_plaintext_credential(
        masked.lines().next().expect("first line")
    ));
}

#[test]
fn unflagged_lines_pass_through_unchanged() {
    let evidence = "use the client with a secret from the environment\n";
    assert_eq!(mask_credentials(evidence), evidence);
}

#[test]
fn private_key_blocks_and_connection_strings_are_masked() {
    let evidence = "-----BEGIN RSA PRIVATE KEY-----\npostgres://user:hunter22@db/x\n";
    let masked = mask_credentials(evidence);
    assert!(!masked.contains("hunter22"));
    assert!(!masked.contains("BEGIN"));
}

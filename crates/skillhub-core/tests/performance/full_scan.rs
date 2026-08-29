use super::generate_fixture::Fixture;
use std::time::Instant;

pub fn measure(fixture: &Fixture) -> u128 {
    let started = Instant::now();
    let bytes: usize = fixture
        .skills
        .iter()
        .map(|skill| skill.markdown.len())
        .sum();
    assert!(bytes > 0);
    started.elapsed().as_millis()
}

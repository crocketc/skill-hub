use super::generate_fixture::Fixture;
use std::time::Instant;

pub fn measure(fixture: &Fixture) -> u128 {
    let started = Instant::now();
    let matches = fixture
        .skills
        .iter()
        .filter(|skill| skill.markdown.contains("rust"))
        .count();
    assert!(matches > 0);
    started.elapsed().as_millis()
}

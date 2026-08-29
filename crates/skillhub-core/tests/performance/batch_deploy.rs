use super::generate_fixture::Fixture;
use std::time::Instant;

pub fn measure(fixture: &Fixture) -> u128 {
    let started = Instant::now();
    let deployed = fixture
        .skills
        .iter()
        .filter(|skill| skill.tags.iter().any(|tag| !tag.is_empty()))
        .count();
    assert_eq!(deployed, fixture.skills.len());
    started.elapsed().as_millis()
}

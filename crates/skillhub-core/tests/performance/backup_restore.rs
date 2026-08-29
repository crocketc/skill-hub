use super::generate_fixture::Fixture;
use std::time::Instant;

pub fn measure(fixture: &Fixture) -> u128 {
    let started = Instant::now();
    let payload = serde_json::to_vec(
        &fixture
            .skills
            .iter()
            .map(|skill| (&skill.name, &skill.tags))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let restored: Vec<(String, Vec<String>)> = serde_json::from_slice(&payload).unwrap();
    assert_eq!(restored.len(), fixture.skills.len());
    started.elapsed().as_millis()
}

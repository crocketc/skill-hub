use super::generate_fixture::Fixture;

pub fn cached_bootstrap(fixture: &Fixture) -> usize {
    fixture
        .skills
        .iter()
        .filter(|skill| !skill.name.is_empty())
        .count()
}

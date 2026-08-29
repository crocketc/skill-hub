#[derive(Clone)]
pub struct FixtureSkill {
    pub name: String,
    pub markdown: String,
    pub tags: Vec<String>,
}

pub struct Fixture {
    pub seed: u64,
    pub skills: Vec<FixtureSkill>,
}

pub fn generate(count: usize) -> Fixture {
    let seed = 0x534b494c4c485542;
    let skills = (0..count)
        .map(|index| {
            let size = match index % 3 { 0 => 256, 1 => 1024, _ => 4096 };
            let body = format!("# Skill {index}\n\n```rust\nfn run_{index}() {{}}\n```\n\n| name | value |\n| --- | --- |\n| seed | {seed} |\n");
            FixtureSkill {
                name: format!("skill-{index:03}"),
                markdown: format!("{body}{:0width$}", "", width = size),
                tags: vec![if index % 2 == 0 { "code" } else { "media" }.into()],
            }
        })
        .collect();
    Fixture { seed, skills }
}

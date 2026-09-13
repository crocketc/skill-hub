#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    skillhub_desktop::run().expect("failed to start SkillHub desktop");
}

#[cfg(test)]
mod tests {
    const WINDOWS_SUBSYSTEM_ATTR: &str =
        "#![cfg_attr(not(debug_assertions), windows_subsystem = \"windows\")]";

    /// 只检查测试模块之前的生产代码：本测试模块源码包含期望字面量，
    /// 不做切分会让 contains 断言自匹配而失效。
    fn production_source() -> &'static str {
        let src = include_str!("main.rs");
        src.split("#[cfg(test)]").next().unwrap_or(src)
    }

    #[test]
    fn release_build_declares_windows_subsystem() {
        assert!(
            production_source().contains(WINDOWS_SUBSYSTEM_ATTR),
            "main.rs must declare the windows_subsystem cfg_attr so the Windows release exe does not allocate a console"
        );
    }

    #[test]
    fn windows_subsystem_attr_is_first_non_empty_line() {
        let src = include_str!("main.rs");
        let src = src.strip_prefix('\u{feff}').unwrap_or(src);
        let first_non_empty = src
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .expect("main.rs must not be empty");
        assert_eq!(
            first_non_empty, WINDOWS_SUBSYSTEM_ATTR,
            "windows_subsystem is an inner attribute and must be the first non-empty line of main.rs"
        );
    }
}

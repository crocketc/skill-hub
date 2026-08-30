use std::fmt;
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackupAction {
    Verify,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CliCommand {
    List,
    Search,
    Scan,
    Import,
    Deploy,
    Undeploy,
    Align,
    Update,
    Check,
    Health,
    Pending,
    Backup,
    Restore,
    ProjectAssemble,
    Status,
}

impl CliCommand {
    pub fn name(&self) -> &'static str {
        match self {
            Self::List => "list",
            Self::Search => "search",
            Self::Scan => "scan",
            Self::Import => "import",
            Self::Deploy => "deploy",
            Self::Undeploy => "undeploy",
            Self::Align => "align",
            Self::Update => "update",
            Self::Check => "check",
            Self::Health => "health",
            Self::Pending => "pending",
            Self::Backup => "backup",
            Self::Restore => "restore",
            Self::ProjectAssemble => "project-assemble",
            Self::Status => "status",
        }
    }
}

impl fmt::Display for CliCommand {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliArgs {
    pub command: CliCommand,
    pub backup_action: Option<BackupAction>,
    pub json: bool,
    pub non_interactive: bool,
    pub yes: bool,
    pub authorize_high_risk: Option<String>,
    pub database: Option<PathBuf>,
    pub library: Option<PathBuf>,
    pub query: Option<String>,
    pub skill: Option<String>,
    pub version: Option<String>,
    pub path: Option<PathBuf>,
    pub page: u32,
    pub page_size: u32,
}

impl CliArgs {
    pub fn parse<I, S>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut args = args.into_iter().map(Into::into);
        let command = match args.next().as_deref() {
            Some("list") => CliCommand::List,
            Some("search") => CliCommand::Search,
            Some("scan") => CliCommand::Scan,
            Some("import") => CliCommand::Import,
            Some("deploy") => CliCommand::Deploy,
            Some("undeploy") => CliCommand::Undeploy,
            Some("align") => CliCommand::Align,
            Some("update") => CliCommand::Update,
            Some("check") => CliCommand::Check,
            Some("health") => CliCommand::Health,
            Some("pending") => CliCommand::Pending,
            Some("backup") => CliCommand::Backup,
            Some("restore") => CliCommand::Restore,
            Some("project-assemble") => CliCommand::ProjectAssemble,
            Some("status") => CliCommand::Status,
            Some("--help") | None => return Err(Self::help()),
            Some(other) => return Err(format!("unknown command `{other}`\n\n{}", Self::help())),
        };
        let mut result = Self {
            command,
            backup_action: None,
            json: false,
            non_interactive: false,
            yes: false,
            authorize_high_risk: None,
            database: None,
            library: None,
            query: None,
            skill: None,
            version: None,
            path: None,
            page: 1,
            page_size: 100,
        };
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--json" => result.json = true,
                "--non-interactive" => result.non_interactive = true,
                "--yes" => result.yes = true,
                "--authorize-high-risk" => {
                    result.authorize_high_risk =
                        Some(next_value(&mut args, "--authorize-high-risk")?)
                }
                "--database" => {
                    result.database = Some(PathBuf::from(next_value(&mut args, "--database")?))
                }
                "--library" => {
                    result.library = Some(PathBuf::from(next_value(&mut args, "--library")?))
                }
                "--query" => result.query = Some(next_value(&mut args, "--query")?),
                "--skill" => result.skill = Some(next_value(&mut args, "--skill")?),
                "--version" => result.version = Some(next_value(&mut args, "--version")?),
                "--path" => result.path = Some(PathBuf::from(next_value(&mut args, "--path")?)),
                "--page" => {
                    result.page = parse_positive_u32(&next_value(&mut args, "--page")?, "--page")?
                }
                "--page-size" => {
                    result.page_size =
                        parse_positive_u32(&next_value(&mut args, "--page-size")?, "--page-size")?
                }
                "--help" => return Err(Self::help()),
                value if value.starts_with('-') => return Err(format!("unknown option `{value}`")),
                "verify" if result.command == CliCommand::Backup => {
                    result.backup_action = Some(BackupAction::Verify)
                }
                value if result.command == CliCommand::Search && result.query.is_none() => {
                    result.query = Some(value.to_owned())
                }
                value => return Err(format!("unexpected argument `{value}`")),
            }
        }
        if result.non_interactive && !result.yes {
            return Err("non-interactive commands require --yes".into());
        }
        if result.non_interactive
            && matches!(result.command, CliCommand::Undeploy)
            && result.authorize_high_risk.is_none()
        {
            return Err("high-risk command requires --authorize-high-risk <fingerprint>".into());
        }
        if result.command == CliCommand::Backup && result.backup_action.is_none() {
            return Err("backup requires the `verify` action".into());
        }
        Ok(result)
    }

    pub fn help() -> String {
        "Usage: skillhub <command> [options]\n\nCommands: list search scan import deploy undeploy align update check health pending backup verify restore project-assemble status\n\nOptions: --json --yes --non-interactive --authorize-high-risk <fingerprint> --database <path> --library <path> --query <text> --skill <id> --version <id> --path <path> --page <n> --page-size <n>".into()
    }
}

fn next_value<I>(args: &mut I, option: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    args.next()
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| format!("option `{option}` requires a value"))
}

fn parse_positive_u32(value: &str, option: &str) -> Result<u32, String> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| format!("option `{option}` requires a positive integer"))?;
    if parsed == 0 {
        return Err(format!("option `{option}` requires a positive integer"));
    }
    Ok(parsed)
}

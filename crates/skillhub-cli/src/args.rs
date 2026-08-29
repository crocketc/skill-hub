use std::fmt;

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
    pub json: bool,
    pub non_interactive: bool,
    pub yes: bool,
    pub authorize_high_risk: Option<String>,
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
            json: false,
            non_interactive: false,
            yes: false,
            authorize_high_risk: None,
        };
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--json" => result.json = true,
                "--non-interactive" => result.non_interactive = true,
                "--yes" => result.yes = true,
                "--authorize-high-risk" => result.authorize_high_risk = args.next(),
                "--help" => return Err(Self::help()),
                value if value.starts_with('-') => return Err(format!("unknown option `{value}`")),
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
        Ok(result)
    }

    pub fn help() -> String {
        "Usage: skillhub <command> [options]\n\nCommands: list search scan import deploy undeploy align update check health pending backup restore project-assemble status\n\nOptions: --json --yes --non-interactive --authorize-high-risk <fingerprint>".into()
    }
}

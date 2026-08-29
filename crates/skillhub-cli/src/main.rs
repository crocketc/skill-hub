use skillhub_cli::args::CliArgs;
use skillhub_cli::commands::{CommandFacade, UnconfiguredFacade};

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().is_some_and(|argument| argument == "--help") {
        println!("{}", CliArgs::help());
        return;
    }
    let parsed = CliArgs::parse(raw);
    let args = match parsed {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let envelope = UnconfiguredFacade.execute(&args.command);
    if args.json {
        println!(
            "{}",
            serde_json::to_string(&envelope).expect("JSON envelope is serializable")
        );
    } else {
        println!("{}: {}", envelope.command, envelope.result_code);
    }
}

#[cfg(test)]
mod tests {
    use skillhub_cli::args::{CliArgs, CliCommand};

    #[test]
    fn supported_commands_are_explicit_and_arbitrary_exec_is_not_available() {
        assert_eq!(
            CliArgs::parse(["status", "--json"]).unwrap().command,
            CliCommand::Status
        );
        assert!(CliArgs::parse(["exec", "whoami"]).is_err());
    }

    #[test]
    fn non_interactive_high_risk_command_requires_authorization() {
        let error = CliArgs::parse(["undeploy", "--non-interactive", "--yes"]).unwrap_err();
        assert!(error.contains("--authorize-high-risk"));
    }
}

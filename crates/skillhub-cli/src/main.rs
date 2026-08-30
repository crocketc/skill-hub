use skillhub_cli::args::CliArgs;
use skillhub_cli::commands::{self, CommandFacade, UnconfiguredFacade};
use skillhub_cli::output::JsonEnvelope;
use skillhub_cli::runtime;

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
    if !commands::is_safe(&args.command) {
        emit(&args, UnconfiguredFacade.execute(&args.command));
        std::process::exit(1);
    }
    let tokio = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let runtime_error = runtime::CliRuntimeError {
                code: "cli.runtime_unavailable".into(),
                detail: error.to_string(),
                params: Default::default(),
                actions: vec!["retry".into()],
            };
            emit_error(&args, &runtime_error);
            std::process::exit(1);
        }
    };
    let result = tokio.block_on(async {
        let facade = runtime::open(&args)?;
        commands::run(&args, &facade).await
    });
    match result {
        Ok(payload) => emit(&args, JsonEnvelope::success(args.command.name(), payload)),
        Err(error) => {
            emit_error(&args, &error);
            std::process::exit(1);
        }
    }
}

fn emit(args: &CliArgs, envelope: JsonEnvelope) {
    if args.json {
        match serde_json::to_string(&envelope) {
            Ok(text) => println!("{text}"),
            Err(error) => {
                eprintln!("cli.output_error: {error}");
                std::process::exit(1);
            }
        }
    } else {
        println!("{}: {}", envelope.command, envelope.result_code);
        if !envelope.payload.is_null() && envelope.payload != serde_json::json!({}) {
            if let Ok(text) = serde_json::to_string_pretty(&envelope.payload) {
                println!("{text}");
            }
        }
    }
}

fn emit_error(args: &CliArgs, error: &runtime::CliRuntimeError) {
    let envelope = JsonEnvelope::error(args.command.name(), error);
    if args.json {
        emit(args, envelope);
    } else {
        eprintln!("{}: {}", error.code, error.detail);
        if !error.actions.is_empty() {
            eprintln!("actions: {}", error.actions.join(", "));
        }
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

use crate::args::CliCommand;
use crate::output::JsonEnvelope;

/// The CLI deliberately delegates business execution to the same facade used by the desktop app.
/// Until a concrete runtime facade is wired, commands return a stable structured status.
pub trait CommandFacade {
    fn execute(&self, command: &CliCommand) -> JsonEnvelope;
}

pub struct UnconfiguredFacade;

impl CommandFacade for UnconfiguredFacade {
    fn execute(&self, command: &CliCommand) -> JsonEnvelope {
        JsonEnvelope::pending(command.name())
    }
}

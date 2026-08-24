mod model;
mod shared_config;

pub use model::{Project, ProjectMetadata, ProjectRepository, ProjectTag, SavedProjectView};
pub use shared_config::{
    PortableSource, SharedProjectConfig, SharedSkillRequirement, SHARED_CONFIG_SCHEMA_VERSION,
};

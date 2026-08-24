mod detector;
mod ownership;

pub use detector::{SkillDetectionConfig, SkillDetector};
pub use ownership::{
    KnownAgentDirectory, KnownProjectDirectory, OwnershipClassifier, ReadOnlySkillDirectory,
};

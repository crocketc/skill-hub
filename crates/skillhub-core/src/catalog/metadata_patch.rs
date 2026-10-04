use serde::de::{Deserializer, Error as DeserializeError, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;
use std::marker::PhantomData;

/// A wire-level patch value: an omitted field is unchanged, `null` clears it,
/// and a concrete value replaces it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PatchField<T> {
    Unchanged,
    Clear,
    Set(T),
}

impl<T> Default for PatchField<T> {
    fn default() -> Self {
        Self::Unchanged
    }
}

impl<T> PatchField<T> {
    pub fn is_unchanged(&self) -> bool {
        matches!(self, Self::Unchanged)
    }
}

impl<T: Serialize> Serialize for PatchField<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            // PatchField is intended as a struct field with
            // `skip_serializing_if = "PatchField::is_unchanged"`.
            Self::Unchanged | Self::Clear => serializer.serialize_none(),
            Self::Set(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for PatchField<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PatchFieldVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for PatchFieldVisitor<T> {
            type Value = PatchField<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("null or a concrete patch value")
            }

            fn visit_none<E: DeserializeError>(self) -> Result<Self::Value, E> {
                Ok(PatchField::Clear)
            }

            fn visit_unit<E: DeserializeError>(self) -> Result<Self::Value, E> {
                Ok(PatchField::Clear)
            }

            fn visit_some<D2: Deserializer<'de>>(
                self,
                deserializer: D2,
            ) -> Result<Self::Value, D2::Error> {
                T::deserialize(deserializer).map(PatchField::Set)
            }
        }

        deserializer.deserialize_option(PatchFieldVisitor(PhantomData))
    }
}

/// A partial edit of user-maintained metadata. The TypeScript override mirrors
/// the wire representation (`field?: T | null`) instead of exposing the Rust
/// PatchField enum as a tagged union.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct SkillMetadataPatch {
    #[serde(default)]
    #[specta(type = Option<String>, optional)]
    pub display_name: PatchField<String>,
    #[serde(default)]
    #[specta(type = Option<String>, optional)]
    pub note: PatchField<String>,
    #[serde(default)]
    #[specta(type = Option<Vec<String>>, optional)]
    pub tags: PatchField<Vec<String>>,
    #[serde(default)]
    #[specta(type = Option<String>, optional)]
    pub author: PatchField<String>,
    #[serde(default)]
    #[specta(type = Option<String>, optional)]
    pub license: PatchField<String>,
    #[serde(default)]
    #[specta(type = Option<String>, optional)]
    pub user_purpose: PatchField<String>,
}

impl Serialize for SkillMetadataPatch {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = [
            self.display_name.is_unchanged(),
            self.note.is_unchanged(),
            self.tags.is_unchanged(),
            self.author.is_unchanged(),
            self.license.is_unchanged(),
            self.user_purpose.is_unchanged(),
        ]
        .into_iter()
        .filter(|unchanged| !unchanged)
        .count();
        let mut state = serializer.serialize_struct("SkillMetadataPatch", fields)?;
        if !self.display_name.is_unchanged() {
            state.serialize_field("display_name", &self.display_name)?;
        }
        if !self.note.is_unchanged() {
            state.serialize_field("note", &self.note)?;
        }
        if !self.tags.is_unchanged() {
            state.serialize_field("tags", &self.tags)?;
        }
        if !self.author.is_unchanged() {
            state.serialize_field("author", &self.author)?;
        }
        if !self.license.is_unchanged() {
            state.serialize_field("license", &self.license)?;
        }
        if !self.user_purpose.is_unchanged() {
            state.serialize_field("user_purpose", &self.user_purpose)?;
        }
        state.end()
    }
}

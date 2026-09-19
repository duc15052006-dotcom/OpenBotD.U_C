//! Persisted behavior for the main-window close button.
//!
//! This is deliberately native-only. After setup the WebView navigates to the local OpenBot app,
//! which has no Tauri IPC capability, so a close preference must not depend on renderer authority.
//! Missing, unreadable, or malformed state falls back to Ask: a corrupt preference must never turn
//! clicking X into an unexpected process exit or a hidden background transition.

use std::path::Path;

pub const FILE: &str = "close-behavior.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseBehavior {
    #[default]
    Ask,
    KeepRunning,
    Exit,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    behavior: CloseBehavior,
}

impl CloseBehavior {
    pub fn read(config_dir: &Path) -> Self {
        std::fs::read(config_dir.join(FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
            .filter(|record| record.version == 1)
            .map(|record| record.behavior)
            .unwrap_or_default()
    }

    pub fn write(self, config_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(config_dir)?;
        crate::env::write_private_file(
            &config_dir.join(FILE),
            &serde_json::to_vec(&Record {
                version: 1,
                behavior: self,
            })?,
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ask => "Ask every time",
            Self::KeepRunning => "Keep running in tray",
            Self::Exit => "Exit and stop all Agents",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "openbot-close-behavior-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn missing_malformed_and_unknown_settings_fail_safe_to_ask() {
        let root = root("invalid");
        assert_eq!(CloseBehavior::read(&root), CloseBehavior::Ask);
        for value in [
            "not-json",
            "{}",
            r#"{"version":2,"behavior":"exit"}"#,
            r#"{"version":1,"behavior":"surprise"}"#,
            r#"{"version":1,"behavior":"exit","extra":true}"#,
        ] {
            std::fs::write(root.join(FILE), value).unwrap();
            assert_eq!(CloseBehavior::read(&root), CloseBehavior::Ask);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn each_supported_behavior_round_trips() {
        let root = root("round-trip");
        for behavior in [
            CloseBehavior::Ask,
            CloseBehavior::KeepRunning,
            CloseBehavior::Exit,
        ] {
            behavior.write(&root).unwrap();
            assert_eq!(CloseBehavior::read(&root), behavior);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

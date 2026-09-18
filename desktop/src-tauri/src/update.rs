use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_RELEASE_REPOSITORY: &str = "duc15052006-dotcom/OpenBotD.U_C";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_url: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

fn release_repository() -> Result<&'static str, String> {
    let repository =
        option_env!("OPENBOT_RELEASE_REPOSITORY").unwrap_or(DEFAULT_RELEASE_REPOSITORY);
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || parts.next().is_some()
        || !owner
            .chars()
            .chain(name.chars())
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("This build has an invalid release repository.".into());
    }
    Ok(repository)
}

fn numeric_version(value: &str) -> Result<(u64, u64, u64), String> {
    let value = value.strip_prefix('v').unwrap_or(value);
    let mut parts = value.split('.');
    let major = parts
        .next()
        .and_then(|one| one.parse::<u64>().ok())
        .ok_or_else(|| format!("Release version {value:?} is not major.minor.patch."))?;
    let minor = parts
        .next()
        .and_then(|one| one.parse::<u64>().ok())
        .ok_or_else(|| format!("Release version {value:?} is not major.minor.patch."))?;
    let patch = parts
        .next()
        .and_then(|one| one.parse::<u64>().ok())
        .ok_or_else(|| format!("Release version {value:?} is not major.minor.patch."))?;
    if parts.next().is_some() {
        return Err(format!(
            "Release version {value:?} is not major.minor.patch."
        ));
    }
    Ok((major, minor, patch))
}

fn from_release(
    current: &str,
    repository: &str,
    release: GitHubRelease,
) -> Result<UpdateInfo, String> {
    if release.draft || release.prerelease {
        return Err("GitHub returned a draft or pre-release as the latest stable release.".into());
    }

    let current_numeric = numeric_version(current)?;
    let latest_numeric = numeric_version(&release.tag_name)?;
    let latest_version = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name)
        .to_string();

    let parsed = reqwest::Url::parse(&release.html_url)
        .map_err(|_| "GitHub returned an invalid release address.".to_string())?;
    let expected_path = format!("/{repository}/releases/");
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || !parsed.path().starts_with(&expected_path)
    {
        return Err("GitHub returned a release address outside this repository.".into());
    }

    Ok(UpdateInfo {
        current_version: current.to_string(),
        latest_version,
        update_available: latest_numeric > current_numeric,
        release_url: parsed.to_string(),
    })
}

/// Ask GitHub for the latest stable release of the repository this desktop build belongs to.
///
/// No credential is sent. The response is accepted only when its release page stays on github.com
/// under that exact repository, so a compromised/misconfigured API response cannot turn the native
/// opener into an arbitrary URL launcher.
pub async fn check_latest_release() -> Result<UpdateInfo, String> {
    let repository = release_repository()?;
    let endpoint = format!("https://api.github.com/repos/{repository}/releases/latest");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Could not create the update checker: {error}"))?;

    let response = client
        .get(endpoint)
        .header(
            reqwest::header::USER_AGENT,
            format!("OpenBot-Desktop/{}", env!("CARGO_PKG_VERSION")),
        )
        .send()
        .await
        .map_err(|error| format!("Could not reach GitHub releases: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub releases answered with HTTP {}.",
            response.status()
        ));
    }

    let release = response
        .json::<GitHubRelease>()
        .await
        .map_err(|error| format!("GitHub returned an unreadable release: {error}"))?;

    from_release(env!("CARGO_PKG_VERSION"), repository, release)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, url: &str) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.into(),
            html_url: url.into(),
            draft: false,
            prerelease: false,
        }
    }

    #[test]
    fn newer_numeric_release_is_reported() {
        let info = from_release(
            "0.0.12",
            "owner/repo",
            release("v0.0.13", "https://github.com/owner/repo/releases/tag/v0.0.13"),
        )
        .unwrap();
        assert!(info.update_available);
        assert_eq!(info.latest_version, "0.0.13");
    }

    #[test]
    fn equal_or_older_release_is_not_an_update() {
        for tag in ["0.0.12", "v0.0.11"] {
            let info = from_release(
                "0.0.12",
                "owner/repo",
                release(tag, &format!("https://github.com/owner/repo/releases/tag/{tag}")),
            )
            .unwrap();
            assert!(!info.update_available);
        }
    }

    #[test]
    fn release_url_must_stay_on_the_configured_github_repository() {
        for url in [
            "https://example.com/owner/repo/releases/tag/v0.0.13",
            "https://github.com/other/repo/releases/tag/v0.0.13",
            "http://github.com/owner/repo/releases/tag/v0.0.13",
        ] {
            assert!(from_release("0.0.12", "owner/repo", release("0.0.13", url)).is_err());
        }
    }

    #[test]
    fn prereleases_and_non_numeric_tags_are_not_used_for_updates() {
        let mut preview = release(
            "v0.0.13",
            "https://github.com/owner/repo/releases/tag/v0.0.13",
        );
        preview.prerelease = true;
        assert!(from_release("0.0.12", "owner/repo", preview).is_err());
        assert!(from_release(
            "0.0.12",
            "owner/repo",
            release("next", "https://github.com/owner/repo/releases/tag/next"),
        )
        .is_err());
    }
}

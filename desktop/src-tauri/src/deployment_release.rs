//! Choose a release for a new deployment and retain an existing deployment's exact version.

use std::path::Path;

use serde::Deserialize;

use crate::deployment;

fn latest_release_url() -> Result<String, String> {
    let repository = crate::update::release_repository()?;
    Ok(format!(
        "https://api.github.com/repos/{repository}/releases/latest"
    ))
}

/// Only new deployments consult GitHub. The fetcher records the exact tag after the source and
/// image manifest have both downloaded successfully; restarts and repairs retain that pin.
/// Uses blocking HTTP, so callers in an async runtime must use a blocking task.
pub fn resolve_version(root: &Path) -> Result<String, String> {
    resolve_version_with(root, || {
        if let Some(version) = preview_version(
            option_env!("OPENBOT_DEPLOYMENT_TAG"),
            option_env!("OPENBOT_SOURCE_SHA"),
        )? {
            return Ok(version);
        }
        let latest = latest_release_url()?;
        let body = deployment::get(&latest)
            .map_err(|error| format!("could not find the latest OpenBot release: {error}"))?;
        release_tag(&body)
    })
}

/// Preview installers name one immutable source commit; stable builds still discover latest.
/// A runtime environment variable cannot redirect an installed desktop to arbitrary source.
fn preview_version(tag: Option<&str>, source: Option<&str>) -> Result<Option<String>, String> {
    let Some(tag) = tag.filter(|tag| !tag.is_empty()) else {
        return Ok(None);
    };
    let invalid = || "This test installer has an invalid deployment version.".to_string();
    let (version, commit) = tag.split_once("-rc.").ok_or_else(invalid)?;
    let numbers: Vec<_> = version
        .strip_prefix('v')
        .ok_or_else(invalid)?
        .split('.')
        .collect();
    if numbers.len() != 3
        || numbers.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || part.parse::<u64>().is_err()
        })
        || commit.len() != 40
        || !commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || source != Some(commit)
    {
        return Err(invalid());
    }
    Ok(Some(tag.to_string()))
}

/// A missing published package is not a problem with the person's Windows installation.
pub fn download_problem(error: &str) -> crate::problem::Problem {
    let said = if error.contains("could not find the latest OpenBot release:")
        && error.contains("/releases/latest answered 404")
    {
        "A complete OpenBot package has not been published for this installer yet. \
         Use a completed test package or wait for an OpenBot release."
    } else {
        "OpenBot could not download what it needs to run. Check the internet \
         connection and try again."
    };
    crate::problem::Problem::with(said, error)
}

fn resolve_version_with(
    root: &Path,
    latest: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    match deployment::installed(root) {
        Some(installed) => Ok(installed.version),
        None => latest(),
    }
}

fn release_tag(body: &[u8]) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }

    let release: Release = serde_json::from_slice(body)
        .map_err(|error| format!("the latest OpenBot release is not readable: {error}"))?;
    if release.tag_name.trim().is_empty() {
        return Err("the latest OpenBot release has no version tag".into());
    }
    Ok(release.tag_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    fn preview_is_bound_to_the_installers_full_source_commit() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let tag = format!("v0.0.12-rc.{sha}");
        assert_eq!(
            preview_version(Some(&tag), Some(sha)).unwrap(),
            Some(tag.clone())
        );
        assert_eq!(preview_version(None, Some(sha)).unwrap(), None);
        assert_eq!(preview_version(Some(""), Some(sha)).unwrap(), None);
        for bad in [
            "v0.0.12",
            "../main",
            "v0.0.12-rc.short",
            "v0.x.12-rc.0123456789abcdef0123456789abcdef01234567",
        ] {
            assert!(preview_version(Some(bad), Some(sha)).is_err());
        }
        assert!(preview_version(Some(&tag), None).is_err());
        assert!(
            preview_version(Some(&tag), Some("fedcba9876543210fedcba9876543210fedcba98")).is_err()
        );
    }

    #[test]
    fn missing_release_explains_the_distribution_gap_without_blaming_windows_or_network() {
        let detail = "could not find the latest OpenBot release: https://api.github.com/repos/owner/repo/releases/latest answered 404 Not Found";
        let problem = download_problem(detail);
        assert!(problem.said.contains("has not been published"));
        assert!(!problem.said.contains("internet"));
        assert_eq!(problem.detail.as_deref(), Some(detail));
        for other in [
            "https://example.com/asset answered 404 Not Found",
            "could not reach GitHub: timeout",
            "GitHub answered 403 Forbidden",
        ] {
            assert!(download_problem(other).said.contains("could not download"));
        }
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        let root = temp_root(label);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn latest_release_uses_the_repository_baked_into_this_desktop_build() {
        let repository = crate::update::release_repository().unwrap();
        assert_eq!(
            latest_release_url().unwrap(),
            format!("https://api.github.com/repos/{repository}/releases/latest")
        );
    }

    #[test]
    fn a_fresh_install_selects_latest_without_recording_an_unfinished_download() {
        let root = scratch("release-fresh");
        let version = resolve_version_with(&root, || Ok("v0.0.9".into())).unwrap();
        assert_eq!(version, "v0.0.9");
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_fresh_preview_does_not_need_a_stable_release_or_record_an_unfinished_download() {
        let root = scratch("release-preview");
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let tag = format!("v0.0.12-rc.{sha}");
        let version = resolve_version_with(&root, || {
            preview_version(Some(&tag), Some(sha))?.ok_or_else(|| "no preview".into())
        })
        .unwrap();
        assert_eq!(version, tag);
        assert!(deployment::installed(&root).is_none());
        assert!(deployment::needs_fetch(&root, &version));
        deployment::record(&root, &version).unwrap();
        let pinned =
            resolve_version_with(&root, || panic!("retain preview while offline")).unwrap();
        assert_eq!(pinned, tag);
        assert!(deployment::needs_fetch(&root, &pinned));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_installed_version_does_not_query_github_or_upgrade() {
        let root = scratch("release-installed");
        deployment::record(&root, "v0.0.7").unwrap();
        std::fs::write(deployment::images_path(&root), "{}").unwrap();
        let version = resolve_version_with(&root, || panic!("must work offline")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(!deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_manifest_repairs_the_pinned_version() {
        let root = scratch("release-repair");
        deployment::record(&root, "v0.0.7").unwrap();
        let version = resolve_version_with(&root, || panic!("keep the installed pin")).unwrap();
        assert_eq!(version, "v0.0.7");
        assert!(deployment::needs_fetch(&root, &version));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_lookup_is_reported_without_recording_a_version() {
        let root = scratch("release-lookup-failed");
        let error = resolve_version_with(&root, || Err("GitHub answered 403".into()))
            .expect_err("a failed lookup must not fall back to an old release");
        assert!(error.contains("403"));
        assert!(deployment::installed(&root).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn githubs_exact_tag_is_used_instead_of_the_release_title() {
        assert_eq!(
            release_tag(br#"{"name":"OpenBot September release","tag_name":"v0.0.9"}"#).unwrap(),
            "v0.0.9"
        );
    }

    #[test]
    fn missing_or_unreadable_release_metadata_is_refused() {
        for body in [b"not json".as_slice(), b"{}", br#"{"tag_name":" "}"#] {
            assert!(release_tag(body).is_err());
        }
    }

    /// Exercises the production resolver and downloader against GitHub in an empty directory.
    #[test]
    #[ignore = "downloads the latest public release from GitHub"]
    fn live_latest_release_is_downloaded_and_pinned() {
        let root = scratch("release-live");
        let version = resolve_version(&root).expect("resolve the public release");
        assert!(deployment::installed(&root).is_none());
        deployment::fetch(&root, &version).expect("download the tagged deployment and manifest");
        assert_eq!(deployment::installed(&root).unwrap().version, version);
        let images: deployment::Images =
            serde_json::from_slice(&std::fs::read(deployment::images_path(&root)).unwrap())
                .unwrap();
        assert_eq!(images.version, version);
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
        assert_eq!(package["version"], version.trim_start_matches('v'));
        for path in deployment::REQUIRED {
            assert!(root.join(path).exists(), "missing {path}");
        }
        assert_eq!(
            resolve_version_with(&root, || panic!("restart must not need GitHub")).unwrap(),
            version
        );
        assert!(!deployment::needs_fetch(&root, &version));
        println!("Downloaded and pinned {version}; tagged source, image manifest, and offline reuse verified.");
        std::fs::remove_dir_all(root).unwrap();
    }
}

//! Putting the deployment on disk, which is not what the installer carries.
//!
//! The installer stays small: a Tauri binary and nothing else. What it needs to run a deployment —
//! `docker-compose.yml`, `server`, `app`, `worker`, the tenant package — is fetched on first run and
//! kept beside it, at a version this app records. Two things follow from that split, and both are
//! the reason for it: the download stays a download rather than becoming part of every installer,
//! and the deployment can be moved forward on its own without shipping a new app.
//!
//! What is fetched is the release's own source tarball, at a tag. Not `main`: an app that pulls
//! whatever is on a branch this morning is not a version anybody can be given, and the images the
//! stack runs are pinned per release, so the tree that names them has to be pinned too.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Written beside the deployment so the app can tell what it already put there.
const STAMP: &str = ".openbot-deployment";

/// The release asset that says which images this version runs.
///
/// Kept beside the deployment because the tree does not contain it: `docker-compose.yml` names
/// `openbot-supervisor:latest` and friends as defaults, which are local build names that exist on a
/// developer's machine and nowhere else. A desktop install has never built anything, so without
/// this file Compose asks Docker Hub for images that are not there and reports a denial, which
/// reads as an authentication problem and is not one.
const IMAGES: &str = "container-images.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Installed {
    pub version: String,
    pub commit: String,
}

fn is_commit_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// The source archive for the immutable commit recorded in the release manifest.
///
/// A commit SHA rather than the release tag is load-bearing here: tags can be moved after an
/// installer ships, while the commit written into the signed release manifest is the exact source
/// whose images and desktop release were produced together.
pub fn tarball_url(commit: &str) -> Result<String, String> {
    if !is_commit_sha(commit) {
        return Err("The release manifest does not contain a valid source commit.".into());
    }
    let repository = crate::update::release_repository()?;
    Ok(format!(
        "https://github.com/{repository}/archive/{commit}.tar.gz"
    ))
}

/// Where the release publishes its image manifest.
pub fn images_url(version: &str) -> Result<String, String> {
    let repository = crate::update::release_repository()?;
    Ok(format!(
        "https://github.com/{repository}/releases/download/{version}/{IMAGES}"
    ))
}

pub fn images_path(root: &Path) -> PathBuf {
    root.join(IMAGES)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Image {
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Images {
    pub version: String,
    pub commit: String,
    pub images: BTreeMap<String, Image>,
}

/// The Compose variable each published image answers to.
///
/// A published name on the left, a Compose variable on the right, because the two vocabularies are
/// different and neither is going to change to suit the other.
pub const IMAGE_VARIABLES: [(&str, &str); 5] = [
    ("server", "SERVER_IMAGE"),
    ("supervisor", "SUPERVISOR_IMAGE"),
    ("agent-computer", "COMPUTER_IMAGE"),
    ("agent-bot", "BOT_IMAGE"),
    ("agent-langgraph", "LANGGRAPH_IMAGE"),
];

/// A stored manifest must describe the exact release and source commit stamped beside it.
fn expected_manifest_identity(root: &Path, manifest: &Images) -> Result<(), String> {
    let installed = installed(root)
        .ok_or_else(|| format!("{IMAGES} exists but this deployment has no recorded identity."))?;
    ensure_manifest_version(manifest, &installed.version)?;
    ensure_manifest_commit(manifest)?;
    if manifest.commit != installed.commit {
        return Err(format!(
            "{IMAGES} points at source commit {}, but this deployment was installed from {}.",
            manifest.commit, installed.commit
        ));
    }
    Ok(())
}

fn ensure_manifest_version(manifest: &Images, expected: &str) -> Result<(), String> {
    if manifest.version != expected {
        return Err(format!(
            "{IMAGES} says it belongs to {}, but this deployment is {expected}.",
            manifest.version
        ));
    }
    Ok(())
}

fn ensure_manifest_commit(manifest: &Images) -> Result<(), String> {
    if !is_commit_sha(&manifest.commit) {
        return Err(format!(
            "{IMAGES} does not contain a canonical source commit SHA."
        ));
    }
    Ok(())
}

fn expected_image_repository(published: &str) -> Result<String, String> {
    let repository = crate::update::release_repository()?;
    let owner = repository
        .split_once('/')
        .map(|(owner, _)| owner)
        .ok_or_else(|| "This build has an invalid release repository.".to_string())?
        .to_ascii_lowercase();
    let image = if published == "openbot" {
        "openbot".to_string()
    } else {
        format!("openbot-{published}")
    };
    Ok(format!("ghcr.io/{owner}/{image}"))
}

fn validated_reference(manifest: &Images, published: &str) -> Result<String, String> {
    let image = manifest
        .images
        .get(published)
        .ok_or_else(|| format!("OpenBot {} does not include {published}.", manifest.version))?;
    let expected = expected_image_repository(published)?;
    let prefix = format!("{expected}@sha256:");
    let digest = image.reference.strip_prefix(&prefix).ok_or_else(|| {
        format!(
            "{IMAGES} for {} points {published} outside the expected repository or without a sha256 digest.",
            manifest.version
        )
    })?;
    let canonical = digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    if !canonical {
        return Err(format!(
            "{IMAGES} for {} gives {published} a non-canonical sha256 digest.",
            manifest.version
        ));
    }
    Ok(image.reference.clone())
}

/// Read the manifest laid down beside the deployment and turn it into Compose variables.
///
/// Digests, not tags. A tag can be moved to point at a different image after the version that was
/// tested; a digest is the image that was tested.
pub fn image_variables(root: &Path) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(images_path(root))
        .map_err(|error| format!("could not read {}: {error}", images_path(root).display()))?;
    let manifest: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    expected_manifest_identity(root, &manifest)?;
    pin(&manifest)
}

/// One published image's reference, digest-pinned, from the manifest beside the deployment.
///
/// Every image reference comes from here, whether Compose reads it or the shell runs it directly.
/// The alternative was a name built from a version, and an engine given an unqualified name looks
/// it up on Docker Hub: `openbot-agent-langgraph-agui:v0.0.8` became
/// `docker.io/library/openbot-agent-langgraph-agui`, and the person was shown "requested access to
/// the resource is denied", which reads as a credentials problem and is not one.
///
/// An image this release does not publish is named as that. It is the honest answer and the
/// actionable one: the alternative is somebody debugging registry permissions for an image that
/// was never pushed.
pub fn reference(root: &Path, published: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(images_path(root))
        .map_err(|error| format!("could not read {}: {error}", images_path(root).display()))?;
    let manifest: Images = serde_json::from_str(&text)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    expected_manifest_identity(root, &manifest)?;
    validated_reference(&manifest, published)
}

/// Every image the stack runs, or a failure that names the one that is missing.
///
/// Refusing a partial manifest rather than filling the gaps from Compose's defaults: a stack that
/// runs four published images and one local build is neither the released version nor a build, and
/// the difference would only show up as behaviour nobody can reproduce.
pub fn pin(manifest: &Images) -> Result<Vec<(String, String)>, String> {
    let mut pinned = Vec::new();
    for (published, variable) in IMAGE_VARIABLES {
        pinned.push((variable.to_string(), validated_reference(manifest, published)?));
    }
    Ok(pinned)
}

pub fn stamp_path(root: &Path) -> PathBuf {
    root.join(STAMP)
}

/// What version is already there, if any.
pub fn installed(root: &Path) -> Option<Installed> {
    std::fs::read_to_string(stamp_path(root))
        .ok()
        .and_then(|text| serde_json::from_str::<Installed>(&text).ok())
        .filter(|installed| is_commit_sha(&installed.commit))
}

pub fn record(root: &Path, version: &str, commit: &str) -> std::io::Result<()> {
    if !is_commit_sha(commit) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "release commit is not a canonical SHA",
        ));
    }
    std::fs::create_dir_all(root)?;
    let stamp = Installed {
        version: version.to_string(),
        commit: commit.to_string(),
    };
    std::fs::write(
        stamp_path(root),
        serde_json::to_string(&stamp).unwrap_or_default(),
    )
}

/// Whether anything needs fetching.
///
/// Answered from the stamp rather than by looking for files, so a half-extracted directory from an
/// interrupted download is replaced rather than trusted: the stamp is written last, and its absence
/// means the fetch did not finish.
///
/// The image manifest is the one exception. A deployment laid down by an app that predates it has a
/// stamp that matches and no manifest, and re-fetching is a better answer than an error about a
/// file the person has never heard of.
pub fn needs_fetch(root: &Path, wanted: &str) -> bool {
    let Some(found) = installed(root) else {
        return true;
    };
    if found.version != wanted {
        return true;
    }
    let Ok(text) = std::fs::read_to_string(images_path(root)) else {
        return true;
    };
    let Ok(manifest) = serde_json::from_str::<Images>(&text) else {
        return true;
    };
    expected_manifest_identity(root, &manifest).is_err()
}

/// Everything the three host processes and Compose need from the tree.
///
/// Named rather than "the whole repository" because most of it is not needed to run: the charts, the
/// docs, the tests and the Dockerfiles are not part of a deployment, and copying them makes the
/// directory look like a place to develop rather than a place something runs.
pub const REQUIRED: [&str; 4] = ["docker-compose.yml", "server", "app", "worker"];

/// The rest of what a deployment needs, which is not what it is checked for.
pub const ALSO_COPIED: [&str; 7] = [
    "shared",
    "examples",
    "package.json",
    "bun.lock",
    "scripts",
    // Every package's tsconfig extends this one. Without it vite fails inside `parseExtends`, in a
    // stack trace that names the parser and not the missing file.
    "tsconfig.base.json",
    "bunfig.toml",
];

/// Fetch the release manifest first, then lay down source from its immutable commit.
///
/// The stamp is written last. Anything that fails before that leaves a directory without one, which
/// `needs_fetch` treats as absent, so an interrupted download is retried rather than half-run.
pub fn fetch(root: &Path, version: &str) -> Result<(), String> {
    let (manifest_body, manifest) = fetch_manifest(version)?;
    let tarball = tarball_url(&manifest.commit)?;
    let body = get(&tarball).map_err(|error| {
        format!("could not fetch {version}: {error}. Is that a released version?")
    })?;

    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not make {}: {error}", root.display()))?;

    unpack(root, &body)?;

    std::fs::write(images_path(root), &manifest_body)
        .map_err(|error| format!("could not write {IMAGES}: {error}"))?;

    record(root, version, &manifest.commit)
        .map_err(|error| format!("could not record the release identity: {error}"))
}

/// Where an archive entry may be written under `root`, or `None` when it is not
/// part of a deployment.
///
/// The traversal is refused here rather than after the fact. `Path::join`
/// followed by `starts_with` compares components and does not resolve `..`, so
/// `root.join("app/../../elsewhere")` starts with `root` and still lands outside
/// it -- which made the check that was there read as a guard without being one.
/// Every component of a path inside the tree is an ordinary name, so anything
/// else (`..`, an absolute path, a Windows drive prefix) is refused outright.
fn destination_in(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    // GitHub wraps everything in one directory named for the tag. Strip it, so the deployment
    // lands at `root` rather than at `root/OpenBot-0.0.7`.
    let mut parts = path.components();
    parts.next();
    let relative: PathBuf = parts.collect();
    if relative.as_os_str().is_empty() {
        return Ok(None);
    }

    // Nothing outside `root`, whatever the archive says. A tarball is somebody else's file.
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "the download tried to write outside {}: {}",
            root.display(),
            path.display()
        ));
    }

    // Only what a deployment needs. The rest of the tree is a place to develop, not to run.
    let wanted = relative
        .components()
        .next()
        .map(|first| {
            let name = first.as_os_str().to_string_lossy().into_owned();
            REQUIRED.contains(&name.as_str()) || ALSO_COPIED.contains(&name.as_str())
        })
        .unwrap_or(false);
    if !wanted {
        return Ok(None);
    }

    Ok(Some(root.join(&relative)))
}

/// Lay the tarball's deployment files out under `root`.
///
/// Split from [`fetch`] so the part that decides where somebody else's archive
/// is allowed to write can be exercised without a network.
pub fn unpack(root: &Path, body: &[u8]) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(body);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("the download is not readable: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("could not read the download: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("could not read a path in the download: {error}"))?
            .into_owned();

        let Some(destination) = destination_in(root, &path)? else {
            continue;
        };
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not make {}: {error}", parent.display()))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("could not write {}: {error}", destination.display()))?;
    }

    Ok(())
}

/// Fetch the image manifest and verify its release/source identity before source is downloaded.
///
/// Parsed before the source archive so a release with a missing/malformed identity fails before an
/// untrusted or mutable ref can choose which application code lands on disk.
fn fetch_manifest(version: &str) -> Result<(Vec<u8>, Images), String> {
    let images = images_url(version)?;
    let body = get(&images)
        .map_err(|error| format!("could not fetch the image list for {version}: {error}"))?;
    let manifest: Images = serde_json::from_slice(&body)
        .map_err(|error| format!("the image list for {version} is not readable: {error}"))?;
    ensure_manifest_version(&manifest, version)?;
    ensure_manifest_commit(&manifest)?;
    pin(&manifest)?;
    Ok((body, manifest))
}

/// Fetch a URL into memory.
///
/// Shared with `install.rs`, which fetches the engine's installers through it and then checks their
/// digests. One client, one user agent, one set of TLS defaults.
pub fn get(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .build()
        .map_err(|error| format!("could not prepare the download: {error}"))?
        .get(url)
        .send()
        .map_err(|error| format!("could not reach {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    response
        .bytes()
        .map(|body| body.to_vec())
        .map_err(|error| format!("the download did not finish: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_COMMIT: &str = "1111111111111111111111111111111111111111";
    const OTHER_COMMIT: &str = "2222222222222222222222222222222222222222";

    fn manifest(names: &[&str]) -> Images {
        let repository = crate::update::release_repository().unwrap();
        let owner = repository.split_once('/').unwrap().0.to_ascii_lowercase();
        Images {
            version: "v0.0.7".into(),
            commit: TEST_COMMIT.into(),
            images: names
                .iter()
                .map(|name| {
                    (
                        (*name).to_string(),
                        Image {
                            reference: format!(
                                "ghcr.io/{owner}/openbot-{name}@sha256:{}",
                                "a".repeat(64)
                            ),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn a_deployment_without_an_image_manifest_is_fetched_again_rather_than_refused() {
        let dir = std::env::temp_dir().join(format!("openbot-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(images_path(&dir));
        record(&dir, "v0.0.7", TEST_COMMIT).unwrap();

        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a matching stamp is not enough when the images are not named"
        );

        let names: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        std::fs::write(
            images_path(&dir),
            serde_json::to_string(&manifest(&names)).unwrap(),
        )
        .unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_service_compose_can_run_is_pinned_to_a_published_digest() {
        let published: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        let pinned = pin(&manifest(&published)).expect("a complete manifest pins");
        assert_eq!(pinned.len(), IMAGE_VARIABLES.len());
        for (_, reference) in &pinned {
            assert!(
                reference.contains("@sha256:"),
                "a tag is not a version: {reference}"
            );
        }
    }

    #[test]
    fn a_manifest_from_another_release_is_refused() {
        let mut wrong = manifest(
            &IMAGE_VARIABLES
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>(),
        );
        wrong.version = "v0.0.6".into();
        assert!(ensure_manifest_version(&wrong, "v0.0.7").is_err());
    }

    #[test]
    fn a_manifest_with_a_different_or_malformed_source_commit_is_refused() {
        let names: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();

        let mut wrong = manifest(&names);
        wrong.commit = OTHER_COMMIT.into();
        let dir = scratch("manifest-commit-mismatch");
        record(&dir, "v0.0.7", TEST_COMMIT).unwrap();
        std::fs::write(
            images_path(&dir),
            serde_json::to_string(&wrong).unwrap(),
        )
        .unwrap();
        assert!(needs_fetch(&dir, "v0.0.7"));
        assert!(image_variables(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();

        let mut malformed = manifest(&names);
        malformed.commit = "not-a-commit".into();
        assert!(ensure_manifest_commit(&malformed).is_err());
    }

    #[test]
    fn mutable_or_cross_repository_image_references_are_refused() {
        let names: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();

        let mut mutable = manifest(&names);
        mutable.images.get_mut("server").unwrap().reference =
            expected_image_repository("server").unwrap() + ":latest";
        assert!(pin(&mutable).is_err());

        let mut cross_repository = manifest(&names);
        cross_repository
            .images
            .get_mut("server")
            .unwrap()
            .reference = format!(
            "ghcr.io/other/openbot-server@sha256:{}",
            "b".repeat(64)
        );
        assert!(pin(&cross_repository).is_err());

        let mut short_digest = manifest(&names);
        short_digest.images.get_mut("server").unwrap().reference =
            expected_image_repository("server").unwrap() + "@sha256:abc";
        assert!(pin(&short_digest).is_err());
    }

    #[test]
    fn a_manifest_missing_an_image_is_refused_rather_than_filled_in_from_compose() {
        // Compose's defaults are local build names. Falling back to them would run four published
        // images beside one that does not exist, and say nothing about the difference.
        let missing = pin(&manifest(&[
            "server",
            "supervisor",
            "agent-computer",
            "agent-bot",
        ]));
        let error = missing.expect_err("an incomplete manifest is not a deployment");
        assert!(error.contains("agent-langgraph"), "{error}");
    }

    #[test]
    fn deployment_downloads_use_the_repository_baked_into_this_desktop_build() {
        let repository = crate::update::release_repository().unwrap();
        assert!(tarball_url(TEST_COMMIT).unwrap().contains(repository));
        assert!(images_url("v0.0.7").unwrap().contains(repository));
    }

    #[test]
    fn the_image_manifest_is_fetched_from_the_same_version_as_the_tree() {
        let url = images_url("v0.0.7").unwrap();
        assert!(url.contains("/download/v0.0.7/"), "{url}");
        assert!(url.ends_with("container-images.json"), "{url}");
    }

    #[test]
    fn the_source_tarball_is_bound_to_an_immutable_commit() {
        let url = tarball_url(TEST_COMMIT).unwrap();
        assert!(url.contains(TEST_COMMIT), "{url}");
        assert!(!url.contains("/refs/tags/"), "a mutable tag is not source identity: {url}");
        assert!(!url.contains("/heads/"), "a branch is not source identity: {url}");
        assert!(url.starts_with("https://"), "must not need a git client: {url}");

        for invalid in ["v0.0.7", "main", "ABCDEF", "1234"] {
            assert!(tarball_url(invalid).is_err(), "{invalid} became a source ref");
        }
    }

    #[test]
    fn an_empty_directory_needs_fetching() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-empty-{}", std::process::id()));
        assert!(needs_fetch(&dir, "v0.0.7"));
    }

    /// One tarball, written as bytes rather than through `tar::Builder`.
    ///
    /// The builder refuses a path holding `..` outright ("paths in archives must
    /// not have `..`"), which is the right thing for it to do and makes it the
    /// wrong tool for this: an archive that climbs out of its root is not
    /// produced by a careful writer, it is produced by somebody writing the
    /// bytes. A ustar header is a name, a size, a checksum and padding.
    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar: Vec<u8> = Vec::new();
        for (name, body) in entries {
            let mut header = [0u8; 512];
            let bytes = name.as_bytes();
            assert!(bytes.len() < 100, "the test uses short names");
            header[..bytes.len()].copy_from_slice(bytes);
            header[100..107].copy_from_slice(b"0000644"); // mode
            header[108..115].copy_from_slice(b"0000000"); // uid
            header[116..123].copy_from_slice(b"0000000"); // gid
            let size = format!("{:011o}", body.len());
            header[124..135].copy_from_slice(size.as_bytes());
            header[136..147].copy_from_slice(b"00000000000"); // mtime
            header[156] = b'0'; // a regular file
            header[257..263].copy_from_slice(b"ustar ");
            header[263..265].copy_from_slice(b"00");
            // The checksum is computed with its own field read as spaces.
            header[148..156].copy_from_slice(b"        ");
            let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
            let checksum = format!("{sum:06o}  ");
            header[148..156].copy_from_slice(checksum.as_bytes());

            tar.extend_from_slice(&header);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(512) * 512, 0); // pad to a block
        }
        tar.extend_from_slice(&[0u8; 1024]); // two empty blocks end an archive

        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar).expect("the test archive is compressed");
        encoder.finish().expect("the test archive is compressed")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openbot-unpack-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        dir
    }

    #[test]
    fn the_test_archive_really_carries_the_traversal() {
        // Guards the guard: if the archive did not hold `..` the next test would
        // pass for the wrong reason.
        let archive = tarball(&[("OpenBot-0.0.8/app/../../escaped.txt", b"owned")]);
        let decoder = flate2::read::GzDecoder::new(&archive[..]);
        let mut tar = tar::Archive::new(decoder);
        let paths: Vec<String> = tar
            .entries()
            .expect("the test archive is readable")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .path()
                    .expect("a path")
                    .display()
                    .to_string()
            })
            .collect();
        assert_eq!(paths, ["OpenBot-0.0.8/app/../../escaped.txt"]);
    }

    #[test]
    fn a_download_that_climbs_out_of_the_root_is_refused() {
        // `root.join("app/../../x")` starts with `root` -- `Path::starts_with`
        // compares components and does not resolve `..` -- so asking where the
        // path landed cannot answer this. The entry sits under `app`, which is a
        // directory a deployment wants, so the wanted-list does not stop it
        // either.
        let dir = scratch("escape");
        let root = dir.join("deployment");
        std::fs::create_dir_all(&root).expect("the root is made");

        let archive = tarball(&[("OpenBot-0.0.8/app/../../escaped.txt", b"owned")]);
        let outcome = unpack(&root, &archive);

        let climbed = dir.join("escaped.txt");
        let written = climbed.exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!written, "a file was written above the root");
        assert!(outcome.is_err(), "the traversal was accepted: {outcome:?}");
        assert!(
            outcome.unwrap_err().contains("outside"),
            "the refusal should say what it refused"
        );
    }

    #[test]
    fn an_ordinary_download_still_lands_where_it_should() {
        let dir = scratch("ordinary");

        let archive = tarball(&[
            ("OpenBot-0.0.8/app/index.ts", b"export {}"),
            ("OpenBot-0.0.8/docker-compose.yml", b"services: {}"),
            // Not part of a deployment: skipped, not refused.
            ("OpenBot-0.0.8/docs/readme.md", b"# hi"),
        ]);
        unpack(&dir, &archive).expect("an ordinary download is laid out");

        let app = std::fs::read_to_string(dir.join("app/index.ts")).ok();
        let compose = std::fs::read_to_string(dir.join("docker-compose.yml")).ok();
        let docs = dir.join("docs").exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(app.as_deref(), Some("export {}"));
        assert_eq!(compose.as_deref(), Some("services: {}"));
        assert!(!docs, "the rest of the tree is not part of a deployment");
    }

    #[test]
    fn a_recorded_version_is_not_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-same-{}", std::process::id()));
        record(&dir, "v0.0.7", TEST_COMMIT).unwrap();
        let names: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        std::fs::write(
            images_path(&dir),
            serde_json::to_string(&manifest(&names)).unwrap(),
        )
        .unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        assert!(
            needs_fetch(&dir, "v0.0.8"),
            "a newer version has to be fetched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_fetch_is_replaced_rather_than_trusted() {
        // Files present, stamp absent: what an interrupted extract leaves behind. The stamp is
        // written last precisely so this case is distinguishable.
        let dir = std::env::temp_dir().join(format!("openbot-dep-partial-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("server")).unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a directory with no stamp is not a deployment"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_legacy_stamp_without_source_commit_is_repaired_instead_of_trusted() {
        let dir = std::env::temp_dir().join(format!(
            "openbot-dep-legacy-stamp-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), r#"{"version":"v0.0.7"}"#).unwrap();

        assert!(installed(&dir).is_none());
        assert!(needs_fetch(&dir, "v0.0.7"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_noncanonical_commit_is_never_written_to_the_deployment_stamp() {
        let dir = std::env::temp_dir().join(format!(
            "openbot-dep-invalid-commit-{}",
            std::process::id()
        ));
        assert!(record(&dir, "v0.0.7", "not-a-commit").is_err());
        assert!(installed(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_stamp_is_treated_as_absent_rather_than_fatal() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), "{ not json").unwrap();
        assert!(installed(&dir).is_none());
        assert!(needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_shared_tsconfig_is_copied_or_every_package_fails_to_parse_its_own() {
        assert!(
            ALSO_COPIED.contains(&"tsconfig.base.json"),
            "app, server and worker all extend it"
        );
    }

    #[test]
    fn what_is_required_is_what_the_stack_actually_runs() {
        // The check in stack.rs looks for exactly these, so the two cannot drift apart.
        for entry in ["docker-compose.yml", "server", "app", "worker"] {
            assert!(
                REQUIRED.contains(&entry),
                "{entry} is not required but is checked for"
            );
        }
        assert!(
            !REQUIRED.contains(&"charts"),
            "a deployment is not a place to develop"
        );
        assert!(!REQUIRED.contains(&"docs"));
    }
}

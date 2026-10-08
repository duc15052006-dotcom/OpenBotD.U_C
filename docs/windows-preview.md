# Complete Windows preview distribution

A Desktop CI artifact is a shell, not a complete first-run distribution. New installations
also need a tagged source archive, a matching `container-images.json` release asset and
publicly pullable images owned by this repository. With no stable release, `/releases/latest`
returns 404 even when WSL and Podman work correctly.

The separate `Publish Windows preview` workflow publishes only on a deliberate push to
`verify/publish-candidate`. Prepare and review changes through a PR into
`verify/release-candidate` first. The immutable preview tag is
`v<base-version>-rc.<full-source-sha>`. The native installer embeds that exact tag; it does
not discover previews through `/releases/latest`. Existing deployment pins still take
precedence, including offline repair. Stable builds continue normal stable discovery.

Publication requires CI and all Desktop acceptance checks on that exact commit, all
components in `.github/published-images.json`, canonical owned image digests and anonymous
pulls of every image. The Windows artifact's full source SHA, internal channel and deployment
tag must match before it can be uploaded. Each preview is Windows x64 only, unsigned,
explicitly prerelease and never marked latest. Tags and release assets are not overwritten.

GHCR creates new packages as private by default. If anonymous pull fails, the package owner
must open GitHub **Your profile → Packages → openbot-&lt;component&gt; → Package settings →
Change visibility → Public** for each intended preview package. Then rerun failed jobs on
the same workflow commit. The workflow must not publish an installer while these pulls fail;
the app must not carry GitHub credentials to work around package visibility.

Download the setup executable from the completed **GitHub prerelease**, not a generic
Desktop Actions artifact. Verify `checksums.txt` and `build-version.json` belong to that
release. CI proves packaging and simulated acceptance; a person still needs to complete the
Windows checklist: clean install, first run, Provider/key/model, Test connection, coworker,
Computer/Browser/Files permissions, persistence, diagnostics/recovery/update/uninstall and
full runtime/VM/browser/child-process cleanup after Quit. Real Intelligence evidence and
protected Windows signing remain required before stable publication or merging PR #30.

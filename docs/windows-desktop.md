# Windows desktop

The Windows desktop app is the intended end-user path for running OpenBot on one machine. A person
should not need to clone this repository, install Bun, or type source-development commands.

## Install

For a published release:

1. Download the signed `*-setup.exe` from that release.
2. Run the installer as your normal Windows account.
3. Launch **OpenBot** from `OpenBot.lnk` on the desktop or from the installed application.
4. Follow first-run setup.

The release pipeline refuses to publish the Windows installer unless the same release commit has
passed desktop packaging and protected signing. The installer is verified against its release
version, source commit, publisher, timestamp, and recorded SHA-256 before it becomes a release
asset.

The installer is also exercised in CI with a fresh Users-only account: install, first launch and
uninstall must work without relying on an administrator token.

## First run

The desktop shell owns the local setup flow. It prepares the local runtime, keeps the chosen OpenBot
root, starts the stack, applies database migrations before the app is allowed to serve, and opens the
local UI when the deployment it started answers with the expected identity.

The visible setup journey is:

1. choose where OpenBot keeps its local installation
2. let OpenBot prepare the local runtime
3. connect CopilotKit Intelligence
4. configure the model/provider used to get started
5. use **Test connection** to check the current provider/API-key/endpoint choice before starting
6. start OpenBot
7. continue in the local web app

Per-coworker Model/API settings, Instructions, Skills and Knowledge can then be managed from the app
without editing source files.

For API-key providers, **Test connection** makes a bounded native request to the provider without
saving the credential. Compatible endpoints are probed at their OpenAI-style `/models` route and
never forward a credential through an HTTP redirect. Plan sign-ins validate that their current or
saved session is still resolvable. The final setup question to the Bot remains the end-to-end check
that the local stack and selected model can actually answer together.

A failed migration or partially started local stack stops startup instead of presenting a
half-migrated deployment as ready.

## What starts automatically

Starting OpenBot from the desktop app starts the local services it owns. The shell keeps ownership
information for the selected installation root, starts the required container services, applies the
one-shot database migration, then starts the host processes and waits for readiness.

Closing the window hides it rather than abandoning the stack. The tray and window menu can reopen
the app, stop OpenBot, check for updates, or quit. Quitting attempts to stop the deployment it owns.

## Computers and persistence

Each Bot computer has its own browser profile and persistent workspace. The Computer Manager exposes
Start, Restart, Stop and Reset:

- **Start / Wake** resumes a stopped computer without clearing saved state.
- **Restart** cycles the computer while preserving its saved profile.
- **Stop / Sleep** stops it while retaining saved state.
- **Reset** is destructive: it clears the browser profile and saved logins.

Reset requires an explicit server-side acknowledgement tied to the exact Bot id. A stale UI or a
bare POST cannot silently wipe whichever Bot happens to be named in a changed route.

The manager also exposes live CPU, RAM and disk samples and a governed file view for the persistent
workspace. File reads and writes still cross the normal policy and audit boundary.

## Credentials

Model/provider credentials are write-only from browser-facing APIs and are stored through the
encrypted credential vault. Per-Agent custom credentials are resolved server-side; credential ids
and key values are not returned to the browser.

Do not put API keys in repository files, channel messages or tenant YAML.

## Diagnostics and recovery

When desktop startup fails, the failure panel offers **Run diagnostics**. The report intentionally
contains only a small read-only support snapshot:

- desktop release version
- source revision for CI/release builds
- repository whose releases this artifact follows
- local container engine and whether it responds
- selected/default OpenBot root
- whether the stack appears to be running
- the last high-level failure sentence

It does not read provider keys, credential values, `.env` contents, or raw failure detail that may
contain sensitive material.

The setup flow also exposes retry/repair paths. A partial local run remains marked as needing
recovery until a successful start or completed stop resolves that condition; merely reading an
error does not mark the deployment healthy.

## Updates

**Check for updates** is available from both the tray and the native window menu. It remains
available even when the WebView is showing the local OpenBot web app.

The native checker asks GitHub for the latest stable release of the repository that built that
desktop artifact. A release link is accepted only when it is HTTPS, hosted on `github.com`, and
under that exact repository. A fork therefore checks its own releases rather than silently following
another project's updater path.

Updates are not installed silently. When a newer stable release exists, OpenBot opens the validated
release page in the default browser so the person can choose when to install it.

## Uninstall

The generated Windows uninstaller removes the installed application and its `OpenBot.lnk` desktop
shortcut. Release acceptance verifies both.

The application treats the local OpenBot data root separately from the installed executable. Do not
delete an existing data root merely to uninstall or upgrade the desktop shell unless you deliberately
intend to remove that deployment's data.

## Developer path

Developers can still run the source tree directly. That path requires Bun and the source checkout and
is documented in [Development](development.md).

The source path is not the end-user installation contract. Release acceptance for the desktop app is
documented in [Releasing](releasing.md), and protected Windows signing is documented in
[Windows desktop signing](windows-signing.md).

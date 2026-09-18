import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

type Json = Record<string, unknown>;
type WorkflowJob = {
  uses?: unknown;
  needs?: unknown;
  with?: unknown;
  environment?: unknown;
  permissions?: unknown;
  steps?: unknown;
};
type Workflow = {
  on?: unknown;
  jobs?: Record<string, WorkflowJob>;
};

const root = resolve(import.meta.dir, "..");
const failures: string[] = [];

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function json(path: string): Json {
  return JSON.parse(read(path)) as Json;
}

function workflow(path: string): Workflow {
  return YAML.parse(read(path)) as Workflow;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function fail(message: string): void {
  failures.push(message);
}

function hasWorkflowCall(flow: Workflow): boolean {
  return object(flow.on) && Object.hasOwn(flow.on, "workflow_call");
}

function jobNeeds(job: WorkflowJob | undefined, dependency: string): boolean {
  return list(job?.needs).includes(dependency);
}

function steps(job: WorkflowJob | undefined): Array<Record<string, unknown>> {
  return Array.isArray(job?.steps) ? job.steps.filter(object) : [];
}

function stepNamed(
  job: WorkflowJob | undefined,
  name: string,
): Record<string, unknown> | undefined {
  return steps(job).find((step) => step.name === name);
}

function cspText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!object(value)) return "";
  return Object.entries(value)
    .flatMap(([directive, sources]) => [
      directive,
      ...(Array.isArray(sources) ? sources : [sources]),
    ])
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function checkDesktopBoundary(): void {
  const tauri = json("desktop/src-tauri/tauri.conf.json");
  const app = object(tauri.app) ? tauri.app : {};
  const security = object(app.security) ? app.security : {};
  const csp = cspText(security.csp);

  if (!csp) fail("desktop: production CSP is missing");
  if (!csp.includes("connect-src")) {
    fail("desktop: production CSP does not declare connect-src");
  }
  if (!csp.includes("ipc:") || !csp.includes("http://ipc.localhost")) {
    fail("desktop: production CSP is missing the Tauri IPC sources");
  }
  for (const forbidden of ["'unsafe-eval'", "https://", "ws://", "wss://"]) {
    if (csp.includes(forbidden)) {
      fail(`desktop: production CSP contains forbidden source ${forbidden}`);
    }
  }
  const http = csp.match(/http:\/\/[^\s;]+/g) ?? [];
  const allowedTauriHttpOrigins = new Set([
    "http://ipc.localhost",
    "http://asset.localhost",
  ]);
  if (http.some((source) => !allowedTauriHttpOrigins.has(source))) {
    fail("desktop: production CSP opens a remote HTTP origin");
  }
  if (security.dangerousDisableAssetCspModification === true) {
    fail("desktop: Tauri asset CSP rewriting is disabled");
  }
  if (
    "dangerousRemoteUrlIpcAccess" in security ||
    "dangerousRemoteDomainIpcAccess" in security
  ) {
    fail("desktop: remote web content has an IPC-access configuration");
  }

  const capability = json("desktop/src-tauri/capabilities/default.json");
  const permissions = list(capability.permissions);
  if (JSON.stringify(capability.windows) !== JSON.stringify(["main"])) {
    fail("desktop: native capability is not restricted to the main window");
  }
  if (JSON.stringify(permissions) !== JSON.stringify(["core:event:default"])) {
    fail(
      "desktop: the setup webview capability grew beyond core:event:default",
    );
  }
  if ("remote" in capability) {
    fail("desktop: the capability grants remote content access to native APIs");
  }

  if (tauri.mainBinaryName !== "openbot-desktop") {
    fail("desktop: mainBinaryName drifted from the Windows shortcut target");
  }
  const bundle = object(tauri.bundle) ? tauri.bundle : {};
  const windows = object(bundle.windows) ? bundle.windows : {};
  const nsis = object(windows.nsis) ? windows.nsis : {};
  if (nsis.installerHooks !== "./windows/hooks.nsh") {
    fail("desktop: NSIS installer no longer loads the desktop-shortcut hook");
  }
  const hooks = read("desktop/src-tauri/windows/hooks.nsh");
  for (const evidence of [
    'CreateShortcut "$DESKTOP\\OpenBot.lnk" "$INSTDIR\\openbot-desktop.exe"',
    'Delete "$DESKTOP\\OpenBot.lnk"',
  ]) {
    if (!hooks.includes(evidence)) {
      fail(`desktop: Windows shortcut lifecycle is missing ${evidence}`);
    }
  }
}

function checkComputerSandboxBoundary(): void {
  const compose = read("docker-compose.yml");
  const supervisor = read("supervisor/src/docker.ts");
  const supervisorIndex = read("supervisor/src/index.ts");
  const names = read("supervisor/src/names.ts");
  const policy = read("server/src/computer/policy-store.ts");
  const schema = read("server/src/computer/schema.ts");
  const stack = read("desktop/src-tauri/src/stack.rs");

  for (const evidence of [
    "COMPUTER_MEMORY_BYTES: ${COMPUTER_MEMORY_BYTES:-2147483648}",
    "COMPUTER_NANO_CPUS: ${COMPUTER_NANO_CPUS:-2000000000}",
  ]) {
    if (!compose.includes(evidence)) {
      fail(`computer: Windows-first resource ceiling is missing ${evidence}`);
    }
  }

  for (const evidence of [
    'SecurityOpt: ["no-new-privileges:true"]',
    'CapDrop: ["ALL"]',
    "Memory: options.memoryBytes",
    "NanoCpus: options.nanoCpus",
    "PidsLimit: options.pidsLimit ?? 512",
    "${names.profileVolume}:/profiles",
    "${names.workspaceVolume}:/workspace",
  ]) {
    if (!supervisor.includes(evidence)) {
      fail(`computer: per-Agent confinement is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES)",
    "computerNanoCpus(process.env.COMPUTER_NANO_CPUS)",
  ]) {
    if (!supervisorIndex.includes(evidence)) {
      fail(`computer: strict resource parsing is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "profileVolume: `${NAMESPACE}-profile-${botId}`",
    "workspaceVolume: `${NAMESPACE}-workspace-${botId}`",
  ]) {
    if (!names.includes(evidence)) {
      fail(`computer: per-Agent storage naming is missing ${evidence}`);
    }
  }

  if (!policy.includes(`deny: ['intent == "run_command"']`)) {
    fail("computer: raw shell execution is not denied by default");
  }
  if (
    !schema.includes('"computer_run_command"') ||
    !schema.includes("COMPUTER_ACTING_TOOLS")
  ) {
    fail("computer: command execution is not pinned as a governed acting tool");
  }

  for (const evidence of [
    "pub fn stop_computers(",
    'const SUPERVISOR_FILTER: &str = "label=openbot.supervisor=true"',
    "label=openbot.namespace=",
    "if !stop_computers(engine, root)?",
  ]) {
    if (!stack.includes(evidence)) {
      fail(
        `desktop: Quit/Stop no longer proves per-Agent Computer shutdown through ${evidence}`,
      );
    }
  }
}

function checkReleaseWiring(): void {
  const releaseProposalSource = read(".github/workflows/release.yml");
  for (const evidence of [
    "github.paginate(github.rest.pulls.list",
    "package.json version must be a stable numeric SemVer",
    "Number.isSafeInteger",
    "next.every(Number.isSafeInteger)",
    "refs/tags/v$version",
    "Refusing to create a release PR for an existing version",
  ]) {
    if (!releaseProposalSource.includes(evidence)) {
      fail(`release: Create release PR guard is missing ${evidence}`);
    }
  }

  const ci = workflow(".github/workflows/ci.yml");
  const desktop = workflow(".github/workflows/desktop.yml");
  const signing = workflow(".github/workflows/desktop-signing.yml");
  const release = workflow(".github/workflows/publish-release.yml");
  const releaseSource = read(".github/workflows/publish-release.yml");
  const federation = json("desktop/signing/azure-federation.json");
  const expectedFederationSubject =
    "repo:duc15052006-dotcom@270219086/OpenBotD.U_C@1374258280:environment:windows-signing";
  if (federation.subject !== expectedFederationSubject) {
    fail(
      `signing: Azure federation subject does not match this repository: ${String(
        federation.subject,
      )}`,
    );
  }
  if (
    federation.issuer !== "https://token.actions.githubusercontent.com" ||
    JSON.stringify(federation.audiences) !==
      JSON.stringify(["api://AzureADTokenExchange"])
  ) {
    fail("signing: Azure federation issuer or audience drifted");
  }

  if (releaseSource.includes("ghcr.io/copilotkit/")) {
    fail(
      "release: container publishing is still hard-coded to the upstream GHCR namespace",
    );
  }
  const releaseDocs = read("docs/releasing.md");
  if (releaseDocs.includes("ghcr.io/copilotkit/")) {
    fail(
      "release: release documentation still points at the upstream GHCR namespace",
    );
  }
  for (const evidence of [
    `registry_owner: \${{ steps.release.outputs.registry_owner }}`,
    `REGISTRY_OWNER: \${{ github.repository_owner }}`,
    "registry_owner=$registry_owner",
    `ghcr.io/\${{ needs.metadata.outputs.registry_owner }}/openbot`,
  ]) {
    if (!releaseSource.includes(evidence)) {
      fail(`release: repository-owned GHCR publishing is missing ${evidence}`);
    }
  }

  for (const [name, flow] of [
    ["CI", ci],
    ["Desktop", desktop],
    ["Desktop Windows signing", signing],
  ] as const) {
    if (!hasWorkflowCall(flow)) {
      fail(`release: ${name} workflow is not reusable with on.workflow_call`);
    }
  }

  const jobs = release.jobs ?? {};
  const expectedCalls: Record<string, string> = {
    checks: "./.github/workflows/ci.yml",
    "desktop-checks": "./.github/workflows/desktop.yml",
    "windows-signing": "./.github/workflows/desktop-signing.yml",
  };
  for (const [jobName, expected] of Object.entries(expectedCalls)) {
    if (jobs[jobName]?.uses !== expected) {
      fail(`release: ${jobName} must call ${expected}`);
    }
  }

  const signingInputs = object(jobs["windows-signing"]?.with)
    ? jobs["windows-signing"]?.with
    : {};
  if (
    signingInputs["signing-mode"] !== "keyvault" ||
    signingInputs["release-build"] !== true
  ) {
    fail(
      "release: Windows signing must request keyvault with release-build: true",
    );
  }

  for (const jobName of ["image", "component-images", "github-release"]) {
    if (!jobNeeds(jobs[jobName], "windows-signing")) {
      fail(`release: ${jobName} does not wait for windows-signing`);
    }
  }

  const signJob = signing.jobs?.sign;
  if (signJob?.environment !== "windows-signing") {
    fail(
      "signing: sign job is not protected by the windows-signing environment",
    );
  }
  const signPermissions = object(signJob?.permissions)
    ? signJob?.permissions
    : {};
  if (signPermissions["id-token"] !== "write") {
    fail("signing: sign job does not request OIDC id-token: write");
  }

  const stageReleaseArtifact = stepNamed(
    signJob,
    "Stage verified release artifact",
  );
  const stageReleaseRun =
    typeof stageReleaseArtifact?.run === "string"
      ? stageReleaseArtifact.run
      : "";
  for (const evidence of [
    "desktop/release-artifact",
    "desktop/signed-app/openbot-desktop.exe",
    "desktop/build-version.json",
    "Expected exactly one signed NSIS installer to stage",
    "Expected exactly three staged release files",
  ]) {
    if (!stageReleaseRun.includes(evidence)) {
      fail(`signing: flat Windows release staging is missing ${evidence}`);
    }
  }

  const signedUpload = stepNamed(signJob, "Retain verified binaries");
  const signedUploadWith =
    signedUpload && object(signedUpload.with) ? signedUpload.with : {};
  if (signedUploadWith["if-no-files-found"] !== "error") {
    fail(
      "signing: signed Windows artifact upload must fail when files are missing",
    );
  }
  if (signedUploadWith.path !== "desktop/release-artifact/") {
    fail(
      "signing: signed Windows artifact must upload one flat desktop/release-artifact/ directory",
    );
  }

  const evidenceUpload = stepNamed(signJob, "Retain verification evidence");
  const evidenceUploadWith =
    evidenceUpload && object(evidenceUpload.with) ? evidenceUpload.with : {};
  if (evidenceUploadWith["if-no-files-found"] !== "error") {
    fail(
      "signing: signature evidence upload must fail when evidence is missing",
    );
  }
  if (evidenceUploadWith.path !== "desktop/signing-evidence/") {
    fail(
      "signing: signature evidence upload path drifted from desktop/signing-evidence/",
    );
  }

  const signedInstallerAcceptance = stepNamed(
    signJob,
    "Signed installer standard-user acceptance",
  );
  const signedInstallerRun =
    typeof signedInstallerAcceptance?.run === "string"
      ? signedInstallerAcceptance.run
      : "";
  for (const evidence of [
    "test-windows-installer-standard-user.ps1",
    "Expected exactly one signed NSIS installer",
    "signed installer failed standard-user acceptance",
  ]) {
    if (!signedInstallerRun.toLowerCase().includes(evidence.toLowerCase())) {
      fail(
        `signing: protected signed installer acceptance is missing ${evidence}`,
      );
    }
  }

  const desktopApp = desktop.jobs?.app;
  const installerSmoke = stepNamed(
    desktopApp,
    "Windows installer install/uninstall smoke",
  );
  const smokeRun =
    typeof installerSmoke?.run === "string" ? installerSmoke.run : "";
  for (const evidence of [
    "Start-Process -FilePath $installers[0].FullName",
    "Start-Process -FilePath $appBinaries[0].FullName",
    "Start-Process -FilePath $uninstallers[0].FullName",
  ]) {
    if (!smokeRun.includes(evidence)) {
      fail(`desktop: installer acceptance no longer proves ${evidence}`);
    }
  }

  const standardUserInstaller = stepNamed(
    desktopApp,
    "Windows standard-user installer acceptance",
  );
  const standardUserRun =
    typeof standardUserInstaller?.run === "string"
      ? standardUserInstaller.run
      : "";
  if (
    !standardUserRun.includes(
      "desktop/scripts/test-windows-installer-standard-user.ps1",
    )
  ) {
    fail(
      "desktop: release acceptance no longer runs the standard-user installer test",
    );
  }
  const standardUserScript = read(
    "desktop/scripts/test-windows-installer-standard-user.ps1",
  );
  for (const evidence of [
    "Users group",
    "IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "Start-Process -FilePath $Installer",
    "OpenBot.lnk",
    "Desktop shortcut remains after uninstall.",
    "Start-Process -FilePath $appPath",
    "Start-Process -FilePath $uninstallers[0].FullName",
  ]) {
    if (!standardUserScript.includes(evidence)) {
      fail(
        `desktop: standard-user installer acceptance is missing ${evidence}`,
      );
    }
  }

  const releaseJob = jobs["github-release"];
  const releaseSteps = steps(releaseJob);
  const downloadNames = releaseSteps
    .map((step) => (object(step.with) ? step.with.name : undefined))
    .filter((name): name is string => typeof name === "string");
  for (const artifact of [
    "openbot-windows-signed",
    "openbot-windows-signatures",
  ]) {
    if (!downloadNames.includes(artifact)) {
      fail(`release: final job does not download ${artifact}`);
    }
  }

  const publish = stepNamed(releaseJob, "Tag and publish");
  const publishRun = typeof publish?.run === "string" ? publish.run : "";
  for (const asset of [
    "windows-release/*-setup.exe",
    "windows-release/build-version.json",
    "windows-signatures/signatures.json",
  ]) {
    if (!publishRun.includes(asset)) {
      fail(`release: GitHub Release does not publish ${asset}`);
    }
  }
  for (const evidence of [
    'existing_tag="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$VERSION"',
    '"commit $GITHUB_SHA"',
    "does not point directly at release commit",
  ]) {
    if (!publishRun.includes(evidence)) {
      fail(
        `release: existing version-tag identity gate is missing ${evidence}`,
      );
    }
  }
  for (const evidence of [
    "releases/tags/$VERSION",
    "draft or prerelease record",
    "unexpected existing assets",
    '"container-images.json"',
    '"build-version.json"',
    '"signatures.json"',
  ]) {
    if (!publishRun.includes(evidence)) {
      fail(
        `release: existing GitHub Release state gate is missing ${evidence}`,
      );
    }
  }

  const identity = stepNamed(
    releaseJob,
    "Verify signed Windows release identity",
  );
  const identityRun = typeof identity?.run === "string" ? identity.run : "";
  for (const evidence of [
    '.sourceSha "$build"',
    '.sourceSha "$evidence"',
    '.publisher == "Tawkit, Inc."',
    'app="windows-release/openbot-desktop.exe"',
    'matches="$(jq -r --arg name "$name"',
    "sha256sum",
  ]) {
    if (!identityRun.includes(evidence)) {
      fail(`release: signed-artifact identity gate is missing ${evidence}`);
    }
  }
}

function checkDesktopUpdatePath(): void {
  const native = read("desktop/src-tauri/src/main.rs");
  const updater = read("desktop/src-tauri/src/update.rs");
  const deployment = read("desktop/src-tauri/src/deployment.rs");
  const deploymentRelease = read("desktop/src-tauri/src/deployment_release.rs");
  const desktopWorkflow = read(".github/workflows/desktop.yml");
  const signingWorkflow = read(".github/workflows/desktop-signing.yml");

  for (const [name, source] of [
    ["deployment", deployment],
    ["deployment release resolver", deploymentRelease],
  ] as const) {
    if (source.includes("CopilotKit/OpenBot")) {
      fail(
        `desktop: ${name} still downloads release artifacts from the upstream repository`,
      );
    }
    if (!source.includes("crate::update::release_repository()")) {
      fail(
        `desktop: ${name} is not bound to the desktop build release repository`,
      );
    }
  }

  for (const evidence of [
    "ensure_manifest_version(&manifest, version)?",
    "expected_manifest_version(root, &manifest)?",
    "expected_image_repository",
    "validated_reference",
    "@sha256:",
  ]) {
    if (!deployment.includes(evidence)) {
      fail(`desktop: deployment manifest identity gate is missing ${evidence}`);
    }
  }

  for (const evidence of [
    '"updates" => check_for_updates',
    '"Check for updates"',
    "update::check_latest_release()",
  ]) {
    if (!native.includes(evidence)) {
      fail(`desktop: native update menu is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "https://api.github.com/repos/{repository}/releases/latest",
    'parsed.host_str() != Some("github.com")',
    "latest_numeric > current_numeric",
  ]) {
    if (!updater.includes(evidence)) {
      fail(`desktop: update checker is missing ${evidence}`);
    }
  }

  const sourceShaExpression = `\${{ github.event.pull_request.head.sha || github.sha }}`;
  for (const [name, source] of [
    ["Desktop", desktopWorkflow],
    ["Windows signing", signingWorkflow],
  ] as const) {
    if (
      !source.includes(`OPENBOT_RELEASE_REPOSITORY: \${{ github.repository }}`)
    ) {
      fail(
        `desktop: ${name} build does not bind update checks to the repository that built the artifact`,
      );
    }
    if (!source.includes(`ref: ${sourceShaExpression}`)) {
      fail(
        `desktop: ${name} build checkout is not pinned to the source commit expression`,
      );
    }
    if (!source.includes(`OPENBOT_SOURCE_SHA: ${sourceShaExpression}`)) {
      fail(
        `desktop: ${name} build does not stamp the exact checked-out source commit into diagnostics`,
      );
    }
  }

  const diagnostics = read("desktop/src/diagnostics.ts");
  for (const evidence of [
    "desktop_build_identity",
    "sourceRevision",
    "releaseRepository",
  ]) {
    if (!diagnostics.includes(evidence)) {
      fail(
        `desktop: diagnostics no longer report build identity field ${evidence}`,
      );
    }
  }
  for (const evidence of [
    "fn desktop_build_identity()",
    'option_env!("OPENBOT_SOURCE_SHA")',
    'env!("CARGO_PKG_VERSION")',
  ]) {
    if (!native.includes(evidence)) {
      fail(`desktop: native build identity is missing ${evidence}`);
    }
  }
}

function checkDesktopCredentialBoundary(): void {
  const native = read("desktop/src-tauri/src/main.rs");
  const app = read("desktop/src/App.tsx");
  const picker = read("desktop/src/ProviderPicker.tsx");

  for (const secret of [
    "INTELLIGENCE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    if (!native.includes(`values.remove("${secret}")`)) {
      fail(
        `desktop: already_configured no longer strips ${secret} before WebView IPC`,
      );
    }
  }

  for (const forbidden of [
    "values.INTELLIGENCE_API_KEY",
    'invoke<string>("intelligence_key_for"',
  ]) {
    if (app.includes(forbidden)) {
      fail(
        `desktop: renderer credential boundary regressed through ${forbidden}`,
      );
    }
  }
  for (const forbidden of [
    "OPENAI_API_KEY?: string",
    "ANTHROPIC_API_KEY?: string",
  ]) {
    if (picker.includes(forbidden)) {
      fail(
        `desktop: saved model secret is exposed in HeldConfiguration through ${forbidden}`,
      );
    }
  }

  for (const evidence of [
    "pending_intelligence_key",
    "Some(PendingIntelligenceKey { root, key })",
  ]) {
    if (!native.includes(evidence)) {
      fail(
        `desktop: native Intelligence credential handoff is missing ${evidence}`,
      );
    }
  }
  if (
    !/intelligence_key_for_start\(\s*&root,\s*api_key,\s*pending_intelligence_key,\s*saved_secret,?\s*\)/.test(
      native,
    )
  ) {
    fail(
      "desktop: Start no longer resolves the root-bound pending Intelligence key",
    );
  }

  const keyCommand = native
    .split("async fn intelligence_key_for(", 2)[1]
    ?.split("/// The model screen", 1)[0];
  if (
    !keyCommand?.includes(
      "-> Result<(), openbot_desktop_lib::problem::Problem>",
    )
  ) {
    fail(
      "desktop: provisioned Intelligence key can cross the WebView response",
    );
  }
}

function checkProviderConnectionTest(): void {
  const picker = read("desktop/src/ProviderPicker.tsx");
  const native = read("desktop/src-tauri/src/main.rs");

  for (const evidence of [
    '"Test connection"',
    '"test_model_connection"',
    "connectionFingerprint",
    "requireConnectionTest",
  ]) {
    if (!picker.includes(evidence)) {
      fail(`desktop: provider setup no longer exposes ${evidence}`);
    }
  }

  const app = read("desktop/src/App.tsx");
  if (!app.includes("requireConnectionTest")) {
    fail(
      "desktop: first-run model setup no longer requires a successful connection proof",
    );
  }

  for (const evidence of [
    "async fn test_model_connection(",
    ".redirect(reqwest::redirect::Policy::none())",
    "https://api.openai.com/v1/models",
    "https://api.anthropic.com/v1/models?limit=1",
    "models_probe_url",
    "model_endpoint_url",
    "must not contain credentials",
    "cannot be saved",
    "model_probe_never_allowed_host",
    "metadata.google.internal",
    "169, 254, 169, 254",
    "0x00, 0x64, 0xff, 0x9b",
  ]) {
    if (!native.includes(evidence)) {
      fail(`desktop: native provider test is missing ${evidence}`);
    }
  }
}

function checkFirstCoworkerHandoff(): void {
  const app = read("desktop/src/App.tsx");
  const ask = read("desktop/src/Ask.tsx");
  const native = read("desktop/src-tauri/src/main.rs");
  const agents = read("app/src/routes/_authed/_app/agents/index.tsx");
  const agentDialog = read("app/src/components/agents/agent-dialog.tsx");

  for (const evidence of ['invoke("show_agent_creator")', "onCreateCoworker"]) {
    if (!app.includes(evidence)) {
      fail(`desktop: completed setup no longer hands off through ${evidence}`);
    }
  }
  if (!ask.includes("Create a coworker")) {
    fail("desktop: successful setup no longer offers coworker creation");
  }
  for (const evidence of [
    "fn show_agent_creator",
    'Some(("/agents", "new=true"))',
    "openbot_route_url",
  ]) {
    if (!native.includes(evidence)) {
      fail(`desktop: fixed coworker route is missing ${evidence}`);
    }
  }
  for (const evidence of ["new: z.boolean().optional()", "open={showCreate}"]) {
    if (!agents.includes(evidence)) {
      fail(
        `app: /agents?new=true no longer opens the coworker creator (${evidence})`,
      );
    }
  }

  for (const evidence of [
    "setComputerStateMutationOptions",
    'action: "start"',
    "ComputerFilesDialog",
    "Start or wake this coworker",
    "profile.builtIn ?",
  ]) {
    if (!agentDialog.includes(evidence)) {
      fail(
        `app: new coworker profile lost computer quickstart evidence ${evidence}`,
      );
    }
  }
}

function checkVersionSources(): void {
  const pkg = json("package.json");
  const version = pkg.version;
  const chart = YAML.parse(read("charts/openbot/Chart.yaml")) as {
    appVersion?: unknown;
  };
  const tauri = json("desktop/src-tauri/tauri.conf.json");

  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail("version: package.json does not contain a numeric release version");
  }
  if (chart.appVersion !== version) {
    fail(
      `version: Helm appVersion ${String(chart.appVersion)} does not match package.json ${String(version)}`,
    );
  }
  if (tauri.version !== "../../package.json") {
    fail("version: Tauri is not reading the root package.json release version");
  }
}

checkDesktopBoundary();
checkComputerSandboxBoundary();
checkReleaseWiring();
checkDesktopUpdatePath();
checkDesktopCredentialBoundary();
checkProviderConnectionTest();
checkFirstCoworkerHandoff();
checkVersionSources();

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log(
  "Release preflight passed: static security, desktop acceptance, signing, artifact, and version gates are wired.",
);
console.log(
  "Runtime CI, clean-machine execution, and protected certificate signing still have to execute before a release is verified.",
);

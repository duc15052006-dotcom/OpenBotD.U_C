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
  return (
    object(flow.on) &&
    Object.prototype.hasOwnProperty.call(flow.on, "workflow_call")
  );
}

function jobNeeds(job: WorkflowJob | undefined, dependency: string): boolean {
  return list(job?.needs).includes(dependency);
}

function steps(job: WorkflowJob | undefined): Array<Record<string, unknown>> {
  return Array.isArray(job?.steps)
    ? job.steps.filter(object)
    : [];
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
  if (http.some((source) => source !== "http://ipc.localhost")) {
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

function checkReleaseWiring(): void {
  const ci = workflow(".github/workflows/ci.yml");
  const desktop = workflow(".github/workflows/desktop.yml");
  const signing = workflow(".github/workflows/desktop-signing.yml");
  const release = workflow(".github/workflows/publish-release.yml");

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
    fail("signing: sign job is not protected by the windows-signing environment");
  }
  const signPermissions = object(signJob?.permissions)
    ? signJob?.permissions
    : {};
  if (signPermissions["id-token"] !== "write") {
    fail("signing: sign job does not request OIDC id-token: write");
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

  const identity = stepNamed(
    releaseJob,
    "Verify signed Windows release identity",
  );
  const identityRun = typeof identity?.run === "string" ? identity.run : "";
  for (const evidence of [
    '.sourceSha "$build"',
    '.sourceSha "$evidence"',
    '.publisher == "Tawkit, Inc."',
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
  const desktopWorkflow = read(".github/workflows/desktop.yml");
  const signingWorkflow = read(".github/workflows/desktop-signing.yml");

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

  for (const [name, source] of [
    ["Desktop", desktopWorkflow],
    ["Windows signing", signingWorkflow],
  ] as const) {
    if (!source.includes("OPENBOT_RELEASE_REPOSITORY: ${{ github.repository }}")) {
      fail(
        `desktop: ${name} build does not bind update checks to the repository that built the artifact`,
      );
    }
    if (!source.includes("OPENBOT_SOURCE_SHA: ${{ github.sha }}")) {
      fail(
        `desktop: ${name} build does not stamp the source commit into diagnostics`,
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

function checkProviderConnectionTest(): void {
  const picker = read("desktop/src/ProviderPicker.tsx");
  const native = read("desktop/src-tauri/src/main.rs");

  for (const evidence of [
    '"Test connection"',
    '"test_model_connection"',
    "connectionFingerprint",
  ]) {
    if (!picker.includes(evidence)) {
      fail(`desktop: provider setup no longer exposes ${evidence}`);
    }
  }

  for (const evidence of [
    "async fn test_model_connection(",
    ".redirect(reqwest::redirect::Policy::none())",
    "https://api.openai.com/v1/models",
    "https://api.anthropic.com/v1/models?limit=1",
    "models_probe_url",
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

  for (const evidence of [
    'invoke("show_agent_creator")',
    'onCreateCoworker',
  ]) {
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
  for (const evidence of [
    "new: z.boolean().optional()",
    "open={showCreate}",
  ]) {
    if (!agents.includes(evidence)) {
      fail(`app: /agents?new=true no longer opens the coworker creator (${evidence})`);
    }
  }

  for (const evidence of [
    "setComputerStateMutationOptions",
    'action: "start"',
    "ComputerFilesDialog",
    "Start or wake this coworker",
  ]) {
    if (!agentDialog.includes(evidence)) {
      fail(`app: new coworker profile lost computer quickstart evidence ${evidence}`);
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
checkReleaseWiring();
checkDesktopUpdatePath();
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

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

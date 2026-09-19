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
    `COMPUTER_MEMORY_BYTES: \${COMPUTER_MEMORY_BYTES:-2147483648}`,
    `COMPUTER_NANO_CPUS: \${COMPUTER_NANO_CPUS:-2000000000}`,
    `COMPUTER_MAX_ACTIVE: \${COMPUTER_MAX_ACTIVE:-3}`,
    `COMPUTER_WORKSPACE_MAX_BYTES: \${COMPUTER_WORKSPACE_MAX_BYTES:-4294967296}`,
  ]) {
    if (!compose.includes(evidence)) {
      fail(`computer: Windows-first resource ceiling is missing ${evidence}`);
    }
  }

  for (const evidence of [
    'SecurityOpt: ["no-new-privileges:true"]',
    'CapDrop: ["ALL"]',
    'RestartPolicy: { Name: "no" }',
    "Memory: options.memoryBytes",
    "NanoCpus: options.nanoCpus",
    "PidsLimit: options.pidsLimit ?? 512",
    `\${names.profileVolume}:/profiles`,
    `\${names.workspaceVolume}:/workspace`,
    `\${names.quarantineVolume}:/quarantine`,
  ]) {
    if (!supervisor.includes(evidence)) {
      fail(`computer: per-Agent confinement is missing ${evidence}`);
    }
  }

  if (supervisor.includes('RestartPolicy: { Name: "unless-stopped" }')) {
    fail(
      "computer: Docker may autorestart an Agent Computer outside the OpenBot app lifecycle",
    );
  }
  for (const evidence of [
    'existing.restartPolicyName !== "no"',
    'RestartPolicy: { Name: "no" }',
    "restartPolicyName: info.HostConfig.RestartPolicy.Name",
  ]) {
    if (!supervisor.includes(evidence)) {
      fail(`computer: legacy restart-policy migration is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES)",
    "computerNanoCpus(process.env.COMPUTER_NANO_CPUS)",
    "computerMaxActive(process.env.COMPUTER_MAX_ACTIVE)",
  ]) {
    if (!supervisorIndex.includes(evidence)) {
      fail(`computer: strict resource parsing is missing ${evidence}`);
    }
  }

  for (const evidence of [
    `profileVolume: \`\${NAMESPACE}-profile-\${botId}\``,
    `workspaceVolume: \`\${NAMESPACE}-workspace-\${botId}\``,
    `quarantineVolume: \`\${NAMESPACE}-quarantine-\${botId}\``,
  ]) {
    if (!names.includes(evidence)) {
      fail(`computer: per-Agent storage naming is missing ${evidence}`);
    }
  }

  if (!policy.includes(`deny: ['tool.name == "computer_run_command"']`)) {
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

  for (const evidence of [
    "STOP ALL AGENTS",
    "Exit OpenBot and stop all Agents",
    "WindowEvent::CloseRequested",
    "window.hide()",
  ]) {
    if (!read("desktop/src-tauri/src/main.rs").includes(evidence)) {
      fail(
        `desktop: Agent runtime state is no longer explicit through ${evidence}`,
      );
    }
  }

  for (const evidence of [
    "removeOwnedVolume(names, volume)",
    'if (ownership === "foreign") throw new NameHeldError(volume, "volume")',
    "Reset was not completed",
    "await ensureOwnedVolume(names, volume)",
  ]) {
    if (!supervisor.includes(evidence)) {
      fail(
        `computer: owned-volume fail-closed lifecycle is missing ${evidence}`,
      );
    }
  }

  for (const evidence of [
    "names.profileVolume",
    "names.workspaceVolume",
    "names.quarantineVolume",
  ]) {
    if (!supervisor.includes(evidence)) {
      fail(
        `computer: Reset/storage boundary lost persistent volume ${evidence}`,
      );
    }
  }

  const downloads = read("agent-computer/src/download-quarantine.ts");
  const quarantineScanner = read("agent-computer/src/quarantine-scanner.ts");
  const profiles = read("agent-computer/src/profiles.ts");
  for (const evidence of [
    'status: "pending"',
    "download.saveAs(file)",
    "quarantineDirectoryFor(root, botId)",
    "Only unchanged bytes from a clean scan can be approved for export",
  ]) {
    if (!downloads.includes(evidence)) {
      fail(`computer: download quarantine is missing ${evidence}`);
    }
  }
  for (const evidence of [
    'status: "scan_failed"',
    "exitCode === 0",
    "exitCode === 1",
    "process.killed",
  ]) {
    if (!quarantineScanner.includes(evidence)) {
      fail(`computer: fail-closed malware scanner is missing ${evidence}`);
    }
  }
  if (
    !profiles.includes("quarantineDownload(QUARANTINE_ROOT, botId, download)")
  ) {
    fail("computer: Chromium downloads no longer flow through quarantine");
  }

  const screen = read(
    "app/src/components/computers/computer-screen-dialog.tsx",
  );
  for (const evidence of [
    "Take control",
    "Return control",
    "Stop viewing",
    "releaseControl(botId)",
    "sendHumanInput",
  ]) {
    if (!screen.includes(evidence)) {
      fail(`computer: human live-screen control is missing ${evidence}`);
    }
  }

  const snapshotSupervisor = read("supervisor/src/docker.ts");
  for (const evidence of [
    "createCleanSnapshot",
    "restoreCleanSnapshot",
    'NetworkMode: "none"',
    'CapDrop: ["ALL"]',
    'SecurityOpt: ["no-new-privileges:true"]',
    "ReadonlyRootfs: true",
    "AutoRemove: true",
    "isPrimaryComputerContainerName",
    "docker.listVolumes",
    "newestCompleteSnapshot",
    "Preserve the currently valid recovery point until the replacement is complete",
    "Never leave a mixed profile/workspace/quarantine set after a failed restore",
    "Snapshot-only state after Reset",
    "Stop the Computer before creating a clean snapshot.",
    "Stop the Computer before restoring its clean snapshot.",
  ]) {
    if (!snapshotSupervisor.includes(evidence)) {
      fail(`computer: clean snapshot boundary is missing ${evidence}`);
    }
  }
  const createSupervisor =
    snapshotSupervisor
      .split("export async function createCleanSnapshot(", 2)[1]
      ?.split("export async function restoreCleanSnapshot(", 1)[0] ?? "";
  const createTarget = createSupervisor.indexOf(
    "const target = slots[current?.index === 0 ? 1 : 0];",
  );
  const createTry = createSupervisor.indexOf("try {", createTarget);
  const createPrepare = createSupervisor.indexOf(
    "for (const volume of target.volumes)",
    createTry,
  );
  const createCatch = createSupervisor.indexOf(
    "} catch (error)",
    createPrepare,
  );
  if (
    createTarget < 0 ||
    createTry < createTarget ||
    createPrepare < createTry ||
    createCatch < createPrepare
  ) {
    fail(
      "computer: snapshot destination preparation is outside the fail-closed cleanup boundary",
    );
  }

  const restoreSupervisor =
    snapshotSupervisor
      .split("export async function restoreCleanSnapshot(", 2)[1]
      ?.split("/**\n * Whether the computer that exists", 1)[0] ?? "";
  const restoreTarget = restoreSupervisor.indexOf(
    "const target = liveVolumes(names);",
  );
  const restoreTry = restoreSupervisor.indexOf("try {", restoreTarget);
  const restorePrepare = restoreSupervisor.indexOf(
    "for (const volume of target)",
    restoreTry,
  );
  const restoreCatch = restoreSupervisor.indexOf(
    "} catch (error)",
    restorePrepare,
  );
  if (
    restoreTarget < 0 ||
    restoreTry < restoreTarget ||
    restorePrepare < restoreTry ||
    restoreCatch < restorePrepare
  ) {
    fail(
      "computer: restore destination preparation is outside the fail-closed cleanup boundary",
    );
  }

  const restoreGateway =
    read("server/src/computer/gateway.ts")
      .split("async restoreComputerSnapshot(", 2)[1]
      ?.split("/**\n     * Wipe a computer", 1)[0] ?? "";
  const restored = restoreGateway.indexOf("provider.restoreSnapshot(botId)");
  const audit = restoreGateway.indexOf('"computer.snapshot_restored"');
  const clearRefs = restoreGateway.indexOf("snapshots.clear(botId)");
  const clearFrames = restoreGateway.indexOf("pageFrames?.clear(botId)");
  if (
    restored < 0 ||
    audit < restored ||
    clearRefs < audit ||
    clearFrames < clearRefs
  ) {
    fail(
      "computer: restore audit must be durable before stale ref/frame cleanup",
    );
  }

  const snapshotRoutes = read("server/src/computer/routes.ts");
  for (const evidence of [
    'body?.confirm !== "SNAPSHOT"',
    'body?.confirm !== "RESTORE"',
    "gateway.createComputerSnapshot",
    "gateway.restoreComputerSnapshot",
  ]) {
    if (!snapshotRoutes.includes(evidence)) {
      fail(`computer: snapshot API confirmation is missing ${evidence}`);
    }
  }

  const resourceProfiles = read("supervisor/src/resource-profile.ts");
  for (const evidence of [
    "light: {",
    "normal: {",
    "heavy: {",
    "memoryBytes: 4_294_967_296",
    "nanoCpus: 3_000_000_000",
  ]) {
    if (!resourceProfiles.includes(evidence)) {
      fail(`computer: resource profile mapping is missing ${evidence}`);
    }
  }
  const agentDialog = read("app/src/components/agents/agent-dialog.tsx");
  for (const evidence of [
    "Computer resources",
    'value="light"',
    'value="normal"',
    'value="heavy"',
  ]) {
    if (!agentDialog.includes(evidence)) {
      fail(`computer: Agent resource profile UI is missing ${evidence}`);
    }
  }
  const serverIndex = read("server/src/index.ts");
  if (
    !serverIndex.includes("agentProfileStore.computerResourceProfile(botId)")
  ) {
    fail(
      "computer: Agent resource profile is not wired into the Computer gateway",
    );
  }

  const computersPage = read("app/src/routes/_authed/admin/computers.tsx");
  const computerRoutes = read("server/src/computer/routes.ts");
  for (const evidence of [
    "KILL ALL COMPUTERS",
    "ComputerScreenDialog",
    "Idle · Computer awake",
    "Sleeping after idle",
    '"Waking…"',
    "Reset",
  ]) {
    if (!computersPage.includes(evidence)) {
      fail(`computer: Computer Manager is missing ${evidence}`);
    }
  }
  if (!computerRoutes.includes('routes.post("/stop-all"')) {
    fail("computer: admin Kill All Computers route is missing");
  }

  const lifecycle = read("server/src/computer/lifecycle.ts");
  const culler = read("server/src/work/culler.ts");
  const gateway = read("server/src/computer/gateway.ts");
  for (const evidence of [
    '"running"',
    '"idle"',
    '"sleeping"',
    '"stopped"',
    'latestEvent === "computer.slept"',
  ]) {
    if (!lifecycle.includes(evidence)) {
      fail(`computer: explicit lifecycle state is missing ${evidence}`);
    }
  }
  for (const evidence of [
    'eventType: "computer.slept"',
    'initiator: { kind: "deployment" }',
    'reason: "idle_timeout"',
  ]) {
    if (!culler.includes(evidence)) {
      fail(`computer: durable idle Sleep provenance is missing ${evidence}`);
    }
  }
  if (!gateway.includes('woke ? "computer.woke" : "computer.started"')) {
    fail(
      "computer: waking from automatic Sleep is not distinguished from Start",
    );
  }

  for (const evidence of [
    'ne(auditEvents.eventType, "computer.stopped")',
    'ne(auditEvents.eventType, "computer.reset")',
    '"used while it was being suspended; restored"',
    'reason: "activity_raced_idle_sleep"',
  ]) {
    if (!culler.includes(evidence)) {
      fail(`computer: Sleep/Wake race recovery is missing ${evidence}`);
    }
  }
  for (const evidence of [
    "recoveredFromSleepRace",
    'after.state !== "ready"',
    "idle sleep raced this Start/Wake request",
  ]) {
    if (!gateway.includes(evidence)) {
      fail(`computer: Start/Wake race recovery is missing ${evidence}`);
    }
  }

  const capacitySupervisorIndex = read("supervisor/src/index.ts");
  const provider = read("server/src/computer/provider.ts");
  const computerQueries = read("app/src/lib/computers/queries.ts");
  for (const evidence of [
    'app.get("/capacity"',
    "resourceProfiles: RESOURCE_PROFILES",
    "maxActiveComputers",
  ]) {
    if (!capacitySupervisorIndex.includes(evidence)) {
      fail(`computer: supervisor capacity reporting is missing ${evidence}`);
    }
  }
  if (!provider.includes("capacity?(): Promise<ComputerHostCapacity")) {
    fail("computer: provider capacity contract is missing");
  }
  for (const evidence of ["capacity?:", "resourceProfiles"]) {
    if (!computerQueries.includes(evidence)) {
      fail(
        `computer: Computer Manager capacity contract is missing ${evidence}`,
      );
    }
  }
  if (
    !computersPage.includes("computerStartWarning") ||
    !computersPage.includes("Start anyway")
  ) {
    fail("computer: start-time host resource warning is missing");
  }

  const restartRoute =
    capacitySupervisorIndex
      .split('app.post("/computers/:botId/restart"', 2)[1]
      ?.split('app.post("/computers/:botId/stop"', 1)[0] ?? "";
  for (const evidence of [
    "lifecycleLock.run(parsed.names.botId",
    "await stop(parsed.names)",
    "return ensure(parsed.names",
  ]) {
    if (!restartRoute.includes(evidence)) {
      fail(`computer: atomic supervisor Restart is missing ${evidence}`);
    }
  }
  if (!provider.includes("restart?(")) {
    fail("computer: provider atomic restart contract is missing");
  }
  const supervisorClient = read("server/src/computer/supervisor.ts");
  if (!supervisorClient.includes("/restart")) {
    fail("computer: server supervisor client does not use atomic restart");
  }
  for (const evidence of [
    "MAX_REMEMBERED_SESSIONS = 512",
    "while (sessions.size > MAX_REMEMBERED_SESSIONS)",
    "rememberedSession(botId)",
    "sessions.delete(botId)",
  ]) {
    if (!supervisorClient.includes(evidence)) {
      fail(
        `computer: supervisor session cache is not bounded through ${evidence}`,
      );
    }
  }
  if (!gateway.includes("provider.restart")) {
    fail("computer: gateway does not prefer atomic provider restart");
  }

  for (const evidence of [
    "Promise<LocatedAction>",
    "const located = ref ? await locateForAction(botId) : undefined;",
    'if (ref && located && "error" in located)',
    "throw located.error;",
  ]) {
    if (!gateway.includes(evidence)) {
      fail(
        `computer: cited actions can lose their checked Computer run through ${evidence}`,
      );
    }
  }

  const supervisorDocker = read("supervisor/src/docker.ts");
  const listOwnedSource =
    supervisorDocker
      .split("export async function listOwned()", 2)[1]
      ?.split("const startingBots", 1)[0] ?? "";
  if (
    listOwnedSource.includes("container.Created") ||
    !listOwnedSource.includes("inspectOwned(parsed.names)")
  ) {
    fail(
      "computer: fleet lifecycle timestamp must come from the current Docker run, not container creation",
    );
  }

  const workspace = read("agent-computer/src/workspace.ts");
  for (const evidence of [
    "totalBytes: 4 * 1024 * 1024 * 1024",
    "workspaceUsageBytes",
    "withWriteLock",
  ]) {
    if (!workspace.includes(evidence)) {
      fail(`computer: workspace disk quota is missing ${evidence}`);
    }
  }
}

function checkInteractiveComputerControls(): void {
  const screen = read(
    "app/src/components/computers/computer-screen-dialog.tsx",
  );
  const computers = read("app/src/routes/_authed/admin/computers.tsx");
  const desktop = read("desktop/src-tauri/src/main.rs");
  const profiles = read("agent-computer/src/profiles.ts");
  const quarantine = read("agent-computer/src/download-quarantine.ts");

  for (const evidence of [
    "Take control",
    "Return control",
    "Stop viewing",
    "releaseControl(botId)",
    'sendHumanInput(botId, "click"',
    'sendHumanInput(botId, "type"',
    "supplySecret(botId, secretText)",
  ]) {
    if (!screen.includes(evidence)) {
      fail(`computer: human screen/takeover control is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "ComputerScreenDialog",
    'startOrWarn(computer.botId, "screen")',
    '"KILL ALL COMPUTERS"',
    "resourceSummary(computer.metrics)",
  ]) {
    if (!computers.includes(evidence)) {
      fail(`computer: Computer Manager is missing ${evidence}`);
    }
  }

  for (const evidence of [
    '"Keep running in tray"',
    '"Exit and stop all Agents"',
    '"STOP ALL AGENTS"',
    '"close-ask"',
    '"close-tray"',
    '"close-exit"',
    "close_behavior_for(app)",
    "app.exit(0)",
  ]) {
    if (!desktop.includes(evidence)) {
      fail(`desktop: close/stop runtime choice is missing ${evidence}`);
    }
  }

  const closeBehavior = read("desktop/src-tauri/src/close_behavior.rs");
  for (const evidence of [
    "pub enum CloseBehavior",
    "Ask",
    "KeepRunning",
    "Exit",
    "unwrap_or_default()",
    "write_private_file",
  ]) {
    if (!closeBehavior.includes(evidence)) {
      fail(`desktop: persisted close behavior is missing ${evidence}`);
    }
  }

  for (const evidence of [
    'target.on("download"',
    "quarantineDownload(QUARANTINE_ROOT, botId, download)",
  ]) {
    if (!profiles.includes(evidence)) {
      fail(
        `computer: browser download quarantine wiring is missing ${evidence}`,
      );
    }
  }

  for (const evidence of [
    '| "pending"',
    '| "clean"',
    '| "blocked"',
    '| "scan_failed"',
    '| "approved"',
    '| "released"',
    "Only unchanged bytes from a clean scan can be approved for export",
  ]) {
    if (!quarantine.includes(evidence)) {
      fail(`computer: download quarantine metadata is missing ${evidence}`);
    }
  }

  const computerRoutes = read("server/src/computer/routes.ts");
  for (const evidence of [
    'routes.post("/:botId/quarantine/scan"',
    'routes.post("/:botId/quarantine/approve"',
    'body.confirm !== "APPROVE"',
    "body.botId !== botId",
  ]) {
    if (!computerRoutes.includes(evidence)) {
      fail(`computer: explicit quarantine approval is missing ${evidence}`);
    }
  }

  const hostAccessRoutes = read("server/src/host-access/routes.ts");
  for (const evidence of [
    'routes.post("/quarantine/export"',
    'body?.confirm !== "EXPORT_QUARANTINED_FILE"',
    'record?.status !== "approved"',
    "record.scannedSha256 !== record.sha256",
    "broker.requestQuarantineExport",
    "gateway.markQuarantineReleased",
  ]) {
    if (!hostAccessRoutes.includes(evidence)) {
      fail(`computer: native quarantine export gate is missing ${evidence}`);
    }
  }

  const nativeHostAccess = read("desktop/src-tauri/src/host_access.rs");
  for (const evidence of [
    "choose_quarantine_export",
    "Sha256::new()",
    ".create_new(true)",
    "written != expected_size",
    "eq_ignore_ascii_case(expected_sha)",
    "fs::rename(&temporary, &destination)",
    '"autoOpened": false',
  ]) {
    if (!nativeHostAccess.includes(evidence)) {
      fail(`desktop: verified quarantine Save As is missing ${evidence}`);
    }
  }

  const quarantineDialog = read(
    "app/src/components/computers/computer-quarantine-dialog.tsx",
  );
  for (const evidence of [
    "scanQuarantinedDownloadMutationOptions",
    "approveQuarantinedDownloadMutationOptions",
    "exportQuarantinedDownloadMutationOptions",
    "Export to Windows…",
    "auto-opens or runs the file.",
  ]) {
    if (!quarantineDialog.includes(evidence)) {
      fail(`computer: quarantine manager is missing ${evidence}`);
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

  for (const evidence of [
    "const candidates = pulls.filter((candidate) =>",
    "candidates.length !== 1",
    'core.setOutput("trusted", "true")',
    "GitHub's commit -> associated PR relation survives merge, squash and rebase",
  ]) {
    if (!releaseSource.includes(evidence)) {
      fail(
        `release: merge-method-independent classifier is missing ${evidence}`,
      );
    }
  }
  if (releaseSource.includes("candidate.merge_commit_sha === context.sha")) {
    fail(
      "release: classifier regressed to merge_commit_sha and can miss squash/rebase merges",
    );
  }

  const releasePrSource = read(".github/workflows/release.yml");
  for (const evidence of [
    'git rev-parse --verify "refs/tags/v$current"',
    'git merge-base --is-ancestor "refs/tags/v$current" HEAD',
    "is not an ancestor of HEAD",
  ]) {
    if (!releasePrSource.includes(evidence)) {
      fail(`release: current-version ancestry gate is missing ${evidence}`);
    }
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

function checkIntelligenceMemory(): void {
  const runtime = read("server/src/copilot.ts");
  for (const evidence of [
    "memory: {",
    'user: "read-write"',
    'project: "none"',
  ]) {
    if (!runtime.includes(evidence)) {
      fail(`memory: runtime user-scope boundary is missing ${evidence}`);
    }
  }

  const settings = read("app/src/components/settings/memory-settings.tsx");
  for (const evidence of [
    "useMemories",
    "Restore",
    "Compare memories",
    "does not infer revision",
  ]) {
    if (!settings.includes(evidence)) {
      fail(`memory: Preferences history/restore UI is missing ${evidence}`);
    }
  }

  const history = read("app/src/lib/memory/history.ts");
  for (const evidence of [
    "/api/copilotkit/memories?includeInvalidated=true",
    'credentials: "include"',
  ]) {
    if (!history.includes(evidence)) {
      fail(`memory: authenticated history loader is missing ${evidence}`);
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
    "protected_model_probe_client",
    "forbidden_resolved_probe_ip",
    "return forbidden_resolved_probe_ip(std::net::IpAddr::V4(",
    ".resolve_to_addrs(host, &addresses)",
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

function checkDurableAgentWake(): void {
  const tools = read("server/src/plugins/builtin-routines.ts");
  const store = read("server/src/routines/store.ts");
  const sweep = read("server/src/routines/sweep.ts");
  const schema = read("server/src/db/schema/coworker.ts");
  const migration = read("server/drizzle/0042_routine_one_shot_wake.sql");

  for (const evidence of [
    'name: "schedule_wake"',
    '"Absolute future RFC3339 timestamp including Z or a numeric UTC offset."',
    '"createOneShot"',
  ]) {
    if (!tools.includes(evidence)) {
      fail(`routines: durable one-shot wake tool is missing ${evidence}`);
    }
  }

  for (const evidence of [
    'scheduleKind: routineScheduleKind("schedule_kind")',
    '"recurring"',
    '"once"',
  ]) {
    if (!schema.includes(evidence)) {
      fail(`routines: one-shot schedule schema is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "async createOneShot(",
    "async consumeOneShot(",
    'scheduleKind === "once"',
  ]) {
    if (!store.includes(evidence)) {
      fail(`routines: durable one-shot store invariant is missing ${evidence}`);
    }
  }

  for (const evidence of [
    'routine.scheduleKind === "once" || lateBy <= graceMs',
    "consumeOneShot(",
    "scheduleKind: routine.scheduleKind",
  ]) {
    if (!sweep.includes(evidence)) {
      fail(`routines: one-shot wake/recovery invariant is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "CREATE TYPE \"public\".\"routine_schedule_kind\" AS ENUM('recurring', 'once')",
    'ADD COLUMN "schedule_kind" routine_schedule_kind',
  ]) {
    if (!migration.includes(evidence)) {
      fail(`routines: one-shot wake migration is missing ${evidence}`);
    }
  }
}

function checkDurableWorkflowState(): void {
  const schema = read("server/src/db/schema/coworker.ts");
  const store = read("server/src/workflows/store.ts");
  const migration = read("server/drizzle/0043_workflow_state.sql");

  for (const evidence of [
    'workflowRunStatus = pgEnum("workflow_run_status"',
    'workflowStepStatus = pgEnum("workflow_step_status"',
    "export const workflowRuns = pgTable(",
    "export const workflowSteps = pgTable(",
    'dependsOn: text("depends_on").array().notNull().default([])',
  ]) {
    if (!schema.includes(evidence)) {
      fail(`workflows: durable state schema is missing ${evidence}`);
    }
  }

  for (const evidence of [
    "eq(workflowRuns.ownerUserId, identity.ownerUserId)",
    "eq(workflowRuns.agentId, identity.agentId)",
    "pg_advisory_xact_lock",
    "which must be an earlier step in the same workflow",
    "eq(workflowSteps.waitUntil, expectedWaitUntil)",
    "lte(workflowSteps.waitUntil, sql`now()`)",
    "dueWaitingSteps(limit)",
  ]) {
    if (!store.includes(evidence)) {
      fail(`workflows: durable recovery boundary is missing ${evidence}`);
    }
  }

  for (const evidence of [
    'CREATE TYPE "public"."workflow_run_status"',
    'CREATE TYPE "public"."workflow_step_status"',
    'CREATE TABLE "workflow_runs"',
    'CREATE TABLE "workflow_steps"',
    "workflow_steps_workflow_key_idx",
  ]) {
    if (!migration.includes(evidence)) {
      fail(`workflows: durable workflow migration is missing ${evidence}`);
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
checkInteractiveComputerControls();
checkReleaseWiring();
checkIntelligenceMemory();
checkDesktopUpdatePath();
checkDesktopCredentialBoundary();
checkProviderConnectionTest();
checkFirstCoworkerHandoff();
checkDurableAgentWake();
checkDurableWorkflowState();
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

type WorkflowJob = {
  uses?: unknown;
  needs?: unknown;
  with?: unknown;
};

type Workflow = {
  on?: unknown;
  jobs?: Record<string, WorkflowJob>;
};

const root = resolve(import.meta.dir, "..");
const workflows = resolve(root, ".github/workflows");
const failures: string[] = [];

for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
  const path = resolve(workflows, name);
  let parsed: Workflow;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8")) as Workflow;
  } catch (error) {
    failures.push(
      `${name}: YAML could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    continue;
  }

  if (name === "publish-release.yml") {
    const jobs = parsed.jobs ?? {};
    const expectedCalls: Record<string, string> = {
      checks: "./.github/workflows/ci.yml",
      "desktop-checks": "./.github/workflows/desktop.yml",
      "windows-signing": "./.github/workflows/desktop-signing.yml",
    };
    for (const [jobName, expected] of Object.entries(expectedCalls)) {
      if (jobs[jobName]?.uses !== expected) {
        failures.push(
          `${name} job ${jobName}: expected release gate ${expected}, got ${String(
            jobs[jobName]?.uses,
          )}`,
        );
      }
    }

    const signingInputs =
      jobs["windows-signing"]?.with &&
      typeof jobs["windows-signing"]?.with === "object"
        ? (jobs["windows-signing"]?.with as Record<string, unknown>)
        : {};
    if (
      signingInputs["signing-mode"] !== "keyvault" ||
      signingInputs["release-build"] !== true
    ) {
      failures.push(
        `${name} job windows-signing: release must request keyvault signing with release-build: true`,
      );
    }

    for (const jobName of ["image", "component-images"]) {
      const raw = jobs[jobName]?.needs;
      const needs = Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === "string")
        : typeof raw === "string"
          ? [raw]
          : [];
      for (const gate of ["checks", "desktop-checks", "windows-signing"]) {
        if (!needs.includes(gate)) {
          failures.push(
            `${name} job ${jobName}: publishing must wait for ${gate}`,
          );
        }
      }
    }
  }

  for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
    const uses = job?.uses;
    if (typeof uses !== "string" || !uses.includes(".github/workflows/")) {
      continue;
    }

    // External reusable workflows are owner/repo/.github/workflows/file.yml@ref. They are not
    // filesystem references in this repository and are outside this check.
    if (uses.includes("@") && !uses.startsWith("./") && !uses.startsWith("$/")) {
      continue;
    }

    const local =
      uses.startsWith("./.github/workflows/") ||
      uses.startsWith("$/.github/workflows/");
    if (!local) {
      failures.push(
        `${name} job ${jobName}: local reusable workflow must use ./.github/workflows/ or $/.github/workflows/, got ${uses}`,
      );
      continue;
    }

    if (uses.includes("@")) {
      failures.push(
        `${name} job ${jobName}: a same-repository reusable workflow must not carry an @ref: ${uses}`,
      );
      continue;
    }

    // Both GitHub Cloud same-repository forms have a two-character prefix: "./" and "$/".
    const target = resolve(root, uses.slice(2));
    if (!existsSync(target)) {
      failures.push(
        `${name} job ${jobName}: reusable workflow does not exist: ${uses}`,
      );
      continue;
    }

    const called = YAML.parse(readFileSync(target, "utf8")) as Workflow;
    const trigger =
      called && typeof called === "object"
        ? (called as Record<string, unknown>).on
        : undefined;
    const callable =
      trigger &&
      typeof trigger === "object" &&
      Object.prototype.hasOwnProperty.call(trigger, "workflow_call");
    if (!callable) {
      failures.push(
        `${name} job ${jobName}: ${uses} is referenced as reusable but has no on.workflow_call trigger`,
      );
      continue;
    }

    const workflowCall = (trigger as Record<string, unknown>)["workflow_call"];
    const declaredInputs =
      workflowCall && typeof workflowCall === "object"
        ? ((workflowCall as Record<string, unknown>).inputs as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const passedInputs =
      job.with && typeof job.with === "object"
        ? (job.with as Record<string, unknown>)
        : {};

    for (const input of Object.keys(passedInputs)) {
      if (!declaredInputs || !(input in declaredInputs)) {
        failures.push(
          `${name} job ${jobName}: passes undeclared input ${input} to ${uses}`,
        );
      }
    }

    for (const [input, raw] of Object.entries(declaredInputs ?? {})) {
      const spec =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      if (
        spec.required === true &&
        !("default" in spec) &&
        !(input in passedInputs)
      ) {
        failures.push(
          `${name} job ${jobName}: required input ${input} is missing for ${uses}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log("Local reusable workflow references are valid.");

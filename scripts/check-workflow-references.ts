import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

type Workflow = {
  on?: unknown;
  jobs?: Record<string, { uses?: unknown }>;
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

  for (const [jobName, job] of Object.entries(parsed.jobs ?? {})) {
    const uses = job?.uses;
    if (typeof uses !== "string" || !uses.includes(".github/workflows/")) {
      continue;
    }

    if (!uses.startsWith("./.github/workflows/")) {
      failures.push(
        `${name} job ${jobName}: local reusable workflow must start with ./.github/workflows/, got ${uses}`,
      );
      continue;
    }

    if (uses.includes("@")) {
      failures.push(
        `${name} job ${jobName}: a local reusable workflow must not carry an @ref: ${uses}`,
      );
      continue;
    }

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
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log("Local reusable workflow references are valid.");

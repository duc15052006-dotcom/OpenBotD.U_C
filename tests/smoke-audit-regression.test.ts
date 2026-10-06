import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the real manual journey against an HTTP fixture. These regressions prove its assertions,
// not a licensed deployment or a working browser; only the real smoke run closes that release gate.
type Scenario =
  | "valid"
  | "old-allowed"
  | "wrong-bot"
  | "wrong-action"
  | "old-refusal"
  | "wrong-rule"
  | "dry-run"
  | "secret-error";

async function journey(scenario: Scenario) {
  const cwd = mkdtempSync(join(tmpdir(), "openbot-smoke-regression-"));
  const original = { mode: "enforce", deny: [], allow: ["true"] };
  let policy = original;
  let restored = false;
  let allowedPage = "";
  let refusedPage = "";
  const bot = "risk-analyst";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/capabilities") {
        return Response.json({ mode: "intelligence", durableHistory: true });
      }
      if (path === "/api/copilotkit/info") {
        return Response.json({ licenseStatus: "valid", agents: { [bot]: {} } });
      }
      if (path === "/api/threads/mint") {
        return Response.json({
          threadId: "00000000-0000-8000-0000-000000000000",
        });
      }
      if (path === "/api/computers/policy") {
        if (request.method === "PUT") {
          policy = await request.json();
          restored = JSON.stringify(policy) === JSON.stringify(original);
          return Response.json({ policy });
        }
        return Response.json({ policy });
      }
      if (path === `/api/computers/${bot}/navigate`) {
        const body = (await request.json()) as { url: string };
        if (policy.deny.length) {
          refusedPage = body.url;
          return new Response("Blocked by policy", { status: 403 });
        }
        if (scenario === "secret-error") {
          return new Response("api-key=do-not-log-this", { status: 500 });
        }
        allowedPage = body.url;
        return Response.json({ url: body.url, title: "Example Domain" });
      }
      if (path === `/api/computers/${bot}/screenshot`) {
        return Response.json({ base64: "c2NyZWVuc2hvdA==", width: 1024 });
      }
      if (path === "/api/admin/audit-events") {
        const refusing = policy.deny.length > 0;
        return Response.json({
          events: [
            {
              eventType: refusing
                ? "computer.action_refused"
                : "computer.action_allowed",
              targetId: scenario === "wrong-bot" ? "other-bot" : bot,
              createdAt: new Date().toISOString(),
              payload: {
                bot,
                action:
                  scenario === "wrong-action"
                    ? "computer_screenshot"
                    : "computer_navigate",
                page:
                  (scenario === "old-allowed" && !refusing) ||
                  (scenario === "old-refusal" && refusing)
                    ? "https://example.com"
                    : refusing
                      ? refusedPage
                      : allowedPage,
                decision: {
                  rule:
                    scenario === "wrong-rule"
                      ? "true"
                      : 'contains(page.host, "example.com")',
                  allowed: !refusing,
                  carriedOut: scenario === "dry-run" || !refusing,
                },
              },
            },
          ],
        });
      }
      return new Response("Missing fixture route", { status: 404 });
    },
  });
  const child = Bun.spawn(
    [process.execPath, "test", join(import.meta.dir, "smoke/journey.test.ts")],
    {
      cwd,
      env: {
        ...process.env,
        OPENBOT_SMOKE: "1",
        OPENBOT_API_URL: server.url.origin,
        OPENBOT_SMOKE_BOT: bot,
        OPENBOT_SMOKE_COOKIE: "better-auth.session_token=fixture-only",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr, restored };
  } finally {
    child.kill();
    server.stop(true);
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("the journey accepts its own allowed/refused audit records and restores policy", async () => {
  const result = await journey("valid");
  expect(result.code).toBe(0);
  expect(result.restored).toBe(true);
});

test.each<Scenario>([
  "old-allowed",
  "wrong-bot",
  "wrong-action",
  "old-refusal",
  "wrong-rule",
  "dry-run",
])(
  "the journey rejects %s audit evidence and restores policy",
  async (scenario) => {
    const result = await journey(scenario);
    expect(result.code).not.toBe(0);
    expect(result.restored).toBe(true);
  },
);

test("a failing smoke response does not copy secrets into the test log", async () => {
  const result = await journey("secret-error");
  expect(result.code).not.toBe(0);
  expect(result.output).not.toContain("do-not-log-this");
  expect(result.output).toContain("answered 500");
  expect(result.restored).toBe(true);
});

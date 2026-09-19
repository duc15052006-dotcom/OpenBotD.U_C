import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import { createComputerGateway } from "../src/computer/gateway";
import type { ComputerProvider } from "../src/computer/provider";
import type { ComputerState } from "../src/computer/schema";

function gatewayFor(statuses: ComputerState[]) {
  const rows: AuditEventInput[] = [];
  const locateCalls: string[] = [];
  let statusIndex = 0;
  const provider: ComputerProvider = {
    name: "start-race",
    isolation: "per-bot",
    locate: async (botId) => {
      locateCalls.push(botId);
      return "http://127.0.0.1:4100";
    },
    status: async (botId) => ({
      botId,
      state: statuses[Math.min(statusIndex++, statuses.length - 1)] ?? "ready",
    }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    allowPrivateHosts: true,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    policy: () => undefined,
  });
  return { gateway, locateCalls, rows };
}

describe("Start/Wake racing idle sleep", () => {
  test("re-locates before returning success when the culler stopped it after the first locate", async () => {
    // It was running when Start began, then the culler completed a stop before the final state check.
    const { gateway, locateCalls, rows } = gatewayFor(["ready", "absent"]);

    const result = await gateway.startComputer("bot-a", { id: "local" });

    expect(result.started).toBe(true);
    expect(locateCalls).toEqual(["bot-a", "bot-a"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.started",
      "computer.woke",
    ]);
    expect(rows.at(-1)?.payload.reason).toContain("raced");
  });

  test("does not add a second locate when the Computer stayed ready", async () => {
    const { gateway, locateCalls, rows } = gatewayFor(["ready", "ready"]);

    const result = await gateway.startComputer("bot-a", { id: "local" });

    expect(result.started).toBe(false);
    expect(locateCalls).toEqual(["bot-a"]);
    expect(rows.map((row) => row.eventType)).toEqual(["computer.started"]);
  });
});

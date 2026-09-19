import { describe, expect, test } from "bun:test";
import type { AuditEventInput } from "../src/audit";
import { createComputerGateway } from "../src/computer/gateway";
import type { ComputerLifecycleEvent } from "../src/computer/lifecycle";
import type { ComputerProvider } from "../src/computer/provider";

function fixture(latestEvent: ComputerLifecycleEvent | undefined) {
  const events: AuditEventInput[] = [];
  const provider: ComputerProvider = {
    name: "fixture",
    isolation: "per-bot",
    locate: async () => "http://127.0.0.1:4100",
    status: async (botId) => ({ botId, state: "absent" }),
    stop: async () => ({ wasRunning: false }),
    reset: async () => ({ cleared: false }),
    list: async () => [],
  };
  const gateway = createComputerGateway({
    provider,
    auditStore: {
      insert: async (event) => {
        events.push(event);
      },
    },
    policy: () => undefined,
    allowPrivateHosts: true,
    lifecycleReader: {
      latest: async (botIds) =>
        new Map(
          latestEvent && botIds.includes("bot-a")
            ? [["bot-a", latestEvent]]
            : [],
        ),
    },
  });
  return { events, gateway };
}

describe("Computer wake audit", () => {
  test("starting an automatically sleeping Computer is recorded as Wake", async () => {
    const { events, gateway } = fixture("computer.slept");

    await gateway.startComputer("bot-a", { id: "local" });

    expect(events.at(-1)?.eventType).toBe("computer.woke");
    expect(events.at(-1)?.payload.reason).toContain("woke");
  });

  test("starting after an explicit Stop remains a normal Start", async () => {
    const { events, gateway } = fixture("computer.stopped");

    await gateway.startComputer("bot-a", { id: "local" });

    expect(events.at(-1)?.eventType).toBe("computer.started");
  });
});

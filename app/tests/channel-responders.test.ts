import { describe, expect, test } from "bun:test";
import { resolveChannelResponder } from "../src/lib/channels/responders";

const AGENTS = ["knowledge", "risk", "writer"] as const;

describe("resolveChannelResponder", () => {
  test("an explicit mention wins", () => {
    expect(resolveChannelResponder(AGENTS, "risk", "knowledge")).toBe("risk");
  });

  test("a follow-up stays with the current responder", () => {
    expect(resolveChannelResponder(AGENTS, null, "writer")).toBe("writer");
  });

  test("a brand-new group falls back to its first member", () => {
    expect(resolveChannelResponder(AGENTS, null)).toBe("knowledge");
  });

  test("a stale or forged mention cannot route outside the channel", () => {
    expect(resolveChannelResponder(AGENTS, "outsider", "risk")).toBe("risk");
    expect(resolveChannelResponder(AGENTS, "outsider")).toBe("knowledge");
  });

  test("an empty channel has no responder", () => {
    expect(resolveChannelResponder([], null)).toBeNull();
  });
});

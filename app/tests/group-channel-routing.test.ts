import { describe, expect, test } from "bun:test";
import { groupMentionInstruction } from "../src/lib/channels/group-routing";

describe("group channel mention routing", () => {
  test("binds an explicit mention to exactly the selected peer Bot", () => {
    const instruction = groupMentionInstruction({
      coordinatorId: "assistant",
      targetId: "risk-analyst",
      targetName: "Risk Analyst",
    });

    expect(instruction).toContain("Risk Analyst");
    expect(instruction).toContain("Bot id: risk-analyst");
    expect(instruction).toContain('message_bot tool exactly once');
    expect(instruction).toContain('target "risk-analyst"');
    expect(instruction).toContain("not you (assistant)");
    expect(instruction).toContain("Do not solve the task yourself");
    expect(instruction).toContain("final answer will be relayed back");
  });
});

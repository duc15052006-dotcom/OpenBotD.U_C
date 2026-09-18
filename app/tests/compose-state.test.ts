import { describe, expect, test } from "bun:test";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  removeRecipient,
} from "../src/components/channels/compose-state";

const KNOWLEDGE = { id: "knowledge", name: "Knowledge" };
const RISK = { id: "risk-analyst", name: "Risk Analyst" };

describe("addRecipient", () => {
  test("adds to an empty list", () => {
    expect(addRecipient([], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });

  test("appends another coworker for a group channel", () => {
    expect(addRecipient([KNOWLEDGE], RISK)).toEqual([KNOWLEDGE, RISK]);
  });

  test("does not silently replace a coworker once the cap is reached", () => {
    const full = Array.from({ length: MAX_RECIPIENTS }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
    }));
    expect(addRecipient(full, RISK)).toEqual(full);
  });

  test("adding the coworker already chosen is a no-op", () => {
    expect(addRecipient([KNOWLEDGE], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });
});

describe("removeRecipient", () => {
  test("removes by id", () => {
    expect(removeRecipient([KNOWLEDGE], "knowledge")).toEqual([]);
  });

  test("ignores an id that is not present", () => {
    expect(removeRecipient([KNOWLEDGE], "nobody")).toEqual([KNOWLEDGE]);
  });
});

describe("canSend", () => {
  test("needs at least one recipient and some text", () => {
    expect(canSend([KNOWLEDGE], "hello")).toBe(true);
    expect(canSend([KNOWLEDGE, RISK], "hello team")).toBe(true);
  });

  test("refuses with no recipient", () => {
    expect(canSend([], "hello")).toBe(false);
  });

  test("refuses whitespace-only text", () => {
    expect(canSend([KNOWLEDGE], "   ")).toBe(false);
  });

  test("group channels are bounded", () => {
    expect(MAX_RECIPIENTS).toBe(8);
    const tooMany = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
    }));
    expect(canSend(tooMany, "hello")).toBe(false);
  });
});

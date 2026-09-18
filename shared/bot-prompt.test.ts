import { describe, expect, test } from "bun:test";
import { COMPUTER_GUIDANCE } from "./bot-prompt";

describe("COMPUTER_GUIDANCE", () => {
  test("keeps paragraph breaks as blank lines instead of collapsing them into spaces", () => {
    expect(COMPUTER_GUIDANCE).toContain("\n\n");
    expect(COMPUTER_GUIDANCE).not.toContain("  ");
  });

  test("keeps each paragraph as one unbroken line of prose", () => {
    for (const paragraph of COMPUTER_GUIDANCE.split("\n\n")) {
      expect(paragraph).not.toContain("\n");
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("treats human verification as a non-bypass boundary", () => {
    expect(COMPUTER_GUIDANCE).toContain(
      "NEVER solve, automate, outsource, evade or bypass those challenges",
    );
    expect(COMPUTER_GUIDANCE).toContain(
      "never use a CAPTCHA-solving service or another route around the verification",
    );
    expect(COMPUTER_GUIDANCE).toContain(
      "A security challenge is not an isolated value even when it shows one code field",
    );
    expect(COMPUTER_GUIDANCE).toContain("computer_request_help");
  });

  test("still contains the full instruction text, unchanged at its stable endpoints", () => {
    expect(COMPUTER_GUIDANCE).toContain(
      "You are a Bot with your own computer, a real web browser the person can watch you use.",
    );
    expect(COMPUTER_GUIDANCE).toContain(
      "Say what you found or did in plain language, briefly.",
    );
  });
});

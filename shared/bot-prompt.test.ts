import { describe, expect, test } from "bun:test";
import { COMPUTER_GUIDANCE, ROUTINE_GUIDANCE } from "./bot-prompt";

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

describe("ROUTINE_GUIDANCE", () => {
  test("recognises recurring work without inventing missing schedule details", () => {
    expect(ROUTINE_GUIDANCE).toContain(
      "requests to do something later, repeatedly, on a schedule, or as a recurring check",
    );
    expect(ROUTINE_GUIDANCE).toContain(
      "Never invent a clock time, cadence or timezone",
    );
    expect(ROUTINE_GUIDANCE).toContain(
      "every morning' names a part of the day, not an exact clock time",
    );
  });

  test("requires durable creation before promising background work", () => {
    expect(ROUTINE_GUIDANCE).toContain("Use create_routine to create it");
    expect(ROUTINE_GUIDANCE).toContain(
      "Never claim that you will keep watching or run later when no durable routine was actually created",
    );
  });

  test("confirms schedules in human-readable words instead of cron by default", () => {
    expect(ROUTINE_GUIDANCE).toContain(
      "confirm the schedule in ordinary words using the tool result",
    );
    expect(ROUTINE_GUIDANCE).toContain(
      "Do not make the person read cron syntax unless they explicitly ask for it",
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  AUTONOMOUS_WORKFLOW_GUIDANCE,
  COMPUTER_GUIDANCE,
  ROUTINE_GUIDANCE,
} from "./bot-prompt";

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

describe("AUTONOMOUS_WORKFLOW_GUIDANCE", () => {
  test("keeps the Agent goal-driven instead of hard-coding every task into one pipeline", () => {
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "operate from the person's goal",
    );
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "Do not turn this guidance into a fixed pipeline for unrelated tasks",
    );
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "Do not silently substitute a different service, account, custom chatbot, model, or order of operations",
    );
  });

  test("keeps every scene's prompt references and output isolated by project and scene", () => {
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain("projectId + sceneId");
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "Never mix, borrow, recycle or overwrite another scene's prompt, reference image or output",
    );
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "never put passwords, session cookies, API keys or other secrets into the checkpoint",
    );
  });

  test("executes approved prompts exactly instead of spending turns grading them", () => {
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "An approved prompt is an execution input, not something to grade",
    );
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "Submit the exact approved prompt and reference assets for that scene",
    );
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "Do not turn execution verification into another prompt-review loop",
    );
  });

  test("pins the NOTE 21-2 service handoff without mixing scene assets", () => {
    for (const evidence of [
      "script-writing chatbot",
      "prompt-writing chatbot",
      "ChatGPT/custom GPT",
      "send only that scene's reference image and exact scene prompt to Flow",
    ]) {
      expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(evidence);
    }
  });

  test("does not fake background wakeups or busy-loop while generation is pending", () => {
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "not a reason to resubmit the scene or burn model turns in a refresh-and-reason loop",
    );
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "Never claim you will automatically wake, monitor in the background or receive a completion event",
    );
  });

  test("pins the NOTE 21-2 planning budget without pretending usage metering exists", () => {
    for (const evidence of [
      "1,000–5,000",
      "15,000–40,000",
      "50,000–100,000",
      "1,000,000",
      "when usage accounting is available",
    ]) {
      expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(evidence);
    }
    expect(AUTONOMOUS_WORKFLOW_GUIDANCE).toContain(
      "stop and ask how they want to proceed rather than silently overspending",
    );
  });
});

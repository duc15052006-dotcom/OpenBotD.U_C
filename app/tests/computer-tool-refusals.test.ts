import { afterEach, describe, expect, test } from "bun:test";
import {
  callComputer,
  captureComputerScreenshot,
} from "../src/lib/copilot/computer-tools";

/**
 * What a Bot is told when its action did not happen.
 *
 * Every refusal reaches the model as this object, and the fields decide what it does next: `staleRefs`
 * is the one its own tool description turns into "the page changed, call this again with the new
 * refs", so labelling a takeover with it sends the Bot back round the same action against the person
 * who just took the browser. The server carries `humanHasControl` for exactly that reason; this is
 * the end of that wire, and the only place the two conditions are told apart for the model.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function serverAnswering(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("computer screenshot capture", () => {
  test("returns compact metadata without feeding image bytes into model context", async () => {
    const base64 = "A".repeat(20_000);
    serverAnswering(200, {
      frame: {
        base64,
        width: 1280,
        height: 800,
        capturedAt: "2026-10-07T07:00:00.000Z",
        url: "https://example.com/",
      },
    });

    const outcome = await captureComputerScreenshot("bot-1", "tool-shot-1");

    expect(outcome).toEqual({
      ok: true,
      width: 1280,
      height: 800,
      capturedAt: "2026-10-07T07:00:00.000Z",
      url: "https://example.com/",
    });
    expect(JSON.stringify(outcome)).not.toContain(base64);
  });

  test("reports an unavailable screen as a normal tool failure", async () => {
    serverAnswering(503, { error: "Browser is not running." });

    const outcome = await captureComputerScreenshot("bot-1", "tool-shot-2");

    expect(outcome).toEqual({
      ok: false,
      reason: "Browser is not running.",
    });
  });
});

describe("a computer call the server refused", () => {
  test("a person holding the wheel is reported as that, not as stale refs", async () => {
    serverAnswering(409, {
      error: "A person has taken control of this computer.",
      humanHasControl: true,
    });

    const outcome = await callComputer("bot-1", "/click", { method: "POST" });

    expect(outcome.ok).toBe(false);
    expect(outcome.humanHasControl).toBe(true);
    // The instruction that must not be attached: it would send the Bot round again.
    expect(outcome.staleRefs).toBeUndefined();
    expect(outcome.reason).toBe("A person has taken control of this computer.");
  });

  test("a stale snapshot is still reported as stale refs", async () => {
    // The half that must not move. Losing this would park a Bot with genuinely stale refs waiting for
    // a person who is not coming.
    serverAnswering(409, { error: "Snapshot 3 is not the current one." });

    const outcome = await callComputer("bot-1", "/click", { method: "POST" });

    expect(outcome.ok).toBe(false);
    expect(outcome.staleRefs).toBe(true);
    expect(outcome.humanHasControl).toBeUndefined();
  });

  test("a policy refusal is neither", async () => {
    serverAnswering(403, {
      error: "That is not allowed here.",
      rule: 'url.host == "example.com"',
    });

    const outcome = await callComputer("bot-1", "/click", { method: "POST" });

    expect(outcome.refused).toBe(true);
    expect(outcome.staleRefs).toBeUndefined();
    expect(outcome.humanHasControl).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { createComputerLifecycleLock } from "../src/computer-lifecycle-lock";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Computer lifecycle lock", () => {
  test("serializes lifecycle work for the same Bot", async () => {
    const lock = createComputerLifecycleLock();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = lock.run("bot-a", async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    await tick();

    const second = lock.run("bot-a", async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await tick();

    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("does not serialize different Bots", async () => {
    const lock = createComputerLifecycleLock();
    const events: string[] = [];
    let releaseA!: () => void;
    const aBlocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = lock.run("bot-a", async () => {
      events.push("a:start");
      await aBlocked;
      events.push("a:end");
    });
    await tick();

    const b = lock.run("bot-b", async () => {
      events.push("b:start");
      events.push("b:end");
    });
    await b;

    expect(events).toEqual(["a:start", "b:start", "b:end"]);
    releaseA();
    await a;
  });

  test("releases the next operation after a failure", async () => {
    const lock = createComputerLifecycleLock();

    await expect(
      lock.run("bot-a", async () => {
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");

    await expect(lock.run("bot-a", async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });
});

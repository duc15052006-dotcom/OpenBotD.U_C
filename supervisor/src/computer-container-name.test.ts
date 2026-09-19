import { describe, expect, test } from "bun:test";
import { isPrimaryComputerContainerName } from "./computer-container-name";

describe("Computer fleet container identity", () => {
  test("accepts only the predictable primary Computer name", () => {
    expect(
      isPrimaryComputerContainerName("openbot-computer-bot-a", [
        "/openbot-computer-bot-a",
      ]),
    ).toBe(true);
    expect(
      isPrimaryComputerContainerName("openbot-computer-bot-a", [
        "/random-snapshot-copy-helper",
      ]),
    ).toBe(false);
    expect(
      isPrimaryComputerContainerName("openbot-computer-bot-a", undefined),
    ).toBe(false);
  });

  test("does not let another Bot or helper alias become the fleet row", () => {
    expect(
      isPrimaryComputerContainerName("openbot-computer-bot-a", [
        "/openbot-computer-bot-b",
        "/snapshot-helper-bot-a",
      ]),
    ).toBe(false);
  });
});

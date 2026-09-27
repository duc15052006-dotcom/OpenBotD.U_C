import { describe, expect, test } from "bun:test";
import { classifyClamAvResult } from "../src/quarantine-scanner";

describe("ClamAV result classification", () => {
  test("only exit code zero is clean", () => {
    expect(classifyClamAvResult(0, "", "").status).toBe("clean");
  });

  test("malware findings are blocked", () => {
    const result = classifyClamAvResult(
      1,
      "/quarantine/file: Eicar-Test-Signature FOUND\n",
      "",
    );
    expect(result.status).toBe("blocked");
    expect(result.detail).toContain("FOUND");
  });

  test("scanner errors and timeouts fail closed", () => {
    expect(classifyClamAvResult(2, "", "database missing").status).toBe(
      "scan_failed",
    );
    expect(classifyClamAvResult(0, "", "", true).status).toBe("scan_failed");
  });
});

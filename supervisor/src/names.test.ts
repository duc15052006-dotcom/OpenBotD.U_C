import { describe, expect, test } from "bun:test";

import { namesFor } from "./names";

describe("per-Bot computer storage names", () => {
  test("different Bots cannot resolve to the same computer or persistent volumes", () => {
    const alpha = namesFor("agent-alpha");
    const beta = namesFor("agent-beta");
    expect(alpha.ok).toBe(true);
    expect(beta.ok).toBe(true);
    if (!alpha.ok || !beta.ok) return;

    expect(alpha.names.container).not.toBe(beta.names.container);
    expect(alpha.names.profileVolume).not.toBe(beta.names.profileVolume);
    expect(alpha.names.workspaceVolume).not.toBe(beta.names.workspaceVolume);
  });

  test("Bot ids cannot smuggle host paths into derived names", () => {
    for (const id of ["../Users", "C:\\Users\\owner", "/etc", ".ssh", "a/b"]) {
      expect(namesFor(id).ok).toBe(false);
    }
  });
});

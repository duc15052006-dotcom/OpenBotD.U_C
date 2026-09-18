import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Csp = Record<string, string | string[]>;

type TauriConfig = {
  app?: {
    security?: {
      csp?: Csp | string | null;
      devCsp?: Csp | string | null;
      dangerousDisableAssetCspModification?: boolean;
      dangerousRemoteUrlIpcAccess?: unknown;
      dangerousRemoteDomainIpcAccess?: unknown;
    };
  };
};

function config(): TauriConfig {
  return JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as TauriConfig;
}

function text(csp: Csp | string): string {
  return typeof csp === "string"
    ? csp
    : Object.entries(csp)
        .flatMap(([directive, sources]) => [
          directive,
          ...(Array.isArray(sources) ? sources : [sources]),
        ])
        .join(" ");
}

type Capability = {
  windows?: string[];
  permissions?: string[];
  remote?: unknown;
};

function capability(): Capability {
  return JSON.parse(
    readFileSync(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ) as Capability;
}

describe("desktop CSP", () => {
  test("production enables CSP and keeps remote network access out of the setup webview", () => {
    const security = config().app?.security;
    expect(security?.csp).toBeTruthy();
    expect(security?.csp).not.toBeNull();

    const policy = text(security?.csp as Csp | string);
    expect(policy).toContain("connect-src");
    expect(policy).toContain("ipc:");
    expect(policy).toContain("http://ipc.localhost");
    expect(policy).toContain("http://asset.localhost");
    expect(policy).toContain("object-src");
    expect(policy).toContain("'none'");
    expect(policy).not.toContain("*");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/https?:\/\/(?!(?:ipc|asset)\.localhost\b)/);
    expect(policy).not.toMatch(/wss?:\/\//);
  });

  test("development opens only Vite's local HMR endpoints in addition to IPC", () => {
    const dev = config().app?.security?.devCsp;
    expect(dev).toBeTruthy();

    const policy = text(dev as Csp | string);
    expect(policy).toContain("http://localhost:3020");
    expect(policy).toContain("ws://localhost:3020");
    expect(policy).not.toContain("*");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/https:\/\//);
    expect(policy).not.toMatch(/wss:\/\//);
  });

  test("Tauri keeps asset CSP rewriting enabled", () => {
    expect(
      config().app?.security?.dangerousDisableAssetCspModification,
    ).not.toBe(true);
  });

  test("remote pages never receive legacy IPC access either", () => {
    const security = config().app?.security;
    expect(security?.dangerousRemoteUrlIpcAccess).toBeUndefined();
    expect(security?.dangerousRemoteDomainIpcAccess).toBeUndefined();
  });
});

describe("desktop Tauri capability surface", () => {
  test("the webview receives only the event capability it actually uses", () => {
    const allowed = capability();
    expect(allowed.windows).toEqual(["main"]);
    expect(allowed.permissions).toEqual(["core:event:default"]);
    // The main window intentionally navigates to the local OpenBot web app after setup. That remote
    // HTTP page must remain ordinary web content, never a Tauri-command caller.
    expect(allowed.remote).toBeUndefined();
    expect(
      allowed.permissions?.some((permission) =>
        /shell|opener|dialog|fs|process|http/i.test(permission),
      ),
    ).toBe(false);
  });
});

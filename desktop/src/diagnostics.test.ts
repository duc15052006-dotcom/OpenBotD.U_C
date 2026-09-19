import { describe, expect, test } from "bun:test";
import {
  collectDesktopDiagnostics,
  formatDesktopDiagnostics,
} from "./diagnostics";

describe("desktop diagnostics", () => {
  test("collects only the allowlisted read-only setup status", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    const call = async <T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ command, args });
      const values: Record<string, unknown> = {
        desktop_build_identity: {
          version: "0.0.12",
          sourceRevision: "0123456789abcdef0123456789abcdef01234567",
          releaseRepository: "duc15052006-dotcom/OpenBotD.U_C",
        },
        detect_engine: {
          engine: "docker",
          responding: true,
          detail: "Docker is answering.",
        },
        selected_root: "C:\\OpenBot",
        default_root: "C:\\Users\\Example\\OpenBot",
        last_failure: { said: "A previous local start failed." },
        already_running: true,
      };
      return values[command] as T;
    };

    const diagnostics = await collectDesktopDiagnostics(call);

    expect(diagnostics.build).toEqual({
      version: "0.0.12",
      sourceRevision: "0123456789abcdef0123456789abcdef01234567",
      releaseRepository: "duc15052006-dotcom/OpenBotD.U_C",
    });
    expect(diagnostics.engine).toMatchObject({
      engine: "docker",
      responding: true,
    });
    expect(diagnostics.selectedRoot).toBe("C:\\OpenBot");
    expect(diagnostics.stackRunning).toBe(true);
    expect(diagnostics.lastFailure).toBe("A previous local start failed.");
    expect(calls).toEqual([
      { command: "desktop_build_identity", args: undefined },
      { command: "detect_engine", args: undefined },
      { command: "selected_root", args: undefined },
      { command: "default_root", args: undefined },
      { command: "last_failure", args: undefined },
      { command: "already_running", args: { root: "C:\\OpenBot" } },
    ]);
  });

  test("does not leak failure detail into the support summary", async () => {
    const diagnostics = await collectDesktopDiagnostics(
      async <T>(command: string): Promise<T> => {
        const values: Record<string, unknown> = {
          desktop_build_identity: {
            version: "0.0.12",
            sourceRevision: null,
            releaseRepository: "duc15052006-dotcom/OpenBotD.U_C",
          },
          detect_engine: null,
          selected_root: null,
          default_root: "C:\\OpenBot",
          last_failure: {
            said: "The stack did not start.",
            detail: "SECRET_API_KEY=must-not-leak",
          },
          already_running: false,
        };
        return values[command] as T;
      },
    );

    const report = formatDesktopDiagnostics(diagnostics);
    expect(report).toContain("Desktop version: 0.0.12");
    expect(report).toContain(
      "Release repository: duc15052006-dotcom/OpenBotD.U_C",
    );
    expect(report).toContain("Last failure: The stack did not start.");
    expect(report).not.toContain("SECRET_API_KEY");
    expect(report).not.toContain("must-not-leak");
  });

  test("degrades individual probes to unknown instead of failing diagnostics", async () => {
    const diagnostics = await collectDesktopDiagnostics(
      async <T>(command: string): Promise<T> => {
        if (command === "default_root") return "C:\\OpenBot" as T;
        throw new Error("probe failed");
      },
    );

    expect(diagnostics.build).toBeNull();
    expect(diagnostics.engine).toBeNull();
    expect(diagnostics.selectedRoot).toBeNull();
    expect(diagnostics.stackRunning).toBeNull();
    expect(diagnostics.lastFailure).toBeNull();
  });
});

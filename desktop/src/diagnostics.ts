import { invoke } from "@tauri-apps/api/core";

export type DesktopDiagnostics = {
  capturedAt: string;
  build: {
    version: string;
    sourceRevision: string | null;
    releaseRepository: string;
  } | null;
  engine: {
    engine: "docker" | "podman" | null;
    responding: boolean;
    detail: string;
  } | null;
  selectedRoot: string | null;
  defaultRoot: string | null;
  stackRunning: boolean | null;
  lastFailure: string | null;
};

type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * Gather the minimum useful support snapshot without reading credentials or the deployment env.
 *
 * The setup screen already has commands for every fact below. Diagnostics composes those existing
 * read-only boundaries rather than adding a native command that could accidentally grow into
 * dumping .env, tokens, or provider configuration.
 */
export async function collectDesktopDiagnostics(
  call: Invoke = invoke,
): Promise<DesktopDiagnostics> {
  const [build, engine, selectedRoot, defaultRoot, lastFailure] =
    await Promise.all([
      call<DesktopDiagnostics["build"]>("desktop_build_identity").catch(
        () => null,
      ),
      call<DesktopDiagnostics["engine"]>("detect_engine").catch(() => null),
      call<string | null>("selected_root").catch(() => null),
      call<string>("default_root").catch(() => null),
      call<{ said?: string } | null>("last_failure").catch(() => null),
    ]);

  const root = selectedRoot ?? defaultRoot;
  const stackRunning = root
    ? await call<boolean>("already_running", { root }).catch(() => null)
    : null;

  return {
    capturedAt: new Date().toISOString(),
    build,
    engine,
    selectedRoot,
    defaultRoot,
    stackRunning,
    lastFailure:
      lastFailure && typeof lastFailure.said === "string"
        ? lastFailure.said
        : null,
  };
}

export function formatDesktopDiagnostics(
  diagnostics: DesktopDiagnostics,
): string {
  const engine = diagnostics.engine;
  const build = diagnostics.build;
  return [
    `Captured: ${diagnostics.capturedAt}`,
    `Desktop version: ${build?.version ?? "unknown"}`,
    `Source revision: ${build?.sourceRevision ?? "unknown"}`,
    `Release repository: ${build?.releaseRepository ?? "unknown"}`,
    `Engine: ${engine?.engine ?? "not detected"}`,
    `Engine responding: ${engine ? String(engine.responding) : "unknown"}`,
    `Engine detail: ${engine?.detail ?? "unavailable"}`,
    `Selected root: ${diagnostics.selectedRoot ?? "none"}`,
    `Default root: ${diagnostics.defaultRoot ?? "unknown"}`,
    `Stack running: ${
      diagnostics.stackRunning === null
        ? "unknown"
        : String(diagnostics.stackRunning)
    }`,
    `Last failure: ${diagnostics.lastFailure ?? "none"}`,
  ].join("\n");
}

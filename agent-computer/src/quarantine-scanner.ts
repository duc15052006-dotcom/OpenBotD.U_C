export type MalwareScanStatus = "clean" | "blocked" | "scan_failed";

export type MalwareScanResult = {
  status: MalwareScanStatus;
  scanner: "clamav";
  detail: string;
  scannedAt: string;
};

const DEFAULT_SCAN_TIMEOUT_MS = 120_000;
const DETAIL_LIMIT = 1_000;

function concise(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > DETAIL_LIMIT
    ? `${normalized.slice(0, DETAIL_LIMIT)}…`
    : normalized;
}

/**
 * ClamAV's documented exit contract:
 * 0 = no virus found, 1 = virus found, anything else = scanner failure.
 *
 * A scanner failure is deliberately not "clean". Export/release code may only accept the exact
 * clean state, so a missing signature database, missing executable, timeout, or internal error all
 * fail closed.
 */
export function classifyClamAvResult(
  exitCode: number,
  stdout: string,
  stderr: string,
  killed = false,
): MalwareScanResult {
  const scannedAt = new Date().toISOString();
  if (killed) {
    return {
      status: "scan_failed",
      scanner: "clamav",
      detail: "ClamAV did not finish before the scan timeout.",
      scannedAt,
    };
  }

  if (exitCode === 0) {
    return {
      status: "clean",
      scanner: "clamav",
      detail: "ClamAV reported no malware.",
      scannedAt,
    };
  }

  if (exitCode === 1) {
    const found =
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => / FOUND$/i.test(line)) ?? "ClamAV reported malware.";
    return {
      status: "blocked",
      scanner: "clamav",
      detail: concise(found),
      scannedAt,
    };
  }

  return {
    status: "scan_failed",
    scanner: "clamav",
    detail:
      concise(stderr) ||
      concise(stdout) ||
      `ClamAV failed with exit code ${exitCode}.`,
    scannedAt,
  };
}

export async function scanWithClamAv(
  file: string,
  options: {
    executable?: string;
    timeoutMs?: number;
  } = {},
): Promise<MalwareScanResult> {
  const executable =
    options.executable?.trim() ||
    process.env.COMPUTER_CLAMAV_PATH?.trim() ||
    "clamscan";
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;

  try {
    const process = Bun.spawn(
      [executable, "--no-summary", "--", file],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
    );

    const stdoutPromise =
      process.stdout instanceof ReadableStream
        ? new Response(process.stdout).text()
        : Promise.resolve("");
    const stderrPromise =
      process.stderr instanceof ReadableStream
        ? new Response(process.stderr).text()
        : Promise.resolve("");
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    return classifyClamAvResult(exitCode, stdout, stderr, process.killed);
  } catch (error) {
    return {
      status: "scan_failed",
      scanner: "clamav",
      detail: concise(
        error instanceof Error
          ? error.message
          : "ClamAV could not be started.",
      ),
      scannedAt: new Date().toISOString(),
    };
  }
}

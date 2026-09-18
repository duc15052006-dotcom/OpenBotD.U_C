import { readFile, statfs } from "node:fs/promises";
import { availableParallelism } from "node:os";

export type ComputerResourceMetrics = {
  /** CPU used during a short sample, normalized to the CPU capacity this cgroup may use. */
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  /** Null when the cgroup has no explicit memory ceiling. */
  memoryLimitBytes: number | null;
  workspaceUsedBytes: number | null;
  workspaceTotalBytes: number | null;
  measuredAt: string;
};

const CGROUP = "/sys/fs/cgroup";

async function text(path: string): Promise<string | null> {
  return readFile(path, "utf8")
    .then((value) => value.trim())
    .catch(() => null);
}

function positiveNumber(value: string | null): number | null {
  if (!value || value === "max") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function cpuUsageMicros(): Promise<number | null> {
  const cpuStat = await text(`${CGROUP}/cpu.stat`);
  const match = cpuStat?.match(/^usage_usec\s+(\d+)$/m);
  if (!match) return null;
  return positiveNumber(match[1] ?? null);
}

function countCpuSet(value: string | null): number | null {
  if (!value) return null;
  let count = 0;
  for (const piece of value.split(",")) {
    const [fromRaw, toRaw] = piece.trim().split("-");
    const from = Number(fromRaw);
    const to = toRaw === undefined ? from : Number(toRaw);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from
    ) {
      return null;
    }
    count += to - from + 1;
  }
  return count > 0 ? count : null;
}

async function cpuCapacity(): Promise<number> {
  const [limit, cpuset] = await Promise.all([
    text(`${CGROUP}/cpu.max`),
    text(`${CGROUP}/cpuset.cpus.effective`),
  ]);

  let quotaCpus: number | null = null;
  if (limit) {
    const [quotaRaw, periodRaw] = limit.split(/\s+/);
    if (quotaRaw !== "max") {
      const quota = Number(quotaRaw);
      const period = Number(periodRaw);
      if (
        Number.isFinite(quota) &&
        Number.isFinite(period) &&
        quota > 0 &&
        period > 0
      ) {
        quotaCpus = quota / period;
      }
    }
  }

  const setCpus = countCpuSet(cpuset);
  const hostCpus = Math.max(1, availableParallelism());
  const candidates = [quotaCpus, setCpus, hostCpus].filter(
    (value): value is number =>
      value !== null && Number.isFinite(value) && value > 0,
  );
  return Math.max(0.01, Math.min(...candidates));
}

async function sampledCpuPercent(): Promise<number | null> {
  const first = await cpuUsageMicros();
  if (first === null) return null;
  const capacity = await cpuCapacity();
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await cpuUsageMicros();
  if (second === null) return null;

  const elapsedMicros = Math.max(1, (performance.now() - started) * 1_000);
  const percent = ((second - first) / elapsedMicros / capacity) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10;
}

async function memory(): Promise<{
  used: number | null;
  limit: number | null;
}> {
  const [usedRaw, limitRaw] = await Promise.all([
    text(`${CGROUP}/memory.current`),
    text(`${CGROUP}/memory.max`),
  ]);
  return {
    used: positiveNumber(usedRaw),
    limit: positiveNumber(limitRaw),
  };
}

async function workspaceDisk(
  workspaceDir: string,
): Promise<{ used: number | null; total: number | null }> {
  try {
    const stats = await statfs(workspaceDir);
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    return {
      total: Number.isFinite(total) ? total : null,
      used: Number.isFinite(total - available) ? total - available : null,
    };
  } catch {
    return { used: null, total: null };
  }
}

/**
 * Read-only resource telemetry for the computer container.
 *
 * Nothing here opens Chromium or touches the workspace contents. CPU and memory come from cgroup v2
 * when available; a platform that does not expose those files reports null rather than fabricating
 * host-wide numbers that would look Agent-specific. Disk is the filesystem containing the durable
 * workspace volume.
 */
export async function computerResourceMetrics(
  workspaceDir: string,
): Promise<ComputerResourceMetrics> {
  const [cpuPercent, memoryValue, disk] = await Promise.all([
    sampledCpuPercent(),
    memory(),
    workspaceDisk(workspaceDir),
  ]);
  return {
    cpuPercent,
    memoryUsedBytes: memoryValue.used,
    memoryLimitBytes: memoryValue.limit,
    workspaceUsedBytes: disk.used,
    workspaceTotalBytes: disk.total,
    measuredAt: new Date().toISOString(),
  };
}

import { readFile, statfs } from "node:fs/promises";
import { availableParallelism } from "node:os";

export type ComputerResourceMetrics = {
  capturedAt: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number | null;
  diskUsedBytes: number;
  diskTotalBytes: number;
};

const CGROUP = "/sys/fs/cgroup";

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function cpuUsageUsecFromStat(stat: string | null): number | null {
  if (!stat) return null;
  const match = stat.match(/(?:^|\n)usage_usec\s+(\d+)(?:\n|$)/);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function cpuCapacityFromMax(
  cpuMax: string | null,
  fallback = Math.max(1, availableParallelism()),
): number {
  if (!cpuMax) return fallback;
  const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
  if (!quotaRaw || quotaRaw === "max" || !periodRaw) return fallback;
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) {
    return fallback;
  }
  return Math.max(quota / period, 0.01);
}

async function cgroupCpuPercent(sampleMs: number): Promise<number | null> {
  const [firstStat, cpuMax] = await Promise.all([
    readText(`${CGROUP}/cpu.stat`),
    readText(`${CGROUP}/cpu.max`),
  ]);
  const first = cpuUsageUsecFromStat(firstStat);
  if (first === null) return null;

  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const second = cpuUsageUsecFromStat(await readText(`${CGROUP}/cpu.stat`));
  if (second === null) return null;

  const elapsedUsec = Math.max((performance.now() - started) * 1_000, 1);
  const capacity = cpuCapacityFromMax(cpuMax);
  return finiteNonNegative(((second - first) / elapsedUsec / capacity) * 100);
}

async function processCpuPercent(sampleMs: number): Promise<number> {
  const first = process.cpuUsage();
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const elapsedUsec = Math.max((performance.now() - started) * 1_000, 1);
  const used = process.cpuUsage(first);
  const capacity = Math.max(1, availableParallelism());
  return finiteNonNegative(((used.user + used.system) / elapsedUsec / capacity) * 100);
}

async function memoryMetrics(): Promise<{
  memoryUsedBytes: number;
  memoryLimitBytes: number | null;
}> {
  const [currentRaw, maxRaw] = await Promise.all([
    readText(`${CGROUP}/memory.current`),
    readText(`${CGROUP}/memory.max`),
  ]);
  const current = Number(currentRaw);
  if (currentRaw !== null && Number.isFinite(current) && current >= 0) {
    const max = maxRaw === "max" ? null : Number(maxRaw);
    return {
      memoryUsedBytes: current,
      memoryLimitBytes:
        maxRaw !== null && Number.isFinite(max) && max > 0 ? max : null,
    };
  }

  return {
    memoryUsedBytes: finiteNonNegative(process.memoryUsage().rss),
    memoryLimitBytes: null,
  };
}

async function diskMetrics(workspaceRoot: string): Promise<{
  diskUsedBytes: number;
  diskTotalBytes: number;
}> {
  try {
    const stats = await statfs(workspaceRoot);
    const total = finiteNonNegative(stats.blocks * stats.bsize);
    const free = finiteNonNegative(stats.bfree * stats.bsize);
    return {
      diskUsedBytes: Math.max(0, total - free),
      diskTotalBytes: total,
    };
  } catch {
    return { diskUsedBytes: 0, diskTotalBytes: 0 };
  }
}

/**
 * Resource usage of this computer container.
 *
 * CPU and memory prefer cgroup v2 so Chromium child processes count too. The process fallback keeps
 * local development useful on hosts without cgroups. Disk is the filesystem that backs /workspace.
 */
export async function collectComputerMetrics(
  workspaceRoot: string,
  sampleMs = 100,
): Promise<ComputerResourceMetrics> {
  const [cpu, memory, disk] = await Promise.all([
    cgroupCpuPercent(sampleMs).then((value) =>
      value === null ? processCpuPercent(sampleMs) : value,
    ),
    memoryMetrics(),
    diskMetrics(workspaceRoot),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    cpuPercent: Math.round(cpu * 10) / 10,
    ...memory,
    ...disk,
  };
}

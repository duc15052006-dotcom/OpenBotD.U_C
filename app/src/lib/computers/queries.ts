import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One Bot's computer, as Admin sees it. */
export type ComputerResourceMetrics = {
  capturedAt: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number | null;
  diskUsedBytes: number;
  diskTotalBytes: number;
  /** False means the Computer container is awake but its browser has gone idle/sleep. */
  browserRunning?: boolean;
};

export type QuarantineStatus =
  | "pending"
  | "clean"
  | "blocked"
  | "scan_failed"
  | "approved"
  | "released";

export type QuarantineEntry = {
  version: 2;
  status: QuarantineStatus;
  id: string;
  botId: string;
  originalName: string;
  sourceUrl: string;
  savedAt: string;
  sizeBytes: number;
  sha256: string;
  scannedSha256?: string;
  scan?: {
    status: "clean" | "blocked" | "scan_failed";
    scanner: "clamav";
    detail: string;
    scannedAt: string;
  };
  approvedAt?: string;
  releasedAt?: string;
};

export type QuarantineList = {
  downloads: QuarantineEntry[];
};

export type ComputerLifecycle = "running" | "idle" | "sleeping" | "stopped";

export type ComputerProfile = {
  botId: string;
  running: boolean;
  /** Optional during rolling upgrades; derive from running/metrics when an older server omits it. */
  lifecycle?: ComputerLifecycle;
  startedAt: string | null;
  /** Absent when the provider does not report egress at all, which is not the same as none. */
  egress?: string | null;
  /** True when the supervisor reports a complete owned clean snapshot for this Bot. */
  snapshotAvailable?: boolean;
  /** Present only when a running computer answered the lightweight metrics probe. */
  metrics?: ComputerResourceMetrics;
};

/** Whether each Bot has a browser profile of its own, or they share one. */
export type ComputerIsolation = "per-bot" | "shared";

/** What the list endpoint answers: the computers, and how they are separated. */
export type ComputerFleet = {
  computers: ComputerProfile[];
  isolation?: ComputerIsolation;
  capacity?: {
    memoryBytes: number | null;
    logicalCpus: number | null;
    maxActiveComputers: number | null;
    resourceProfiles: Record<
      "light" | "normal" | "heavy",
      { memoryBytes: number; nanoCpus: number }
    >;
  };
};

/**
 * Whether the boundary acts on its verdict.
 *
 * `dry-run` records what it would have refused without refusing it, which is how a policy is tried
 * out before it stops a Bot mid-task.
 */
export type PolicyMode = "dry-run" | "enforce";

/** The rules a Bot's actions are judged against. */
export type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
};

export const computerKeys = {
  all: ["computers"] as const,
  fleet: () => ["computers", "fleet"] as const,
  policy: () => ["computers", "policy"] as const,
  quarantine: (botId: string) => ["computers", "quarantine", botId] as const,
};

/**
 * The deployment-wide fleet route.
 *
 * Not a Bot id in a member route, which is what this used to be. That placeholder stopped working
 * when the server began checking whether the caller may act as the Bot in the path: a placeholder
 * is not a Bot, so the list 404d and this screen showed nothing at all.
 */
const FLEET_PATH = "/api/computers/fleet";

/** No envelope key: the body carries both the list and the isolation mode. */
export function computerFleetQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.fleet(),
    queryFn: async (): Promise<ComputerFleet> => {
      const response = await client(FLEET_PATH, {
        fallback: "The computers could not be listed.",
      });
      return response.json();
    },
    // Resource samples are useful only while fresh. TanStack Query pauses this in the background,
    // so an open Admin page updates without turning hidden tabs into a monitoring daemon.
    refetchInterval: 5_000,
  });
}

export function quarantineQueryOptions(botId: string) {
  return queryOptions({
    queryKey: computerKeys.quarantine(botId),
    queryFn: async (): Promise<QuarantineList> => {
      const response = await client(
        `/api/computers/${encodeURIComponent(botId)}/quarantine`,
        {
          fallback: "The quarantine could not be listed.",
        },
      );
      return response.json();
    },
  });
}

export function actionPolicyQueryOptions() {
  return queryOptions({
    queryKey: computerKeys.policy(),
    queryFn: (): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        fallback: "The boundary could not be read.",
      }),
  });
}

/** One recorded action a candidate policy would decide differently than what happened. */
export type DryRunChange = {
  id: string;
  createdAt: string;
  action: string;
  bot: string;
  page: string;
  element: { role: string; name: string } | null;
  command: string | null;
  file: string | null;
  was: "allowed" | "refused";
  would: "allowed" | "refused";
  rule: string | null;
  reason: string;
};

export type DryRunReport = {
  scanned: number;
  wouldRefuse: number;
  wouldAllow: number;
  unchanged: number;
  /** Capped by the server; the counts cover everything scanned. */
  changes: DryRunChange[];
};

/**
 * What would this policy have decided, about recent recorded actions?
 *
 * A plain function rather than a query: the answer is about this candidate at this moment, nothing
 * caches it and nothing invalidates it. It writes nothing — not the policy, and no audit row.
 */
export async function dryRunActionPolicy(
  candidate: ActionPolicy,
): Promise<DryRunReport> {
  return client("/api/computers/policy-dry-run", "report", {
    method: "POST",
    body: { policy: candidate },
    fallback: "The rule could not be tested against history.",
  });
}

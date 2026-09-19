import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

export type AgentVisibility = "public" | "private";

/**
 * A coworker as the browser sees it.
 *
 * `canManage` and `systemOwned` are server-decided authorization facts; components render from the
 * returned flags rather than recomputing ownership rules.
 */
export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /**
   * Whether it runs on this deployment's own Bot.
   *
   * Creating a coworker with no endpoint stores the deployment's managed address, so `endpoint`
   * alone cannot tell "built-in" from "hosted by a person" — and the difference decides whether the
   * Connection screen asks for a callback token. A built-in coworker calls tools back with the
   * deployment's own credential and needs no setup at all.
   */
  builtIn: boolean;
  /** Whether a key is set for it. Never the key itself. */
  hasAuth: boolean;
  /**
   * Whether this coworker holds a credential for calling tools back.
   *
   * A boolean, because the token is readable exactly once: in the response that issued it. The
   * surface needs this only to decide between offering "generate" and "rotate".
   */
  hasCallbackToken: boolean;
  hidden: boolean;
  systemOwned: boolean;
  canManage: boolean;
  /**
   * Whether the signed-in person created this coworker.
   *
   * Separate from `canManage`, which is also true for administrators on everybody's coworkers. Split
   * a roster on `canManage` and an administrator's "mine" fills up with other people's work.
   */
  mine: boolean;
};

/**
 * Whether this is an agent shared with you: made public by somebody else, not your own.
 *
 * Written once so the roster (`/`) and the browse screen (`/agents`) can't drift apart on what
 * "shared with you" means — both filter their list through this, not a copy of the rule.
 */
export function isSharedWithYou(agent: AgentProfile): boolean {
  return !agent.mine && agent.visibility === "public";
}

export const agentKeys = {
  all: ["agents"] as const,
  list: (hidden = false) => ["agents", "list", { hidden }] as const,
  detail: (agentId: string) => ["agents", "detail", agentId] as const,
  botRouteDetail: (agentId: string) =>
    ["agents", "bot-route-detail", agentId] as const,
  handoff: (agentId: string) => ["agents", "handoff", agentId] as const,
  capabilities: () => ["agents", "capabilities"] as const,
  model: (agentId: string) => ["agents", "model", agentId] as const,
  instructions: (agentId: string) =>
    ["agents", "instructions", agentId] as const,
  knowledge: (agentId: string) => ["agents", "knowledge", agentId] as const,
  memory: (agentId: string) => ["agents", "memory", agentId] as const,
  memoryHistory: (agentId: string) =>
    ["agents", "memory", agentId, "history"] as const,
};

/** Keep the browser counter aligned with the server-enforced prompt limit. */
export const AGENT_INSTRUCTIONS_LIMIT = 8_000;

export type AgentInstructionsSettings = {
  instructions: string;
  canManage: boolean;
};

export type AgentKnowledgeDocument = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  characters: number;
};

export type AgentKnowledgeSettings = {
  documents: AgentKnowledgeDocument[];
  canManage: boolean;
  limits: {
    documents: number;
    fileBytes: number;
    documentCharacters: number;
    totalCharacters: number;
  };
};

export const AGENT_MEMORY_LIMIT = 8_000;

export type AgentMemorySettings = {
  memory: string;
  revisionId: string | null;
  canManage: boolean;
};

export type AgentMemoryHistoryEntry = {
  id: string;
  createdAt: string;
  kind: "edit" | "undo";
  sourceRevisionId?: string;
  characters: number;
  preview: string;
};

export type AgentMemoryHistory = {
  revisions: AgentMemoryHistoryEntry[];
  canManage: boolean;
};

export type AgentMemoryDiff = {
  revision: AgentMemoryHistoryEntry;
  lines: Array<{ type: "same" | "added" | "removed"; text: string }>;
};

export type AgentModelProvider = "openai" | "anthropic" | "google";
export type AgentModelTarget = {
  provider: AgentModelProvider;
  model: string;
};
export type AgentModelSettings =
  | { mode: "global" }
  | {
      mode: "custom";
      provider: AgentModelProvider;
      model: string;
      credentialSource: "global" | "custom";
      hasApiKey: boolean;
      baseUrl?: string;
      temperature?: number;
      maxTokens?: number;
      fallback?: AgentModelTarget;
    };

export type AgentModelConnection =
  | { ok: true; provider: AgentModelProvider; model: string }
  | {
      ok: false;
      provider: AgentModelProvider;
      model: string;
      code: string;
      error: string;
      status?: number;
    };

/** What kinds of coworker this deployment can create. */
export type AgentCapabilities = {
  /** Whether a coworker can run on the deployment's own Bot, with no endpoint of its own. */
  builtInAvailable: boolean;
};

export function agentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: agentKeys.capabilities(),
    queryFn: (): Promise<AgentCapabilities> =>
      client("/api/agents/capabilities", "capabilities", {
        fallback: "Could not load what this deployment supports",
      }),
    // Deployment configuration, not data: it cannot change without the server restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Which Bots one Bot may hand work to, and whether this deployment lets it. */
export type HandoffGrants = {
  /**
   * Whether the capability is switched on at all.
   *
   * Separate from the grants because the two fail differently: with this false, a grant is a row
   * nothing will ever read, so the screen says so rather than offering a switch wired to nothing.
   */
  enabled: boolean;
  /** Whether the signed-in person may change any of it. Granting is an administrator's. */
  canGrant: boolean;
  /** Bot ids this Bot may address today. */
  reachable: string[];
  /**
   * Whether this Bot can hold such a grant at all.
   *
   * The handing-on tool executes inside this deployment's own run loop, so only a Bot that runs in
   * it can be offered one. False means every grant would be refused, and the screen should say that
   * once instead of letting each switch bounce with the same message.
   */
  grantable: boolean;
};

export function agentListQueryOptions(hidden = false) {
  return queryOptions({
    queryKey: agentKeys.list(hidden),
    queryFn: (): Promise<AgentProfile[]> =>
      client(`/api/agents${hidden ? "?hidden=true" : ""}`, "agents", {
        fallback: "Could not load coworkers",
      }),
  });
}

/** Package-defined IDs remain one path segment without changing their stored or cache identity. */
export function agentApiPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}`;
}

export function agentQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.detail(agentId),
    queryFn: (): Promise<AgentProfile> =>
      client(agentApiPath(agentId), "agent", {
        fallback: "Could not load this coworker",
      }),
  });
}

export function agentModelQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.model(agentId),
    queryFn: (): Promise<AgentModelSettings> =>
      client(`${agentApiPath(agentId)}/model`, "model", {
        fallback: "Could not load model settings",
      }),
  });
}

export function agentInstructionsQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.instructions(agentId),
    queryFn: (): Promise<AgentInstructionsSettings> =>
      client(`${agentApiPath(agentId)}/instructions`, "instructions", {
        fallback: "Could not load Agent instructions",
      }),
  });
}

export function agentKnowledgeQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.knowledge(agentId),
    queryFn: (): Promise<AgentKnowledgeSettings> =>
      client(`${agentApiPath(agentId)}/knowledge`, "knowledge", {
        fallback: "Could not load Agent knowledge",
      }),
  });
}

export function agentMemoryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.memory(agentId),
    queryFn: (): Promise<AgentMemorySettings> =>
      client(`${agentApiPath(agentId)}/memory`, "memory", {
        fallback: "Could not load Agent memory",
      }),
  });
}

export function agentMemoryHistoryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.memoryHistory(agentId),
    queryFn: (): Promise<AgentMemoryHistory> =>
      client(`${agentApiPath(agentId)}/memory/history`, "history", {
        fallback: "Could not load Agent memory history",
      }),
  });
}

export function loadAgentMemoryDiff(
  agentId: string,
  revisionId: string,
): Promise<AgentMemoryDiff> {
  return client(
    `${agentApiPath(agentId)}/memory/history/${encodeURIComponent(revisionId)}`,
    "diff",
    { fallback: "Could not compare that memory revision" },
  );
}

export function agentHandoffQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: agentKeys.handoff(agentId),
    queryFn: (): Promise<HandoffGrants> =>
      client(`${agentApiPath(agentId)}/handoff`, "handoff", {
        fallback: "Could not load which Bots this one may ask",
      }),
  });
}

/** What the server said when it tried the endpoint. */
export type ConnectionVerdict =
  | { ok: true; events: string[] }
  | { ok: false; reason: string };

/**
 * Ask the server to reach a coworker's endpoint, from where a run will reach it.
 *
 * A plain function rather than a factory: the answer is about this moment, nothing caches it, and
 * there is no key for anything to invalidate. Fails closed, like the other verdicts here — an
 * endpoint that cannot be tested is reported as unreachable rather than thrown at the form.
 *
 * The unsaved key is sent so the test matches the form as it stands, not as it was last saved.
 */
export async function testAgentConnection(
  endpoint: string,
  key: string,
): Promise<ConnectionVerdict> {
  try {
    const response = await tryClient("/api/agents/test-connection", {
      method: "POST",
      body: {
        endpoint,
        ...(key.trim() ? { headers: { Authorization: key.trim() } } : {}),
      },
    });
    const body = (await response.json().catch(() => null)) as
      | ConnectionVerdict
      | { error?: string }
      | null;
    if (body && "ok" in body) return body;
    return {
      ok: false,
      reason:
        (body as { error?: string } | null)?.error ??
        "The connection could not be tested.",
    };
  } catch {
    return { ok: false, reason: "The connection could not be tested." };
  }
}

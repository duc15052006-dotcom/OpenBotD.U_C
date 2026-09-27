/**
 * Where a Bot's computer lives, asked of the supervisor.
 *
 * Each Bot gets a container of its own, which means the address of a computer is no longer one
 * fixed URL, it is whatever port the supervisor published for that Bot, and it changes when the
 * computer is reset. So the server stops holding an address and starts asking for one.
 *
 * The server still never touches Docker. It asks for a Bot's computer by Bot; the supervisor decides
 * what that means. Everything the API server can express is in this file, and it is four verbs.
 *
 * Without a supervisor configured, nothing here is used and the fixed `AGENT_COMPUTER_URL` still
 * answers for every Bot. That is the single-container mode: fine for one person on a laptop, and
 * honest about being one shared computer.
 */

import type {
  ComputerHostCapacity,
  ComputerLocation,
  ComputerProvider,
} from "./provider";
import type { ComputerStatus } from "./schema";
import type { ComputerResourceProfile } from "./resource-profile";

type SupervisorComputerLocation = {
  botId: string;
  container?: string;
  status: string;
  port?: number;
  /** Where to reach it, decided by the supervisor rather than assembled here. */
  url?: string;
  startedAt?: string;
  snapshotAvailable?: boolean;
};

export type SupervisorOptions = {
  baseUrl: string;
  token?: string;
  /** How a published port becomes a URL the server can reach. */
  hostForPort?: (port: number) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class SupervisorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

export function createDockerSupervisorProvider(
  options: SupervisorOptions,
): ComputerProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 120_000;
  /*
   * Numeric, never `localhost`.
   *
   * `localhost` does not resolve the same way on every operating system — Node prefers `::1`, bun
   * prefers `127.0.0.1` — so a name here reaches a different interface depending on what started
   * the process, and a computer that is listening looks like one that is not.
   */
  const hostForPort =
    options.hostForPort ?? ((port) => `http://127.0.0.1:${port}`);

  /**
   * The last container start time seen for each Bot, from the `/ensure` that located it.
   *
   * ONE MAP PER PROVIDER, not one per process. It was module-scope, so every provider built in a
   * process shared it: two supervisors, or a test's second stack, answered each other's question
   * about which run a Bot's computer is on, and the answer they gave was whichever one wrote last.
   *
   * Not a cache in front of the supervisor: `locate` still calls it every time, and a governed
   * action locates before it asks. This only carries that answer the few lines to whoever needs to
   * know which run of the computer they are talking to.
   *
   * Still process-local, and therefore never the only answer. A replica that has never located this
   * Bot has nothing here, and an unknown run skips the generation check rather than failing it, so
   * `sessionOf` falls back to asking rather than letting an empty map quietly stop checking.
   */
  const sessions = new Map<string, string>();
  const MAX_REMEMBERED_SESSIONS = 512;

  function rememberSession(botId: string, session: string): void {
    // Touch on write so the Map's insertion order is also its LRU order.
    sessions.delete(botId);
    sessions.set(botId, session);
    while (sessions.size > MAX_REMEMBERED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  function rememberedSession(botId: string): string | undefined {
    const session = sessions.get(botId);
    if (!session) return undefined;
    // Touch on read. Frequently active Bots stay hot; abandoned/deleted Bot ids fall out naturally.
    sessions.delete(botId);
    sessions.set(botId, session);
    return session;
  }

  async function call(
    path: string,
    method = "POST",
    requestBody?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(requestBody === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(requestBody === undefined
          ? {}
          : { body: JSON.stringify(requestBody) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SupervisorError(
        `The container supervisor at ${base} could not be reached (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      error?: string;
      stopped?: boolean;
      reset?: boolean;
      computers?: SupervisorComputerLocation[];
    } | null;
    if (!response.ok) {
      throw new SupervisorError(
        body?.error ?? `The supervisor answered ${response.status}.`,
      );
    }
    return body;
  }

  async function listRaw(): Promise<SupervisorComputerLocation[]> {
    const body = (await call("/computers", "GET")) as {
      computers?: SupervisorComputerLocation[];
    } | null;
    return body?.computers ?? [];
  }

  async function list(): Promise<ComputerLocation[]> {
    const computers = await listRaw();
    return computers.map((computer) => ({
      botId: computer.botId,
      status:
        computer.status.toLowerCase() === "running" ? "running" : "stopped",
      ...(computer.url
        ? { url: computer.url }
        : computer.port
          ? { url: hostForPort(computer.port) }
          : {}),
      ...(computer.startedAt ? { startedAt: computer.startedAt } : {}),
      ...(computer.snapshotAvailable !== undefined
        ? { snapshotAvailable: computer.snapshotAvailable }
        : {}),
    }));
  }

  function addressFromState(
    botId: string,
    state: SupervisorComputerLocation,
  ): string {
    // Restart and ensure both return the exact run they created. Remember that identity before
    // handing the address back so stale accessibility refs cannot cross a lifecycle boundary.
    if (state?.startedAt) rememberSession(botId, state.startedAt);
    if (state?.url) return state.url;
    if (state?.port) return hostForPort(state.port);
    throw new SupervisorError(
      `The computer for ${botId} started but reported no address, so it cannot be reached.`,
    );
  }

  function statusFromLocation(
    botId: string,
    location: SupervisorComputerLocation | undefined,
  ): ComputerStatus {
    if (!location) return { botId, state: "absent" };

    const rawStatus = location.status.toLowerCase();
    switch (rawStatus) {
      case "running":
        return { botId, state: "ready" };
      case "created":
      case "restarting":
        return { botId, state: "starting" };
      case "paused":
      case "removing":
      case "exited":
        return { botId, state: "absent" };
      case "dead":
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported state "${location.status}".`,
        };
      default:
        return {
          botId,
          state: "unreachable",
          reason: `The computer reported unknown state "${location.status}".`,
        };
    }
  }

  return {
    name: "Docker supervisor",
    isolation: "per-bot",

    /**
     * The URL of this Bot's computer, starting it if it is not already up.
     *
     * A computer that is running but has published no port is a computer nothing can reach, so that
     * is an error rather than a URL, the alternative is a caller quietly falling back to somebody
     * else's computer.
     */
    async sessionOf(botId: string): Promise<string | undefined> {
      /*
       * Read from the same `/ensure` every action already makes, and remembered rather than asked
       * for again: on the replica that located this Bot, `locate` ran immediately before the call
       * that needs this, so the value is as fresh as the address it was fetched with. Asking twice
       * would double the supervisor's work on the hot path to learn something it just told us.
       */
      const known = rememberedSession(botId);
      if (known) return known;

      /*
       * Nothing here means another replica did the work, not that there is nothing to know.
       *
       * LISTING, NOT ENSURING, and the difference is the whole feature. `/ensure` starts a computer
       * that is not running, so answering "which run is this" with it would wake every idle Bot that
       * anything asked about, and a deployment that suspends idle computers would quietly never
       * suspend one. Listing is a read: a Bot with no computer answers undefined, which is the same
       * answer as before and leaves the check exactly where it was.
       */
      try {
        const computers = await listRaw();
        const startedAt = computers.find(
          (computer) => computer.botId === botId,
        )?.startedAt;
        if (startedAt) rememberSession(botId, startedAt);
        return startedAt;
      } catch {
        // Unknown, not mismatched. A supervisor that cannot be reached must not turn every ref into
        // a refusal; the generation check goes back to being skipped, which is where it started.
        return undefined;
      }
    },

    async locate(
      botId: string,
      request?: { resourceProfile?: ComputerResourceProfile },
    ): Promise<string> {
      const state = (await call(
        `/computers/${encodeURIComponent(botId)}/ensure`,
        "POST",
        request?.resourceProfile
          ? { resourceProfile: request.resourceProfile }
          : undefined,
      )) as SupervisorComputerLocation;
      return addressFromState(botId, state);
    },

    async restart(
      botId: string,
      request?: { resourceProfile?: ComputerResourceProfile },
    ): Promise<string> {
      const state = (await call(
        `/computers/${encodeURIComponent(botId)}/restart`,
        "POST",
        request?.resourceProfile
          ? { resourceProfile: request.resourceProfile }
          : undefined,
      )) as SupervisorComputerLocation;
      return addressFromState(botId, state);
    },

    async status(botId: string): Promise<ComputerStatus> {
      try {
        const computers = await listRaw();
        return statusFromLocation(
          botId,
          computers.find((computer) => computer.botId === botId),
        );
      } catch (error) {
        return {
          botId,
          state: "unreachable",
          reason:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Unknown failure.",
        };
      }
    },

    async stop(botId: string): Promise<{ wasRunning: boolean }> {
      const result = (await call(
        `/computers/${encodeURIComponent(botId)}/stop`,
      )) as { stopped?: boolean } | null;
      sessions.delete(botId);
      return { wasRunning: result?.stopped === true };
    },

    async reset(botId: string): Promise<{ cleared: boolean }> {
      const result = (await call(
        `/computers/${encodeURIComponent(botId)}/reset`,
      )) as { reset?: boolean } | null;
      sessions.delete(botId);
      return { cleared: result?.reset === true };
    },

    async snapshot(botId: string): Promise<{ created: boolean }> {
      const result = (await call(
        `/computers/${encodeURIComponent(botId)}/snapshot`,
      )) as { snapshot?: boolean } | null;
      return { created: result?.snapshot === true };
    },

    async restoreSnapshot(botId: string): Promise<{ restored: boolean }> {
      const result = (await call(
        `/computers/${encodeURIComponent(botId)}/restore`,
      )) as { restored?: boolean } | null;
      sessions.delete(botId);
      return { restored: result?.restored === true };
    },

    async capacity(): Promise<ComputerHostCapacity | undefined> {
      return (await call("/capacity", "GET")) as ComputerHostCapacity;
    },

    list,
  };
}

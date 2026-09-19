import { serve } from "bun";
import { Hono } from "hono";
import { createComputerLifecycleLock } from "./computer-lifecycle-lock";
import { environmentFor } from "./environment";
import {
  ComputerCapacityError,
  ComputerNotAnsweringError,
  ComputerSnapshotError,
  createCleanSnapshot,
  DockerUnavailableError,
  ensure,
  hostCapacity,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  restoreCleanSnapshot,
  stop,
} from "./docker";
import { registerEntry } from "./identity";
import { namesFor } from "./names";
import { computerMaxActive } from "./computer-max-active";
import { computerMemoryBytes } from "./computer-memory-bytes";
import { computerNanoCpus } from "./computer-nano-cpus";
import { listenPort } from "./listen-port";
import {
  parseComputerResourceProfile,
  RESOURCE_PROFILES,
} from "./resource-profile";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in Bots rather than in Docker: ensure a computer
 * for this Bot, stop it, reset it, list them. There is no passthrough and no way to name a container
 * directly, names are derived from the Bot id, which is validated first. A compromised API server
 * can ask for a Bot's computer to be restarted. It cannot ask for anything else, because nothing
 * else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Neither is the network the boundary, but it is the layer in front of both. Compose publishes this
 * port on `127.0.0.1` rather than on every address the host has, for the same reason the computer's
 * own port is bound there: a secret in an environment variable is one leak away from being known,
 * and this process holds the Docker socket. This listener stays on every interface inside its own
 * container, which is what the published mapping forwards to and what a server running inside the
 * compose network connects to as `supervisor:4300`.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const resolvedPort = listenPort(process.env.PORT, 4300);
if (!resolvedPort.ok) {
  console.error(resolvedPort.reason);
  process.exit(1);
}
const port = resolvedPort.port;
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
const image =
  process.env.COMPUTER_IMAGE?.trim() || "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK?.trim() || undefined;
const runtime = process.env.COMPUTER_RUNTIME?.trim() || undefined;
const resolvedMemory = computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES);
if (!resolvedMemory.ok) {
  console.error(resolvedMemory.reason);
  process.exit(1);
}
const memoryBytes = resolvedMemory.bytes;
const resolvedCpu = computerNanoCpus(process.env.COMPUTER_NANO_CPUS);
if (!resolvedCpu.ok) {
  console.error(resolvedCpu.reason);
  process.exit(1);
}
const nanoCpus = resolvedCpu.nanoCpus;
const resolvedMaxActive = computerMaxActive(process.env.COMPUTER_MAX_ACTIVE);
if (!resolvedMaxActive.ok) {
  console.error(resolvedMaxActive.reason);
  process.exit(1);
}
const maxActiveComputers = resolvedMaxActive.maxActive;
const spireSocketVolume =
  process.env.SPIRE_AGENT_SOCKET_VOLUME?.trim() || undefined;

const lifecycleLock = createComputerLifecycleLock();
const app = new Hono();

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health") return next();
  if (context.req.header("authorization") !== `Bearer ${token}`) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

/** The Bot id in the path, validated before it becomes any kind of name. */
function resolve(raw: string) {
  return namesFor(raw);
}

app.post("/computers/:botId/ensure", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);

  const body = (await context.req.json().catch(() => ({}))) as {
    resourceProfile?: unknown;
  };
  const requestedProfile =
    body.resourceProfile === undefined
      ? null
      : parseComputerResourceProfile(body.resourceProfile);
  if (body.resourceProfile !== undefined && !requestedProfile) {
    return context.json(
      { error: "Resource profile must be light, normal, or heavy." },
      400,
    );
  }
  const profileResources = requestedProfile
    ? RESOURCE_PROFILES[requestedProfile]
    : null;

  try {
    // Registered before the computer is handed out, so it can prove which Bot it is from its first
    // request.
    const identity = await registerEntry(parsed.names);

    const state = await lifecycleLock.run(parsed.names.botId, () =>
      ensure(parsed.names, {
        image,
        environment: environmentFor(parsed.names.botId),
        ...(network ? { network } : {}),
        ...(runtime ? { runtime } : {}),
        ...(profileResources
          ? { memoryBytes: profileResources.memoryBytes }
          : memoryBytes
            ? { memoryBytes }
            : {}),
        ...(profileResources
          ? { nanoCpus: profileResources.nanoCpus }
          : nanoCpus
            ? { nanoCpus }
            : {}),
        ...(maxActiveComputers ? { maxActiveComputers } : {}),
        ...(spireSocketVolume ? { spireSocketVolume } : {}),
      }),
    );
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    // A held name is not an outage. 409 says the conflict is with something already there, so an
    // operator reads the message rather than going to look at a daemon that is working.
    if (
      error instanceof NameHeldError ||
      error instanceof ComputerCapacityError ||
      error instanceof ComputerSnapshotError
    ) {
      return context.json({ error: error.message }, 409);
    }
    // Not ready is a 503 like an outage is, because the caller's next move is the same: wait and
    // ask again. The message is what differs, and it is the part an operator acts on.
    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/restart", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);

  const body = (await context.req.json().catch(() => ({}))) as {
    resourceProfile?: unknown;
  };
  const requestedProfile =
    body.resourceProfile === undefined
      ? null
      : parseComputerResourceProfile(body.resourceProfile);
  if (body.resourceProfile !== undefined && !requestedProfile) {
    return context.json(
      { error: "Resource profile must be light, normal, or heavy." },
      400,
    );
  }
  const profileResources = requestedProfile
    ? RESOURCE_PROFILES[requestedProfile]
    : null;

  try {
    const identity = await registerEntry(parsed.names);
    const state = await lifecycleLock.run(parsed.names.botId, async () => {
      // One critical section for the whole cycle. A Reset/Stop/Ensure for this Bot cannot slip
      // between these two calls and accidentally erase or supersede the state Restart preserves.
      await stop(parsed.names);
      return ensure(parsed.names, {
        image,
        environment: environmentFor(parsed.names.botId),
        ...(network ? { network } : {}),
        ...(runtime ? { runtime } : {}),
        ...(profileResources
          ? { memoryBytes: profileResources.memoryBytes }
          : memoryBytes
            ? { memoryBytes }
            : {}),
        ...(profileResources
          ? { nanoCpus: profileResources.nanoCpus }
          : nanoCpus
            ? { nanoCpus }
            : {}),
        ...(maxActiveComputers ? { maxActiveComputers } : {}),
        ...(spireSocketVolume ? { spireSocketVolume } : {}),
      });
    });
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    if (
      error instanceof NameHeldError ||
      error instanceof ComputerCapacityError ||
      error instanceof ComputerSnapshotError
    ) {
      return context.json({ error: error.message }, 409);
    }
    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/stop", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await lifecycleLock.run(parsed.names.botId, () =>
      stop(parsed.names),
    );
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/snapshot", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const created = await lifecycleLock.run(parsed.names.botId, () =>
      createCleanSnapshot(parsed.names, image),
    );
    return context.json({ snapshot: created });
  } catch (error) {
    if (
      error instanceof NameHeldError ||
      error instanceof ComputerSnapshotError
    ) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/restore", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const restored = await lifecycleLock.run(parsed.names.botId, () =>
      restoreCleanSnapshot(parsed.names, image),
    );
    return context.json({ restored });
  } catch (error) {
    if (
      error instanceof NameHeldError ||
      error instanceof ComputerSnapshotError
    ) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/reset", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await lifecycleLock.run(parsed.names.botId, () =>
      reset(parsed.names),
    );
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof NameHeldError) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/capacity", async (context) => {
  try {
    return context.json({
      ...(await hostCapacity()),
      maxActiveComputers: maxActiveComputers ?? null,
      resourceProfiles: RESOURCE_PROFILES,
    });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);

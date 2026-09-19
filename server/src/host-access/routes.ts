import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { recordAuditEvent, type AuditStore } from "../audit";
import type { AppVariables } from "../auth/guards";
import { sameToken } from "../agents/callback-token";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { ComputerGateway } from "../computer/gateway";
import { HostAccessRefusedError, type HostAccessBroker } from "./broker";
import {
  asHostAccessDesktopResult,
  HOST_ACCESS_DESKTOP_LEASE_MS,
} from "./schema";

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

function desktopAuthorized(request: Request, token: string) {
  const given = bearerToken(request);
  return !!given && given.length === token.length && sameToken(given, token);
}

function safeExportName(input: string): string {
  const leaf = input.replaceAll("\\", "/").split("/").pop() ?? "";
  const safe = leaf
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .trim()
    .slice(0, 160);
  return !safe || safe === "." || safe === ".." ? "download" : safe;
}

function dangerousExportName(name: string): boolean {
  return /\.(?:exe|msi|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|scr|cpl|jar|hta|reg|lnk|url|sh|bash|zsh|fish|py|rb|pl|php|apk|appx|appxbundle|msix|msixbundle|docm|xlsm|pptm)$/i.test(
    name,
  );
}

async function audit(
  auditStore: AuditStore | undefined,
  input: {
    actorUserId?: string;
    targetId?: string;
    change: string;
    botId?: string;
  },
) {
  if (!auditStore) return;
  await recordAuditEvent(auditStore, {
    eventType: "configuration.changed",
    targetType: "host_access",
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    payload: input,
  });
}

export function createHostAccessRoutes(options: {
  broker: HostAccessBroker;
  desktopToken?: string;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  auditStore?: AuditStore;
  /** The only source of quarantine bytes for the native desktop worker. */
  computerGateway?: ComputerGateway;
  botName?: (
    botId: string,
    actor: AppVariables["actor"],
  ) => Promise<string | null>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { broker, requireUser, canUseBot, auditStore } = options;

  const requireDesktop: MiddlewareHandler = async (context, next) => {
    const token = options.desktopToken;
    if (!token)
      return context.json(
        { error: "Desktop host access is not configured." },
        503,
      );
    if (!desktopAuthorized(context.req.raw, token)) {
      return context.json(
        { error: "Desktop host access authentication failed." },
        401,
      );
    }
    await next();
  };

  routes.get("/desktop/next", requireDesktop, (context) => {
    const next = broker.nextDesktopOperation();
    return context.json(
      next ?? { operations: [], leaseMs: HOST_ACCESS_DESKTOP_LEASE_MS },
    );
  });

  /**
   * Stream one already-approved quarantine object to the native worker.
   *
   * This route has no user-session alternative and no browser-facing token. The fresh desktop bearer
   * token plus the live operation id are both required, and the digest queued for Save As must still
   * match the Computer's response before any bytes are forwarded.
   */
  routes.get(
    "/desktop/quarantine/:operationId",
    requireDesktop,
    async (context) => {
      const source = broker.quarantineExportSource(
        context.req.param("operationId"),
      );
      if (!source) {
        return context.json(
          { error: "That native quarantine export is not active." },
          404,
        );
      }
      const gateway = options.computerGateway;
      if (!gateway) {
        return context.json(
          { error: "Quarantine export is not configured." },
          503,
        );
      }

      try {
        const response = await gateway.quarantineExportResponse(
          source.botId,
          source.quarantineId,
        );
        const sha256 = response.headers.get("x-openbot-sha256");
        if (sha256 !== source.sha256) {
          await response.body?.cancel().catch(() => undefined);
          return context.json(
            {
              error:
                "The quarantined bytes changed after native export approval.",
            },
            409,
          );
        }
        const headers = new Headers({
          "content-type": "application/octet-stream",
          "x-openbot-sha256": sha256,
          "cache-control": "no-store",
        });
        const length = response.headers.get("content-length");
        if (length) headers.set("content-length", length);
        return new Response(response.body, { status: 200, headers });
      } catch (error) {
        return context.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "The quarantined bytes could not be streamed.",
          },
          409,
        );
      }
    },
  );

  routes.post("/desktop/result", requireDesktop, async (context) => {
    const parsed = asHostAccessDesktopResult(
      await context.req.json().catch(() => null),
    );
    if (!parsed)
      return context.json(
        { error: "Send a valid desktop operation result." },
        400,
      );
    broker.resolveDesktopOperation(parsed);
    return context.json({ ok: true });
  });

  routes.get("/", requireUser, (context) =>
    context.json(broker.statusFor(context.var.actor.id)),
  );

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
    } | null;
    // Whitespace-only is truthy and would pass to `canUseBot` (404) and the broker naming
    // nothing. Trimmed non-empty here, so malformed reads as malformed.
    const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
    if (!botId) {
      return context.json({ error: "botId is required." }, 400);
    }
    const actor = context.var.actor;
    if (!(await canUseBot(actor, botId))) {
      return context.json({ error: "That Bot is not available to you." }, 404);
    }
    try {
      const grant = await broker.requestFolderGrant({
        botId,
        botName: (await options.botName?.(botId, actor)) ?? botId,
        actorId: actor.id,
      });
      await audit(auditStore, {
        actorUserId: actor.id,
        targetId: grant.id,
        change: "host_folder_granted",
        botId,
      });
      return context.json({ grant });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The folder was not granted.";
      return context.json(
        { error: message },
        error instanceof HostAccessRefusedError ? 409 : 500,
      );
    }
  });

  routes.post("/quarantine/export", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
      id?: unknown;
      confirm?: unknown;
    } | null;
    const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!botId || !id || body?.confirm !== "EXPORT_QUARANTINED_FILE") {
      return context.json(
        {
          error:
            "Export requires EXPORT_QUARANTINED_FILE confirmation, a Bot id, and a quarantine download id.",
        },
        400,
      );
    }

    const actor = context.var.actor;
    if (!(await canUseBot(actor, botId))) {
      return context.json({ error: "That Bot is not available to you." }, 404);
    }
    const gateway = options.computerGateway;
    if (!gateway) {
      return context.json(
        { error: "Quarantine export is not configured." },
        503,
      );
    }
    if (!broker.statusFor(actor.id).connected) {
      return context.json(
        {
          error:
            "The native OpenBot desktop is not connected. Open the desktop app before exporting.",
        },
        409,
      );
    }

    try {
      const listed = await gateway.listQuarantine(botId);
      const record = listed.downloads.find((entry) => entry.id === id);
      if (
        record?.status !== "approved" ||
        record.scan?.status !== "clean" ||
        record.scannedSha256 !== record.sha256
      ) {
        throw new HostAccessRefusedError(
          "Only unchanged bytes from a clean scan that were explicitly approved can be exported.",
        );
      }

      const suggestedName = safeExportName(record.originalName);
      const result = await broker.requestQuarantineExport({
        botId,
        actorId: actor.id,
        quarantineId: id,
        suggestedName,
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
        dangerous: dangerousExportName(suggestedName),
      });
      if (result?.exported !== true) {
        throw new HostAccessRefusedError(
          "The native desktop did not confirm a completed export.",
        );
      }

      const released = await gateway.markQuarantineReleased(
        botId,
        {
          id: actor.id,
          ...(actor.email === "dev@openbot.local" ? {} : { userId: actor.id }),
        },
        id,
      );
      await audit(auditStore, {
        actorUserId: actor.email === "dev@openbot.local" ? undefined : actor.id,
        targetId: id,
        change: "quarantine_exported",
        botId,
      });
      return context.json({ record: released });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The quarantined file could not be exported.";
      return context.json(
        { error: message },
        error instanceof HostAccessRefusedError ? 409 : 500,
      );
    }
  });

  routes.delete("/grants/:id", requireUser, async (context) => {
    const actor = context.var.actor;
    // The catch below maps every error to 404, so a malformed id would read as "not found"
    // instead of malformed. Checked here, before the broker or audit row.
    const id = context.req.param("id");
    if (!id.trim()) {
      return context.json({ error: "A grant id is required." }, 400);
    }
    try {
      broker.revokeGrant(id, actor.id);
      await audit(auditStore, {
        actorUserId: actor.id,
        targetId: id,
        change: "host_folder_revoked",
      });
      return context.json({ ok: true });
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The folder grant could not be revoked.",
        },
        404,
      );
    }
  });

  routes.post("/stop", requireUser, async (context) => {
    const actor = context.var.actor;
    broker.stop(actor.id);
    await audit(auditStore, {
      actorUserId: actor.id,
      change: "host_access_stopped",
    });
    return context.json({ ok: true });
  });

  return routes;
}

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import { createHostAccessBroker } from "../src/host-access/broker";
import { createHostAccessRoutes } from "../src/host-access/routes";

function appFor(computerGateway?: ComputerGateway) {
  const broker = createHostAccessBroker();
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/host-access",
    createHostAccessRoutes({
      broker,
      desktopToken: "desktop-token",
      requireUser: async (context, next) => {
        context.set("actor", {
          id: "user-a",
          email: "user@example.test",
          role: "user",
        });
        await next();
      },
      canUseBot: async (actor, botId) =>
        actor.id === "user-a" && botId === "bot-a",
      computerGateway,
      botName: async () => "Readable Bot Name",
    }),
  );
  return { app, broker };
}

describe("host access routes", () => {
  test("desktop polling is bearer-token authenticated and leases queued operations", async () => {
    const { app, broker } = appFor();
    const grantRequest = broker.requestFolderGrant({
      botId: "bot-a",
      botName: "Bot A",
      actorId: "user-a",
    });

    expect((await app.request("/api/host-access/desktop/next")).status).toBe(
      401,
    );

    const response = await app.request("/api/host-access/desktop/next", {
      headers: { authorization: "Bearer desktop-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      operations: [
        { kind: "choose_folder", botId: "bot-a", actorId: "user-a" },
      ],
    });
    broker.resolveDesktopOperation({
      operationId: body.operations[0].operationId,
      ok: true,
      grant: { grantId: "grant-1", displayName: "Project" },
    });
    await grantRequest;
  });

  test("status includes whether the desktop worker is connected", async () => {
    const { app, broker } = appFor();
    expect(await (await app.request("/api/host-access")).json()).toMatchObject({
      connected: false,
    });
    broker.nextDesktopOperation();
    expect(await (await app.request("/api/host-access")).json()).toMatchObject({
      connected: true,
    });
  });

  test("owner grant requests send the Bot's readable name to native", async () => {
    const { app } = appFor();
    const request = app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: "bot-a" }),
      headers: { "content-type": "application/json" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lease = await app.request("/api/host-access/desktop/next", {
      headers: { authorization: "Bearer desktop-token" },
    });
    const body = await lease.json();
    expect(body.operations[0]).toMatchObject({
      kind: "choose_folder",
      botName: "Readable Bot Name",
    });
    await app.request("/api/host-access/desktop/result", {
      method: "POST",
      headers: {
        authorization: "Bearer desktop-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operationId: body.operations[0].operationId,
        ok: true,
        grant: { grantId: "grant-1", displayName: "Project" },
      }),
    });
    expect((await request).status).toBe(200);
  });

  test("owner routes do not let an admin-style caller pick for a Bot they cannot use", async () => {
    const { app } = appFor();
    const denied = await app.request("/api/host-access/grants", {
      method: "POST",
      body: JSON.stringify({ botId: "bot-b" }),
      headers: { "content-type": "application/json" },
    });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({
      error: "That Bot is not available to you.",
    });
  });

  test("quarantine is marked released only after native export succeeds", async () => {
    let released = 0;
    const approved = {
      version: 2 as const,
      status: "approved" as const,
      id: "download-1",
      botId: "bot-a",
      originalName: "../tool.exe",
      sourceUrl: "https://example.test/tool.exe",
      savedAt: new Date().toISOString(),
      sizeBytes: 321,
      sha256: "a".repeat(64),
      scannedSha256: "a".repeat(64),
      scan: {
        status: "clean" as const,
        scanner: "clamav" as const,
        detail: "clean",
        scannedAt: new Date().toISOString(),
      },
      approvedAt: new Date().toISOString(),
    };
    const gateway = {
      listQuarantine: async () => ({ downloads: [approved] }),
      markQuarantineReleased: async () => {
        released += 1;
        return {
          ...approved,
          status: "released" as const,
          releasedAt: new Date().toISOString(),
        };
      },
    } as unknown as ComputerGateway;
    const { app, broker } = appFor(gateway);
    broker.nextDesktopOperation();

    const request = app.request("/api/host-access/quarantine/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "bot-a",
        id: "download-1",
        confirm: "EXPORT_QUARANTINED_FILE",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const operation = broker.nextDesktopOperation()?.operations[0];
    expect(operation).toMatchObject({
      kind: "export_quarantine",
      botId: "bot-a",
      quarantineId: "download-1",
      suggestedName: "tool.exe",
      dangerous: true,
      sha256: "a".repeat(64),
      sizeBytes: 321,
    });
    expect(released).toBe(0);

    broker.resolveDesktopOperation({
      operationId: operation!.operationId,
      ok: true,
      result: { exported: true },
    });
    const response = await request;
    expect(response.status).toBe(200);
    expect(released).toBe(1);
    expect(await response.json()).toMatchObject({
      record: { id: "download-1", status: "released" },
    });
  });

  test("native export refusal leaves quarantine approved", async () => {
    let released = 0;
    const gateway = {
      listQuarantine: async () => ({
        downloads: [
          {
            version: 2,
            status: "approved",
            id: "download-2",
            botId: "bot-a",
            originalName: "report.pdf",
            sourceUrl: "https://example.test/report.pdf",
            savedAt: new Date().toISOString(),
            sizeBytes: 10,
            sha256: "b".repeat(64),
            scannedSha256: "b".repeat(64),
            scan: {
              status: "clean",
              scanner: "clamav",
              detail: "clean",
              scannedAt: new Date().toISOString(),
            },
          },
        ],
      }),
      markQuarantineReleased: async () => {
        released += 1;
        throw new Error("must not be called");
      },
    } as unknown as ComputerGateway;
    const { app, broker } = appFor(gateway);
    broker.nextDesktopOperation();

    const request = app.request("/api/host-access/quarantine/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "bot-a",
        id: "download-2",
        confirm: "EXPORT_QUARANTINED_FILE",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const operation = broker.nextDesktopOperation()?.operations[0];
    broker.resolveDesktopOperation({
      operationId: operation!.operationId,
      ok: false,
      error: "The local owner denied this operation.",
    });

    const response = await request;
    expect(response.status).toBe(409);
    expect(released).toBe(0);
  });
});

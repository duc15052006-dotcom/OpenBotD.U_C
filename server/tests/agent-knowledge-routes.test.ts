import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createAgentKnowledgeRoutes } from "../src/agents/knowledge-routes";
import type { AgentKnowledgeStore } from "../src/agents/knowledge-store";
import { AgentNotManageableError } from "../src/agents/profile-store";
import type { AppVariables } from "../src/auth/guards";

type Actor = AppVariables["actor"];

const OWNER: Actor = {
  id: "owner",
  email: "owner@example.test",
  role: "user",
};

const EMPTY = {
  documents: [],
  canManage: true,
  limits: {
    documents: 8,
    fileBytes: 65_536,
    documentCharacters: 60_000,
    totalCharacters: 120_000,
  },
};

function authenticated(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", OWNER);
    await next();
  };
}

function store(
  overrides: Partial<AgentKnowledgeStore> = {},
): AgentKnowledgeStore {
  return {
    list: async () => EMPTY,
    add: async () => EMPTY,
    remove: async () => EMPTY,
    ...overrides,
  };
}

function appWith(knowledge: AgentKnowledgeStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/agents",
    createAgentKnowledgeRoutes(knowledge, authenticated()),
  );
  return app;
}

describe("Agent knowledge routes", () => {
  test("lists only metadata returned by the store", async () => {
    const app = appWith(
      store({
        list: async () => ({
          ...EMPTY,
          documents: [
            {
              id: "doc-1",
              name: "policy.txt",
              mimeType: "text/plain",
              sizeBytes: 12,
              characters: 12,
              createdAt: "2026-09-18T00:00:00.000Z",
            },
          ],
        }),
      }),
    );

    const response = await app.request("/api/agents/writer/knowledge");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      knowledge: {
        ...EMPTY,
        documents: [
          {
            id: "doc-1",
            name: "policy.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            characters: 12,
            createdAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain("secret contents");
  });

  test("parses a text upload before calling the store", async () => {
    let content: string | undefined;
    const app = appWith(
      store({
        add: async (_actor, _agentId, upload) => {
          content = upload.bytes.toString("utf8");
          return EMPTY;
        },
      }),
    );

    const response = await app.request("/api/agents/writer/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "policy.txt",
        mimeType: "text/plain",
        bytesBase64: Buffer.from("Known policy.").toString("base64"),
      }),
    });

    expect(response.status).toBe(200);
    expect(content).toBe("Known policy.");
  });

  test("refuses a non-text upload without reaching storage", async () => {
    let writes = 0;
    const app = appWith(
      store({
        add: async () => {
          writes += 1;
          return EMPTY;
        },
      }),
    );

    const response = await app.request("/api/agents/writer/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "image.png",
        mimeType: "image/png",
        bytesBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      }),
    });

    expect(response.status).toBe(400);
    expect(writes).toBe(0);
  });

  test("rejects an oversized request before JSON parsing", async () => {
    let writes = 0;
    const app = appWith(
      store({
        add: async () => {
          writes += 1;
          return EMPTY;
        },
      }),
    );

    const response = await app.request("/api/agents/writer/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "huge.txt",
        mimeType: "text/plain",
        bytesBase64: "A".repeat(100 * 1024),
      }),
    });

    expect(response.status).toBe(413);
    expect(writes).toBe(0);
  });

  test("maps the Agent authorization boundary to 403", async () => {
    const app = appWith(
      store({
        list: async () => {
          throw new AgentNotManageableError("writer");
        },
      }),
    );

    const response = await app.request("/api/agents/writer/knowledge");
    expect(response.status).toBe(403);
  });
});

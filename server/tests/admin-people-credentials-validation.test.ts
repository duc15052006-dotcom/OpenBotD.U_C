import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { PeopleCursorError, decodeCursor } from "../src/people/store";
import { testEnvironment } from "./support/environment";

const ADMIN = {
  id: "admin-1",
  email: "admin@openbot.test",
  name: "An Administrator",
  image: null,
};

function appWith(opts: {
  peopleList?: (query: unknown) => Promise<unknown>;
  credentialCreate?: (input: unknown) => Promise<unknown>;
}) {
  const calls: { people: unknown[]; credentials: unknown[] } = {
    people: [],
    credentials: [],
  };
  const peopleStore = {
    list: async (query: unknown) => {
      calls.people.push(query);
      if (opts.peopleList) return opts.peopleList(query);
      return { people: [], nextCursor: null };
    },
  };
  const credentialService = {
    list: async () => [],
    create: async (input: unknown) => {
      calls.credentials.push(input);
      if (opts.credentialCreate) return opts.credentialCreate(input);
      return { credential: input };
    },
  };
  // createApp takes positional stores; peopleStore is the 18th parameter. Build the argument
  // list by index so a future appended store cannot silently shift it.
  const args: never[] = Array.from({ length: 18 }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => ({ user: ADMIN }) },
  } as never;
  args[2] = { rolesForUser: async () => ["admin"] } as never;
  args[4] = credentialService as never;
  args[17] = peopleStore as never;
  const app = createApp(...args);
  return { app, calls };
}

/**
 * `GET /api/admin/people` capped `limit` strictly but passed `search` straight to a `%...% ILIKE`
 * full scan. A multi-megabyte search is a cheap denial of service; over 200 characters is now a
 * 400 before the store is touched.
 */
describe("GET /api/admin/people search", () => {
  test("refuses an oversized search with 400 and never reaches the store", async () => {
    const { app, calls } = appWith({});
    const response = await app.request(
      `http://openbot.test/api/admin/people?search=${"x".repeat(201)}`,
      { method: "GET" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A search of at most 200 characters is required.",
    });
    expect(calls.people).toEqual([]);
  });

  test("passes a normal search to the store", async () => {
    const { app, calls } = appWith({});
    const response = await app.request(
      "http://openbot.test/api/admin/people?search=ada",
      { method: "GET" },
    );
    expect(response.status).toBe(200);
    expect(calls.people).toHaveLength(1);
  });
});

/**
 * `credentialInput` accepted empty `provider`/`keyId` strings and any non-array object as
 * `metadata`, so `{"provider":"","keyId":""}` reached the vault as a junk row (or a unique
 * violation 500) and `{"metadata":{"__proto__":{...}}}` passed the shape check.
 */
describe("POST /api/admin/credentials input", () => {
  const good = {
    kind: "mcp",
    provider: "acme",
    keyId: "key-1",
    plaintext: "secret",
    metadata: {},
  };
  test.each([
    ["an empty provider", { ...good, provider: "" }],
    ["a whitespace provider", { ...good, provider: "   " }],
    ["a number provider", { ...good, provider: 123 }],
    ["an empty keyId", { ...good, keyId: "" }],
    ["a whitespace keyId", { ...good, keyId: "  " }],
    ["an array metadata", { ...good, metadata: [] }],
  ])("refuses %s with 400 and never reaches the vault", async (_n, body) => {
    const { app, calls } = appWith({});
    const response = await app.request(
      "http://openbot.test/api/admin/credentials",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    expect(response.status).toBe(400);
    expect(calls.credentials).toEqual([]);
  });

  test("trims provider and keyId on the happy path", async () => {
    const { app, calls } = appWith({});
    const response = await app.request(
      "http://openbot.test/api/admin/credentials",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...good, provider: "  acme  " }),
      },
    );
    expect(response.status).toBe(201);
    expect(calls.credentials[0]).toMatchObject({ provider: "acme" });
  });
});

describe("people page cursors", () => {
  function encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  test.each([
    "not-a-cursor",
    encode(null),
    encode([]),
    encode({}),
    encode({ email: "", lastSignedInAt: null }),
    encode({ email: "a@x.test", lastSignedInAt: "not-a-date" }),
    encode({ email: "a@x.test", lastSignedInAt: 2020 }),
  ])("refuses malformed cursor %p", (cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(PeopleCursorError);
    expect(() => decodeCursor(cursor)).toThrow(
      "cursor must be a valid people page cursor",
    );
  });

  test("keeps a valid cursor and drops extra fields", () => {
    expect(
      decodeCursor(
        encode({
          email: "a@x.test",
          lastSignedInAt: "2026-01-01T00:00:00Z",
          injected: "ignored",
        }),
      ),
    ).toEqual({ email: "a@x.test", lastSignedInAt: "2026-01-01T00:00:00Z" });
  });

  test("GET /api/admin/people returns 400 before the store for a bad cursor", async () => {
    const { app, calls } = appWith({});
    const response = await app.request(
      "http://openbot.test/api/admin/people?cursor=not-a-cursor",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "cursor must be a valid people page cursor",
    });
    expect(calls.people).toEqual([]);
  });

  test("maps a store-level cursor refusal to 400", async () => {
    const cursor = encode({
      email: "a@x.test",
      lastSignedInAt: "2026-01-01T00:00:00Z",
    });
    const { app } = appWith({
      peopleList: async () => {
        throw new PeopleCursorError();
      },
    });
    const response = await app.request(
      `http://openbot.test/api/admin/people?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "cursor must be a valid people page cursor",
    });
  });
});

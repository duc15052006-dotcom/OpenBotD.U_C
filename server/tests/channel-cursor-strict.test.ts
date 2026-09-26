import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  ChannelCursorError,
  createChannelRoutes,
  decodeChannelCursor,
  encodeChannelCursor,
  type ChannelStore,
} from "../src/channels/routes";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function fakeStore(queries: unknown[]): ChannelStore {
  return {
    create: async () => {
      throw new Error("not reached");
    },
    direct: async () => {
      throw new Error("not reached");
    },
    get: async () => null,
    list: async (_actor, query) => {
      queries.push(query ?? {});
      return { channels: [], nextCursor: null };
    },
    setPinned: async () => {},
    markRead: async () => {},
    softDelete: async () => {},
    recordActivity: async () => {},
    signalBusy: async () => {},
    signalChannelBusy: async () => {},
    listDelegations: async () => [],
  };
}

function appFor(store: ChannelStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, requireUser));
  return app;
}

describe("decodeChannelCursor", () => {
  test("round-trips a cursor and drops extra fields", () => {
    const cursor = encode({
      pinned: true,
      recency: "2026-09-01T00:00:00.000Z",
      id: "channel-1",
      injected: "ignored",
    });
    expect(decodeChannelCursor(cursor)).toEqual({
      pinned: true,
      recency: "2026-09-01T00:00:00.000Z",
      id: "channel-1",
    });
    expect(
      decodeChannelCursor(
        encodeChannelCursor({
          pinned: false,
          recency: "2026-09-02T00:00:00.000Z",
          id: "channel-2",
        }),
      ),
    ).toEqual({
      pinned: false,
      recency: "2026-09-02T00:00:00.000Z",
      id: "channel-2",
    });
  });

  test.each([
    "not-a-cursor",
    encode(null),
    encode([]),
    encode({ recency: "2026-09-01T00:00:00.000Z", id: "channel-1" }),
    encode({ pinned: "yes", recency: "2026-09-01T00:00:00.000Z", id: "c1" }),
    encode({ pinned: true, recency: "not-a-date", id: "c1" }),
    encode({ pinned: true, recency: "2026-09-01T00:00:00.000Z", id: "" }),
  ])("refuses malformed cursor %p", (cursor) => {
    expect(() => decodeChannelCursor(cursor)).toThrow(ChannelCursorError);
    expect(() => decodeChannelCursor(cursor)).toThrow(
      "cursor must be a valid channel page cursor",
    );
  });
});

describe("channel list cursor", () => {
  test("returns 400 for a bad cursor without reaching the store", async () => {
    const queries: unknown[] = [];
    const response = await appFor(fakeStore(queries)).request(
      "http://openbot.test/?cursor=not-a-cursor",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "cursor must be a valid channel page cursor",
    });
    expect(queries).toEqual([]);
  });

  test("passes a valid cursor through and leaves an absent one alone", async () => {
    const queries: unknown[] = [];
    const app = appFor(fakeStore(queries));
    const cursor = encodeChannelCursor({
      pinned: false,
      recency: "2026-09-01T00:00:00.000Z",
      id: "channel-1",
    });

    expect(
      (
        await app.request(
          `http://openbot.test/?cursor=${encodeURIComponent(cursor)}`,
        )
      ).status,
    ).toBe(200);
    expect((await app.request("http://openbot.test/")).status).toBe(200);
    expect(queries).toEqual([{ cursor }, {}]);
  });
});

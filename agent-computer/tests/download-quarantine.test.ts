import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteQuarantinedDownload,
  listQuarantinedDownloads,
  quarantineDirectoryFor,
  quarantineDownload,
  safeDownloadName,
} from "../src/download-quarantine";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-quarantine-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("download quarantine", () => {
  test("sanitizes path-shaped and Windows-hostile file names", () => {
    expect(safeDownloadName("../../evil.exe")).toBe("evil.exe");
    expect(safeDownloadName("..\\..\\payload.cmd")).toBe("payload.cmd");
    expect(safeDownloadName("bad:<name>?.ps1")).toBe("bad__name__.ps1");
    expect(safeDownloadName("..")).toBe("download");
  });

  test("Bot ids cannot escape the quarantine root", () => {
    expect(() => quarantineDirectoryFor(root, "../other")).toThrow();
    expect(quarantineDirectoryFor(root, "agent-a")).toBe(join(root, "agent-a"));
  });

  test("persists identity metadata without exposing a host path", async () => {
    let savedAs = "";
    const result = await quarantineDownload(root, "agent-a", {
      failure: async () => null,
      saveAs: async (path: string) => {
        savedAs = path;
        await Bun.write(path, "untrusted bytes");
      },
      suggestedFilename: () => "../../installer.exe",
      url: () => "https://example.test/installer.exe",
    });

    expect(savedAs.startsWith(join(root, "agent-a"))).toBe(true);
    expect(savedAs.endsWith("-installer.exe")).toBe(true);
    expect(await readFile(result.file, "utf8")).toBe("untrusted bytes");
    expect(result.entry).toMatchObject({
      status: "quarantined",
      originalName: "../../installer.exe",
      sourceUrl: "https://example.test/installer.exe",
      bytes: 15,
    });
    expect(result.entry.sha256).toMatch(/^[a-f0-9]{64}$/);

    const raw = JSON.parse(await readFile(result.metadata, "utf8")) as {
      version: number;
      storedName: string;
      file?: unknown;
      sha256: string;
    };
    expect(raw.version).toBe(2);
    expect(raw.storedName.endsWith("-installer.exe")).toBe(true);
    expect(raw.file).toBeUndefined();
    expect(raw.sha256).toBe(result.entry.sha256);
  });

  test("lists only valid regular quarantined files and never returns their path", async () => {
    const first = await quarantineDownload(root, "agent-a", {
      failure: async () => null,
      saveAs: async (path: string) => Bun.write(path, "one"),
      suggestedFilename: () => "one.txt",
      url: () => "https://example.test/one.txt",
    });
    await quarantineDownload(root, "agent-b", {
      failure: async () => null,
      saveAs: async (path: string) => Bun.write(path, "other bot"),
      suggestedFilename: () => "other.txt",
      url: () => "https://example.test/other.txt",
    });

    const entries = await listQuarantinedDownloads(root, "agent-a");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(first.id);
    expect(entries[0]).not.toHaveProperty("file");
    expect(entries[0]).not.toHaveProperty("storedName");
  });

  test("deletes by generated id, never by a caller supplied path", async () => {
    const saved = await quarantineDownload(root, "agent-a", {
      failure: async () => null,
      saveAs: async (path: string) => Bun.write(path, "delete me"),
      suggestedFilename: () => "payload.exe",
      url: () => "https://example.test/payload.exe",
    });

    await expect(
      deleteQuarantinedDownload(root, "agent-a", "../../payload.exe"),
    ).rejects.toThrow();
    expect(await deleteQuarantinedDownload(root, "agent-a", saved.id)).toBe(
      true,
    );
    expect(await listQuarantinedDownloads(root, "agent-a")).toEqual([]);
    expect(await deleteQuarantinedDownload(root, "agent-a", saved.id)).toBe(
      false,
    );
  });
});

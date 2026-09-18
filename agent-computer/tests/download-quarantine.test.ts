import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
    expect(safeDownloadName('bad:<name>?.ps1')).toBe("bad__name__.ps1");
    expect(safeDownloadName("..")).toBe("download");
  });

  test("Bot ids cannot escape the quarantine root", () => {
    expect(() => quarantineDirectoryFor(root, "../other")).toThrow();
    expect(quarantineDirectoryFor(root, "agent-a")).toBe(join(root, "agent-a"));
  });

  test("persists a download only under quarantine with quarantine metadata", async () => {
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

    const metadata = JSON.parse(await readFile(result.metadata, "utf8")) as {
      status: string;
      originalName: string;
      sourceUrl: string;
    };
    expect(metadata.status).toBe("quarantined");
    expect(metadata.originalName).toBe("../../installer.exe");
    expect(metadata.sourceUrl).toBe("https://example.test/installer.exe");
  });
});

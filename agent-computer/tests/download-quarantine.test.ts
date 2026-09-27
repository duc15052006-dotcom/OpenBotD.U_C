import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveQuarantinedDownload,
  approvedQuarantineFile,
  deleteQuarantinedDownload,
  listQuarantinedDownloads,
  markQuarantinedDownloadReleased,
  quarantineDirectoryFor,
  quarantineDownload,
  QuarantineStateError,
  safeDownloadName,
  scanQuarantinedDownload,
} from "../src/download-quarantine";
import type { MalwareScanResult } from "../src/quarantine-scanner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-quarantine-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeScan(
  status: MalwareScanResult["status"],
  detail = status,
): (file: string) => Promise<MalwareScanResult> {
  return async () => ({
    status,
    scanner: "clamav",
    detail,
    scannedAt: new Date().toISOString(),
  });
}

async function addDownload(botId = "agent-a") {
  return quarantineDownload(root, botId, {
    failure: async () => null,
    saveAs: async (path: string) => {
      await Bun.write(path, "untrusted bytes");
    },
    suggestedFilename: () => "../../installer.exe",
    url: () => "https://example.test/installer.exe",
  });
}

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

  test("persists identity only under quarantine as pending untrusted input", async () => {
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
    expect(result.record.status).toBe("pending");
    expect(result.record.sha256).toMatch(/^[a-f0-9]{64}$/);

    const metadata = JSON.parse(await readFile(result.metadata, "utf8")) as {
      status: string;
      originalName: string;
      sourceUrl: string;
      sha256: string;
      file?: unknown;
    };
    expect(metadata.status).toBe("pending");
    expect(metadata.originalName).toBe("../../installer.exe");
    expect(metadata.sourceUrl).toBe("https://example.test/installer.exe");
    expect(metadata.sha256).toBe(result.record.sha256);
    expect(metadata.file).toBeUndefined();
  });

  test("a failed scanner is never treated as clean or approvable", async () => {
    const download = await addDownload();
    const scanned = await scanQuarantinedDownload(
      root,
      "agent-a",
      download.id,
      fakeScan("scan_failed", "signature database unavailable"),
    );
    expect(scanned.status).toBe("scan_failed");
    expect(scanned.scan?.detail).toContain("database");

    await expect(
      approveQuarantinedDownload(root, "agent-a", download.id),
    ).rejects.toThrow(QuarantineStateError);
  });

  test("a malware verdict stays blocked and cannot be approved", async () => {
    const download = await addDownload();
    const scanned = await scanQuarantinedDownload(
      root,
      "agent-a",
      download.id,
      fakeScan("blocked", "Eicar-Test-Signature FOUND"),
    );
    expect(scanned.status).toBe("blocked");

    await expect(
      approveQuarantinedDownload(root, "agent-a", download.id),
    ).rejects.toThrow(QuarantineStateError);
  });

  test("changing the file during a clean scan fails closed", async () => {
    const download = await addDownload();
    const scanned = await scanQuarantinedDownload(
      root,
      "agent-a",
      download.id,
      async (file) => {
        await Bun.write(file, "different bytes after scan started");
        return {
          status: "clean",
          scanner: "clamav",
          detail: "no malware",
          scannedAt: new Date().toISOString(),
        };
      },
    );
    expect(scanned.status).toBe("scan_failed");
    expect(scanned.scannedSha256).toBeUndefined();
    expect(scanned.scan?.detail).toContain("changed");
  });

  test("approval and export stay bound to the exact clean bytes", async () => {
    const download = await addDownload();
    const scanned = await scanQuarantinedDownload(
      root,
      "agent-a",
      download.id,
      fakeScan("clean", "no malware"),
    );
    expect(scanned.status).toBe("clean");
    expect(scanned.scannedSha256).toBe(scanned.sha256);

    const approved = await approveQuarantinedDownload(
      root,
      "agent-a",
      download.id,
    );
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeTruthy();

    const exportable = await approvedQuarantineFile(
      root,
      "agent-a",
      download.id,
    );
    expect(exportable.record.sha256).toBe(scanned.sha256);
    expect(await readFile(exportable.file, "utf8")).toBe("untrusted bytes");

    await Bun.write(download.file, "tampered but still quarantined");
    await expect(
      approvedQuarantineFile(root, "agent-a", download.id),
    ).rejects.toThrow(QuarantineStateError);
    await expect(
      markQuarantinedDownloadReleased(root, "agent-a", download.id),
    ).rejects.toThrow(QuarantineStateError);
  });

  test("release is a separate transition after native export succeeds", async () => {
    const download = await addDownload();
    await scanQuarantinedDownload(
      root,
      "agent-a",
      download.id,
      fakeScan("clean"),
    );
    await approveQuarantinedDownload(root, "agent-a", download.id);
    const released = await markQuarantinedDownloadReleased(
      root,
      "agent-a",
      download.id,
    );
    expect(released.status).toBe("released");
    expect(released.releasedAt).toBeTruthy();
    await expect(
      approvedQuarantineFile(root, "agent-a", download.id),
    ).rejects.toThrow(QuarantineStateError);
  });

  test("delete accepts only the generated id and remains per-Agent", async () => {
    const download = await addDownload("agent-a");
    await expect(
      deleteQuarantinedDownload(root, "agent-a", "../../installer.exe"),
    ).rejects.toThrow(QuarantineStateError);
    expect(await deleteQuarantinedDownload(root, "agent-b", download.id)).toBe(
      false,
    );
    expect(await deleteQuarantinedDownload(root, "agent-a", download.id)).toBe(
      true,
    );
    expect(await listQuarantinedDownloads(root, "agent-a")).toEqual([]);
  });

  test("one Agent cannot list or scan another Agent's quarantine", async () => {
    const download = await addDownload("agent-a");
    expect(await listQuarantinedDownloads(root, "agent-b")).toEqual([]);
    await expect(
      scanQuarantinedDownload(root, "agent-b", download.id, fakeScan("clean")),
    ).rejects.toThrow(QuarantineStateError);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { Download } from "playwright";
import { isPlainBotId } from "./bot-id";

const METADATA_SUFFIX = ".openbot.json";

/**
 * Browser downloads are hostile input until somebody explicitly releases them.
 *
 * They are copied out of Playwright's temporary download area into a dedicated persistent
 * quarantine volume, never into /workspace and never onto the Windows host.
 */
export function safeDownloadName(input: string): string {
  const leaf = basename(input.replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .trim()
    .slice(0, 160);
  return !leaf || leaf === "." || leaf === ".." ? "download" : leaf;
}

export function quarantineDirectoryFor(root: string, botId: string): string {
  if (!isPlainBotId(botId)) {
    throw new Error("A quarantine directory requires a plain Bot id.");
  }
  return join(root, botId);
}

export type QuarantineEntry = {
  id: string;
  status: "quarantined";
  originalName: string;
  sourceUrl: string;
  savedAt: string;
  bytes: number;
  sha256: string;
};

type QuarantineMetadata = QuarantineEntry & {
  version: 2;
  botId: string;
  storedName: string;
  note: string;
};

export type QuarantinedDownload = {
  id: string;
  file: string;
  metadata: string;
  entry: QuarantineEntry;
};

async function fingerprint(file: string): Promise<{ bytes: number; sha256: string }> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("A quarantined download must be a regular file.");
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return { bytes: info.size, sha256: hash.digest("hex") };
}

function publicEntry(metadata: QuarantineMetadata): QuarantineEntry {
  return {
    id: metadata.id,
    status: "quarantined",
    originalName: metadata.originalName,
    sourceUrl: metadata.sourceUrl,
    savedAt: metadata.savedAt,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
  };
}

function validMetadata(
  value: unknown,
  botId: string,
  storedName: string,
): value is QuarantineMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 2 &&
    item.status === "quarantined" &&
    item.botId === botId &&
    item.storedName === storedName &&
    typeof item.id === "string" &&
    /^[A-Za-z0-9-]{1,100}$/.test(item.id) &&
    storedName.startsWith(`${item.id}-`) &&
    typeof item.originalName === "string" &&
    typeof item.sourceUrl === "string" &&
    typeof item.savedAt === "string" &&
    typeof item.bytes === "number" &&
    Number.isSafeInteger(item.bytes) &&
    item.bytes >= 0 &&
    typeof item.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(item.sha256)
  );
}

export async function quarantineDownload(
  root: string,
  botId: string,
  download: Pick<Download, "failure" | "saveAs" | "suggestedFilename" | "url">,
): Promise<QuarantinedDownload> {
  const directory = quarantineDirectoryFor(root, botId);
  await mkdir(directory, { recursive: true });

  const failure = await download.failure();
  if (failure) {
    throw new Error(
      `The browser download failed before quarantine: ${failure}`,
    );
  }

  const id = `${Date.now()}-${randomUUID()}`;
  const storedName = `${id}-${safeDownloadName(download.suggestedFilename())}`;
  const file = join(directory, storedName);
  await download.saveAs(file);

  try {
    const { bytes, sha256 } = await fingerprint(file);
    const savedAt = new Date().toISOString();
    const metadata: QuarantineMetadata = {
      version: 2,
      status: "quarantined",
      id,
      botId,
      storedName,
      originalName: download.suggestedFilename(),
      sourceUrl: download.url(),
      savedAt,
      bytes,
      sha256,
      note: "Untrusted browser download. Do not execute or export without explicit user approval and scanning policy.",
    };
    const metadataPath = `${file}${METADATA_SUFFIX}`;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return {
      id,
      file,
      metadata: metadataPath,
      entry: publicEntry(metadata),
    };
  } catch (error) {
    // An untracked hostile file is worse than a failed download. If identity/metadata cannot be
    // created, remove the bytes rather than leave something in quarantine that no UI can account for.
    await unlink(file).catch(() => undefined);
    throw error;
  }
}

export async function listQuarantinedDownloads(
  root: string,
  botId: string,
): Promise<QuarantineEntry[]> {
  const directory = quarantineDirectoryFor(root, botId);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const entries: QuarantineEntry[] = [];

  for (const metadataName of names) {
    if (!metadataName.endsWith(METADATA_SUFFIX)) continue;
    const storedName = metadataName.slice(0, -METADATA_SUFFIX.length);
    const metadataPath = join(directory, metadataName);
    const file = join(directory, storedName);
    try {
      const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
      if (!validMetadata(parsed, botId, storedName)) continue;
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (info.size !== parsed.bytes) continue;
      entries.push(publicEntry(parsed));
    } catch {
      // Corrupt/missing metadata or bytes are not promoted into a trusted-looking admin entry.
      // Reset still clears the whole quarantine volume.
    }
  }

  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function deleteQuarantinedDownload(
  root: string,
  botId: string,
  id: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) {
    throw new Error("That is not a valid quarantine id.");
  }

  const directory = quarantineDirectoryFor(root, botId);
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });

  for (const metadataName of names) {
    if (!metadataName.endsWith(METADATA_SUFFIX)) continue;
    const storedName = metadataName.slice(0, -METADATA_SUFFIX.length);
    const metadataPath = join(directory, metadataName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!validMetadata(parsed, botId, storedName) || parsed.id !== id) continue;

    // Only paths derived from the directory listing are removed. The request never supplies a path.
    await unlink(join(directory, storedName)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(metadataPath);
    return true;
  }

  return false;
}

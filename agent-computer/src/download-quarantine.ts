import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { Download } from "playwright";
import { isPlainBotId } from "./bot-id";
import { scanWithClamAv, type MalwareScanResult } from "./quarantine-scanner";

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

export type QuarantineStatus =
  | "pending"
  | "clean"
  | "blocked"
  | "scan_failed"
  | "approved"
  | "released";

export type QuarantineRecord = {
  version: 2;
  status: QuarantineStatus;
  id: string;
  botId: string;
  originalName: string;
  sourceUrl: string;
  savedAt: string;
  sizeBytes: number;
  scan?: MalwareScanResult;
  approvedAt?: string;
  releasedAt?: string;
};

type StoredQuarantineRecord = QuarantineRecord & {
  file: string;
  metadata: string;
};

export type QuarantinedDownload = {
  id: string;
  file: string;
  metadata: string;
};

export class QuarantineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineStateError";
  }
}

const METADATA_SUFFIX = ".openbot.json";
const QUARANTINE_ID =
  /^\d{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(id: string): boolean {
  return QUARANTINE_ID.test(id);
}

async function writeMetadata(
  path: string,
  record: QuarantineRecord,
  exclusive = false,
): Promise<void> {
  if (exclusive) {
    await writeFile(path, JSON.stringify(record, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return;
  }

  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record, null, 2), "utf8");
  await rename(temporary, path);
}

function publicRecord(record: StoredQuarantineRecord): QuarantineRecord {
  const { file: _file, metadata: _metadata, ...safe } = record;
  return safe;
}

function normalizeStatus(value: unknown): QuarantineStatus {
  if (value === "quarantined") return "pending";
  if (
    value === "pending" ||
    value === "clean" ||
    value === "blocked" ||
    value === "scan_failed" ||
    value === "approved" ||
    value === "released"
  ) {
    return value;
  }
  return "scan_failed";
}

async function readStoredMetadata(
  metadata: string,
  expectedBotId: string,
): Promise<StoredQuarantineRecord> {
  const raw = JSON.parse(await readFile(metadata, "utf8")) as Record<
    string,
    unknown
  >;
  const file = metadata.slice(0, -METADATA_SUFFIX.length);
  const filename = basename(file);
  if (typeof raw.id !== "string" || !validId(raw.id)) {
    throw new QuarantineStateError(
      "Quarantine metadata has an invalid download id.",
    );
  }
  const id = raw.id;
  if (raw.botId !== expectedBotId || !filename.startsWith(`${id}-`)) {
    throw new QuarantineStateError(
      "Quarantine metadata does not belong to this Bot or download.",
    );
  }

  const fileInfo = await stat(file);
  if (!fileInfo.isFile()) {
    throw new QuarantineStateError("The quarantined download is not a file.");
  }

  return {
    version: 2,
    status: normalizeStatus(raw.status),
    id,
    botId: expectedBotId,
    originalName:
      typeof raw.originalName === "string"
        ? raw.originalName
        : filename.slice(id.length + 1),
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
    savedAt:
      typeof raw.savedAt === "string"
        ? raw.savedAt
        : new Date(fileInfo.mtimeMs).toISOString(),
    sizeBytes: fileInfo.size,
    ...(raw.scan && typeof raw.scan === "object"
      ? { scan: raw.scan as MalwareScanResult }
      : {}),
    ...(typeof raw.approvedAt === "string"
      ? { approvedAt: raw.approvedAt }
      : {}),
    ...(typeof raw.releasedAt === "string"
      ? { releasedAt: raw.releasedAt }
      : {}),
    file,
    metadata,
  };
}

async function findStored(
  root: string,
  botId: string,
  id: string,
): Promise<StoredQuarantineRecord> {
  if (!validId(id)) {
    throw new QuarantineStateError("That quarantine download id is invalid.");
  }
  const directory = quarantineDirectoryFor(root, botId);
  const entries = await readdir(directory).catch(() => []);
  const matches = entries.filter(
    (entry) => entry.startsWith(`${id}-`) && entry.endsWith(METADATA_SUFFIX),
  );
  const metadata = matches[0];
  if (matches.length !== 1 || !metadata) {
    throw new QuarantineStateError("That quarantined download was not found.");
  }
  return readStoredMetadata(join(directory, metadata), botId);
}

export async function listQuarantinedDownloads(
  root: string,
  botId: string,
): Promise<QuarantineRecord[]> {
  const directory = quarantineDirectoryFor(root, botId);
  const entries = await readdir(directory).catch(() => []);
  const records: QuarantineRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(METADATA_SUFFIX)) continue;
    try {
      records.push(
        publicRecord(await readStoredMetadata(join(directory, entry), botId)),
      );
    } catch {
      // An incomplete/corrupt sidecar is not silently called clean. It is omitted from the normal
      // list and still remains physically quarantined for diagnostics/recovery.
    }
  }
  return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function scanQuarantinedDownload(
  root: string,
  botId: string,
  id: string,
  scanner: (file: string) => Promise<MalwareScanResult> = scanWithClamAv,
): Promise<QuarantineRecord> {
  const stored = await findStored(root, botId, id);
  if (stored.status === "released") {
    throw new QuarantineStateError(
      "A released download cannot be scanned in place.",
    );
  }

  const scan = await scanner(stored.file);
  const current = publicRecord(stored);
  const {
    approvedAt: _approvedAt,
    releasedAt: _releasedAt,
    ...unapproved
  } = current;
  const updated: QuarantineRecord = {
    ...unapproved,
    status: scan.status,
    scan,
  };
  await writeMetadata(stored.metadata, updated);
  return updated;
}

export async function approveQuarantinedDownload(
  root: string,
  botId: string,
  id: string,
): Promise<QuarantineRecord> {
  const stored = await findStored(root, botId, id);
  if (stored.status === "approved") return publicRecord(stored);
  if (stored.status !== "clean") {
    throw new QuarantineStateError(
      `Only a clean scanned download can be approved for export (current status: ${stored.status}).`,
    );
  }

  const updated: QuarantineRecord = {
    ...publicRecord(stored),
    status: "approved",
    approvedAt: new Date().toISOString(),
  };
  await writeMetadata(stored.metadata, updated);
  return updated;
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
  const file = join(
    directory,
    `${id}-${safeDownloadName(download.suggestedFilename())}`,
  );
  await download.saveAs(file);

  const fileInfo = await stat(file);
  const metadata = `${file}${METADATA_SUFFIX}`;
  await writeMetadata(
    metadata,
    {
      version: 2,
      status: "pending",
      id,
      botId,
      originalName: download.suggestedFilename(),
      sourceUrl: download.url(),
      savedAt: new Date().toISOString(),
      sizeBytes: fileInfo.size,
    },
    true,
  );

  return { id, file, metadata };
}

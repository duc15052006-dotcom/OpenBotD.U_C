import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
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
  /** Identity of the exact bytes the record refers to. Never a container/host path. */
  sha256: string;
  /** Exact bytes ClamAV scanned. Approval/export must still match this digest. */
  scannedSha256?: string;
  scan?: MalwareScanResult;
  approvedAt?: string;
  releasedAt?: string;
};

type StoredQuarantineRecord = QuarantineRecord & {
  file: string;
  metadata: string;
  integrityOk: boolean;
};

export type QuarantinedDownload = {
  id: string;
  file: string;
  metadata: string;
  record: QuarantineRecord;
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
const SHA256 = /^[a-f0-9]{64}$/;

function validId(id: string): boolean {
  return QUARANTINE_ID.test(id);
}

async function fingerprint(
  file: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new QuarantineStateError(
      "A quarantined download must be a regular file.",
    );
  }

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return { sizeBytes: info.size, sha256: hash.digest("hex") };
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
  const {
    file: _file,
    metadata: _metadata,
    integrityOk: _integrityOk,
    ...safe
  } = record;
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

function integrityFailure(record: QuarantineRecord): QuarantineRecord {
  const {
    approvedAt: _approvedAt,
    releasedAt: _releasedAt,
    scannedSha256: _scannedSha256,
    ...untrusted
  } = record;
  return {
    ...untrusted,
    status: "scan_failed",
    scan: {
      status: "scan_failed",
      scanner: "clamav",
      detail:
        "The quarantined file changed after its recorded identity/scan and must be rescanned.",
      scannedAt: new Date().toISOString(),
    },
  };
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

  const current = await fingerprint(file);
  const recordedSha =
    typeof raw.sha256 === "string" && SHA256.test(raw.sha256)
      ? raw.sha256
      : current.sha256;
  const recordedSize =
    typeof raw.sizeBytes === "number" &&
    Number.isSafeInteger(raw.sizeBytes) &&
    raw.sizeBytes >= 0
      ? raw.sizeBytes
      : current.sizeBytes;
  const status = normalizeStatus(raw.status);
  const integrityOk =
    recordedSha === current.sha256 && recordedSize === current.sizeBytes;

  const parsed: QuarantineRecord = {
    version: 2,
    status,
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
        : new Date().toISOString(),
    sizeBytes: recordedSize,
    sha256: recordedSha,
    ...(typeof raw.scannedSha256 === "string" &&
    SHA256.test(raw.scannedSha256)
      ? { scannedSha256: raw.scannedSha256 }
      : {}),
    ...(raw.scan && typeof raw.scan === "object"
      ? { scan: raw.scan as MalwareScanResult }
      : {}),
    ...(typeof raw.approvedAt === "string"
      ? { approvedAt: raw.approvedAt }
      : {}),
    ...(typeof raw.releasedAt === "string"
      ? { releasedAt: raw.releasedAt }
      : {}),
  };

  const safe =
    integrityOk || status === "pending" || status === "blocked"
      ? parsed
      : integrityFailure(parsed);

  return {
    ...safe,
    file,
    metadata,
    integrityOk,
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
      // An incomplete/corrupt sidecar is never promoted into a trusted-looking entry. Reset can
      // still clear the complete quarantine volume for recovery.
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

  const before = await fingerprint(stored.file);
  const scan = await scanner(stored.file);
  const after = await fingerprint(stored.file);
  const current = publicRecord(stored);
  const {
    approvedAt: _approvedAt,
    releasedAt: _releasedAt,
    scannedSha256: _scannedSha256,
    ...unapproved
  } = current;

  const changedDuringScan =
    before.sha256 !== after.sha256 || before.sizeBytes !== after.sizeBytes;
  const effectiveScan: MalwareScanResult = changedDuringScan
    ? {
        status: "scan_failed",
        scanner: "clamav",
        detail:
          "The quarantined file changed while malware scanning was in progress.",
        scannedAt: new Date().toISOString(),
      }
    : scan;
  const updated: QuarantineRecord = {
    ...unapproved,
    sizeBytes: after.sizeBytes,
    sha256: after.sha256,
    status: effectiveScan.status,
    scan: effectiveScan,
    ...(effectiveScan.status === "clean"
      ? { scannedSha256: after.sha256 }
      : {}),
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
  if (
    stored.status === "approved" &&
    stored.integrityOk &&
    stored.scannedSha256 === stored.sha256
  ) {
    return publicRecord(stored);
  }
  if (
    stored.status !== "clean" ||
    !stored.integrityOk ||
    stored.scannedSha256 !== stored.sha256
  ) {
    throw new QuarantineStateError(
      `Only unchanged bytes from a clean scan can be approved for export (current status: ${stored.status}).`,
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

/**
 * Resolve bytes for the native export worker, never for a browser/model response.
 *
 * The caller still has to choose a host destination natively. Returning a path internally avoids
 * loading hostile bytes into JSON while binding export to the exact digest that was scanned.
 */
export async function approvedQuarantineFile(
  root: string,
  botId: string,
  id: string,
): Promise<{ file: string; record: QuarantineRecord }> {
  const stored = await findStored(root, botId, id);
  if (
    stored.status !== "approved" ||
    !stored.integrityOk ||
    stored.scannedSha256 !== stored.sha256
  ) {
    throw new QuarantineStateError(
      "This download is not an unchanged, clean, explicitly approved file.",
    );
  }
  return { file: stored.file, record: publicRecord(stored) };
}

export async function markQuarantinedDownloadReleased(
  root: string,
  botId: string,
  id: string,
): Promise<QuarantineRecord> {
  const stored = await findStored(root, botId, id);
  if (
    stored.status !== "approved" ||
    !stored.integrityOk ||
    stored.scannedSha256 !== stored.sha256
  ) {
    throw new QuarantineStateError(
      "Only the unchanged approved bytes can be marked released.",
    );
  }
  const updated: QuarantineRecord = {
    ...publicRecord(stored),
    status: "released",
    releasedAt: new Date().toISOString(),
  };
  await writeMetadata(stored.metadata, updated);
  return updated;
}

export async function deleteQuarantinedDownload(
  root: string,
  botId: string,
  id: string,
): Promise<boolean> {
  const stored = await findStored(root, botId, id).catch((error) => {
    if (
      error instanceof QuarantineStateError &&
      error.message === "That quarantined download was not found."
    ) {
      return null;
    }
    throw error;
  });
  if (!stored) return false;

  await unlink(stored.file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(stored.metadata).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
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

  try {
    const { sizeBytes, sha256 } = await fingerprint(file);
    const metadata = `${file}${METADATA_SUFFIX}`;
    const record: QuarantineRecord = {
      version: 2,
      status: "pending",
      id,
      botId,
      originalName: download.suggestedFilename(),
      sourceUrl: download.url(),
      savedAt: new Date().toISOString(),
      sizeBytes,
      sha256,
    };
    await writeMetadata(metadata, record, true);
    return { id, file, metadata, record };
  } catch (error) {
    // Untracked hostile bytes are worse than a failed download. If identity/metadata cannot be
    // established, remove the bytes rather than leave something the UI cannot account for.
    await unlink(file).catch(() => undefined);
    throw error;
  }
}

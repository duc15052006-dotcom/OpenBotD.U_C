import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Download } from "playwright";
import { isPlainBotId } from "./bot-id";

/**
 * Browser downloads are hostile input until somebody explicitly releases them.
 *
 * They are copied out of Playwright's temporary download area into a dedicated persistent
 * quarantine volume, never into /workspace and never onto the Windows host.
 */
export function safeDownloadName(input: string): string {
  const leaf = basename(input.replaceAll("\\", "/"))
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
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

export type QuarantinedDownload = {
  id: string;
  file: string;
  metadata: string;
};

export async function quarantineDownload(
  root: string,
  botId: string,
  download: Pick<Download, "failure" | "saveAs" | "suggestedFilename" | "url">,
): Promise<QuarantinedDownload> {
  const directory = quarantineDirectoryFor(root, botId);
  await mkdir(directory, { recursive: true });

  const failure = await download.failure();
  if (failure) {
    throw new Error(\n      `The browser download failed before quarantine: ${failure}`,\n    );
  }

  const id = `${Date.now()}-${randomUUID()}`;
  const file = join(\n    directory,\n    `${id}-${safeDownloadName(download.suggestedFilename())}`,\n  );
  await download.saveAs(file);

  const metadata = `${file}.openbot.json`;
  await writeFile(
    metadata,
    JSON.stringify(
      {
        version: 1,
        status: "quarantined",
        id,
        botId,
        originalName: download.suggestedFilename(),
        sourceUrl: download.url(),
        savedAt: new Date().toISOString(),
        file,
        note: "Untrusted browser download. Do not execute or export without explicit user approval and scanning policy.",
      },
      null,
      2,
    ),
    { encoding: "utf8", flag: "wx" },
  );

  return { id, file, metadata };
}

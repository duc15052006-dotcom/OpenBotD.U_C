import { client } from "@/lib/client";

export type ComputerWorkspaceEntry = {
  path: string;
  kind: "file" | "folder";
  bytes?: number;
};

export type ComputerWorkspaceListing = {
  path: string;
  entries: ComputerWorkspaceEntry[];
  truncated: boolean;
};

export type ComputerWorkspaceFile = {
  path: string;
  text: string;
  truncated: boolean;
  bytes: number;
};

const computerPath = (botId: string, suffix: string) =>
  `/api/computers/${encodeURIComponent(botId)}${suffix}`;

export async function listComputerFiles(
  botId: string,
  path?: string,
): Promise<ComputerWorkspaceListing> {
  const response = await client(computerPath(botId, "/files/list"), {
    method: "POST",
    body: path ? { path } : {},
    fallback: "The folder could not be listed.",
  });
  return response.json();
}

export async function readComputerFile(
  botId: string,
  path: string,
): Promise<ComputerWorkspaceFile> {
  const response = await client(computerPath(botId, "/files/read"), {
    method: "POST",
    body: { path },
    fallback: "The file could not be read.",
  });
  return response.json();
}

export async function writeComputerFile(
  botId: string,
  path: string,
  contents: string,
): Promise<{ path: string; bytes: number; appended: boolean }> {
  const response = await client(computerPath(botId, "/files/write"), {
    method: "POST",
    body: { path, contents },
    fallback: "The file could not be saved.",
  });
  return response.json();
}

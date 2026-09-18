import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type ChannelSharedFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  attachedAt: string;
};

export const sharedFileKeys = {
  channel: (channelId: string) =>
    ["channels", "shared-files", channelId] as const,
};

export function channelSharedFilesQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: sharedFileKeys.channel(channelId),
    queryFn: async (): Promise<ChannelSharedFile[]> =>
      client(
        `/api/channels/${encodeURIComponent(channelId)}/attachments`,
        "attachments",
        { fallback: "Could not load shared files" },
      ),
    // Mounted only while the files dialog is open. A fresh send appears without requiring the
    // person to close and reopen it, while closed channels do no polling.
    refetchInterval: 5_000,
  });
}

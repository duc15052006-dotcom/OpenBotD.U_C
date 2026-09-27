import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveAgentModelMutationOptions,
  testAgentModelMutationOptions,
} from "@/lib/agents/mutations";
import {
  type AgentModelProvider,
  agentModelQueryOptions,
} from "@/lib/agents/queries";

const PROVIDERS: Record<AgentModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

type Draft = {
  mode: "global" | "custom";
  provider: AgentModelProvider;
  model: string;
  credentialSource: "global" | "custom";
  apiKey: string;
  baseUrl: string;
  temperature: string;
  maxTokens: string;
  fallbackProvider: AgentModelProvider;
  fallbackModel: string;
};

const EMPTY_DRAFT: Draft = {
  mode: "global",
  provider: "openai",
  model: "",
  credentialSource: "global",
  apiKey: "",
  baseUrl: "",
  temperature: "",
  maxTokens: "",
  fallbackProvider: "openai",
  fallbackModel: "",
};

export function ModelSettingsPanel({
  agentId,
  builtIn,
}: {
  agentId: string;
  builtIn: boolean;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    ...agentModelQueryOptions(agentId),
    enabled: builtIn,
  });
  const save = useMutation(saveAgentModelMutationOptions(queryClient));
  const testConnection = useMutation(testAgentModelMutationOptions());
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    if (settings.data.mode === "global") {
      setDraft(EMPTY_DRAFT);
      return;
    }
    setDraft({
      mode: "custom",
      provider: settings.data.provider,
      model: settings.data.model,
      credentialSource: settings.data.credentialSource,
      apiKey: "",
      baseUrl: settings.data.baseUrl ?? "",
      temperature: settings.data.temperature?.toString() ?? "",
      maxTokens: settings.data.maxTokens?.toString() ?? "",
      fallbackProvider: settings.data.fallback?.provider ?? "openai",
      fallbackModel: settings.data.fallback?.model ?? "",
    });
  }, [settings.data]);

  if (!builtIn) {
    return (
      <p className="text-sm text-muted-foreground">
        This coworker runs at its own endpoint, so its model and API credentials
        are configured there.
      </p>
    );
  }
  if (settings.isPending) return null;
  if (settings.error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {settings.error.message}
      </p>
    );
  }

  const configured =
    settings.data?.mode === "custom" && settings.data.hasApiKey;
  const update = <Key extends keyof Draft>(key: Key, value: Draft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    setError(null);
    try {
      if (draft.mode === "global") {
        await save.mutateAsync({ agentId, input: { mode: "global" } });
        return;
      }
      const temperature = draft.temperature.trim()
        ? Number(draft.temperature)
        : undefined;
      const maxTokens = draft.maxTokens.trim()
        ? Number(draft.maxTokens)
        : undefined;
      await save.mutateAsync({
        agentId,
        input: {
          mode: "custom",
          provider: draft.provider,
          model: draft.model.trim(),
          credentialSource: draft.credentialSource,
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          ...(draft.provider === "openai" && draft.baseUrl.trim()
            ? { baseUrl: draft.baseUrl.trim() }
            : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(draft.fallbackModel.trim()
            ? {
                fallback: {
                  provider: draft.fallbackProvider,
                  model: draft.fallbackModel.trim(),
                },
              }
            : {}),
        },
      });
      update("apiKey", "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    }
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="agent-model-mode">Configuration</Label>
        <Select
          items={{ global: "Use global API", custom: "Custom API" }}
          onValueChange={(value) => update("mode", value as Draft["mode"])}
          value={draft.mode}
        >
          <SelectTrigger id="agent-model-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="global">Use global API</SelectItem>
            <SelectItem value="custom">Custom API</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Global uses the deployment model. Custom applies only to this
          coworker.
        </p>
      </div>

      {draft.mode === "custom" ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="agent-model-provider">Provider</Label>
              <Select
                items={PROVIDERS}
                onValueChange={(value) =>
                  update("provider", value as AgentModelProvider)
                }
                value={draft.provider}
              >
                <SelectTrigger id="agent-model-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDERS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-model-name">Model</Label>
              <Input
                id="agent-model-name"
                onChange={(event) => update("model", event.target.value)}
                placeholder="gpt-5, claude-sonnet, gemini-pro…"
                value={draft.model}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="agent-model-credential">API credential</Label>
            <Select
              items={{
                global: "Use provider global key",
                custom: "Custom key",
              }}
              onValueChange={(value) =>
                update("credentialSource", value as Draft["credentialSource"])
              }
              value={draft.credentialSource}
            >
              <SelectTrigger id="agent-model-credential">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Use provider global key</SelectItem>
                <SelectItem value="custom">Custom key</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.credentialSource === "custom" ? (
            <div className="grid gap-2">
              <Label htmlFor="agent-model-key">API key</Label>
              <Input
                autoComplete="new-password"
                id="agent-model-key"
                onChange={(event) => update("apiKey", event.target.value)}
                placeholder={
                  configured
                    ? "API key configured — leave blank to keep it"
                    : "Enter API key"
                }
                type="password"
                value={draft.apiKey}
              />
              {configured ? (
                <p className="text-xs text-muted-foreground">
                  API key configured. It cannot be read back.
                </p>
              ) : null}
            </div>
          ) : null}

          {draft.provider === "openai" ? (
            <div className="grid gap-2">
              <Label htmlFor="agent-model-base-url">
                OpenAI-compatible Base URL
              </Label>
              <Input
                id="agent-model-base-url"
                onChange={(event) => update("baseUrl", event.target.value)}
                placeholder="https://api.example.com/v1"
                type="url"
                value={draft.baseUrl}
              />
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="agent-model-temperature">Temperature</Label>
              <Input
                id="agent-model-temperature"
                max="2"
                min="0"
                onChange={(event) => update("temperature", event.target.value)}
                placeholder="Provider default"
                step="0.1"
                type="number"
                value={draft.temperature}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-model-max-tokens">Max tokens</Label>
              <Input
                id="agent-model-max-tokens"
                min="1"
                onChange={(event) => update("maxTokens", event.target.value)}
                placeholder="Provider default"
                step="1"
                type="number"
                value={draft.maxTokens}
              />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="agent-model-fallback-provider">
                Fallback provider
              </Label>
              <Select
                items={PROVIDERS}
                onValueChange={(value) =>
                  update("fallbackProvider", value as AgentModelProvider)
                }
                value={draft.fallbackProvider}
              >
                <SelectTrigger id="agent-model-fallback-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDERS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-model-fallback-model">Fallback model</Label>
              <Input
                id="agent-model-fallback-model"
                onChange={(event) =>
                  update("fallbackModel", event.target.value)
                }
                placeholder="Optional"
                value={draft.fallbackModel}
              />
            </div>
          </div>
        </>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {testConnection.data ? (
        <p
          className={
            testConnection.data.ok
              ? "text-sm text-emerald-600"
              : "text-sm text-destructive"
          }
          role="status"
        >
          {testConnection.data.ok
            ? `Connected to ${testConnection.data.provider}/${testConnection.data.model}.`
            : testConnection.data.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={save.isPending} onClick={() => void submit()}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
        <Button
          disabled={
            save.isPending ||
            testConnection.isPending ||
            settings.data?.mode !== "custom"
          }
          onClick={() => testConnection.mutate(agentId)}
          variant="outline"
        >
          {testConnection.isPending ? "Testing…" : "Test connection"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Test Connection checks the last saved settings. Save changes first.
      </p>
    </div>
  );
}

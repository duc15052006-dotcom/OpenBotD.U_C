import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  previewIdentity,
  previewManifest,
  verifyPreviewInstaller,
} from "./preview-distribution";

const sha = "0123456789abcdef0123456789abcdef01234567";
const identity = previewIdentity(
  "0.0.12",
  sha,
  "DUC15052006-dotcom/OpenBotD.U_C",
);
const components: string[] = JSON.parse(
  readFileSync(
    new URL("../.github/published-images.json", import.meta.url),
    "utf8",
  ),
);
const digests = Object.fromEntries(
  components.map((name) => [name, `sha256:${"a".repeat(64)}`]),
);
const build = {
  version: `0.0.12-internal.g${sha.slice(0, 12)}`,
  releaseVersion: "0.0.12",
  sourceSha: sha,
  channel: "internal",
  deploymentTag: identity.tag,
};

describe("complete preview distribution", () => {
  test("all framework choices have owned immutable runtime images", () => {
    const manifest = previewManifest(identity, components, digests);
    expect(Object.keys(manifest.images)).toEqual(components);
    expect(manifest.commit).toBe(sha);
    expect(manifest.version).toBe(identity.tag);
    for (const [name, image] of Object.entries(manifest.images))
      expect(image.reference).toBe(
        `ghcr.io/duc15052006-dotcom/openbot-${name}@${digests[name]}`,
      );
  });
  test("an incomplete, ambiguous or mutable runtime cannot become a release", () => {
    const missing = { ...digests };
    delete missing["agent-langgraph-agui"];
    for (const bad of [
      missing,
      { ...digests, unexpected: digests.server },
      { ...digests, server: "latest" },
      { ...digests, server: `sha256:${"A".repeat(64)}` },
    ])
      expect(() => previewManifest(identity, components, bad)).toThrow();
    expect(() =>
      previewManifest(identity, [...components, "server"], digests),
    ).toThrow();
    expect(() =>
      previewIdentity("0.0.12", sha.slice(0, 12), "owner/repo"),
    ).toThrow();
    expect(() => previewIdentity("0.0.12", sha, "owner/repo/other")).toThrow();
  });
  test("a normal CI installer or another commit is refused", () => {
    expect(
      verifyPreviewInstaller(identity, build, ["OpenBot_0.0.12_x64-setup.exe"]),
    ).toEndWith("-setup.exe");
    const { deploymentTag: _tag, ...ordinaryCI } = build;
    for (const bad of [
      ordinaryCI,
      { ...build, sourceSha: "b".repeat(40) },
      { ...build, channel: "release" },
      { ...build, deploymentTag: "v0.0.12" },
    ])
      expect(() =>
        verifyPreviewInstaller(identity, bad, ["OpenBot_x64-setup.exe"]),
      ).toThrow();
    expect(() => verifyPreviewInstaller(identity, build, [])).toThrow();
    expect(() =>
      verifyPreviewInstaller(identity, build, [
        "one-setup.exe",
        "two-setup.exe",
      ]),
    ).toThrow();
  });
  test("publication waits for exact-tree checks, desktop acceptance and anonymous pulls", () => {
    const workflow = YAML.parse(
      readFileSync(
        new URL("../.github/workflows/publish-preview.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(workflow.on.push.branches).toEqual(["verify/publish-candidate"]);
    expect(workflow.jobs.publish.needs).toEqual([
      "metadata",
      "checks",
      "desktop-checks",
      "component-images",
      "anonymous-pull",
    ]);
    expect(workflow.jobs["desktop-checks"].with["deployment-tag"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression is literal YAML data.
      "${{ needs.metadata.outputs.tag }}",
    );
    const pull = workflow.jobs["anonymous-pull"].steps.find(
      (step: { run?: string }) => step.run?.includes("docker pull"),
    );
    expect(pull.run).toContain('DOCKER_CONFIG="$(mktemp -d)"');
    expect(pull.run).not.toContain("docker login");
    const publish = workflow.jobs.publish.steps.find((step: { run?: string }) =>
      step.run?.includes("gh release create"),
    );
    expect(publish.run).toContain("--prerelease --latest=false");
    expect(publish.run).toContain('--target "$GITHUB_SHA" --verify-tag');
    expect(publish.run).not.toContain("--clobber");
  });
});

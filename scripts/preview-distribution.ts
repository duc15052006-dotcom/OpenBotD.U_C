/** Assemble an immutable Windows x64 preview without changing stable release gates. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function previewIdentity(
  version: string,
  sha: string,
  repository: string,
) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Invalid base version");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Full source SHA required");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)
  )
    throw new Error("Invalid source repository");
  return {
    tag: `v${version}-rc.${sha}`,
    owner: repository.split("/")[0].toLowerCase(),
    sha,
    version,
  };
}

export function previewManifest(
  identity: ReturnType<typeof previewIdentity>,
  components: string[],
  digests: Record<string, string>,
) {
  if (
    components.length === 0 ||
    new Set(components).size !== components.length ||
    components.some((name) => !/^[a-z][a-z0-9-]*$/.test(name)) ||
    Object.keys(digests).length !== components.length ||
    components.some((name) => !Object.hasOwn(digests, name))
  )
    throw new Error(
      "Preview must contain every published component exactly once",
    );
  const images: Record<string, { reference: string }> = {};
  for (const name of components) {
    const digest = digests[name];
    if (!/^sha256:[0-9a-f]{64}$/.test(digest))
      throw new Error(`Invalid digest for ${name}`);
    images[name] = {
      reference: `ghcr.io/${identity.owner}/openbot-${name}@${digest}`,
    };
  }
  return { version: identity.tag, commit: identity.sha, images };
}

export function verifyPreviewInstaller(
  identity: ReturnType<typeof previewIdentity>,
  metadata: unknown,
  installers: string[],
) {
  const expected = {
    version: `${identity.version}-internal.g${identity.sha.slice(0, 12)}`,
    releaseVersion: identity.version,
    sourceSha: identity.sha,
    channel: "internal",
    deploymentTag: identity.tag,
  };
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Object.entries(expected).some(
      ([key, value]) => (metadata as Record<string, unknown>)[key] !== value,
    ) ||
    installers.length !== 1 ||
    !/^[A-Za-z0-9._-]+-setup\.exe$/.test(installers[0])
  )
    throw new Error(
      "Expected one Windows installer bound to this exact preview",
    );
  return installers[0];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const identity = previewIdentity(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    process.env.GITHUB_SHA ?? "",
    process.env.GITHUB_REPOSITORY ?? "",
  );
  const components: string[] = JSON.parse(
    readFileSync(join(root, ".github/published-images.json"), "utf8"),
  );
  const [command, directory] = process.argv.slice(2);
  if (command === "metadata") {
    // Validate the component set before it becomes a shell/matrix input.
    previewManifest(
      identity,
      components,
      Object.fromEntries(
        components.map((name) => [name, `sha256:${"0".repeat(64)}`]),
      ),
    );
    for (const name of components) readFileSync(join(root, name, "Dockerfile"));
    console.log(JSON.stringify({ ...identity, components }));
  } else if (command === "manifest" && directory) {
    const digests = Object.fromEntries(
      readdirSync(directory).map((name) => [
        name,
        readFileSync(join(directory, name), "utf8").trim(),
      ]),
    );
    writeFileSync(
      "container-images.json",
      `${JSON.stringify(previewManifest(identity, components, digests), null, 2)}\n`,
    );
  } else if (command === "installer" && directory) {
    const names = readdirSync(directory, { recursive: true }).map(String);
    const metadataFiles = names.filter((name) =>
      name.endsWith("build-version.json"),
    );
    if (metadataFiles.length !== 1)
      throw new Error("One build metadata file required");
    const metadata = JSON.parse(
      readFileSync(join(directory, metadataFiles[0]), "utf8"),
    );
    const installers = names.filter((name) => name.endsWith("-setup.exe"));
    verifyPreviewInstaller(
      identity,
      metadata,
      installers.map((name) => name.split(/[\\/]/).pop() ?? ""),
    );
    console.log(
      JSON.stringify({
        installer: join(directory, installers[0]),
        metadata: join(directory, metadataFiles[0]),
      }),
    );
  } else {
    throw new Error(
      "Usage: preview-distribution.ts metadata|manifest <dir>|installer <dir>",
    );
  }
}

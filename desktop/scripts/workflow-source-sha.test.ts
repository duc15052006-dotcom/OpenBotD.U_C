import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE_SHA_EXPRESSION = `\${{ github.event.pull_request.head.sha || github.sha }}`;

function workflow(name: string): string {
  return readFileSync(
    resolve(import.meta.dir, "../..", ".github/workflows", name),
    "utf8",
  );
}

for (const name of ["desktop.yml", "desktop-signing.yml"]) {
  test(`${name} stamps the same source SHA it checks out`, () => {
    const source = workflow(name);
    expect(source).toContain(`ref: ${SOURCE_SHA_EXPRESSION}`);
    expect(source).toContain(`OPENBOT_SOURCE_SHA: ${SOURCE_SHA_EXPRESSION}`);
  });
}

test("protected Windows signing validates the same PR-head-or-push SHA", () => {
  const source = workflow("desktop-signing.yml");
  expect(source).toContain(`SIGNING_SOURCE_SHA: ${SOURCE_SHA_EXPRESSION}`);
  expect(source).toContain(
    "if ((git rev-parse HEAD) -ne $env:SIGNING_SOURCE_SHA) { throw 'Checkout does not match requested source SHA.' }",
  );
});

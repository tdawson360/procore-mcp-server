import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procoreApiCall } from "../src/api/client.js";
import { handleApiCall } from "../src/tools/handlers/api-call.js";

// The API path comes from the MCP caller. These tests prove no path can make
// the client send the bearer token anywhere but the Procore API host.

const tokenPath = join(tmpdir(), `procore-mcp-api-host-${process.pid}.json`);
const originalFetch = globalThis.fetch;
const originalTokenPath = process.env.PROCORE_TOKEN_PATH;
const originalEnv = process.env.PROCORE_ENV;
let sent: { host: string; authorization: string | null }[] = [];

before(() => {
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token: "test-token",
      refresh_token: "test-refresh-token",
      expires_at: Date.now() + 3_600_000,
    })
  );
  process.env.PROCORE_TOKEN_PATH = tokenPath;
  delete process.env.PROCORE_ENV;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      host: new URL(request.url).host,
      authorization: request.headers.get("authorization"),
    });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

beforeEach(() => {
  sent = [];
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalTokenPath === undefined) delete process.env.PROCORE_TOKEN_PATH;
  else process.env.PROCORE_TOKEN_PATH = originalTokenPath;
  if (originalEnv === undefined) delete process.env.PROCORE_ENV;
  else process.env.PROCORE_ENV = originalEnv;
  unlinkSync(tokenPath);
});

test("paths that would change the host are rejected before fetch", async () => {
  for (const path of [
    "@attacker.example/x",
    ".attacker.example/x",
    ":443@attacker.example/x",
    "attacker.example/x",
    "",
  ]) {
    await assert.rejects(
      procoreApiCall({ method: "GET", path, timeoutMs: 100 }),
      /must start with "\/"/,
      `path ${JSON.stringify(path)} should be rejected`
    );
  }
  assert.deepEqual(sent, [], "no request may be sent for a rejected path");
});

test("leading-slash paths always stay on the Procore API host", async () => {
  const paths = [
    "/rest/v1.0/me",
    "//attacker.example/x",
    "/\\attacker.example/x",
    "/@attacker.example",
  ];
  for (const path of paths) {
    await procoreApiCall({ method: "GET", path, timeoutMs: 100 });
  }
  assert.deepEqual(
    sent,
    paths.map(() => ({ host: "api.procore.com", authorization: "Bearer test-token" }))
  );
});

test("path_params cannot inject a host either", async () => {
  await procoreApiCall({
    method: "GET",
    path: "{section}/x",
    pathParams: { section: "@attacker.example" },
    timeoutMs: 100,
  }).catch(() => undefined);
  for (const request of sent) assert.equal(request.host, "api.procore.com");
});

test("the procore_api_call tool reports a rejected path as an error", async () => {
  const result = await handleApiCall({ method: "GET", path: "@attacker.example/x" });
  assert.equal(result.isError, true);
  assert.match(result.text, /must start with "\/"/);
  assert.deepEqual(sent, []);
});

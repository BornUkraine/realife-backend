import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited before health check (${child.exitCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("health endpoint did not become ready");
}

test("health endpoint reports the public service contract", async (t) => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_API_KEY: "",
      PINATA_JWT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  const response = await waitForHealth(`http://127.0.0.1:${port}/`, child);
  const body = await response.json();

  assert.equal(body.status, "ok");
  assert.equal(body.aiSuggest.enabled, false);
  assert.equal(body.protectedPayment.symbol, "USDC");
  assert.ok(Array.isArray(body.contracts.known1155));

  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from("not-a-real-image")], { type: "image/png" }),
    "fixture.png"
  );
  const multipartResponse = await fetch(
    `http://127.0.0.1:${port}/api/ai-suggest`,
    { method: "POST", body: form }
  );
  const multipartBody = await multipartResponse.json();
  assert.equal(multipartResponse.status, 500);
  assert.equal(multipartBody.message, "OPENAI_API_KEY is missing");

  const invalidResponse = await fetch(
    `http://127.0.0.1:${port}/api/ai-suggest`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }
  );
  assert.equal(invalidResponse.status, 400);
});

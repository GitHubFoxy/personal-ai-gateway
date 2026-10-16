import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, loadSecrets, saveJson, secretsPath } from "../src/config.ts";
import { getOAuthToken } from "../src/siwc.ts";

test("OAuth refresh uses issued client ID, rotates token and persists it safely", async () => {
  const previous = process.env.PAG_HOME;
  const dir = mkdtempSync(join(tmpdir(), "pag-oauth-"));
  process.env.PAG_HOME = dir;
  try {
    initialize();
    const secrets = loadSecrets();
    secrets.oauth = {
      chatgpt: { clientId: "oaiapp_example", accessToken: "old", refreshToken: "refresh-old",
        idToken: "retained", expiresAt: Date.now() - 1000, scope: "chatgpt.tokens.use.direct", subject: "sub1" }
    };
    saveJson(secretsPath(), secrets);
    let calls = 0;
    const fakeFetch: typeof fetch = async (url, init) => {
      assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
      const params = new URLSearchParams(init?.body as string);
      assert.equal(params.get("client_id"), "oaiapp_example");
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "refresh-old");
      calls++;
      return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh",
        scope: "chatgpt.tokens.use.direct offline_access", token_type: "Bearer", expires_in: 3600 });
    };
    assert.equal(await getOAuthToken("chatgpt", secrets, fakeFetch), "fresh-access");
    assert.equal(calls, 1);
    assert.equal(loadSecrets().oauth?.chatgpt.refreshToken, "fresh-refresh");
    assert.equal(await getOAuthToken("chatgpt", loadSecrets(), fakeFetch), "fresh-access");
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.PAG_HOME; else process.env.PAG_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

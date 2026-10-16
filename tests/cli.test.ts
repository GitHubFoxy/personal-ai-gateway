import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("CLI init, add credential, set route, reorder and persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "pag-test-"));
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const run = (args: string[], input?: string) => spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args], {
    env: { ...process.env, PAG_HOME: dir }, encoding: "utf8", input
  });
  try {
    const init = run(["init"]);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Gateway API key/);
    assert.equal(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600);
    const added = run(["auth", "add", "opencode-go", "--key-stdin"], "some-example-key\n");
    assert.equal(added.status, 0, added.stderr);
    const set = run(["route", "set", "coding", "llm", "opencode-go:gpt-6-luna"]);
    assert.equal(set.status, 0, set.stderr);
    const off = run(["route", "fallback", "coding", "off"]);
    assert.equal(off.status, 0, off.stderr);
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(cfg.routes.coding.targets[0].model, "gpt-6-luna");
    assert.equal(cfg.routes.coding.fallback, false);
    assert.equal(run(["doctor"]).status, 0);
    assert.equal(run(["auth", "login", "openai"]).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

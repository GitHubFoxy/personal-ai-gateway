import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseLogQuery, queryLogs } from "../src/logs.ts";

test("validates limits, ordering and filters", () => {
  for (const query of ["limit=0", "limit=201", "offset=-1", "sort=ts%3Bdrop", "direction=sideways", "status=2xx"]) assert.throws(() => parseLogQuery(new URLSearchParams(query)));
  assert.equal(parseLogQuery(new URLSearchParams()).limit, 50);
});

test("uses ClickHouse parameters for filters and fetches one extra row", async () => {
  let url = "", sql = "";
  const server = http.createServer((req, res) => {
    url = req.url ?? "";
    req.on("data", chunk => { sql += chunk; });
    req.on("end", () => res.end('{"model":"a"}\n{"model":"b"}\n'));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const filter = "' OR 1=1 --";
    const query = parseLogQuery(new URLSearchParams({ limit: "1", model: filter }));
    const result = await queryLogs({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, user: "reader", password: "secret" }, query);
    assert.equal(result.hasMore, true);
    assert.equal(result.rows.length, 1);
    assert.equal(new URL(url, "http://localhost").searchParams.get("param_model"), filter);
    assert.ok(sql.includes("model = {model:String}"));
    assert.ok(!sql.includes(filter));
    assert.ok(sql.includes("LIMIT 2 OFFSET 0"));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

export type LogQuery = { limit: number; offset: number; sort: string; direction: string; model?: string; status?: string; upstream?: string };

export function parseLogQuery(params: URLSearchParams): LogQuery {
  const number = (name: string, fallback: number, max: number) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) throw new Error(`invalid ${name}`);
    return Number(raw);
  };
  const limit = number("limit", 50, 200), offset = number("offset", 0, 1000000);
  if (!limit) throw new Error("invalid limit");
  const sort = params.get("sort") ?? "ts", direction = params.get("direction") ?? "desc";
  if (!["ts", "model", "status", "duration_ms"].includes(sort)) throw new Error("invalid sort");
  if (!["asc", "desc"].includes(direction)) throw new Error("invalid direction");
  const model = params.get("model") || undefined, status = params.get("status") || undefined, upstream = params.get("upstream") || undefined;
  if ((model && model.length > 256) || (upstream && upstream.length > 128) || (status && !/^\d{3}$/.test(status))) throw new Error("invalid filter");
  return { limit, offset, sort, direction, model, status, upstream };
}

export async function queryLogs(cfg: { url: string; user: string; password: string }, q: LogQuery): Promise<{ rows: unknown[]; hasMore: boolean }> {
  const filters: string[] = [];
  const url = new URL(cfg.url);
  for (const field of ["model", "status", "upstream"] as const) {
    const value = q[field];
    if (value !== undefined) {
      filters.push(`${field} = {${field}:${field === "status" ? "UInt16" : "String"}}`);
      url.searchParams.set(`param_${field}`, value);
    }
  }
  const sql = `SELECT ts, id, model, status, upstream, duration_ms, ttft_ms, JSONExtractString(req_headers, 'x-pag-key') AS key_name, user_agent, path FROM pag.requests${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY ${q.sort} ${q.direction.toUpperCase()}, id ${q.direction.toUpperCase()} LIMIT ${q.limit + 1} OFFSET ${q.offset} FORMAT JSONEachRow`;
  const res = await fetch(url, { method: "POST", headers: { "X-ClickHouse-User": cfg.user, "X-ClickHouse-Key": cfg.password }, body: sql, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ClickHouse HTTP ${res.status}`);
  const rows = (await res.text()).split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

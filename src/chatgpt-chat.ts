// shortcut: only text-only, non-streaming chat; extend when other clients need more.
export function chatRequest(body: Record<string, unknown>, model: string): Record<string, unknown> | undefined {
  const allowed = new Set(["model", "messages", "stream", "max_tokens", "response_format", "reasoning"]);
  if (Object.keys(body).some(key => !allowed.has(key)) || (body.stream !== undefined && body.stream !== false) || !Array.isArray(body.messages)) return;
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || Number(body.max_tokens) < 1)) return;
  if (body.response_format !== undefined && (!body.response_format || typeof body.response_format !== "object" || Array.isArray(body.response_format))) return;
  const format = body.response_format as Record<string, unknown> | undefined;
  if (format && (format.type !== "json_object" || Object.keys(format).length !== 1)) return;
  if (body.reasoning !== undefined && (!body.reasoning || typeof body.reasoning !== "object" || Array.isArray(body.reasoning))) return;
  const reasoning = body.reasoning as Record<string, unknown> | undefined;
  if (reasoning && (Object.keys(reasoning).some(key => key !== "effort") || !["low", "medium", "high"].includes(String(reasoning.effort)))) return;
  const input: { role: string; content: string }[] = [];
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Object.keys(message).some(key => key !== "role" && key !== "content") || typeof message.content !== "string") return;
    if (message.role === "system" || message.role === "developer") input.push({ role: "developer", content: message.content });
    else if (message.role === "user" || message.role === "assistant") input.push({ role: message.role, content: message.content });
    else return;
  }
  if (!input.some(message => message.role === "user")) return;
  return { model, instructions: "Follow the conversation instructions.", input, store: false, stream: true,
    ...(format ? { text: { format } } : {}), ...(reasoning ? { reasoning } : {}),
    ...(body.max_tokens !== undefined ? { max_output_tokens: body.max_tokens } : {}) };
}

export async function chatResponse(response: Response, model: string): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Missing response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let stream = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value, { stream: true });
      if (stream.length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Response too large"); }
    }
    stream += decoder.decode();
  } finally { reader.releaseLock(); }
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    let event: any;
    try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (event.type === "response.failed" || event.type === "error") throw new Error("Upstream response failed");
    if (event.type !== "response.completed" || event.response?.status !== "completed") continue;
    const result = event.response;
    const parts = result.output?.flatMap((item: any) => item.type === "message" ? item.content?.filter((part: any) => part.type === "output_text").map((part: any) => part.text) ?? [] : []) ?? [];
    if (!parts.length || parts.some((part: unknown) => typeof part !== "string")) throw new Error("No text in response");
    const usage = result.usage;
    return { id: result.id, object: "chat.completion", created: result.created_at ?? Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: parts.join("") }, finish_reason: "stop" }],
      ...(usage ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } } : {}) };
  }
  throw new Error("No completed response");
}

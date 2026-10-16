export type DecisionQuestion = { type: "predicate" | "noul" | "choice" | "score"; instructions: string; choices?: Record<string, string>; levels?: string[]; criteria?: Record<string, string> | string[] };
export type DecisionRequest = { model: string; state: unknown; questions: Record<string, DecisionQuestion> };
function record(x: unknown): x is Record<string, unknown> { return typeof x === "object" && x !== null && !Array.isArray(x); }
export function parseDecision(body: Record<string, unknown>): DecisionRequest {
  if (!("state" in body) || !record(body.questions)) throw new Error("Decisions require state and questions");
  const qs = body.questions as Record<string, unknown>;
  if (!Object.keys(qs).length || Object.keys(qs).length > 64) throw new Error("Decisions require 1–64 questions");
  for (const [id, value] of Object.entries(qs)) {
    if (!/^[\w.-]{1,100}$/.test(id) || !record(value) || typeof value.instructions !== "string" || !value.instructions.trim()) throw new Error("Invalid question: " + id);
    if (!["predicate", "noul", "choice", "score"].includes(String(value.type))) throw new Error("Unsupported question type: " + id);
    if (value.type === "choice") {
      const choices = value.choices ?? value.criteria;
      if (!record(choices) || Object.keys(choices).length < 2 || Object.values(choices).some(v => typeof v !== "string")) throw new Error("Invalid choice options: " + id);
    }
    if (value.type === "score") {
      const levels = value.levels ?? value.criteria;
      if (!Array.isArray(levels) || levels.length < 2 || levels.some(v => typeof v !== "string")) throw new Error("Invalid score levels: " + id);
    }
  }
  return { model: String(body.model ?? ""), state: body.state, questions: qs as Record<string, DecisionQuestion> };
}
export function toSystemOne(req: DecisionRequest, model: string): Record<string, unknown> {
  return {
    model, state: req.state,
    questions: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, {
      type: q.type === "predicate" ? "noul" : q.type,
      instructions: q.instructions,
      ...((q.type === "choice" || q.type === "score") ? { criteria: q.type === "choice" ? (q.choices ?? q.criteria) : (q.levels ?? q.criteria) } : {})
    }]))
  };
}
export function normalizeDecisions(response: unknown, req: DecisionRequest, alias: string): Record<string, unknown> {
  if (!record(response)) throw new Error("Invalid upstream response");
  let payload = response;
  if (record(response.result) && record(response.result.answers)) payload = response.result;
  if (!record(payload.answers)) throw new Error("Missing answers");
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const a = payload.answers[id];
    if (!record(a)) throw new Error("Missing answer: " + id);
    if (q.type === "predicate" || q.type === "noul") {
      const p = a.noul ?? a.probability;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error("Invalid predicate: " + id);
      answers[id] = { type: "predicate", probability: p };
    } else if (q.type === "choice") {
      const choices = (q.choices ?? q.criteria) as Record<string, string>;
      if (typeof a.choice !== "string" || !Object.hasOwn(choices, a.choice)) throw new Error("Invalid choice: " + id);
      const out: Record<string, unknown> = { type: "choice", choice: a.choice };
      if (typeof a.confidence === "number" && a.confidence >= 0 && a.confidence <= 1) out.confidence = a.confidence;
      if (record(a.probabilities)) out.probabilities = a.probabilities;
      answers[id] = out;
    } else {
      const score = a.score;
      const levels = (q.levels ?? q.criteria) as string[];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels.length - 1) throw new Error("Invalid score: " + id);
      answers[id] = { type: "score", score };
    }
  }
  return { model: alias, answers, ...(record(payload.usage) ? { usage: payload.usage } : {}) };
}

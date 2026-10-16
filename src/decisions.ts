/**
 * PAG Decisions: one normalized domain-neutral contract with two interoperable
 * public wire formats, System One and native OpenAI Decisions.
 * A provider's wire format is configured per account; it is not guessed from a model ID.
 */
export type Question = {
  type: "predicate" | "noul" | "choice" | "score";
  instructions: string;
  choices?: Record<string, string>;
  levels?: string[];
  criteria?: Record<string, string> | string[];
  levelDescriptions?: Record<string, string>;
};
export type DecisionRequest = {
  model: string;
  format: "systemone" | "openai";
  state: unknown;
  questions: Record<string, Question>;
};
type Dict = Record<string, unknown>;
function record(x: unknown): x is Dict { return x !== null && typeof x === "object" && !Array.isArray(x); }
const safeName = /^[A-Za-z0-9_.-]{1,100}$/;
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
const error = (message: string): never => { throw new Error(message); };
const requireName = (name: string): void => {
  if (!safeName.test(name) || dangerous.has(name)) error("Invalid question ID: " + name);
};
function nonEmpty(s: unknown, label: string): string {
  if (typeof s !== "string" || !s.trim() || s.length > 20_000) error("Invalid " + label);
  return s;
}
function choices(value: unknown): Record<string, string> {
  if (!record(value)) return error("Choice question requires an options object");
  const keys = Object.keys(value);
  if (keys.length < 2 || keys.length > 255) return error("Choice needs 2–255 options");
  const out: Record<string, string> = Object.create(null);
  for (const k of keys) {
    requireName(k);
    out[k] = nonEmpty(value[k], "choice description");
  }
  return out;
}
function levels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 255)
    return error("Score needs 2–255 levels");
  return value.map(x => nonEmpty(x, "score label"));
}
function parseSystemOne(body: Dict): DecisionRequest {
  if (!Object.hasOwn(body, "state") || body.state === null || !record(body.questions))
    return error("Decisions require state and questions");
  const entries = Object.entries(body.questions);
  if (entries.length < 1 || entries.length > 64) return error("Decisions require 1–64 questions");
  const qs: Record<string, Question> = Object.create(null);
  for (const [id, raw] of entries) {
    requireName(id);
    if (!record(raw)) return error("Invalid question " + id);
    const instructions = nonEmpty(raw.instructions, id + ".instructions");
    const type = raw.type;
    if (type === "predicate" || type === "noul") {
      qs[id] = { type: "predicate", instructions };
    } else if (type === "choice") {
      qs[id] = { type, instructions, choices: choices(raw.choices ?? raw.criteria) };
    } else if (type === "score") {
      qs[id] = { type, instructions, levels: levels(raw.levels ?? raw.criteria) };
    } else return error("Unsupported question type: " + id);
  }
  return { model: String(body.model ?? ""), format: "systemone", state: body.state, questions: qs };
}
function parseOpenAI(body: Dict): DecisionRequest {
  if (!Object.hasOwn(body, "input") || !Array.isArray(body.questions))
    return error("Native Decisions requires input and questions array");
  if (typeof body.input !== "string" && !Array.isArray(body.input))
    return error("Native Decisions input must be text or an array of messages");
  if (!body.questions.length || body.questions.length > 64)
    return error("Decisions require 1–64 named questions");
  const qs: Record<string, Question> = Object.create(null);
  for (const item of body.questions) {
    if (!record(item)) return error("Invalid native question");
    const id = nonEmpty(item.name, "question name");
    requireName(id);
    if (Object.hasOwn(qs, id)) return error("Duplicate question ID: " + id);
    const instructions = nonEmpty(item.instructions, id + ".instructions");
    if (item.type === "predicate") qs[id] = { type: "predicate", instructions };
    else if (item.type === "choice") {
      if (!Array.isArray(item.choices)) return error("Native choice requires choices array");
      const input: Dict = Object.create(null);
      for (const c of item.choices) {
        if (!record(c) || typeof c.value !== "string")
          return error("PAG currently supports string-valued native choices only");
        requireName(c.value);
        if (Object.hasOwn(input, c.value)) return error("Duplicate choice value");
        input[c.value] = nonEmpty(c.description ?? c.value, "choice description");
      }
      qs[id] = { type: "choice", instructions, choices: choices(input) };
    } else if (item.type === "score") {
      if (!Array.isArray(item.levels)) return error("Native score requires levels array");
      const labels: string[] = [];
      const descriptions: Record<string, string> = Object.create(null);
      for (const l of item.levels) {
        if (!record(l)) return error("Invalid native score level");
        const label = nonEmpty(l.label, "score label");
        if (labels.includes(label)) return error("Duplicate score label");
        labels.push(label);
        if (l.description !== undefined) descriptions[label] = nonEmpty(l.description, "score description");
      }
      qs[id] = { type: "score", instructions, levels: levels(labels), levelDescriptions: descriptions };
    } else return error("Unsupported native question type");
  }
  return { model: String(body.model ?? ""), format: "openai", state: body.input, questions: qs };
}
export function parseDecision(body: Dict): DecisionRequest {
  return Array.isArray(body.questions) ? parseOpenAI(body) : parseSystemOne(body);
}
export function canTranslate(req: DecisionRequest, protocol: "systemone" | "openai"): boolean {
  return protocol === "openai" || typeof req.state === "string" || !Array.isArray(req.state);
}
export function toSystemOne(req: DecisionRequest, model: string): Dict {
  if (!canTranslate(req, "systemone")) return error("Cannot represent native message-array input in System One");
  const questions: Dict = Object.create(null);
  for (const [id, q] of Object.entries(req.questions)) {
    questions[id] = {
      type: q.type === "predicate" ? "noul" : q.type,
      instructions: q.instructions,
      ...(q.type === "choice" ? { criteria: q.choices } : {}),
      ...(q.type === "score" ? { criteria: q.levels?.map(l => q.levelDescriptions?.[l] || l) } : {})
    };
  }
  return { model, state: req.state, questions };
}
export function toOpenAI(req: DecisionRequest, model: string): Dict {
  const questions = Object.entries(req.questions).map(([name, q]) => {
    if (q.type === "predicate") return { name, type: "predicate", instructions: q.instructions };
    if (q.type === "choice") return { name, type: "choice", instructions: q.instructions,
      choices: Object.entries(q.choices ?? {}).map(([value, description]) => ({ value, description })) };
    return { name, type: "score", instructions: q.instructions,
      levels: (q.levels ?? []).map(label => ({ label, ...(q.levelDescriptions?.[label] ? { description: q.levelDescriptions[label] } : {}) })) };
  });
  // Native Decisions input must be a string or message array. Serialize arbitrary System One JSON state.
  const input = typeof req.state === "string" || Array.isArray(req.state)
    ? req.state : JSON.stringify(req.state);
  return { model, input, questions };
}
export function toProviderDecision(req: DecisionRequest, model: string, protocol: "systemone" | "openai"): Dict {
  return protocol === "openai" ? toOpenAI(req, model) : toSystemOne(req, model);
}
function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    return error("Upstream returned invalid probability");
  return value;
}
function normalizedChoiceDistribution(input: unknown, options: Record<string, string>): { byKey: Record<string, number>; array: {value: string; probability: number}[] } | undefined {
  if (input === undefined) return undefined;
  const byKey: Record<string, number> = Object.create(null);
  if (Array.isArray(input)) {
    for (const el of input) {
      if (!record(el) || typeof el.value !== "string" || !Object.hasOwn(options, el.value) || Object.hasOwn(byKey, el.value))
        return error("Invalid choice distribution");
      byKey[el.value] = probability(el.probability);
    }
  } else if (record(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(options, key)) return error("Unknown choice distribution value");
      byKey[key] = probability(value);
    }
  } else return error("Invalid choice probabilities");
  return { byKey, array: Object.entries(byKey).map(([value, p]) => ({ value, probability: p })) };
}
function normalizedScoreDistribution(input: unknown, labels: string[]): { byKey: Record<string, number>; array: {value: number; label: string; probability: number}[] } | undefined {
  if (input === undefined) return undefined;
  const byKey: Record<string, number> = Object.create(null);
  if (Array.isArray(input)) {
    for (const el of input) {
      if (!record(el) || !Number.isInteger(el.value) || typeof el.value !== "number" ||
          el.value < 0 || el.value >= labels.length || (el.label !== undefined && el.label !== labels[el.value]))
        return error("Invalid score distribution");
      const key = String(el.value);
      if (Object.hasOwn(byKey, key)) return error("Duplicate score distribution index");
      byKey[key] = probability(el.probability);
    }
  } else if (record(input)) {
    for (const [key, value] of Object.entries(input)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= labels.length) return error("Invalid score distribution index");
      byKey[key] = probability(value);
    }
  } else return error("Invalid score probabilities");
  return { byKey, array: Object.entries(byKey).map(([key, p]) => ({ value: Number(key), label: labels[Number(key)], probability: p })) };
}
export function normalizeDecisions(raw: unknown, req: DecisionRequest, alias: string): Dict {
  if (!record(raw)) return error("Invalid upstream response");
  const payload = record(raw.result) && (record(raw.result.answers) || Array.isArray(raw.result.answers)) ? raw.result : raw;
  if (!record(payload.answers) && !Array.isArray(payload.answers)) return error("Missing answers");
  const source: Record<string, unknown> = Object.create(null);
  if (Array.isArray(payload.answers)) {
    for (const a of payload.answers) {
      if (!record(a) || typeof a.name !== "string" || !Object.hasOwn(req.questions, a.name) || Object.hasOwn(source, a.name))
        return error("Invalid or duplicated named answer");
      source[a.name] = a;
    }
  } else {
    for (const [key, a] of Object.entries(payload.answers)) {
      if (!Object.hasOwn(req.questions, key)) return error("Unexpected named answer");
      source[key] = a;
    }
  }
  const answers: Record<string, Dict> = Object.create(null);
  for (const [id, q] of Object.entries(req.questions)) {
    const a = source[id];
    if (record(a) && a.type === "refusal") {
      answers[id] = { type: "refusal" };
      continue;
    }
    if (q.type === "predicate" || q.type === "noul") {
      const p = typeof a === "number" ? a : record(a) ? a.noul ?? a.probability : undefined;
      answers[id] = { type: "predicate", probability: probability(p) };
    } else if (q.type === "choice") {
      if (!record(a) || typeof a.choice !== "string" || !Object.hasOwn(q.choices ?? {}, a.choice))
        return error("Invalid choice answer: " + id);
      const out: Dict = { type: "choice", choice: a.choice };
      if (a.confidence !== undefined) out.confidence = probability(a.confidence);
      const dist = normalizedChoiceDistribution(a.probabilities, q.choices ?? {});
      if (dist) out.probabilities = req.format === "openai" ? dist.array : dist.byKey;
      answers[id] = out;
    } else {
      if (!record(a) || typeof a.score !== "number" || !Number.isFinite(a.score) ||
          a.score < 0 || a.score > (q.levels?.length ?? 0) - 1)
        return error("Invalid score answer: " + id);
      const out: Dict = { type: "score", score: a.score };
      if (a.confidence !== undefined) out.confidence = probability(a.confidence);
      const dist = normalizedScoreDistribution(a.probabilities, q.levels ?? []);
      if (dist) out.probabilities = req.format === "openai" ? dist.array : dist.byKey;
      answers[id] = out;
    }
  }
  return {
    model: alias,
    answers: req.format === "openai"
      ? Object.entries(answers).map(([name, a]) => ({ name, ...a }))
      : answers,
    ...(record(payload.usage) ? { usage: payload.usage } : {})
  };
}

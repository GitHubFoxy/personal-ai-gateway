/** Switch settings persisted as JSON. Writes are atomic (temp file + rename). */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { SWITCHABLE, type Prefixes, type Settings } from "./routing.ts";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function defaultSettings(prefixes: Prefixes): Settings {
  return { claude: Object.keys(prefixes.claude)[0], gemini: Object.keys(prefixes.gemini)[0], codexDisabled: [] };
}

/** Throws on anything that is not a complete, known settings object. */
export function validateSettings(x: unknown, prefixes: Prefixes): Settings {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("settings must be an object");
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["claude", "gemini", "codexDisabled"].includes(k)) throw new Error(`unknown setting "${k}"`);
  for (const f of SWITCHABLE) {
    if (typeof o[f] !== "string" || !Object.hasOwn(prefixes[f], o[f] as string)) {
      throw new Error(`${f} must be one of: ${Object.keys(prefixes[f]).join(", ")}`);
    }
  }
  const list = o.codexDisabled;
  if (!Array.isArray(list) || list.length > 200 || !list.every(m => typeof m === "string" && MODEL_ID.test(m))) {
    throw new Error("codexDisabled must be a list of model ids");
  }
  return { claude: o.claude as string, gemini: o.gemini as string, codexDisabled: [...new Set(list as string[])].sort() };
}

/** Missing file -> defaults. A file that exists but is invalid is an error, not a silent reset. */
export function loadSettings(file: string, prefixes: Prefixes): Settings {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return defaultSettings(prefixes);
    throw e;
  }
  return validateSettings(JSON.parse(text), prefixes);
}

export function saveSettings(file: string, s: Settings): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, JSON.stringify(s, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

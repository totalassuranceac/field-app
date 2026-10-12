/**
 * Optional Workers AI for the job brief and wrap-up split.
 * Inert unless env.AI exists AND setting tech_assist_ai is "1".
 * This build does not add an [ai] binding.
 */
import { getSetting } from "./audit";
import type { Env } from "./types";

export type AiResult = { ok: true; text: string; model: string } | { ok: false; reason: string };

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

function textOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "response" in raw) {
    return String((raw as { response?: unknown }).response || "");
  }
  return "";
}

export async function runTechAi(env: Env, db: D1Database, system: string, user: string): Promise<AiResult> {
  if (!env.AI) return { ok: false, reason: "no_binding" };
  let setting = "0";
  try {
    setting = await getSetting(db, "tech_assist_ai", "0");
  } catch {
    setting = "0";
  }
  if (setting !== "1") return { ok: false, reason: "off" };
  try {
    const prompt = `${system}\n\n${user.slice(0, 4000)}`;
    const input = { prompt, max_tokens: 300, temperature: 0.2 };
    const result = await Promise.race([
      env.AI.run(MODEL, input as { prompt: string }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), 4000);
      }),
    ]);
    const text = textOf(result).replace(/[^\x20-\x7E\n]/g, "").trim();
    if (!text) return { ok: false, reason: "error" };
    return { ok: true, text, model: MODEL };
  } catch (err) {
    if (err instanceof Error && err.message === "timeout") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "error" };
  }
}

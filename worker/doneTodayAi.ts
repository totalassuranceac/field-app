/**
 * Optional checklist split via Workers AI. Inert unless env.AI exists
 * AND setting done_today_ai is "1". Any error falls back to rules.
 * This build does not add an [ai] binding.
 */
import { splitExtras } from "./doneTodayPlan";

type AiBinding = {
  run: (model: string, input: { prompt: string }) => Promise<unknown>;
};

const PROMPT =
  "Turn this into a short checklist of work items done today. One item per line, max 10, each under 120 characters, plain ASCII, no numbering, no invented details.\n\n";

function linesFromAi(raw: unknown): string[] {
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "response" in raw
        ? String((raw as { response?: unknown }).response || "")
        : "";
  return splitExtras(text);
}

export async function splitChecklist(
  text: string,
  opts: { ai?: AiBinding | null; setting?: string | null }
): Promise<{ lines: string[]; split_by: "rules" | "ai" }> {
  const rules = { lines: splitExtras(text), split_by: "rules" as const };
  if (!opts.ai || String(opts.setting ?? "0") !== "1") return rules;
  try {
    const result = await Promise.race([
      opts.ai.run("@cf/meta/llama-3.1-8b-instruct", { prompt: PROMPT + text }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), 3000);
      }),
    ]);
    const lines = linesFromAi(result).slice(0, 10);
    if (!lines.length) return rules;
    return { lines, split_by: "ai" };
  } catch {
    return rules;
  }
}

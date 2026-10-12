/**
 * Done today: Chicago day bounds, line merge, and rules-based extra split.
 * No D1, no fetch, no AI call from this file.
 */
import { chicagoLocalToUtc, formatChicagoTime, parseUtcLoose } from "./clockinNudgePlan";

export function dayBoundsUtc(dayCt: string): [string, string] {
  const [y, m, d] = dayCt.slice(0, 10).split("-").map(Number);
  const start = chicagoLocalToUtc(y, m, d, 0, 0);
  const next = new Date(Date.UTC(y, m - 1, d) + 86400000);
  const end = chicagoLocalToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  return [sql(start), sql(end)];
}

export function dayBoundsMs(dayCt: string): [number, number] {
  const [a, b] = dayBoundsUtc(dayCt);
  return [Date.parse(a.replace(" ", "T") + "Z"), Date.parse(b.replace(" ", "T") + "Z")];
}

export function inChicagoDay(raw: string, dayCt: string): boolean {
  const ms = parseUtcLoose(raw);
  if (ms == null) return false;
  const [a, b] = dayBoundsMs(dayCt);
  return ms >= a && ms < b;
}

export function formatTimeCt(raw: string): string {
  const ms = parseUtcLoose(raw);
  if (ms == null) return "";
  return formatChicagoTime(ms);
}

export type DoneItem = {
  at: string;
  text: string;
  kind: string;
  source: string;
  entity_type?: string | null;
  entity_id?: string | number | null;
  issue_id?: number | null;
  wo_minutes?: number | null;
  link?: string | null;
  time_ct?: string;
};

const WO_KINDS = new Set(["wo_start", "wo_pause", "wo_resume", "wo_done"]);

function atMs(raw: string): number {
  return parseUtcLoose(raw) ?? 0;
}

export function mergeItems(items: DoneItem[]): DoneItem[] {
  const woGroups = new Map<number, DoneItem[]>();
  const rest: DoneItem[] = [];
  for (const item of items) {
    if (item.issue_id && WO_KINDS.has(item.kind)) {
      const list = woGroups.get(item.issue_id) || [];
      list.push(item);
      woGroups.set(item.issue_id, list);
    } else {
      rest.push(item);
    }
  }
  const collapsed: DoneItem[] = [];
  for (const [issueId, group] of woGroups) {
    const done = group.find((g) => g.kind === "wo_done");
    const minutes = group.reduce((s, g) => s + (Number(g.wo_minutes) || 0), 0);
    const hours = Math.round((minutes / 60) * 10) / 10;
    if (done) {
      const last = group.slice().sort((a, b) => atMs(a.at) - atMs(b.at)).slice(-1)[0];
      collapsed.push({
        at: done.at || last.at,
        text: `Finished WO #${issueId} (${hours} h)`,
        kind: "wo_done",
        source: "fleet_wo",
        issue_id: issueId,
        entity_type: "vehicle_issue",
        entity_id: issueId,
        link: `/fleet-shop?wo=${issueId}`,
      });
    } else {
      collapsed.push(...group);
    }
  }
  const combined = [...rest, ...collapsed];
  const kept: DoneItem[] = [];
  for (const item of combined) {
    if (item.source === "audit" && item.entity_type && item.entity_id != null) {
      const ms = atMs(item.at);
      const dup = combined.some((other) => {
        if (other === item || other.source === "audit") return false;
        if (String(other.entity_type || "") !== String(item.entity_type)) return false;
        if (String(other.entity_id ?? "") !== String(item.entity_id)) return false;
        return Math.abs(atMs(other.at) - ms) <= 60000;
      });
      if (dup) continue;
    }
    kept.push(item);
  }
  kept.sort((a, b) => atMs(a.at) - atMs(b.at));
  return kept.map((item) => ({ ...item, time_ct: formatTimeCt(item.at) }));
}

function toAscii(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00a0/g, " ");
}

const SPLIT_SEPS = ["\n", ";", " - ", ". ", " and then ", ", then ", ", also "];

function splitChunks(text: string): string[] {
  let parts = [text];
  for (const sep of SPLIT_SEPS) {
    const next: string[] = [];
    for (const part of parts) {
      for (const bit of part.split(sep)) next.push(bit);
    }
    parts = next;
  }
  return parts;
}

function cleanLine(raw: string): string {
  let s = toAscii(raw).replace(/\s+/g, " ").trim();
  let guard = 0;
  while (guard++ < 6) {
    const next = s.replace(/^(um|uh|and|also)\b[, ]*/i, "").trim();
    if (next === s) break;
    s = next;
  }
  if (s.length < 3) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length > 200) s = s.slice(0, 200).trim();
  return s;
}

export function splitExtras(text: string): string[] {
  const raw = toAscii(String(text || "")).trim();
  if (!raw) return [];
  const lines: string[] = [];
  for (const chunk of splitChunks(raw)) {
    const line = cleanLine(chunk);
    if (!line) continue;
    lines.push(line);
    if (lines.length >= 10) break;
  }
  return lines;
}

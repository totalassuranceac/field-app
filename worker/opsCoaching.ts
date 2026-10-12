/**
 * Shop scoreboard coaching math. Pure: no ServiceTitan, no D1.
 * Comeback rate is follow-up / warranty jobs this tech worked, divided by jobs.
 * A recall is attributed to whoever was on the original job, not only the tech who ran the callback.
 */

export type ComebackTypeCount = { job_type: string; count: number };

export type RecallOfWork = {
  original_job_id: string;
  original_job_number: string | null;
  original_job_type: string | null;
  recall_job_id: string;
  recall_job_number: string | null;
};

export type OpsCoaching = {
  comeback_jobs: number | null;
  comeback_rate: number | null;
  comeback_types: ComebackTypeCount[];
  avg_ticket: number | null;
  recalls: RecallOfWork[];
  recalls_more: number;
};

export type RecallJobRef = {
  id: number;
  jobNumber: string | null;
  jobTypeName: string | null;
  recallForId: number | null;
  technicianIds: number[];
};

const RECALL_LIST_CAP = 8;

export function emptyCoaching(): OpsCoaching {
  return {
    comeback_jobs: null,
    comeback_rate: null,
    comeback_types: [],
    avg_ticket: null,
    recalls: [],
    recalls_more: 0,
  };
}

/** Null when the job count is missing or zero, so a quiet week is not "0% comebacks". */
export function comebackRate(comebacks: number | null, jobs: number | null): number | null {
  if (comebacks == null || jobs == null || !(jobs > 0)) return null;
  if (!Number.isFinite(comebacks) || comebacks < 0) return null;
  return Math.round((comebacks / jobs) * 1000) / 1000;
}

export function averageTicket(sales: number | null, jobs: number | null): number | null {
  if (sales == null || jobs == null || !(jobs > 0) || !Number.isFinite(sales)) return null;
  return Math.round((sales / jobs) * 100) / 100;
}

export function countComebackTypes(
  names: Array<string | null | undefined>,
  limit = 3
): ComebackTypeCount[] {
  const counts = new Map<string, number>();
  for (const raw of names) {
    const name = String(raw || "").trim() || "Warranty / follow-up";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([job_type, count]) => ({ job_type, count }));
}

export function recallsForTech(
  currentJobs: RecallJobRef[],
  originals: Map<number, RecallJobRef>,
  techId: number
): { recalls: RecallOfWork[]; recalls_more: number } {
  const hits: RecallOfWork[] = [];
  for (const job of currentJobs) {
    const origId = job.recallForId;
    if (origId == null || !(origId > 0)) continue;
    const original = originals.get(origId);
    if (!original || !original.technicianIds.includes(techId)) continue;
    hits.push({
      original_job_id: String(original.id),
      original_job_number: original.jobNumber,
      original_job_type: original.jobTypeName,
      recall_job_id: String(job.id),
      recall_job_number: job.jobNumber,
    });
  }
  hits.sort((a, b) => Number(b.recall_job_id) - Number(a.recall_job_id));
  return {
    recalls: hits.slice(0, RECALL_LIST_CAP),
    recalls_more: Math.max(0, hits.length - RECALL_LIST_CAP),
  };
}

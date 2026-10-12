/** Disciplinary action fields. Matches the company paper. Every box stays editable. */

export const WRITEUP_ACTIONS = [
  { id: "tardiness", label: "Tardiness" },
  { id: "absenteeism", label: "Absenteeism" },
  { id: "insubordination", label: "Insubordination" },
  { id: "performance", label: "Work performance" },
  { id: "dress", label: "Dress code" },
  { id: "safety", label: "Safety" },
  { id: "substance", label: "Substance abuse" },
  { id: "policy", label: "Policy violation" },
] as const;

export const WRITEUP_CORRECTIVE = [
  { id: "verbal", label: "Verbal counseling" },
  { id: "written", label: "Written warning" },
  { id: "suspension", label: "Disciplinary suspension" },
  { id: "final", label: "Final warning" },
  { id: "hr", label: "Counseling with Human Resources" },
  { id: "termination", label: "Termination" },
] as const;

export const WRITEUP_NEXT = [
  { id: "verbal", label: "Verbal counseling" },
  { id: "written", label: "Written warning" },
  { id: "suspension", label: "Disciplinary suspension" },
  { id: "final", label: "Final warning" },
  { id: "termination", label: "Termination" },
] as const;

export const WRITEUP_ACK =
  "I acknowledge by my signature below that I have been given the opportunity to present my views and explanations and I am signing this review prior to it being placed in my personnel file. I also understand the corrective actions to be taken by my supervisor and consequences if my improvement is unsatisfactory or I receive further disciplinary actions.";

const ACTION_IDS = new Set<string>(WRITEUP_ACTIONS.map((row) => row.id));
const CORRECTIVE_IDS = new Set<string>(WRITEUP_CORRECTIVE.map((row) => row.id));
const NEXT_IDS = new Set<string>(WRITEUP_NEXT.map((row) => row.id));

export type PriorOccurrence = { date: string; action: string };

export type WriteupDetail = {
  actions: string[];
  action_other: string;
  policy: string;
  prior_yes: "" | "no" | "yes";
  prior_rows: PriorOccurrence[];
  corrective: string[];
  termination_date: string;
  next_step: string[];
  employee_statement: string;
  /** True on write-ups filled with the company disciplinary form. */
  company_form: boolean;
};

function blankPrior(): PriorOccurrence[] {
  return [
    { date: "", action: "" },
    { date: "", action: "" },
    { date: "", action: "" },
  ];
}

export function emptyWriteupDetail(): WriteupDetail {
  return {
    actions: [],
    action_other: "",
    policy: "",
    prior_yes: "",
    prior_rows: blankPrior(),
    corrective: [],
    termination_date: "",
    next_step: [],
    employee_statement: "",
    company_form: false,
  };
}

function text(value: unknown, cap: number): { ok: true; value: string } | { ok: false } {
  const cleaned = String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
  if (cleaned.length > cap) return { ok: false };
  return { ok: true, value: cleaned };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function idList(value: unknown, allowed: Set<string>): { ok: true; ids: string[] } | { ok: false } {
  if (value == null || value === "") return { ok: true, ids: [] };
  if (!Array.isArray(value)) return { ok: false };
  const ids: string[] = [];
  for (const item of value) {
    const id = String(item ?? "").trim();
    if (!id) continue;
    if (!allowed.has(id)) return { ok: false };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

export function parseWriteupDetail(
  value: unknown
): { ok: true; value: WriteupDetail } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, value: emptyWriteupDetail() };
  const src = asRecord(value);
  if (!src) return { ok: false, error: "The disciplinary details are not in the right shape." };
  const actions = idList(src.actions, ACTION_IDS);
  const corrective = idList(src.corrective, CORRECTIVE_IDS);
  const next = idList(src.next_step, NEXT_IDS);
  if (!actions.ok || !corrective.ok || !next.ok) {
    return { ok: false, error: "One of the boxes is not a choice on this form." };
  }
  const priorYes = String(src.prior_yes ?? "").trim();
  if (priorYes !== "" && priorYes !== "no" && priorYes !== "yes") {
    return { ok: false, error: "Mark whether this happened before." };
  }
  const rawRows = Array.isArray(src.prior_rows) ? src.prior_rows : [];
  if (rawRows.length > 3) return { ok: false, error: "Keep prior occurrences to three." };
  const prior_rows = blankPrior();
  for (let i = 0; i < rawRows.length; i++) {
    const row = asRecord(rawRows[i]) || {};
    const date = text(row.date, 40);
    const action = text(row.action, 2000);
    if (!date.ok || !action.ok) {
      return { ok: false, error: "Keep each box under 5,000 characters." };
    }
    prior_rows[i] = { date: date.value, action: action.value };
  }
  let company_form = false;
  if (src.company_form === true) company_form = true;
  else if (src.company_form != null && src.company_form !== false && src.company_form !== "") {
    return { ok: false, error: "The disciplinary details are not in the right shape." };
  }
  const action_other = text(src.action_other, 200);
  const policy = text(src.policy, 2000);
  const employee_statement = text(src.employee_statement, 5000);
  const termination_date = text(src.termination_date, 40);
  if (!action_other.ok || !policy.ok || !employee_statement.ok || !termination_date.ok) {
    return { ok: false, error: "Keep each box under 5,000 characters." };
  }
  return {
    ok: true,
    value: {
      actions: actions.ids,
      action_other: action_other.value,
      policy: policy.value,
      prior_yes: priorYes as WriteupDetail["prior_yes"],
      prior_rows,
      corrective: corrective.ids,
      termination_date: termination_date.value,
      next_step: next.ids,
      employee_statement: employee_statement.value,
      company_form,
    },
  };
}

export function writeupDetailIsEmpty(detail: WriteupDetail): boolean {
  if (detail.actions.length || detail.corrective.length || detail.next_step.length) return false;
  if (detail.action_other || detail.policy || detail.prior_yes || detail.termination_date) return false;
  if (detail.employee_statement || detail.company_form) return false;
  return detail.prior_rows.every((row) => !row.date && !row.action);
}

export function labelsFor(ids: string[], options: readonly { id: string; label: string }[]): string[] {
  const wanted = new Set(ids);
  return options.filter((row) => wanted.has(row.id)).map((row) => row.label);
}

/** Accepts a saved object or a JSON string. Bad data becomes a blank form. */
export function coerceWriteupDetail(value: unknown): WriteupDetail {
  let raw = value;
  if (typeof raw === "string") {
    const stored = raw.trim();
    if (!stored) raw = null;
    else {
      try {
        raw = JSON.parse(stored);
      } catch {
        raw = null;
      }
    }
  }
  const parsed = parseWriteupDetail(raw);
  return parsed.ok ? parsed.value : emptyWriteupDetail();
}

export function cloneWriteupDetail(detail: WriteupDetail): WriteupDetail {
  return {
    ...detail,
    actions: [...detail.actions],
    corrective: [...detail.corrective],
    next_step: [...detail.next_step],
    prior_rows: [0, 1, 2].map((i) => ({
      date: detail.prior_rows[i]?.date || "",
      action: detail.prior_rows[i]?.action || "",
    })),
  };
}

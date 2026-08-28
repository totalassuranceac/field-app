import type { HandbookTopic } from "./handbookContent";

/** Structured pieces for phone-friendly handbook reading. */
export type HandbookBlock =
  | { type: "p"; text: string }
  | { type: "h"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[]; ordered?: "letter" | "number" }
  | { type: "note"; text: string };

/** Hand-polished topics that used to be one dense PDF paragraph. */
const OVERRIDES: Record<string, HandbookBlock[]> = {
  // Benefits match 2024 handbook; protective wording from 2026 kept where it does not add paid time.
  "6.2": [
    { type: "h", text: "Paid sick days" },
    {
      type: "ul",
      items: [
        "Eligible employees receive five (5) paid sick days per year.",
        "For regular full-time employees, sick pay is your base pay rate × the hours you would otherwise have worked that day.",
      ],
    },
    { type: "h", text: "Unused sick time" },
    {
      type: "p",
      text: "Unused sick days are forfeited at the end of the year. Sick time is not paid out when employment ends.",
    },
    { type: "h", text: "Documentation & abuse" },
    {
      type: "ul",
      items: [
        "A doctor’s note is required for absences of more than three consecutive days.",
        "Abuse of sick leave (for example patterns of Mondays/Fridays, or missing required documentation) may lead to discipline.",
      ],
    },
  ],
  "6.3": [
    { type: "h", text: "How much vacation you earn" },
    {
      type: "ul",
      items: [
        "After 1 year: five (5) paid vacation days per year.",
        "After 3 years: ten (10) paid vacation days per year.",
        "After 5 years: fifteen (15) paid vacation days per year.",
      ],
    },
    {
      type: "p",
      text: "For regular full-time employees, vacation pay is your base pay rate × the hours you would otherwise have worked that day.",
    },
    { type: "h", text: "Scheduling" },
    {
      type: "p",
      text: "Vacation must be scheduled in advance and approved by your manager so the team stays covered.",
    },
    { type: "h", text: "Unused vacation" },
    {
      type: "note",
      text: "Unused vacation is forfeited at the end of the year. Vacation is not paid out at termination unless required by law.",
    },
  ],
  "6.4": [
    { type: "h", text: "Paid holidays" },
    {
      type: "ul",
      items: [
        "New Year’s Day",
        "Memorial Day",
        "Independence Day",
        "Labor Day",
        "Thanksgiving Day",
        "Christmas Day",
      ],
    },
    { type: "h", text: "Who gets holiday pay" },
    {
      type: "ul",
      items: [
        "Eligible employees receive paid holiday time off.",
        "Full-time: base pay rate (as of the holiday) × hours you would otherwise have worked that day.",
        "Regular part-time: paid on a pro rata basis.",
      ],
    },
    { type: "h", text: "If you work the holiday" },
    {
      type: "p",
      text: "If an eligible nonexempt employee works a recognized holiday with company approval, they receive holiday pay plus straight-time wages for hours worked on the holiday.",
    },
    { type: "h", text: "Weekend holidays & attendance" },
    {
      type: "ul",
      items: [
        "If a holiday falls on a weekend, it is observed on the nearest weekday as set by management.",
        "If you are on leave or absent without approval on the scheduled workday before or after a holiday, you may not receive holiday pay.",
      ],
    },
  ],
  "6.1": [
    { type: "h", text: "How to request leave" },
    {
      type: "ul",
      items: [
        "For planned leaves, submit a request in writing at least 30 days in advance to the office / manager for approval (stricter notice than the prior 14-day rule).",
        "For emergencies, submit as soon as you know you need leave.",
        "All leaves must be approved by management. Taking leave without approval may be treated as a voluntary resignation.",
      ],
    },
    { type: "h", text: "Paid time before unpaid" },
    {
      type: "p",
      text: "Employees must use available sick and vacation time before taking unpaid time off.",
    },
    { type: "h", text: "During leave" },
    {
      type: "note",
      text: "If during a leave you accept another job, do outside employment/consulting, or apply for unemployment insurance benefits, you may be considered to have voluntarily resigned.",
    },
    { type: "h", text: "Approval & return to work" },
    {
      type: "ul",
      items: [
        "Requests are considered based on business needs and the law; management may approve or deny unless the law requires otherwise.",
        "Medical leave may require a healthcare-provider certification; late or missing certification can delay or deny leave.",
        "Ask for any extension and get it approved before your current leave ends.",
        "The company will make a reasonable effort to return you to your former or a comparable position; reinstatement is not guaranteed except as required by law.",
      ],
    },
  ],
  "6.7": [
    { type: "h", text: "Paid bereavement leave" },
    {
      type: "p",
      text: "If there is a death in your immediate family, you may have up to two (2) working days with pay (regular straight-time rate or base salary) to handle family affairs and attend the funeral.",
    },
    { type: "h", text: "Immediate family means" },
    {
      type: "ul",
      items: [
        "Father or mother",
        "Brother or sister",
        "Spouse or domestic partner",
        "Child",
        "Mother-in-law or father-in-law",
        "Grandparents",
        "Grandchildren",
      ],
    },
  ],
  "6.8": [
    {
      type: "p",
      text: "U.S. citizens have a civic obligation to serve on a jury when called.",
    },
    { type: "h", text: "What you must do" },
    {
      type: "ul",
      items: [
        "Bring the jury duty notice to your manager as soon as you receive it so coverage can be arranged.",
        "Call in or report for work on days (or parts of days) when court does not require you.",
      ],
    },
  ],
  "6.9": [
    {
      type: "p",
      text: "Registered voters who do not have two consecutive non-work hours while the polls are open may take paid time off to vote in a local, state, or national election.",
    },
  ],
  "3.2": [
    { type: "h", text: "Nonexempt overtime" },
    {
      type: "ul",
      items: [
        "Paid at 1.5× your regular rate for hours worked over 40 in a workweek.",
        "Regular rate includes your hourly wage plus things like commissions or bonuses.",
        "Get manager approval before working overtime when possible.",
      ],
    },
    {
      type: "p",
      text: "Example: 45 hours in a week means 5 hours paid at the overtime rate.",
    },
    {
      type: "note",
      text: "Unauthorized overtime is still paid, but repeated cases may lead to discipline. Falsifying hours to claim overtime can result in termination.",
    },
    { type: "h", text: "Exempt employees" },
    {
      type: "p",
      text: "Exempt status requires both the salary threshold ($58,656 / year or $1,128 / week as of 2025, subject to change) and the duties test.",
    },
  ],
  "4.10": [
    { type: "h", text: "Who may drive" },
    {
      type: "ul",
      items: [
        "Only authorized employees with a valid license may operate company vehicles.",
        "Follow all traffic laws and drive safely.",
      ],
    },
    { type: "h", text: "Care, fuel & security" },
    {
      type: "ul",
      items: [
        "Report maintenance issues promptly; the company schedules regular maintenance.",
        "Do a daily inspection (tires, lights, fluids, and similar checks) and keep the vehicle clean and professional.",
        "Record fuel accurately using company fuel cards.",
        "Lock unattended vehicles. Keep personal belongings in the vehicle only when needed for work.",
      ],
    },
    { type: "h", text: "Personal use" },
    {
      type: "note",
      text: "Personal use of company vehicles is prohibited. Non-compliance may mean loss of driving privileges and termination.",
    },
    { type: "h", text: "Trackers & cameras" },
    {
      type: "p",
      text: "Company vehicles are equipped with trackers and cameras for the safety and security of the vehicle and the driver.",
    },
    { type: "h", text: "Accidents" },
    {
      type: "ul",
      items: [
        "Report accidents or incidents promptly and follow company procedures.",
        "After any accident involving a company vehicle (or a personal vehicle used for company work), you must complete drug and alcohol testing promptly at an approved facility.",
        "Refusal to test, or a positive test, may lead to discipline up to and including termination. Positive results may also include a rehab referral when appropriate.",
      ],
    },
  ],
  "4.9": [
    { type: "h", text: "Personal use" },
    {
      type: "p",
      text: "Limited personal cell phone use is allowed during breaks or non-working time, as long as it does not disrupt operations or customer service.",
    },
    { type: "h", text: "Driving" },
    {
      type: "note",
      text: "Cell phone use while operating a company vehicle or driving on company business is strictly prohibited (hands-free only where legally permitted and safe).",
    },
    { type: "h", text: "Violations" },
    {
      type: "ul",
      items: [
        "First offense: warning.",
        "Repeated or serious violations: may lead to termination.",
      ],
    },
  ],
  "1.4": [
    {
      type: "p",
      text: "Employment with Total Assurance is at-will, unless a written agreement signed by an authorized officer says otherwise.",
    },
    { type: "h", text: "What at-will means" },
    {
      type: "ul",
      items: [
        "You may resign at any time, for any reason, with or without notice.",
        "The company may end employment at any time for any lawful reason, with or without cause, and with or without notice.",
      ],
    },
    {
      type: "note",
      text: "This manual does not create a contract or guarantee continued employment. Only the CEO, President, or CFO can change at-will status — and only in a signed writing.",
    },
  ],
};

function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  return parts.map((s) => s.trim()).filter(Boolean);
}

function shortParagraphs(text: string, maxChars = 220): string[] {
  const sentences = splitSentences(text);
  if (!sentences.length) return [];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const next = buf ? `${buf} ${s}` : s;
    if (buf && next.length > maxChars) {
      out.push(buf);
      buf = s;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function extractFollowingList(text: string): { intro: string; items: string[] } | null {
  const m = text.match(/^(.*?(?:following|as follows)[^:]{0,100}:)\s*(.+)$/i);
  if (!m) return null;
  const intro = m[1].trim();
  const rest = m[2].trim();
  // Prefer semicolon-separated clauses; else short comma lists (holidays)
  let items: string[] = [];
  if (rest.includes(";")) {
    items = rest
      .split(/\s*;\s*/)
      .map((s) => s.replace(/\.\s*$/, "").trim())
      .filter((s) => s.length > 2);
  } else {
    items = rest
      .split(/,\s*|\s+and\s+/i)
      .map((s) => s.replace(/\.\s*$/, "").trim())
      .filter((s) => s.length > 1 && s.length < 90);
  }
  if (items.length < 2) return null;
  // Keep a readable intro without forcing "following:" alone
  return { intro, items };
}

function extractLetteredList(text: string): { intro: string; items: string[] } | null {
  if (!/\ba\.\s+\S/i.test(text) || !/\bb\.\s+\S/i.test(text)) return null;
  const first = text.search(/\ba\.\s+/i);
  if (first < 0) return null;
  const intro = text.slice(0, first).trim();
  const listPart = text.slice(first).trim();
  const items = listPart
    .split(/(?=\b[a-z]\.\s+)/i)
    .map((s) => s.replace(/^[a-z]\.\s+/i, "").trim())
    .filter((s) => s.length > 2);
  if (items.length < 2) return null;
  return { intro: intro.replace(/:\s*$/, "").trim(), items };
}

function formatParagraphToBlocks(text: string): HandbookBlock[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];

  const lettered = extractLetteredList(t);
  if (lettered) {
    const blocks: HandbookBlock[] = [];
    if (lettered.intro) {
      for (const p of shortParagraphs(lettered.intro)) blocks.push({ type: "p", text: p });
    }
    blocks.push({ type: "ol", items: lettered.items, ordered: "letter" });
    return blocks;
  }

  const following = extractFollowingList(t);
  if (following) {
    const blocks: HandbookBlock[] = [];
    for (const p of shortParagraphs(following.intro)) blocks.push({ type: "p", text: p });
    blocks.push({ type: "ul", items: following.items });
    return blocks;
  }

  // Split long walls into readable chunks
  if (t.length > 260) {
    return shortParagraphs(t, 200).map((p) => ({ type: "p" as const, text: p }));
  }
  return [{ type: "p", text: t }];
}

function coalesceLetteredBody(paras: string[]): HandbookBlock[] | null {
  const letterRe = /^[a-z]\.\s+/i;
  const items: string[] = [];
  const introParts: string[] = [];
  let sawLetter = false;
  for (const raw of paras) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (letterRe.test(p)) {
      sawLetter = true;
      items.push(p.replace(letterRe, "").trim());
    } else if (!sawLetter) {
      introParts.push(p);
    } else {
      // Trailing prose after the list
      break;
    }
  }
  if (!sawLetter || items.length < 2) return null;
  const blocks: HandbookBlock[] = [];
  for (const p of introParts.flatMap((t) => shortParagraphs(t))) {
    blocks.push({ type: "p", text: p });
  }
  blocks.push({ type: "ol", items, ordered: "letter" });
  // Append any leftover after the lettered run
  let past = false;
  let count = 0;
  for (const raw of paras) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (letterRe.test(p)) {
      past = true;
      count += 1;
      continue;
    }
    if (!past) continue;
    if (count >= 2) {
      for (const chunk of shortParagraphs(p)) blocks.push({ type: "p", text: chunk });
    }
  }
  return blocks;
}

/** Blocks to render for a topic (overrides first, then auto-format). */
export function topicBlocks(topic: HandbookTopic): HandbookBlock[] {
  const override = OVERRIDES[topic.id];
  if (override) return override;

  const letteredRun = coalesceLetteredBody(topic.body);
  if (letteredRun) return letteredRun;

  // Whole-topic pass catches lettered lists that arrived as one PDF blob
  const joined = topic.body.join(" ");
  const lettered = extractLetteredList(joined);
  if (lettered) {
    const blocks: HandbookBlock[] = [];
    if (lettered.intro) {
      for (const p of shortParagraphs(lettered.intro)) blocks.push({ type: "p", text: p });
    }
    blocks.push({ type: "ol", items: lettered.items, ordered: "letter" });
    return blocks;
  }

  return topic.body.flatMap(formatParagraphToBlocks);
}

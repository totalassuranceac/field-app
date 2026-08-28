"""Generate src/handbookContent.ts from tmp-handbook-extract.txt."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
raw = (ROOT / "tmp-handbook-extract.txt").read_text(encoding="utf-8")

idx = raw.find("Section 1 – Introduction")
idx2 = raw.find("Section 1 – Introduction", idx + 1)
body = raw[idx2:] if idx2 >= 0 else raw[idx:]

header_re = re.compile(
    r"(?m)^(Section \d+\s*[–\-]\s*[^\n]+|\d+\.\d+\s+[^\n]+|Employee Acknowledgment)\s*$"
)
headers = list(header_re.finditer(body))
parts: list[tuple[str, str]] = []
for i, m in enumerate(headers):
    end = headers[i + 1].start() if i + 1 < len(headers) else len(body)
    parts.append((m.group(1).strip(), body[m.end() : end].strip()))

SECTIONS = {
    "1": ("Introduction", "Welcome, how this manual works, and at-will employment."),
    "2": (
        "Employment Policies",
        "Classifications, EEO, confidentiality, relatives, and workplace rules.",
    ),
    "3": ("Hours & Payroll", "Paydays, overtime, breaks, time cards, and deductions."),
    "4": (
        "Conduct & Performance",
        "Harassment, attendance, safety, phones, vehicles, and workplace standards.",
    ),
    "5": ("Benefits", "Insurance, workers’ compensation, and other company benefits."),
    "6": (
        "Leaves & Time Off",
        "Sick, vacation, holidays, FMLA, bereavement, jury duty, and voting.",
    ),
}

SUMMARIES = {
    "1.1": "A welcome to the team and what this manual is for.",
    "1.2": "What the manual covers — and that it is not an employment contract.",
    "1.3": "How policies can change and how updates are communicated.",
    "1.4": "Employment is at-will unless a written agreement says otherwise.",
    "2.1": "Exempt, nonexempt, full-time, part-time, temporary, and contractors.",
    "2.2": "Equal opportunity, ADA, CROWN Act, pregnancy accommodations, and AI bias rules.",
    "2.3": "Protecting company and customer confidential information.",
    "2.4": "Rules for employing minors under federal and state law.",
    "2.5": "When relatives may work together and conflict-of-interest limits.",
    "2.6": "New-hire introductory period and expectations.",
    "2.7": "Personnel files, references, and who can request records.",
    "2.8": "Privacy expectations at work.",
    "2.9": "I-9 / immigration compliance.",
    "2.10": "Political activity and neutrality at work.",
    "2.11": "Pregnancy, lactation, and related accommodations.",
    "2.12": "Social media, publicity, and use of your likeness.",
    "3.1": "Pay periods and when you get paid.",
    "3.2": "When overtime applies and how it is paid.",
    "3.3": "Rest breaks and meal periods.",
    "3.4": "Time cards and accurate timekeeping.",
    "3.5": "Payroll deductions that may appear on your check.",
    "3.6": "How wage garnishments are handled.",
    "3.7": "Direct deposit for pay.",
    "4.1": "Zero tolerance for harassment and discrimination; how to report.",
    "4.2": "Attendance expectations and call-in rules.",
    "4.3": "Conduct standards and discipline.",
    "4.4": "What to wear at work and on the job.",
    "4.5": "Safety rules and incident reporting.",
    "4.6": "Drug and alcohol policy.",
    "4.7": "When the company may search workplace property.",
    "4.8": "Internet, email, and computer use.",
    "4.9": "Cell phone use on the job.",
    "4.10": "Company vehicles, driving, and care of equipment.",
    "4.11": "Workplace violence prevention and reporting.",
    "5.1": "Overview of benefits eligibility.",
    "5.2": "Group health insurance.",
    "5.3": "Group life insurance.",
    "5.4": "COBRA continuation coverage.",
    "5.5": "Workers’ compensation for on-the-job injuries.",
    "5.6": "Social Security / FICA.",
    "5.7": "Unemployment insurance.",
    "5.8": "Other benefits the company may offer.",
    "6.1": "How leave requests generally work.",
    "6.2": "Sick day entitlement and use.",
    "6.3": "Vacation entitlement and use.",
    "6.4": "Company holidays.",
    "6.5": "Family and Medical Leave (FMLA).",
    "6.6": "Leave related to workers’ compensation.",
    "6.7": "Bereavement leave.",
    "6.8": "Jury duty leave.",
    "6.9": "Time off to vote.",
}

KEYWORDS = {
    "1.4": ["at-will", "resign", "terminate", "fired"],
    "2.2": ["eeo", "discrimination", "ada", "crown", "pregnancy", "ai"],
    "2.3": ["nda", "confidential", "secret"],
    "3.2": ["overtime", "ot", "time and a half"],
    "3.3": ["break", "lunch", "meal"],
    "3.4": ["timecard", "time card", "clock"],
    "4.1": ["harassment", "hostile", "report"],
    "4.2": ["attendance", "late", "absent", "call in", "no call"],
    "4.5": ["safety", "injury", "accident"],
    "4.6": ["drug", "alcohol", "substance"],
    "4.9": ["phone", "cell", "mobile", "texting"],
    "4.10": ["vehicle", "truck", "van", "driving", "fleet"],
    "4.11": ["violence", "threat", "weapon"],
    "5.2": ["health", "insurance", "medical"],
    "5.5": ["workers comp", "workers compensation", "injury"],
    "6.2": ["sick", "sick day", "illness"],
    "6.3": ["vacation", "pto", "time off"],
    "6.4": ["holiday", "christmas", "thanksgiving"],
    "6.5": ["fmla", "family leave", "medical leave"],
    "6.7": ["bereavement", "funeral", "death"],
    "6.8": ["jury"],
    "6.9": ["vote", "voting", "election"],
}


def clean_text(s: str) -> str:
    s = s.replace("\r", "")
    s = re.sub(r"(\w)-\n(\w)", r"\1\2", s)
    s = re.sub(
        r"(?<![.!?:>])\n(?![a-z]\.\s|[A-Z]\.|Section |\d+\.\d+|Employee )", " ", s
    )
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def to_paragraphs(s: str) -> list[str]:
    s = clean_text(s)
    chunks = re.split(r"\n\s*\n", s)
    paras: list[str] = []
    for c in chunks:
        c = c.strip()
        if not c:
            continue
        if re.search(r"(?m)^[a-z]\.\s", c):
            items = re.split(r"(?m)(?=^[a-z]\.\s)", c)
            for it in items:
                it = re.sub(r"\s+", " ", it).strip()
                if it:
                    paras.append(it)
        else:
            paras.append(re.sub(r"\s+", " ", c).strip())
    return [p for p in paras if len(p) > 2]


topics: list[dict] = []
sections_map: dict[str, list[str]] = {sid: [] for sid in SECTIONS}

for title, content in parts:
    if title.startswith("Section ") or title == "Employee Acknowledgment":
        continue
    m = re.match(r"^(\d+)\.(\d+)\s+(.*)$", title)
    if not m:
        continue
    sid, tid, name = m.group(1), m.group(2), m.group(3).strip()
    topic_id = f"{sid}.{tid}"
    paras = to_paragraphs(content) or ["(Content coming soon.)"]
    paras = [
        p.replace("Within these pages, you will find", "In this manual you will find")
        .replace(
            "sign an acknowledgment form upon receipt and annually thereafter",
            "confirm you have read this manual in the Field App (and again when updates are issued)",
        )
        .replace("via signed form", "in the Field App")
        for p in paras
    ]
    topics.append(
        {
            "id": topic_id,
            "sectionId": sid,
            "title": name,
            "summary": SUMMARIES.get(topic_id, name),
            "keywords": KEYWORDS.get(topic_id, []),
            "body": paras,
        }
    )
    sections_map[sid].append(topic_id)

lines: list[str] = []
lines += [
    "/**",
    " * Employee Manual — phone-first structured content.",
    " * Source: Total Assurance Employee Manual 2026 (migrated from PDF for digital reading).",
    " * Policy meaning preserved; formatting adapted for phones. Not an employment contract.",
    " */",
    "",
    "export type HandbookTopic = {",
    "  id: string;",
    "  sectionId: string;",
    "  title: string;",
    "  summary: string;",
    "  keywords?: string[];",
    "  body: string[];",
    "};",
    "",
    "export type HandbookSection = {",
    "  id: string;",
    "  title: string;",
    "  summary: string;",
    "  topicIds: string[];",
    "};",
    "",
    "export type HandbookQuickAnswer = {",
    "  label: string;",
    "  topicId: string;",
    "};",
    "",
    "export const HANDBOOK_META = {",
    '  title: "Employee Manual",',
    '  versionLabel: "2026",',
    '  effectiveDate: "2026-01-01",',
    '  company: "Total Assurance A/C & Heating",',
    '  address: "3833 Saturn Rd, Corpus Christi, Texas 78413",',
    '  phone: "361-446-6925",',
    '  license: "TACLA47840E",',
    "} as const;",
    "",
    "export const HANDBOOK_QUICK_ANSWERS: HandbookQuickAnswer[] = [",
]
for label, tid in [
    ("Sick days", "6.2"),
    ("Vacation / PTO", "6.3"),
    ("Overtime", "3.2"),
    ("Company vehicles", "4.10"),
    ("Cell phones", "4.9"),
    ("Harassment", "4.1"),
    ("Attendance", "4.2"),
    ("At-will employment", "1.4"),
]:
    lines.append(f'  {{ label: "{label}", topicId: "{tid}" }},')
lines.append("];")
lines.append("")
lines.append("export const HANDBOOK_SECTIONS: HandbookSection[] = [")
for sid, (title, summary) in SECTIONS.items():
    ids = ", ".join(f'"{x}"' for x in sections_map.get(sid, []))
    lines += [
        "  {",
        f'    id: "{sid}",',
        f'    title: "{title}",',
        f'    summary: "{summary}",',
        f"    topicIds: [{ids}],",
        "  },",
    ]
lines.append("];")
lines.append("")
lines.append("export const HANDBOOK_TOPICS: HandbookTopic[] = [")
for t in topics:
    lines += [
        "  {",
        f'    id: "{t["id"]}",',
        f'    sectionId: "{t["sectionId"]}",',
        f"    title: {json.dumps(t['title'], ensure_ascii=False)},",
        f"    summary: {json.dumps(t['summary'], ensure_ascii=False)},",
    ]
    if t["keywords"]:
        kw = ", ".join(json.dumps(k, ensure_ascii=False) for k in t["keywords"])
        lines.append(f"    keywords: [{kw}],")
    lines.append("    body: [")
    for p in t["body"]:
        lines.append(f"      {json.dumps(p, ensure_ascii=False)},")
    lines += ["    ],", "  },"]
lines += [
    "];",
    "",
    "const topicById = new Map(HANDBOOK_TOPICS.map((t) => [t.id, t]));",
    "const sectionById = new Map(HANDBOOK_SECTIONS.map((s) => [s.id, s]));",
    "",
    "export function getHandbookTopic(id: string): HandbookTopic | undefined {",
    "  return topicById.get(id);",
    "}",
    "",
    "export function getHandbookSection(id: string): HandbookSection | undefined {",
    "  return sectionById.get(id);",
    "}",
    "",
    "export function searchHandbookTopics(query: string): HandbookTopic[] {",
    "  const q = query.trim().toLowerCase();",
    "  if (!q) return [];",
    "  const tokens = q.split(/\\s+/).filter(Boolean);",
    "  return HANDBOOK_TOPICS.filter((t) => {",
    '    const hay = `${t.id} ${t.title} ${t.summary} ${(t.keywords || []).join(" ")} ${t.body.join(" ")}`.toLowerCase();',
    "    return tokens.every((tok) => hay.includes(tok));",
    "  });",
    "}",
    "",
    "export function neighboringTopics(topicId: string): {",
    "  prev: HandbookTopic | null;",
    "  next: HandbookTopic | null;",
    "} {",
    "  const list = HANDBOOK_TOPICS;",
    "  const i = list.findIndex((t) => t.id === topicId);",
    "  if (i < 0) return { prev: null, next: null };",
    "  return { prev: list[i - 1] || null, next: list[i + 1] || null };",
    "}",
    "",
]

out = ROOT / "src" / "handbookContent.ts"
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("topics", len(topics), "bytes", out.stat().st_size)
for sid, ids in sections_map.items():
    print(sid, len(ids), ids)

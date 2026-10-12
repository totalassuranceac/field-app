import {
  WRITEUP_ACK,
  WRITEUP_ACTIONS,
  WRITEUP_CORRECTIVE,
  WRITEUP_NEXT,
  emptyWriteupDetail,
  type WriteupDetail,
} from "../../worker/writeupDetail";

export type WriteupSheetProps = {
  dateLabel: string;
  employee: string;
  supervisor: string;
  what: string;
  prior: string;
  expectations: string;
  consequences: string;
  detail?: WriteupDetail | null;
  voided?: boolean;
};

const OCCURRENCE = ["First Occurrence", "Second Occurrence", "Third Occurrence"];

const PRINT_LABEL: Record<string, string> = {
  tardiness: "Tardiness",
  absenteeism: "Absenteeism",
  insubordination: "Insubordination",
  performance: "Work Performance",
  dress: "Dress Code",
  safety: "Safety",
  substance: "Substance Abuse",
  policy: "Policy Violation",
  verbal: "Verbal Counseling",
  written: "Written Warning",
  suspension: "Disciplinary Suspension",
  final: "Final Warning",
  hr: "Counseling with Human Resources",
  termination: "Termination",
};

function clean(value: string): string {
  return value.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Field type size on the company paper. Labels are set in CSS. */
const FIELD_PT = 10.5;

/** Printable width of one full writing line, in CSS pixels. */
const RULE_TEXT_PX = 700;

/** First improvement line shares the heading row, so that field is shorter. */
const IMPROVE_HEAD_PX = 500;

/** First employee-statement line shares the heading row. */
const STATEMENT_HEAD_PX = 520;

/**
 * Company paper line counts. Policy is two lines so a two-sentence policy
 * still prints. The blank company sheet draws one policy rule.
 */
const POLICY_LINES = 2;
const DETAIL_LINES = 3;
const IMPROVE_LINES = 3;
const STATEMENT_LINES = 3;

let measureCanvas: HTMLCanvasElement | null = null;

function textWidth(value: string, pt: number): number {
  if (typeof document === "undefined") return value.length * pt * 0.5;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  const ctx = measureCanvas.getContext("2d");
  if (!ctx) return value.length * pt * 0.5;
  ctx.font = `${pt}pt Calibri, Arial, Helvetica, sans-serif`;
  return ctx.measureText(value).width;
}

/** One row per width. A new paragraph starts a new row. Extra words are dropped. */
function fitWidths(text: string, widths: number[]): string[] {
  const lines: string[] = [];
  let index = 0;
  for (const paragraph of clean(text).split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = "";
    for (const word of words) {
      if (index >= widths.length) break;
      const next = line ? `${line} ${word}` : word;
      const width = widths[index];
      if (line && textWidth(next, FIELD_PT) > width) {
        lines.push(line);
        index += 1;
        line = word;
      } else {
        line = next;
      }
    }
    if (line && index < widths.length) {
      lines.push(line);
      index += 1;
    }
  }
  return Array.from({ length: widths.length }, (_, row) => lines[row] || "");
}

function fullWidths(lines: number): number[] {
  return Array.from({ length: lines }, () => RULE_TEXT_PX);
}

function Box({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="writeup-choice">
      <span className="writeup-box" aria-hidden="true">
        {on ? "X" : ""}
      </span>
      {label}
    </span>
  );
}

function Choices({
  options,
  selected,
  className,
}: {
  options: readonly { id: string; label: string }[];
  selected: string[];
  className: string;
}) {
  const on = new Set(selected);
  return (
    <div className={className}>
      {options.map((row) => (
        <Box key={row.id} on={on.has(row.id)} label={PRINT_LABEL[row.id] || row.label} />
      ))}
    </div>
  );
}

function Ruled({ text, lines }: { text: string; lines: number }) {
  const rows = fitWidths(text, fullWidths(lines));
  return (
    <div className="writeup-ruled">
      {rows.map((row, index) => (
        <div key={index} className="writeup-rule">
          {row || "\u00a0"}
        </div>
      ))}
    </div>
  );
}

function HeadedLines({
  title,
  text,
  headPx,
  lines,
}: {
  title: string;
  text: string;
  headPx: number;
  lines: number;
}) {
  const rows = fitWidths(text, [headPx, ...fullWidths(lines - 1)]);
  return (
    <>
      <div className="writeup-head-row">
        <h2>{title}</h2>
        <span className="writeup-line writeup-line-grow">{rows[0] || "\u00a0"}</span>
      </div>
      <div className="writeup-ruled">
        {rows.slice(1).map((row, index) => (
          <div key={index} className="writeup-rule">
            {row || "\u00a0"}
          </div>
        ))}
      </div>
    </>
  );
}

function Signature({ label }: { label: string }) {
  return (
    <div className="writeup-sig-row">
      <span>{label}:</span>
      <span className="writeup-line writeup-sign-line">{"\u00a0"}</span>
      <span>Date:</span>
      <span className="writeup-line writeup-sign-line" />
    </div>
  );
}

/** Company disciplinary paper. Hidden on screen until print-writeup. */
export function WriteupSheet(props: WriteupSheetProps) {
  const detail = props.detail || emptyWriteupDetail();
  const employee = clean(props.employee);
  const dateLabel = props.dateLabel && props.dateLabel !== "-" ? props.dateLabel : "";
  const improvement = [clean(props.expectations), clean(props.consequences)].filter(Boolean).join("\n");
  const correctiveFirst = WRITEUP_CORRECTIVE.slice(0, 4);
  const correctiveRest = WRITEUP_CORRECTIVE.slice(4);

  return (
    <article className="writeup-sheet writeup-paper">
      <img className="writeup-logo" src="/writeup-form-logo.jpg" alt="Total Assurance A/C & Heating" />
      <div className="writeup-banner">
        <img src="/writeup-form-banner.jpg" alt="" />
        <span>DISCIPLINARY ACTION FORM</span>
      </div>
      {props.voided ? <div className="writeup-voided">VOIDED</div> : null}

      <div className="writeup-id">
        <span>Name of Employee:</span>
        <span className="writeup-line writeup-name-line">{employee || "\u00a0"}</span>
        <span>Date:</span>
        <span className="writeup-line writeup-when-line">{dateLabel || "\u00a0"}</span>
      </div>

      <h2>I. Disciplinary Action</h2>
      <Choices options={WRITEUP_ACTIONS} selected={detail.actions} className="writeup-choices writeup-choices-4" />
      <div className="writeup-other">
        <Box on={Boolean(clean(detail.action_other))} label="Other" />
        <span className="writeup-line writeup-line-grow">{clean(detail.action_other) || "\u00a0"}</span>
      </div>
      <p className="writeup-prompt">If applicable, please list the Total Assurance Policy(s) violated:</p>
      <Ruled text={detail.policy} lines={POLICY_LINES} />

      <div className="writeup-sec-row">
        <h2>
          II. Details of Occurrence <span>(Attached additional sheet if necessary)</span>
        </h2>
        <div className="writeup-date-field">
          <span>Date of Occurrence:</span>
          <span className="writeup-line">{dateLabel || "\u00a0"}</span>
        </div>
      </div>
      <Ruled text={props.what} lines={DETAIL_LINES} />

      <h2>III. Has this or a similar infraction occurred before?</h2>
      <div className="writeup-yesno">
        <Box on={detail.prior_yes === "no"} label="No" />
        <Box on={detail.prior_yes === "yes"} label="Yes" />
        <span>If yes, please provide the details below and attach prior disciplinary actions.</span>
      </div>
      {OCCURRENCE.map((label, index) => {
        const row = detail.prior_rows[index] || { date: "", action: "" };
        return (
          <div key={label} className="writeup-occur">
            <span>{label}</span>
            <span>Date:</span>
            <span className="writeup-line">{clean(row.date) || "\u00a0"}</span>
            <span>Action Taken:</span>
            <span className="writeup-line">{clean(row.action) || "\u00a0"}</span>
          </div>
        );
      })}
      <h2>IV. Corrective action to be taken:</h2>
      <Choices options={correctiveFirst} selected={detail.corrective} className="writeup-choices writeup-choices-row" />
      <div className="writeup-term-row">
        <Choices options={correctiveRest} selected={detail.corrective} className="writeup-choices writeup-choices-row" />
        <span>Termination Date:</span>
        <span className="writeup-line writeup-date-line">{clean(detail.termination_date) || "\u00a0"}</span>
      </div>

      <HeadedLines title="V. Expected Improvement:" text={improvement} headPx={IMPROVE_HEAD_PX} lines={IMPROVE_LINES} />

      <p className="writeup-prompt">
        Consequence for unsatisfactory improvement and/or further disciplinary actions:
      </p>
      <Choices options={WRITEUP_NEXT} selected={detail.next_step} className="writeup-choices writeup-choices-row writeup-next" />

      <Signature label="Supervisor Signature" />

      <HeadedLines
        title="VI. Employee Statement:"
        text={detail.employee_statement}
        headPx={STATEMENT_HEAD_PX}
        lines={STATEMENT_LINES}
      />
      <p className="writeup-ack-print">{WRITEUP_ACK}</p>
      <Signature label="Employee Signature" />
    </article>
  );
}

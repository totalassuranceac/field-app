import {
  WRITEUP_ACK,
  WRITEUP_ACTIONS,
  WRITEUP_CORRECTIVE,
  WRITEUP_NEXT,
  labelsFor,
  writeupDetailIsEmpty,
  type WriteupDetail,
} from "../../worker/writeupDetail";

const OCCURRENCE = ["First occurrence", "Second occurrence", "Third occurrence"];

function toggle(list: string[], id: string, on: boolean): string[] {
  if (on) return list.includes(id) ? list : [...list, id];
  return list.filter((item) => item !== id);
}

function priorRow(detail: WriteupDetail, index: number): { date: string; action: string } {
  return detail.prior_rows[index] || { date: "", action: "" };
}

function CheckGrid({
  options,
  selected,
  onToggle,
}: {
  options: readonly { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="writeup-check-grid">
      {options.map((row) => (
        <label key={row.id} className="check-row">
          <input
            type="checkbox"
            checked={selected.includes(row.id)}
            onChange={(e) => onToggle(row.id, e.target.checked)}
          />
          <span>{row.label}</span>
        </label>
      ))}
    </div>
  );
}

export function WriteupDetailFields({
  name,
  detail,
  onChange,
  what,
  onWhat,
  prior,
  onPrior,
  expectations,
  onExpectations,
  consequences,
  onConsequences,
}: {
  name: string;
  detail: WriteupDetail;
  onChange: (next: WriteupDetail) => void;
  what: string;
  onWhat: (value: string) => void;
  prior: string;
  onPrior: (value: string) => void;
  expectations: string;
  onExpectations: (value: string) => void;
  consequences: string;
  onConsequences: (value: string) => void;
}) {
  function setPrior(index: number, key: "date" | "action", value: string) {
    const prior_rows = [0, 1, 2].map((i) => {
      const row = priorRow(detail, i);
      return i === index ? { ...row, [key]: value } : row;
    });
    onChange({ ...detail, prior_rows });
  }

  return (
    <div className="writeup-detail-fields">
      <div className="writeup-form-block">
        <h3>I. Disciplinary action</h3>
        <CheckGrid
          options={WRITEUP_ACTIONS}
          selected={detail.actions}
          onToggle={(id, on) => onChange({ ...detail, actions: toggle(detail.actions, id, on) })}
        />
        <label>
          Other
          <input
            value={detail.action_other}
            maxLength={200}
            onChange={(e) => onChange({ ...detail, action_other: e.target.value })}
            placeholder="Type another reason, if there is one"
          />
        </label>
        <label>
          If applicable, please list the Total Assurance policy or policies violated
          <textarea
            rows={2}
            maxLength={2000}
            value={detail.policy}
            onChange={(e) => onChange({ ...detail, policy: e.target.value })}
          />
        </label>
      </div>

      <div className="writeup-form-block">
        <h3>II. Details of the occurrence</h3>
        <p className="muted">The date at the top of this form is the date of the occurrence. Fill in the bracketed blanks.</p>
        <label>
          What happened
          <textarea rows={8} value={what} onChange={(e) => onWhat(e.target.value)} />
        </label>
      </div>

      <div className="writeup-form-block">
        <h3>III. Has this or a similar infraction occurred before?</h3>
        <div className="writeup-check-grid">
          <label className="check-row">
            <input
              type="radio"
              name={`${name}-prior`}
              checked={detail.prior_yes === "no"}
              onChange={() => onChange({ ...detail, prior_yes: "no" })}
            />
            <span>No</span>
          </label>
          <label className="check-row">
            <input
              type="radio"
              name={`${name}-prior`}
              checked={detail.prior_yes === "yes"}
              onChange={() => onChange({ ...detail, prior_yes: "yes" })}
            />
            <span>Yes</span>
          </label>
        </div>
        <p className="muted">If yes, list the earlier dates and what was done. Attach the earlier write-up if you have it.</p>
        {OCCURRENCE.map((label, index) => {
          const row = priorRow(detail, index);
          return (
            <div key={label} className="writeup-prior-row">
              <label>
                {label} date
                <input
                  value={row.date}
                  maxLength={40}
                  onChange={(e) => setPrior(index, "date", e.target.value)}
                  placeholder="Date"
                />
              </label>
              <label>
                Action taken
                <input
                  value={row.action}
                  maxLength={2000}
                  onChange={(e) => setPrior(index, "action", e.target.value)}
                  placeholder="What was done"
                />
              </label>
            </div>
          );
        })}
        <label>
          Prior notes
          <textarea rows={2} value={prior} onChange={(e) => onPrior(e.target.value)} />
        </label>
      </div>

      <div className="writeup-form-block">
        <h3>IV. Corrective action to be taken</h3>
        <p className="muted">Mark what you are doing with this write-up. A starting point does not pick this for you.</p>
        <CheckGrid
          options={WRITEUP_CORRECTIVE}
          selected={detail.corrective}
          onToggle={(id, on) => onChange({ ...detail, corrective: toggle(detail.corrective, id, on) })}
        />
        <label>
          Termination date, if termination is marked
          <input
            value={detail.termination_date}
            maxLength={40}
            onChange={(e) => onChange({ ...detail, termination_date: e.target.value })}
            placeholder="Date"
          />
        </label>
      </div>

      <div className="writeup-form-block">
        <h3>V. Expected improvement</h3>
        <label>
          What needs to change
          <textarea rows={4} value={expectations} onChange={(e) => onExpectations(e.target.value)} />
        </label>
        <p className="muted">Consequence if improvement is unsatisfactory or there is another disciplinary action.</p>
        <CheckGrid
          options={WRITEUP_NEXT}
          selected={detail.next_step}
          onToggle={(id, on) => onChange({ ...detail, next_step: toggle(detail.next_step, id, on) })}
        />
        <label>
          Notes on that consequence
          <textarea rows={3} value={consequences} onChange={(e) => onConsequences(e.target.value)} />
        </label>
      </div>

      <div className="writeup-form-block">
        <h3>VI. Employee statement</h3>
        <p className="muted">The employee can write this before signing. Leave it blank if they will write it on the printed copy.</p>
        <label>
          Employee statement
          <textarea
            rows={4}
            maxLength={5000}
            value={detail.employee_statement}
            onChange={(e) => onChange({ ...detail, employee_statement: e.target.value })}
          />
        </label>
        <p className="writeup-ack">{WRITEUP_ACK}</p>
      </div>
    </div>
  );
}

function filled(ids: string[], options: readonly { id: string; label: string }[]): string {
  const labels = labelsFor(ids, options);
  return labels.length ? labels.join(", ") : "-";
}

export function WriteupDetailSummary({
  detail,
  what,
  prior,
  expectations,
  consequences,
}: {
  detail: WriteupDetail;
  what: string;
  prior: string;
  expectations: string;
  consequences: string;
}) {
  if (writeupDetailIsEmpty(detail)) {
    return (
      <>
        <h2>What happened</h2>
        <p className="writeup-body-screen">{what || "-"}</p>
        <h2>Prior warnings</h2>
        <p className="writeup-body-screen">{prior || "-"}</p>
        <h2>Expected correction</h2>
        <p className="writeup-body-screen">{expectations || "-"}</p>
        <h2>Consequences</h2>
        <p className="writeup-body-screen">{consequences || "-"}</p>
      </>
    );
  }

  const priorAnswer = detail.prior_yes === "yes" ? "Yes" : detail.prior_yes === "no" ? "No" : "-";
  return (
    <>
      <h2>I. Disciplinary action</h2>
      <p className="writeup-body-screen">{filled(detail.actions, WRITEUP_ACTIONS)}</p>
      {detail.action_other ? <p className="writeup-body-screen">Other: {detail.action_other}</p> : null}
      <h2>Policy violated</h2>
      <p className="writeup-body-screen">{detail.policy || "-"}</p>
      <h2>II. Details of the occurrence</h2>
      <p className="writeup-body-screen">{what || "-"}</p>
      <h2>III. Has this or a similar infraction occurred before?</h2>
      <p className="writeup-body-screen">{priorAnswer}</p>
      {OCCURRENCE.map((label, index) => {
        const row = priorRow(detail, index);
        if (!row.date && !row.action) return null;
        return (
          <p key={label} className="writeup-body-screen">
            {label}: {row.date || "-"} / {row.action || "-"}
          </p>
        );
      })}
      <h2>Prior notes</h2>
      <p className="writeup-body-screen">{prior || "-"}</p>
      <h2>IV. Corrective action to be taken</h2>
      <p className="writeup-body-screen">{filled(detail.corrective, WRITEUP_CORRECTIVE)}</p>
      {detail.termination_date ? (
        <p className="writeup-body-screen">Termination date: {detail.termination_date}</p>
      ) : null}
      <h2>V. Expected improvement</h2>
      <p className="writeup-body-screen">{expectations || "-"}</p>
      <h2>Consequence if this is not corrected</h2>
      <p className="writeup-body-screen">{filled(detail.next_step, WRITEUP_NEXT)}</p>
      <p className="writeup-body-screen">{consequences || "-"}</p>
      <h2>VI. Employee statement</h2>
      <p className="writeup-body-screen">{detail.employee_statement || "-"}</p>
      <p className="writeup-ack">{WRITEUP_ACK}</p>
    </>
  );
}

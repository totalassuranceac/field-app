/**
 * Run:
 * npx esbuild scripts/test-hr-writeups.ts --bundle --platform=node --format=esm --outfile=tmp-build-permit/test-hr-writeups.mjs
 * node tmp-build-permit/test-hr-writeups.mjs
 */
import {
  WRITEUP_TEXT_CAP,
  canManageWriteups,
  canVoidWriteup,
  validateVoidReason,
  validateWriteupInput,
} from "../worker/hrWriteups";
import { writeupDetailIsEmpty } from "../worker/writeupDetail";
import { WRITEUP_TEMPLATES } from "../src/writeupTemplates";

let fails = 0;
let n = 0;
function check(name: string, ok: boolean, got?: unknown) {
  n++;
  if (ok) console.log("PASS", name);
  else {
    fails++;
    console.log("FAIL", name, got === undefined ? "" : JSON.stringify(got));
  }
}

const good = {
  employee_name: "  Avery Sample  ",
  what_happened: "  Left the gate open.  ",
  supervisor_name: "  Blair  ",
  incident_date: " 2026-10-02 ",
  prior_warnings: "  none ",
  expectations: "  Close it  ",
  consequences: "  Next time is a suspension  ",
  employee_id: 12,
};

check("empty body fails", validateWriteupInput({}).ok === false);
check("missing name fails", validateWriteupInput({ what_happened: "x" }).ok === false);
check(
  "whitespace name fails",
  validateWriteupInput({ employee_name: "   ", what_happened: "x" }).ok === false
);
check("missing what happened fails", validateWriteupInput({ employee_name: "Avery" }).ok === false);
check(
  "whitespace what happened fails",
  validateWriteupInput({ employee_name: "Avery", what_happened: " \n " }).ok === false
);

const trimmed = validateWriteupInput(good);
check("valid draft ok", trimmed.ok === true);
if (trimmed.ok) {
  check("trims employee name", trimmed.value.employee_name === "Avery Sample");
  check("trims what happened", trimmed.value.what_happened === "Left the gate open.");
  check("trims supervisor", trimmed.value.supervisor_name === "Blair");
  check("trims date", trimmed.value.incident_date === "2026-10-02");
  check("trims prior warnings", trimmed.value.prior_warnings === "none");
  check("trims expectations", trimmed.value.expectations === "Close it");
  check("trims consequences", trimmed.value.consequences === "Next time is a suspension");
  check("keeps employee id", trimmed.value.employee_id === 12);
  check("omitted detail is empty", writeupDetailIsEmpty(trimmed.value.form_detail));
  check("omitted detail is the old paper", trimmed.value.form_detail.company_form === false);
}

const blankId = validateWriteupInput({
  employee_name: "Avery",
  what_happened: "Late",
  employee_id: "",
});
check("blank employee id is null", blankId.ok && blankId.value.employee_id === null);

const stringId = validateWriteupInput({
  employee_name: "Avery",
  what_happened: "Late",
  employee_id: "44",
});
check("numeric string employee id", stringId.ok && stringId.value.employee_id === 44);

check(
  "zero employee id fails",
  validateWriteupInput({ employee_name: "Avery", what_happened: "Late", employee_id: 0 }).ok === false
);
check(
  "negative employee id fails",
  validateWriteupInput({ employee_name: "Avery", what_happened: "Late", employee_id: -3 }).ok === false
);
check(
  "junk employee id fails",
  validateWriteupInput({ employee_name: "Avery", what_happened: "Late", employee_id: "abc" }).ok === false
);

const cap = "a".repeat(WRITEUP_TEXT_CAP);
const over = "b".repeat(WRITEUP_TEXT_CAP + 1);
const atCap = validateWriteupInput({ employee_name: cap, what_happened: "ok" });
check("5000 character name is allowed", atCap.ok === true && atCap.ok && atCap.value.employee_name.length === 5000);
const overName = validateWriteupInput({ employee_name: over, what_happened: "ok" });
check(
  "5001 character name is rejected",
  overName.ok === false && overName.ok === false && overName.error.includes("5,000")
);
const padded = validateWriteupInput({
  employee_name: `  ${cap}  `,
  what_happened: "ok",
});
check("cap counts after trim", padded.ok === true);
check(
  "what happened cap",
  validateWriteupInput({ employee_name: "Avery", what_happened: over }).ok === false
);
check(
  "expectations cap",
  validateWriteupInput({ employee_name: "Avery", what_happened: "ok", expectations: over }).ok === false
);
check(
  "expected correction alias is trimmed",
  (() => {
    const row = validateWriteupInput({
      employee_name: "Avery",
      what_happened: "ok",
      expected_correction: "  Be on time  ",
    });
    return row.ok && row.value.expectations === "Be on time";
  })()
);
check(
  "expected correction alias is capped",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "ok",
    expected_correction: over,
  }).ok === false
);

check(
  "blank detail string is empty",
  (() => {
    const row = validateWriteupInput({ employee_name: "Avery", what_happened: "Late", form_detail: "" });
    return row.ok && writeupDetailIsEmpty(row.value.form_detail);
  })()
);
check(
  "null detail is empty",
  (() => {
    const row = validateWriteupInput({ employee_name: "Avery", what_happened: "Late", form_detail: null });
    return row.ok && writeupDetailIsEmpty(row.value.form_detail);
  })()
);
const detailed = validateWriteupInput({
  employee_name: "Avery",
  what_happened: "Did not answer",
  form_detail: {
    actions: ["policy", "policy"],
    action_other: " Standby, did not answer ",
    policy: " Handbook section 4.2 ",
    prior_yes: "yes",
    prior_rows: [{ date: " 2026-09-01 ", action: " Verbal " }],
    corrective: [],
    next_step: ["written"],
    employee_statement: " I was out of range. ",
    termination_date: "",
  },
});
check("detailed form saves", detailed.ok === true);
if (detailed.ok) {
  check("duplicate action is kept once", detailed.value.form_detail.actions.join(",") === "policy");
  check("other line trims", detailed.value.form_detail.action_other === "Standby, did not answer");
  check("policy trims", detailed.value.form_detail.policy === "Handbook section 4.2");
  check("prior yes sticks", detailed.value.form_detail.prior_yes === "yes");
  check("first prior row trims", detailed.value.form_detail.prior_rows[0].date === "2026-09-01");
  check("first prior action trims", detailed.value.form_detail.prior_rows[0].action === "Verbal");
  check("later prior rows stay blank", detailed.value.form_detail.prior_rows[1].date === "");
  check("three prior rows", detailed.value.form_detail.prior_rows.length === 3);
  check("next step sticks", detailed.value.form_detail.next_step.join(",") === "written");
  check("statement trims", detailed.value.form_detail.employee_statement === "I was out of range.");
}
check(
  "unknown action is rejected",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "Late",
    form_detail: { actions: ["fired"] },
  }).ok === false
);
check(
  "action sent as text is rejected",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "Late",
    form_detail: { actions: "policy" },
  }).ok === false
);
check(
  "junk prior answer is rejected",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "Late",
    form_detail: { prior_yes: "maybe" },
  }).ok === false
);
check(
  "a fourth prior row is rejected",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "Late",
    form_detail: { prior_rows: [{}, {}, {}, {}] },
  }).ok === false
);
check(
  "company form flag alone uses the long paper",
  (() => {
    const row = validateWriteupInput({
      employee_name: "Avery",
      what_happened: "Late",
      form_detail: { company_form: true },
    });
    return row.ok && row.value.form_detail.company_form === true && writeupDetailIsEmpty(row.value.form_detail) === false;
  })()
);
check(
  "junk company form flag is rejected",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "Late",
    form_detail: { company_form: "yes" },
  }).ok === false
);
check(
  "other line over the cap is rejected",
  validateWriteupInput({
    employee_name: "Avery",
    what_happened: "Late",
    form_detail: { action_other: "x".repeat(201) },
  }).ok === false
);

check("void reason required", validateVoidReason({}).ok === false);
check("whitespace void reason fails", validateVoidReason({ reason: "  " }).ok === false);
const voidOk = validateVoidReason({ reason: "  Filed in error  " });
check("void reason trims", voidOk.ok && voidOk.reason === "Filed in error");
check("void reason alias", validateVoidReason({ void_reason: " Duplicate " }).ok === true);
check("void reason cap", validateVoidReason({ reason: over }).ok === false);
check(
  "void reason at cap",
  validateVoidReason({ reason: cap }).ok === true
);

for (const role of ["admin", "office", "supervisor"]) {
  check(`${role} can save and view`, canManageWriteups(role) === true);
}
for (const role of ["driver", "mechanic", "viewer", "warehouse"]) {
  check(`${role} cannot see write-ups`, canManageWriteups(role) === false);
}
for (const role of ["admin", "office"]) {
  check(`${role} can void`, canVoidWriteup(role) === true);
}
for (const role of ["supervisor", "driver", "mechanic", "viewer", "warehouse"]) {
  check(`${role} cannot void`, canVoidWriteup(role) === false);
}

check("seven starters", WRITEUP_TEMPLATES.length === 7);
const ids = WRITEUP_TEMPLATES.map((template) => template.id);
check("starter ids are unique", new Set(ids).size === ids.length);
const standby = WRITEUP_TEMPLATES.find((template) => template.id === "standby");
check("standby starter exists", Boolean(standby));
if (standby) {
  check("standby is a policy miss", standby.detail.actions.join(",") === "policy");
  check("standby names the situation", standby.detail.action_other === "Standby, did not answer");
  check(
    "standby does not pick a penalty",
    standby.detail.corrective.length === 0 && standby.detail.next_step.length === 0
  );
  check(
    "standby says the schedule was disrupted",
    standby.what.includes("disrupted the work schedule") && standby.consequences.includes("disrupts the schedule")
  );
  check(
    "standby stays universal",
    !standby.what.includes("[") && !standby.what.includes("Number called")
  );
  check(
    "standby quotes the handbook",
    standby.detail.policy.includes("Regular and punctual attendance is essential") &&
      standby.detail.policy.includes("does not disrupt operations or customer service")
  );
}
for (const template of WRITEUP_TEMPLATES) {
  check(
    `${template.id} leaves the penalty blank`,
    template.detail.corrective.length === 0 && template.detail.next_step.length === 0
  );
  check(`${template.id} uses the company form`, template.detail.company_form === true);
  check(`${template.id} cites the handbook`, template.detail.policy.includes("Handbook section"));
  if (template.id !== "standby") {
    check(`${template.id} is more than one line`, template.what.includes("\n"));
  }
}

console.log(fails ? `FAIL ${fails}/${n}` : `OK ${n}/${n}`);
if (fails) process.exit(1);

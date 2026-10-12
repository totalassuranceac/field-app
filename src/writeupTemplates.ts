import { emptyWriteupDetail, type WriteupDetail } from "../worker/writeupDetail";

export type WriteupTemplate = {
  id: string;
  label: string;
  what: string;
  prior: string;
  expectations: string;
  consequences: string;
  detail: WriteupDetail;
};

const PRIOR =
  "If this or something like it happened before, mark Yes and list the date and what was done.";

const NEXT_STEP =
  "Another occurrence can move to the next step, including time off without pay or separation.";

function starter(actions: string[], policy: string, actionOther = ""): WriteupDetail {
  return {
    ...emptyWriteupDetail(),
    actions,
    action_other: actionOther,
    policy,
    company_form: true,
  };
}

/** Starting text only. Every box stays editable after a template is placed. */
export const WRITEUP_TEMPLATES: WriteupTemplate[] = [
  {
    id: "late",
    label: "Late or no-call",
    detail: starter(
      ["tardiness"],
      "Handbook section 4.2 (Attendance). Call the manager by 7:00 a.m. on the day of any absence or tardiness and give the reason. More than three unexcused absences in 90 days is excessive."
    ),
    what: [
      "Scheduled start: [time]. Arrived: [time], or did not come in.",
      "Called ahead: [yes or no]. Who was called, and when: [name and time]. Who was waiting: [customer, crew, or office].",
      "Job or route: [job, customer, or address]. How the day was covered: [who went, or the job was moved].",
    ].join("\n"),
    prior: PRIOR,
    expectations:
      "Be on time. If you will be late or out, call your manager by 7:00 a.m., say why, and say when you will be there.",
    consequences: `Another late start, no-show, or no-call can move to the next step.\n${NEXT_STEP}`,
  },
  {
    id: "callback",
    label: "Callback on own work",
    detail: starter(
      ["performance"],
      "Handbook section 4.3 (Discipline and Standards of Conduct). The job is expected to be finished correctly before the employee leaves."
    ),
    what: [
      "Original job: [date]. Customer: [name]. Address: [address].",
      "What was left unfinished or done wrong: [description].",
      "Return visit: [date]. Who went back: [name]. What the return visit fixed: [description].",
    ].join("\n"),
    prior: PRIOR,
    expectations:
      "Check the work before you leave. If a step is unfinished, tell the office before you leave.",
    consequences: `Another return visit for the same kind of work can move to the next step.\n${NEXT_STEP}`,
  },
  {
    id: "safety",
    label: "Safety",
    detail: starter(
      ["safety"],
      "Handbook section 4.5 (Safety). Follow company safety rules, use the required protective equipment, and report a hazard or injury the same day."
    ),
    what: [
      "Job: [job or customer]. Address: [address]. Who saw it: [name].",
      "Safety step that was skipped: [step]. What could have happened: [risk].",
      "Was anyone hurt: [yes or no]. If yes, what happened: [description].",
    ].join("\n"),
    prior: PRIOR,
    expectations:
      "Follow that safety step every time. Stop and ask if the setup is not safe. Report an injury the same day.",
    consequences:
      "A repeat, or a miss that puts someone in danger, can mean the employee is sent home or separated.",
  },
  {
    id: "truck",
    label: "Truck or tools",
    detail: starter(
      ["policy"],
      "Handbook section 4.10 (Company Vehicles). Lock an unattended vehicle, report damage the same day, and put company tools back."
    ),
    what: [
      "Unit: [truck or van]. What was unsecured, missing, or damaged: [description].",
      "Where it was: [shop, job, or street]. When it was found: [date and time]. Who found it: [name].",
      "When it was reported: [date and time], or it was not reported.",
    ].join("\n"),
    prior: PRIOR,
    expectations:
      "Lock the truck when you leave it. Put tools back. Report damage or a missing tool the same day.",
    consequences: `Damage that is not reported the same day is its own miss.\n${NEXT_STEP}`,
  },
  {
    id: "customer",
    label: "Customer complaint",
    detail: starter(
      ["performance"],
      "Handbook section 4.3 (Discipline and Standards of Conduct). Employees are expected to treat customers with respect."
    ),
    what: [
      "Customer: [name]. Job: [job number]. Address: [address].",
      "What the customer said happened: [description].",
      "Who reported it: [name]. When we heard about it: [date].",
    ].join("\n"),
    prior: PRIOR,
    expectations:
      "Stay professional with the customer. If the visit is going badly, call the office before it becomes a complaint.",
    consequences: `Another complaint can move to the next step.\n${NEXT_STEP}`,
  },
  {
    id: "clock",
    label: "Clock time",
    detail: starter(
      ["policy"],
      "Handbook section 3.4 (Time Cards). Record the real start, end, and meal break. Writing hours that were not worked is grounds for immediate separation."
    ),
    what: [
      "Date: [date]. Clocked in: [time], or did not clock in. Clocked out: [time], or did not clock out.",
      "Jobs that day: [job numbers or customers].",
      "How the clock time did not match the work: [description].",
    ].join("\n"),
    prior: PRIOR,
    expectations:
      "Clock in at the start and clock out at the end. Keep the time matched to the jobs you worked.",
    consequences:
      "Pay can be corrected to the hours worked. Writing hours that were not worked can mean separation.",
  },
  {
    id: "standby",
    label: "Standby, no answer",
    detail: starter(
      ["policy"],
      [
        '"Regular and punctual attendance is essential to our operations and customer service."',
        "Handbook section 4.2 and 4.9: does not disrupt operations or customer service. A first offense is a warning.",
      ].join("\n"),
      "Standby, did not answer"
    ),
    what: [
      "The employee was on standby and was expected to answer when the office called.",
      "The employee did not answer. Work was left waiting, and the schedule had to be rearranged.",
      "Not answering disrupted the work schedule and our service to the customer.",
    ].join("\n"),
    prior: "",
    expectations: [
      "While on standby, keep your phone on and answer when the office calls.",
      "If you cannot take the assignment, say so on that call so the work can be covered.",
    ].join("\n"),
    consequences:
      "Not answering while on standby disrupts the schedule. Another miss can move to the next step.",
  },
];

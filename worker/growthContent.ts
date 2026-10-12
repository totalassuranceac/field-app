/**
 * Tool checklist and NATE practice content.
 * Questions are original shop practice. They are not NATE's exam.
 * The worker grades these. Do not import this file from the client bundle.
 */

export type TrackId = "helper" | "install_helper" | "service" | "install";

export type ExamKey =
  | "core"
  | "gas-heat"
  | "air-conditioning"
  | "heat-pump"
  | "air-distribution";

export type ToolItem = {
  id: string;
  name: string;
  group: string;
  tracks: TrackId[];
  /** What the tech uses it for on a real call. */
  use: string;
  /** How the day gets easier once they own it. */
  easier: string;
  tip?: string;
  loanName?: string;
  loanReason?: string;
  /** Asked when they already own one. A yes takes it off the list. A no keeps the upgrade. */
  upgrade?: { ask: string; better: string };
};

export type NateQuestion = {
  id: string;
  exam: ExamKey;
  topic: string;
  prompt: string;
  choices: [string, string, string, string];
  answer: 0 | 1 | 2 | 3;
  why: string;
};

export const TRACKS: { id: TrackId; label: string; note: string }[] = [
  {
    id: "helper",
    label: "Helper",
    note: "Your first goal is a meter of your own. Hand tools come with the work. Gauges wait until you can explain the reading.",
  },
  {
    id: "install_helper",
    label: "Install helper",
    note: "Four goals: a drill, snips, a long level, and a torch. The manifold and the analyzer stay with the lead until you run the startup.",
  },
  {
    id: "service",
    label: "Service tech",
    note: "Each goal changes a call you already run. Check off what you own. The open one is the tool to get next.",
  },
  {
    id: "install",
    label: "Install lead",
    note: "You own the vacuum, the startup numbers, and the combustion check. These goals are the tools that make that yours.",
  },
];

export const BUY_NEXT: Record<TrackId, string[]> = {
  helper: ["meter"],
  install_helper: ["drill", "snips", "level-long", "torch"],
  service: [
    "co-monitor",
    "meter",
    "vacuum-rig",
    "sman-4",
    "manometer",
    "analyzer",
    "leak-detector",
    "vacuum-pump",
    "scale",
    "flare-torque",
  ],
  install: [
    "vacuum-rig",
    "sman-4",
    "nitrogen-reg",
    "torch",
    "manometer",
    "analyzer",
    "vacuum-pump",
    "scale",
    "flare-torque",
    "benders",
  ],
};

const VACUUM_TIP =
  "A 3-port SMAN on 1/4 inch hoses can take an hour and a half because the vapor is squeezed through small hoses, small passages, and the Schrader cores. Cores pulled, a short 1/2 inch hose, and the micron gauge on the system can put a tight dry system near 500 microns in a few minutes. It has to hold after you valve off at the equipment. If the number stalls high, the system is wet or it has a leak. Blank the pump off first.";

const SMAN_TIP =
  "A 4-port SMAN gives that large hose its own vacuum port. A new 4-port still hooked up with the yellow 1/4 inch hose will stay slow. Keep the core tools and the micron gauge.";

export const TOOL_ITEMS: ToolItem[] = [
  {
    id: "glasses",
    name: "Safety glasses",
    group: "Safety",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Wear them any time metal, refrigerant, or dust can hit your face.",
    easier: "You finish the call with both eyes. One slip with a drill or a line does not end the day.",
  },
  {
    id: "gloves",
    name: "Work gloves",
    group: "Safety",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Grip hot copper, sharp sheet metal, and dirty equipment.",
    easier: "Your hands stay on the tools instead of stopping for a cut.",
  },
  {
    id: "knee-pads",
    name: "Knee pads",
    group: "Safety",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Kneel at a furnace, an air handler, or a crawlspace.",
    easier: "You stay with the repair instead of standing up every minute because your knees hurt.",
  },
  {
    id: "headlamp",
    name: "Headlamp",
    group: "Safety",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Light the cabinet, the attic, and the closet while both hands stay on the work.",
    easier: "You see the wire and the screw the first time, without a flashlight in your teeth.",
  },
  {
    id: "co-monitor",
    name: "Personal CO monitor",
    group: "Safety",
    tracks: ["service", "install"],
    use: "Wear it on every heat call so you know if carbon monoxide is in the air around you.",
    easier: "You can stay and finish the furnace call knowing the room is safe. CO has no smell.",
    loanName: "Personal CO monitor",
    loanReason:
      "Personal CO monitor to wear on heat calls. Carbon monoxide has no odor, so the monitor has to be on the person doing the work.",
  },
  {
    id: "shoe-covers",
    name: "Shoe covers and a drop cloth",
    group: "Safety",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Cover your boots and lay a cloth before you walk a finished floor.",
    easier: "The customer stays glad you were there, and you are not cleaning the house at the end of the call.",
  },
  {
    id: "meter",
    name: "True-RMS clamp meter with DC microamps",
    group: "Electrical",
    tracks: ["helper", "service", "install"],
    use: "Prove a circuit is dead, read amps, and read flame-sensor microamps.",
    easier: "You stop borrowing a meter, and you stop guessing why a furnace will not stay lit.",
    tip: "A non-contact tester is only a second check. It is not the proof the power is off.",
    upgrade: {
      ask: "Does your meter read DC microamps for a flame sensor?",
      better: "A true-RMS meter that reads DC microamps",
    },
    loanName: "True-RMS clamp meter with DC microamps",
    loanReason:
      "True-RMS clamp meter that reads amps and DC microamps for flame-sensor checks, and proves a circuit is dead before it is touched.",
  },
  {
    id: "drivers",
    name: "Insulated screwdrivers, nut drivers (1/4, 5/16, 3/8), and an 11-in-1",
    group: "Electrical",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Open panels and pull the screw sizes this equipment actually uses.",
    easier: "The right driver is in your pouch, so a five-minute panel does not turn into a hunt.",
  },
  {
    id: "strippers",
    name: "Wire strippers and a crimper",
    group: "Electrical",
    tracks: ["service", "install"],
    use: "Strip and crimp control wire and line-voltage leads.",
    easier: "Connections are clean. You are not nicking copper with side cutters and building a callback.",
  },
  {
    id: "vacuum-rig",
    name: "Core-removal tools, a short 1/2 inch vacuum hose, and a micron gauge",
    group: "Evacuation",
    tracks: ["service", "install"],
    use: "Pull the Schrader cores, hook a short 1/2 inch hose, and read microns at the system.",
    easier: "A tight dry system can be near 500 microns in a few minutes instead of an hour and a half on skinny hoses.",
    tip: VACUUM_TIP,
    upgrade: {
      ask: "Do you have core-removal tools, a short 1/2 inch hose, and a micron gauge on the system?",
      better: "Core tools, a short 1/2 inch hose, and a micron gauge",
    },
    loanName: "Vacuum rig: core tools, 1/2 inch hose, micron gauge",
    loanReason: VACUUM_TIP,
  },
  {
    id: "sman-4",
    name: "4-port manifold with a separate vacuum port",
    group: "Evacuation",
    tracks: ["service", "install"],
    use: "Give the vacuum its own large port so the pump is not choked by the charging hose.",
    easier: "Evacuation stays fast. A new 4-port still hooked to the old yellow 1/4 inch hose will stay slow.",
    tip: SMAN_TIP,
    upgrade: {
      ask: "Is it a 4-port with its own vacuum port, not a 3-port on the yellow 1/4 inch hose?",
      better: "A 4-port manifold with its own vacuum port",
    },
    loanName: "4-port SMAN with vacuum port",
    loanReason: SMAN_TIP,
  },
  {
    id: "vacuum-pump",
    name: "Vacuum pump, about 6 CFM",
    group: "Evacuation",
    tracks: ["service", "install"],
    use: "Pull the system down, then blank the pump off to prove the pump itself can go very low.",
    easier: "You know a high micron reading is the system, not a tired pump, before you chase a leak that is not there.",
    upgrade: {
      ask: "Is it about a 6 CFM pump that can pass a blank-off test?",
      better: "A 6 CFM vacuum pump",
    },
    loanName: "6 CFM vacuum pump",
    loanReason:
      "Vacuum pump in the 6 CFM class. Blank-off test first so a tired pump is not mistaken for a wet system.",
  },
  {
    id: "nitrogen-reg",
    name: "Nitrogen regulator",
    group: "Evacuation",
    tracks: ["service", "install"],
    use: "Pressure-test a system and flow nitrogen through the lines while you braze.",
    easier: "Joints stay clean inside, and a leak shows up on nitrogen before you weigh in refrigerant.",
    tip: "Oxygen is never the purge gas and never the test gas.",
    loanName: "Nitrogen regulator",
    loanReason:
      "Nitrogen regulator for pressure tests and for flowing nitrogen while brazing. Oxygen is never used to purge or to pressure-test.",
  },
  {
    id: "scale",
    name: "Refrigerant scale",
    group: "Refrigeration",
    tracks: ["service", "install"],
    use: "Weigh refrigerant in and out against the charging chart.",
    easier: "You leave knowing the charge is right. Adding by feel or by the clock is a guess you do not have to make.",
    loanName: "Refrigerant scale",
    loanReason: "Refrigerant scale so the charge is weighed against the charging chart instead of added by feel.",
  },
  {
    id: "temp-clamps",
    name: "Temperature clamps for the lines",
    group: "Refrigeration",
    tracks: ["service", "install"],
    use: "Read liquid and suction line temperature next to the pressures.",
    easier: "Superheat and subcooling become numbers you can trust, so you charge the right way the first time.",
  },
  {
    id: "leak-detector",
    name: "Leak detector",
    group: "Refrigeration",
    tracks: ["service", "install"],
    use: "Search for refrigerant, then confirm the exact spot with bubbles.",
    easier: "You fix the leak today instead of adding refrigerant and coming back next month.",
    tip: "Heated diode or infrared. Bubbles still confirm the spot before refrigerant is added.",
    upgrade: {
      ask: "Is it a heated-diode or infrared detector, not bubbles alone?",
      better: "A heated-diode or infrared leak detector",
    },
    loanName: "Refrigerant leak detector",
    loanReason:
      "Heated-diode or infrared leak detector. Soap bubbles still confirm the hit before refrigerant is added.",
  },
  {
    id: "flare-torque",
    name: "Tubing cutter, deburr tool, flare tool, and a flare-nut torque wrench",
    group: "Refrigeration",
    tracks: ["service", "install"],
    use: "Cut, deburr, flare, and tighten a flare nut to the torque it needs.",
    easier: "R-410A flares stay sealed. Too loose leaks. Too tight cracks the flare. The wrench takes the guess out.",
    loanName: "Flare-nut torque wrench and flare set",
    loanReason:
      "Flare tools and a flare-nut torque wrench. R-410A flares leak when the nut is too loose or crushed.",
  },
  {
    id: "service-wrench",
    name: "Refrigeration service wrench and Knipex-style pliers",
    group: "Refrigeration",
    tracks: ["service", "install"],
    use: "Open service valves and grip tubing without crushing it.",
    easier: "Valve work is quick and the copper stays round.",
  },
  {
    id: "manometer",
    name: "Dual-port manometer",
    group: "Air and gas",
    tracks: ["service", "install"],
    use: "Measure static pressure in the ducts and gas pressure at the valve.",
    easier: "A weak duct or a wrong gas pressure shows up before you change a part that was fine.",
    loanName: "Dual-port manometer",
    loanReason:
      "Dual-port manometer for static pressure and gas pressure, so airflow and gas problems are measured before parts are changed.",
  },
  {
    id: "analyzer",
    name: "Combustion analyzer",
    group: "Air and gas",
    tracks: ["service", "install"],
    use: "Read oxygen, CO, and draft on every gas start and every heat diagnosis.",
    easier: "You sign a furnace off with numbers. You are not hoping the flame looks okay.",
    loanName: "Combustion analyzer",
    loanReason:
      "Combustion analyzer for gas startups and heat calls. Gas pressure, oxygen, and CO are how a furnace is signed off.",
  },
  {
    id: "fin-comb",
    name: "Fin comb, inspection mirror, and a flashlight",
    group: "Air and gas",
    tracks: ["service", "install"],
    use: "Straighten fins and see the far side of a coil.",
    easier: "Airflow comes back on a matted coil without replacing a coil that was still good.",
  },
  {
    id: "drill",
    name: "Drill and impact on the shop battery",
    group: "Hand tools",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Drill and drive on the same battery the rest of the crew uses.",
    easier: "You are not waiting on someone else's drill to pull a panel or set a bracket.",
    loanName: "Drill and impact",
    loanReason: "Drill and impact on the shop battery so the work is not borrowed from someone else every day.",
  },
  {
    id: "tape-level",
    name: "Tape measure and a torpedo level",
    group: "Hand tools",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Measure the space and check that a unit or a line sits level.",
    easier: "Equipment goes in once, in the right spot, and the drain slopes the way it should.",
  },
  {
    id: "snips",
    name: "Aviation snips, left, right, and straight",
    group: "Hand tools",
    tracks: ["helper", "install_helper", "service", "install"],
    use: "Cut sheet metal to the left, to the right, and straight.",
    easier: "Duct turns the way the job needs. One pair of snips fights you all day.",
    loanName: "Aviation snips",
    loanReason: "Left, right, and straight aviation snips for duct work.",
  },
  {
    id: "level-long",
    name: "4-foot level and a square",
    group: "Install",
    tracks: ["install_helper", "install"],
    use: "Set furnaces, coils, and long duct runs level and square.",
    easier: "Doors close, drains slope, and the install looks straight when the customer walks up.",
    loanName: "4-foot level",
    loanReason: "4-foot level and a square for setting equipment and duct.",
  },
  {
    id: "torch",
    name: "Torch, striker, and heat shields",
    group: "Install",
    tracks: ["install_helper", "install"],
    use: "Braze a line set with shields in place and nitrogen flowing through the pipe.",
    easier: "The joint is strong and the inside of the line stays clean, so the new system does not start full of scale.",
    tip: "The extinguisher stays on the truck.",
    loanName: "Torch kit",
    loanReason:
      "Torch kit for brazing line sets. Nitrogen flows while brazing so the inside of the pipe stays clean.",
  },
  {
    id: "benders",
    name: "Tubing benders for 3/8, 3/4, and 7/8",
    group: "Install",
    tracks: ["install"],
    use: "Bend 3/8, 3/4, and 7/8 tubing through the path the line set has to take.",
    easier: "The line set flows. A kink is a restriction you cannot see from the truck, and you do not make one.",
    loanName: "Tubing benders",
    loanReason: "Tubing benders for 3/8, 3/4, and 7/8 so line sets are bent instead of kinked.",
  },
  {
    id: "holesaw",
    name: "Hole saws and a right-angle drill",
    group: "Install",
    tracks: ["install"],
    use: "Cut round openings and get the drill into a tight joist bay.",
    easier: "Line-set holes are clean, and you are not wedged in a closet fighting a straight drill.",
  },
  {
    id: "sheetmetal",
    name: "Hand seamer, crimper, caulk gun, and a line-set knife",
    group: "Install",
    tracks: ["install"],
    use: "Seam, crimp, and seal duct, and strip line-set insulation.",
    easier: "Connections seal and the line set looks finished instead of taped together.",
  },
  {
    id: "pvc",
    name: "PVC cutter and the vent cement the furnace manual calls for",
    group: "Install",
    tracks: ["install"],
    use: "Cut vent pipe and cement it with the product that furnace manual names.",
    easier: "The vent matches that furnace. An 80% and a 90% do not vent the same way, and you are not guessing at the supply house.",
  },
];

export const GROUP_ORDER = [
  "Safety",
  "Electrical",
  "Evacuation",
  "Refrigeration",
  "Air and gas",
  "Hand tools",
  "Install",
];

export function suggestedTrack(title: string | null | undefined): TrackId | null {
  const t = String(title || "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  if (t.includes("install helper")) return "install_helper";
  if (t.includes("apprentice")) return "helper";
  if (t.includes("install")) return "install";
  if (t.includes("service") || t.includes("maintenance") || t.includes("field supervisor")) {
    return "service";
  }
  return null;
}

export function isTrackId(value: string): value is TrackId {
  return TRACKS.some((t) => t.id === value);
}

export function itemsForTrack(track: TrackId): ToolItem[] {
  return TOOL_ITEMS.filter((item) => item.tracks.includes(track));
}

const WORK_TOOL_RULES: { test: RegExp; tools: string[]; because: string }[] = [
  {
    test: /no cool|not cooling|air condition|refrigerant|leak search|evaporator|condenser/i,
    tools: ["vacuum-rig", "leak-detector", "scale", "sman-4", "meter"],
    because: "Cooling and refrigerant work comes up on your jobs.",
  },
  {
    test: /furnace|gas heat|combustion|heat exchanger|carbon monoxide/i,
    tools: ["co-monitor", "analyzer", "manometer", "meter"],
    because: "Gas heat work comes up on your jobs.",
  },
  {
    test: /changeout|change-out|change out|system install|condenser install|air handler install|startup|start-up|\binstall/i,
    tools: ["vacuum-rig", "nitrogen-reg", "sman-4", "torch", "flare-torque"],
    because: "Install work comes up on your jobs.",
  },
  {
    test: /maintenance|tune-up|tune up|precision tune|inspection/i,
    tools: ["meter", "co-monitor", "manometer"],
    because: "Maintenance work comes up on your jobs.",
  },
  {
    test: /electrical|no power|breaker|control board|flame sensor/i,
    tools: ["meter"],
    because: "Electrical checks come up on your jobs.",
  },
  {
    test: /static pressure|airflow|duct/i,
    tools: ["manometer"],
    because: "Airflow work comes up on your jobs.",
  },
  {
    test: /braze|brazing|solder|line set/i,
    tools: ["torch", "nitrogen-reg", "flare-torque"],
    because: "Brazing work comes up on your jobs.",
  },
];

/** First open tool that matches recent work or the role path. */
export function recommendFirstTool(opts: {
  track: TrackId | null;
  openIds: string[];
  signals: string[];
}): { id: string; because: string } | null {
  const open = new Set(opts.openIds);
  const onTrack = new Set(opts.track ? itemsForTrack(opts.track).map((item) => item.id) : []);
  for (const signal of opts.signals) {
    const text = String(signal || "").trim();
    if (!text) continue;
    for (const rule of WORK_TOOL_RULES) {
      if (!rule.test.test(text)) continue;
      const hit = rule.tools.find((id) => open.has(id) && onTrack.has(id));
      if (hit) return { id: hit, because: rule.because };
    }
  }
  if (!opts.track) return null;
  const path = BUY_NEXT[opts.track].find((id) => open.has(id) && onTrack.has(id));
  if (!path) return null;
  return { id: path, because: "This is the next tool on your role path." };
}

export type ExamMeta = {
  key: ExamKey;
  label: string;
  blurb: string;
  tracks: TrackId[];
};

export const EXAMS: ExamMeta[] = [
  {
    key: "core",
    label: "NATE Core",
    blurb:
      "Safety, tools, electrical basics, heat, and working in the customer's house. Core comes first. The real Core exam is 50 questions. This practice is shorter.",
    tracks: ["helper", "install_helper", "service", "install"],
  },
  {
    key: "gas-heat",
    label: "Gas Heat",
    blurb: "Sequence, combustion, airflow, and the safeties you do not leave jumped.",
    tracks: ["service", "install"],
  },
  {
    key: "air-conditioning",
    label: "Air Conditioning",
    blurb: "The refrigerant cycle, charging by the right method, airflow, and the electrical checks.",
    tracks: ["service", "install"],
  },
  {
    key: "heat-pump",
    label: "Heat Pump",
    blurb: "Reversing valve, defrost, auxiliary heat, and charging in the mode the chart uses.",
    tracks: ["service"],
  },
  {
    key: "air-distribution",
    label: "Air Distribution",
    blurb: "Static pressure, cfm, ducts, and the blower setup on a startup.",
    tracks: ["install"],
  },
];

export const TOPICS: Record<ExamKey, { key: string; label: string }[]> = {
  core: [
    { key: "safety", label: "Safety" },
    { key: "tools", label: "Tools and measurements" },
    { key: "electrical", label: "Electrical basics" },
    { key: "heat", label: "Heat and airflow" },
    { key: "customer", label: "With the customer" },
  ],
  "gas-heat": [
    { key: "sequence", label: "Sequence" },
    { key: "combustion", label: "Combustion" },
    { key: "airflow-heat", label: "Heat airflow" },
    { key: "safeties", label: "Safeties" },
  ],
  "air-conditioning": [
    { key: "cycle", label: "Refrigerant cycle" },
    { key: "charge", label: "Charge" },
    { key: "airflow-ac", label: "Cooling airflow" },
    { key: "electrical-ac", label: "Cooling electrical" },
  ],
  "heat-pump": [
    { key: "reversing", label: "Reversing valve" },
    { key: "defrost", label: "Defrost" },
    { key: "aux", label: "Auxiliary heat" },
    { key: "charge-hp", label: "Heat pump charge" },
  ],
  "air-distribution": [
    { key: "static", label: "Static pressure" },
    { key: "cfm", label: "CFM" },
    { key: "ducts", label: "Ducts" },
    { key: "blower", label: "Blower" },
  ],
};

function nq(
  id: string,
  exam: ExamKey,
  topic: string,
  prompt: string,
  choices: [string, string, string, string],
  answer: 0 | 1 | 2 | 3,
  why: string
): NateQuestion {
  return { id, exam, topic, prompt, choices, answer, why };
}

export const QUESTIONS: NateQuestion[] = [
  nq(
    "core-safety-1",
    "core",
    "safety",
    "Before you touch conductors in a panel, what proves the power is off?",
    [
      "A non-contact tester that chirped once earlier",
      "A meter reading zero volts on the conductors you will touch",
      "The breaker handle pointing to off",
      "The thermostat set to off",
    ],
    1,
    "A breaker handle and a non-contact tester can both be wrong. Measure the conductors."
  ),
  nq(
    "core-safety-2",
    "core",
    "safety",
    "You jumped a safety switch to see if it was why the furnace would not run. Before you leave you:",
    [
      "Leave the jumper so the customer has heat tonight",
      "Remove the jumper and fix the real cause",
      "Tape the jumper so it cannot fall off",
      "Tell them the jumper is temporary and leave it",
    ],
    1,
    "A safety left jumped can leave a furnace running with no limit, no draft proof, or no flame proof."
  ),
  nq(
    "core-safety-3",
    "core",
    "safety",
    "Liquid refrigerant on skin is dangerous because it:",
    [
      "Is always a strong acid",
      "Boils off and freezes the skin",
      "Is as hot as steam",
      "Only stains clothing",
    ],
    1,
    "Liquid refrigerant flashes to vapor and pulls heat out of skin fast."
  ),
  nq(
    "core-safety-4",
    "core",
    "safety",
    "Which gas is used to pressure-test a line set and to purge while brazing?",
    ["Oxygen", "Shop air from a tire", "Nitrogen", "Acetylene with no torch tip"],
    2,
    "Oxygen plus oil in a system can explode. Nitrogen is the inert gas for the test and the purge."
  ),
  nq(
    "core-safety-5",
    "core",
    "safety",
    "A personal CO monitor belongs:",
    [
      "In the glove box",
      "On you during a heat call",
      "Only on the shop wall",
      "In the customer's hand while they watch",
    ],
    1,
    "Carbon monoxide has no odor. The monitor has to be in the air you are breathing."
  ),
  nq(
    "core-safety-6",
    "core",
    "safety",
    "Three points of contact on a ladder means:",
    [
      "Two hands and one foot, or two feet and one hand, while you climb",
      "Three rungs between your feet",
      "The ladder touches the building in three places",
      "Three people hold the base",
    ],
    0,
    "You keep three points on the ladder while you move."
  ),
  nq(
    "core-tools-1",
    "core",
    "tools",
    "Where should the micron gauge sit while you pull a vacuum?",
    [
      "At the pump only",
      "On the system, at the equipment",
      "In the truck, checked once a year",
      "Only on the middle of the yellow hose, far from both ends",
    ],
    1,
    "A gauge at the pump can look deep while the system is still full of vapor. Read it on the system side."
  ),
  nq(
    "core-tools-2",
    "core",
    "tools",
    "A 3-port manifold on 1/4 inch hoses is slow to pull a vacuum mostly because:",
    [
      "Digital gauges cannot read vacuum",
      "The vapor has to squeeze through small hoses, small passages, and the Schrader cores",
      "R-410A will not boil",
      "The pump oil brand is always the cause",
    ],
    1,
    "Cores out, a short large hose, and a real vacuum port are what speed it up. About 500 microns still has to hold."
  ),
  nq(
    "core-tools-3",
    "core",
    "tools",
    "A blank-off test on the vacuum pump is used to:",
    [
      "Charge the system by weight",
      "See that the pump itself can pull a deep vacuum before you blame the equipment",
      "Set gas pressure",
      "Prove the air filter is clean",
    ],
    1,
    "If the pump will not fall very low with the hose valved off, the system reading does not mean much."
  ),
  nq(
    "core-tools-4",
    "core",
    "tools",
    "Refrigerant on a repair should be added:",
    [
      "Until the suction line sweats",
      "By weight, against the manufacturer amount or the charging chart",
      "For ten seconds per ton",
      "Until the needles match last year's sticker",
    ],
    1,
    "Feel and time are guesses. The scale and the chart are the measurement."
  ),
  nq(
    "core-tools-5",
    "core",
    "tools",
    "A true-RMS meter is the one to carry because:",
    [
      "It only reads DC volts",
      "Controls and inverters are not always a clean sine wave",
      "It replaces a manometer",
      "It reads microns",
    ],
    1,
    "An average-responding meter can lie on variable-speed equipment."
  ),
  nq(
    "core-tools-6",
    "core",
    "tools",
    "Gas pressure and static pressure in a house are measured in:",
    [
      "Psi on the refrigerant gauges",
      "Inches of water column with a manometer",
      "Volts",
      "Degrees F",
    ],
    1,
    "Those pressures are small. A manometer reads them. Refrigerant gauges do not."
  ),
  nq(
    "core-elec-1",
    "core",
    "electrical",
    "Ohm's law says:",
    [
      "Volts = amps times ohms",
      "Amps = volts times ohms",
      "Ohms = volts times amps",
      "Watts = volts divided by amps",
    ],
    0,
    "Raise the resistance at the same voltage and the current falls."
  ),
  nq(
    "core-elec-2",
    "core",
    "electrical",
    "In a series circuit:",
    [
      "Voltage is the same across every load and the currents add",
      "Current is the same through every load and the voltages add",
      "Every switch is automatically in parallel",
      "Resistance stays at zero",
    ],
    1,
    "There is one path. Current is the same. Voltages split across the loads."
  ),
  nq(
    "core-elec-3",
    "core",
    "electrical",
    "In a parallel circuit:",
    [
      "Current is identical in every branch and voltage splits",
      "Each branch sees the same source voltage",
      "Opening one branch opens all of them",
      "Total resistance rises every time you add a branch",
    ],
    1,
    "Each branch sees the source voltage. Another branch gives current another path, so total resistance falls."
  ),
  nq(
    "core-elec-4",
    "core",
    "electrical",
    "A flame sensor on a hot-surface furnace is checked in:",
    [
      "AC volts across the gas valve coil only",
      "DC microamps in series with the sensor while it is firing",
      "Inches of water column",
      "Ohms to ground with the burners lit",
    ],
    1,
    "The flame rectifies a tiny DC current. Near zero means the control does not see flame."
  ),
  nq(
    "core-elec-5",
    "core",
    "electrical",
    "A weak run capacitor on a PSC motor often shows up as:",
    [
      "The motor humming, starting slowly, or running hot and over-amping",
      "A perfect start and unusually low amps",
      "High gas pressure",
      "A stuck heat-pump reversing valve",
    ],
    0,
    "The capacitor makes the second phase that starts and runs the motor. Discharge a capacitor before you handle it."
  ),
  nq(
    "core-elec-6",
    "core",
    "electrical",
    "The 24-volt circuit on a furnace or air handler is there to:",
    [
      "Spin the compressor directly from the thermostat wire",
      "Let the thermostat and the safeties operate contactors and the gas valve",
      "Replace the breaker",
      "Measure static pressure",
    ],
    1,
    "The thermostat asks a contactor or a board to switch the line voltage. It does not feed the compressor itself."
  ),
  nq(
    "core-heat-1",
    "core",
    "heat",
    "Sensible heat is heat that:",
    [
      "Changes the air temperature you can read with a thermometer",
      "Only removes moisture and does not change temperature",
      "Is lost in the flue and nowhere else",
      "Is the same number as superheat",
    ],
    0,
    "Sensible heat changes temperature. Latent heat is the moisture part. The blower moves both."
  ),
  nq(
    "core-heat-2",
    "core",
    "heat",
    "Superheat is:",
    [
      "How many degrees the vapor is above its boiling temperature at that pressure",
      "How many degrees the liquid is below its boiling temperature",
      "Return air minus supply air",
      "Gas manifold pressure",
    ],
    0,
    "Low superheat can send liquid back to the compressor. High superheat means the evaporator is starved."
  ),
  nq(
    "core-heat-3",
    "core",
    "heat",
    "Subcooling is:",
    [
      "How many degrees the liquid is cooler than the saturation temperature at that pressure",
      "Suction-line temperature minus outdoor temperature",
      "Flame-sensor microamps",
      "Supply air minus outdoor air",
    ],
    0,
    "On a TXV system, subcooling is the usual charge check. On a fixed orifice, superheat is the usual charge check."
  ),
  nq(
    "core-heat-4",
    "core",
    "heat",
    "A proper vacuum on a residential system means:",
    [
      "The pump ran for five minutes",
      "The reading is near 500 microns and it holds after you valve off at the equipment",
      "The compound gauge hit 29 inches and you closed the valves",
      "The suction line is cold",
    ],
    1,
    "Time and a compound gauge do not prove the system is dry and tight. A rising micron reading means moisture or a leak."
  ),
  nq(
    "core-heat-5",
    "core",
    "heat",
    "A cooling temperature split (return minus supply) is often about:",
    ["1 to 3 degrees F", "15 to 20 degrees F", "40 to 50 degrees F", "The outdoor temperature"],
    1,
    "It is a clue. A very low split can be airflow or charge. Measure, then decide."
  ),
  nq(
    "core-heat-6",
    "core",
    "heat",
    "Low airflow across an evaporator often:",
    [
      "Warms the coil and raises superheat on purpose",
      "Can freeze the coil",
      "Trips the rollout switch",
      "Sets manifold pressure to zero",
    ],
    1,
    "Not enough air lets the coil get too cold. Check the filter, the blower, and static pressure before you condemn the charge."
  ),
  nq(
    "core-cust-1",
    "core",
    "customer",
    "Shoe covers and a drop cloth are for:",
    [
      "Looking busy in a photo",
      "Leaving the house the way you found it",
      "Replacing a combustion test",
      "Covering a refrigerant leak",
    ],
    1,
    "The customer judges the job by the mess as well as by the repair."
  ),
  nq(
    "core-cust-2",
    "core",
    "customer",
    "Before you cut a wall, a ceiling, or a line-set path, you:",
    [
      "Cut first so the hole is done when you ask",
      "Tell the customer what you need to open and get a yes",
      "Hide the cut behind furniture",
      "Let a helper choose without asking",
    ],
    1,
    "It is their house. A surprise cut becomes a complaint."
  ),
  nq(
    "core-cust-3",
    "core",
    "customer",
    "The note at the end of the call should include:",
    [
      "What you found, what you did, and the readings that prove it",
      "The word Fixed and nothing else",
      "The door code in a public note",
      "A guess you did not measure",
    ],
    0,
    "The next tech, the office, and a warranty claim need the measurements."
  ),
  nq(
    "core-cust-4",
    "core",
    "customer",
    "The last company left a jumper on a limit. You:",
    [
      "Leave it so you are not blamed",
      "Remove it, find the cause, and tell the customer what the equipment is doing",
      "Add a second jumper",
      "Post their logo with a complaint",
    ],
    1,
    "Say what the furnace is doing. The customer does not need a fight between companies."
  ),
  nq(
    "core-cust-5",
    "core",
    "customer",
    "A customer asks you to vent leftover refrigerant behind the garage. You:",
    [
      "Vent it if the bottle is almost empty",
      "Recover it. Venting refrigerant is not allowed",
      "Open the valve and walk away",
      "Dump it into the nitrogen bottle",
    ],
    1,
    "EPA 608 applies on the job. Recovery is the legal path."
  ),
  nq(
    "gas-seq-1",
    "gas-heat",
    "sequence",
    "A typical induced-draft furnace order is:",
    [
      "Gas valve, then inducer, then blower, then pressure switch",
      "Inducer, pressure switch closes, igniter, gas valve, flame proof, then the main blower",
      "Main blower first, then gas",
      "Thermostat straight to the gas valve with no safeties",
    ],
    1,
    "Draft is proved before fuel is allowed."
  ),
  nq(
    "gas-seq-2",
    "gas-heat",
    "sequence",
    "The pressure switch on an induced-draft furnace proves:",
    [
      "Manifold gas pressure",
      "That the inducer is moving enough air to close the switch",
      "That the filter is new",
      "The thermostat battery voltage",
    ],
    1,
    "If the switch stays open, the board should not open the gas valve. Do not leave it jumped."
  ),
  nq(
    "gas-seq-3",
    "gas-heat",
    "sequence",
    "On a hot-surface furnace, the flame sensor:",
    [
      "Is a thermocouple sitting in a standing pilot",
      "Has to show a small DC microamp signal while the flame touches it",
      "Reads oxygen percent",
      "Opens the pressure switch",
    ],
    1,
    "Clean the rod if the current is missing and the flame looks right. A cracked porcelain or a weak flame also drops it."
  ),
  nq(
    "gas-seq-4",
    "gas-heat",
    "sequence",
    "The main blower on a furnace usually starts:",
    [
      "The instant the thermostat calls",
      "After the heat exchanger has warmed, on a time delay or a temperature delay",
      "Only when the thermostat calls for cooling",
      "When the rollout switch trips",
    ],
    1,
    "The delay keeps cold air off the people and gives the exchanger time to warm. Know which delay that model uses."
  ),
  nq(
    "gas-seq-5",
    "gas-heat",
    "sequence",
    "A standing-pilot furnace proves flame with:",
    [
      "The same microamp flame sensor as a hot-surface board",
      "A thermocouple or thermopile sitting in the pilot flame",
      "The draft pressure switch",
      "External static pressure",
    ],
    1,
    "That part makes millivolts. Do not look for microamps on it."
  ),
  nq(
    "gas-comb-1",
    "gas-heat",
    "combustion",
    "Manifold gas pressure is set by:",
    [
      "Ear, until the flame sounds strong",
      "The rating plate, read with a manometer. Natural gas is often near 3.5 inches water column",
      "20 psi on the refrigerant gauges",
      "The color of the cabinet",
    ],
    1,
    "Too much gas overfires. Too little can make CO. The plate beats memory."
  ),
  nq(
    "gas-comb-2",
    "gas-heat",
    "combustion",
    "A combustion analyzer on a running furnace is used to read:",
    [
      "Superheat and subcooling",
      "Oxygen, carbon monoxide, and flue temperature",
      "Only the thermostat voltage",
      "Microns",
    ],
    1,
    "A blue flame is not a combustion test."
  ),
  nq(
    "gas-comb-3",
    "gas-heat",
    "combustion",
    "High CO in the flue, or CO in the house, means you:",
    [
      "Raise the gas pressure and leave",
      "Shut the appliance down and find the cause before it keeps running",
      "Tape the vent and go",
      "Turn the blower off so the air stays in the furnace",
    ],
    1,
    "Carbon monoxide is the emergency. Do not hand the house back with that appliance still firing."
  ),
  nq(
    "gas-comb-4",
    "gas-heat",
    "combustion",
    "A cracked heat exchanger is:",
    [
      "A filter you can rinse and leave running",
      "A safety failure. Do not leave the furnace in service",
      "Fixed by raising gas pressure",
      "Normal rust you note and leave running",
    ],
    1,
    "Flue gas can enter the airstream. Take it out of service."
  ),
  nq(
    "gas-comb-5",
    "gas-heat",
    "combustion",
    "Temperature rise on a furnace is:",
    [
      "Supply temperature minus return temperature, and it has to land inside the nameplate range",
      "Outdoor temperature minus indoor temperature",
      "Always 40 degrees on every model",
      "Flue temperature with no nameplate to compare",
    ],
    0,
    "High rise means the heat is not being carried off. Low rise can mean too much air or not enough heat."
  ),
  nq(
    "gas-air-1",
    "gas-heat",
    "airflow-heat",
    "Temperature rise above the nameplate usually means:",
    [
      "Airflow is too low for the heat the furnace is making",
      "The gas valve coil is unplugged",
      "The outdoor condenser is dirty",
      "The flame sensor is in perfect shape",
    ],
    0,
    "Check the filter, the coil, the blower setting, and the ducts. Static pressure tells you if the duct is the limit."
  ),
  nq(
    "gas-air-2",
    "gas-heat",
    "airflow-heat",
    "External static pressure on a furnace is:",
    [
      "Supply static plus return static, compared with the blower rating",
      "Manifold gas pressure",
      "Refrigerant suction pressure",
      "The arrow printed on the filter",
    ],
    0,
    "Many residential furnaces are rated near 0.50 inches water column. Above the plate, the blower is not moving the air the rise chart assumes."
  ),
  nq(
    "gas-air-3",
    "gas-heat",
    "airflow-heat",
    "Closing half the supply registers to push air farther:",
    [
      "Is a good permanent fix",
      "Raises static pressure and can overheat the furnace",
      "Lowers gas pressure",
      "Cleans the flame sensor",
    ],
    1,
    "The heat still has to go somewhere. Starving the blower makes the rise worse."
  ),
  nq(
    "gas-air-4",
    "gas-heat",
    "airflow-heat",
    "A PSC furnace sometimes uses a higher blower tap for cooling and a lower tap for heat because:",
    [
      "Cooling wants more cfm, and heat wants the rise to stay on the plate",
      "Using two different taps is not allowed",
      "Heat always needs more air than cooling",
      "The capacitor sets the gas pressure",
    ],
    0,
    "Read the plate. An ECM may be set by an airflow profile instead of a wire tap."
  ),
  nq(
    "gas-safe-1",
    "gas-heat",
    "safeties",
    "A rollout switch trips when:",
    [
      "Flame is spilling out of the burner area instead of going through the heat exchanger",
      "The filter is one month old",
      "The thermostat is satisfied",
      "The condenser fan stops",
    ],
    0,
    "Find out why the flame rolled out. A blocked exchanger, a wrong orifice, or a vent problem. Do not reset it and leave."
  ),
  nq(
    "gas-safe-2",
    "gas-heat",
    "safeties",
    "A high limit trips when:",
    [
      "The heat exchanger got too hot, often from low airflow or too much gas",
      "The flame sensor current is strong",
      "The outdoor temperature is mild",
      "The inducer is running faster than usual",
    ],
    0,
    "Resetting it without finding the airflow or gas problem brings the callback and can damage the exchanger."
  ),
  nq(
    "gas-safe-3",
    "gas-heat",
    "safeties",
    "Vent pipe and cement for a furnace are chosen from:",
    [
      "Whatever is on the truck",
      "The installation manual for that model",
      "The color of the siding",
      "The refrigerant type",
    ],
    1,
    "An 80% furnace and a 90% furnace do not vent the same way. The manual names the material."
  ),
  nq(
    "gas-safe-4",
    "gas-heat",
    "safeties",
    "Leaving a jumper on a rollout or a limit:",
    [
      "Is fine if the customer agrees",
      "Takes a safety out of the circuit. Remove it and fix the cause",
      "Is printed on the rating plate as the repair",
      "Sets the manifold pressure",
    ],
    1,
    "That switch is what stands between a bad fire and the house."
  ),
  nq(
    "ac-cycle-1",
    "air-conditioning",
    "cycle",
    "In cooling, the evaporator:",
    [
      "Rejects heat to the outdoor air",
      "Absorbs heat from the indoor air as the refrigerant boils",
      "Meters liquid into the condenser",
      "Proves inducer draft",
    ],
    1,
    "Boiling refrigerant takes heat with it. The outdoor coil then rejects that heat."
  ),
  nq(
    "ac-cycle-2",
    "air-conditioning",
    "cycle",
    "The compressor:",
    [
      "Raises vapor pressure so the outdoor coil can dump heat to the air",
      "Is the indoor metering device",
      "Only runs in heat mode",
      "Sets gas manifold pressure",
    ],
    0,
    "High-pressure vapor condenses outdoors when the outdoor air is cooler than that refrigerant."
  ),
  nq(
    "ac-cycle-3",
    "air-conditioning",
    "cycle",
    "The piston or TXV:",
    [
      "Drops liquid pressure so the refrigerant can boil in the evaporator",
      "Pumps vapor to the condenser",
      "Replaces the filter-drier",
      "Proves flame",
    ],
    0,
    "Without that pressure drop there is no boiling at a useful temperature."
  ),
  nq(
    "ac-cycle-4",
    "air-conditioning",
    "cycle",
    "A TXV tries to hold:",
    [
      "A steady superheat at the evaporator outlet",
      "A steady gas manifold pressure",
      "Outdoor fan rpm",
      "Subcooling measured on the suction line",
    ],
    0,
    "That is why a TXV system is usually charged by subcooling. The valve is already chasing superheat."
  ),
  nq(
    "ac-cycle-5",
    "air-conditioning",
    "cycle",
    "A filter-drier belongs:",
    [
      "In the liquid line, arrow with the flow",
      "On the suction line, arrow backward, as a muffler only",
      "In the condensate drain",
      "Anywhere, direction does not matter",
    ],
    0,
    "It catches moisture and debris before they wreck a TXV or a compressor. Point the arrow with the liquid flow."
  ),
  nq(
    "ac-ch-1",
    "air-conditioning",
    "charge",
    "Before you open a system that still has refrigerant, you:",
    [
      "Vent it outdoors",
      "Recover it into a cylinder",
      "Blow it out with oxygen",
      "Purge it through the vacuum-pump oil",
    ],
    1,
    "Venting is not the job. The vacuum pump is not a recovery machine."
  ),
  nq(
    "ac-ch-2",
    "air-conditioning",
    "charge",
    "After the line set is brazed and before the vacuum, you:",
    [
      "Pressure-test with nitrogen and find any leak",
      "Release refrigerant and listen for a hiss",
      "Run the compressor to pull the vacuum",
      "Fill the lines with oxygen so bubbles show up",
    ],
    0,
    "Find the leak while the system is still dry. Oxygen is the wrong gas."
  ),
  nq(
    "ac-ch-3",
    "air-conditioning",
    "charge",
    "A fixed-orifice (piston) system is usually charged by:",
    [
      "Subcooling only, with superheat ignored",
      "Superheat, using the manufacturer chart",
      "Thirty seconds of refrigerant per pound of nameplate charge",
      "Indoor humidity alone",
    ],
    1,
    "The piston does not control superheat. The charge does."
  ),
  nq(
    "ac-ch-4",
    "air-conditioning",
    "charge",
    "A TXV system is usually charged by:",
    [
      "Subcooling, using the manufacturer chart",
      "Superheat only, with the sensing bulb left bare",
      "70 psi suction on every refrigerant",
      "Outdoor temperature alone",
    ],
    0,
    "The TXV holds superheat. Subcooling tells you how much extra liquid is stacked in the condenser."
  ),
  nq(
    "ac-ch-5",
    "air-conditioning",
    "charge",
    "The TXV sensing bulb should be:",
    [
      "On the suction line, tight, in the clock position the manufacturer wants, and insulated",
      "Hanging in the supply airstream",
      "Strapped to the liquid line at the outdoor unit",
      "Left loose so it reads attic air",
    ],
    0,
    "A loose or warm bulb lies to the valve and the superheat goes wrong."
  ),
  nq(
    "ac-air-1",
    "air-conditioning",
    "airflow-ac",
    "A dirty condenser coil usually:",
    [
      "Raises head pressure because the outdoor coil cannot reject heat",
      "Lowers head pressure",
      "Trips a furnace rollout",
      "Sets superheat by itself with no other effect",
    ],
    0,
    "Clean the coil and confirm the fan before you add refrigerant to hide a high head."
  ),
  nq(
    "ac-air-2",
    "air-conditioning",
    "airflow-ac",
    "About 400 cfm per ton is:",
    [
      "The usual starting airflow for a residential cooling coil",
      "The natural-gas manifold pressure",
      "The vacuum target in microns",
      "The required ladder angle",
    ],
    0,
    "A 3-ton coil starts near 1200 cfm. The chart and the static reading decide the real number."
  ),
  nq(
    "ac-air-3",
    "air-conditioning",
    "airflow-ac",
    "Ice on an evaporator can come from:",
    [
      "Low airflow, low charge, or a metering problem",
      "High gas pressure only",
      "A new filter and a correct charge with no other cause",
      "A heat-pump defrost board on a cooling-only air conditioner",
    ],
    0,
    "Do not only thaw it. Find which of those three it is."
  ),
  nq(
    "ac-air-4",
    "air-conditioning",
    "airflow-ac",
    "Static pressure on a cooling call tells you:",
    [
      "Whether the duct, filter, and coil are letting the blower move the air the tonnage needs",
      "The refrigerant type",
      "The flame signal",
      "How much nitrogen is left in the bottle",
    ],
    0,
    "A correct charge on a starved coil still makes a weak house."
  ),
  nq(
    "ac-el-1",
    "air-conditioning",
    "electrical-ac",
    "A contactor with burned points:",
    [
      "Can drop voltage to the compressor so it runs hot or chatters",
      "Raises subcooling by itself",
      "Is the metering device",
      "Proves the vacuum",
    ],
    0,
    "Measure volts in and volts out under load. A pitted contactor is a decision you can prove."
  ),
  nq(
    "ac-el-2",
    "air-conditioning",
    "electrical-ac",
    "A compressor that hums and will not start, with a good capacitor and a closed contactor, may be:",
    [
      "Locked up, or not getting the right voltage at its terminals",
      "Low on gas-manifold pressure",
      "A dirty flame sensor",
      "Out of nitrogen",
    ],
    0,
    "Check voltage at the compressor and the windings before you condemn it. A hard-start kit does not fix a grounded winding."
  ),
  nq(
    "ac-el-3",
    "air-conditioning",
    "electrical-ac",
    "On a single-phase compressor, power off and the capacitor discharged, a healthy winding check shows:",
    [
      "Run-to-common plus start-to-common about equal to run-to-start",
      "Zero ohms on every pair",
      "Infinite ohms on every pair",
      "A microamp reading while the meter is still on ohms",
    ],
    0,
    "Open is infinite. A short to the shell is a separate test from the terminals to ground."
  ),
  nq(
    "ac-el-4",
    "air-conditioning",
    "electrical-ac",
    "The condenser fan and the compressor share one contactor. The fan is dead and the compressor is running. You look at:",
    [
      "The fan motor, its capacitor, and its wiring",
      "A missing thermostat call",
      "The gas valve coil",
      "Defrost on a straight air conditioner",
    ],
    0,
    "The contactor is already closed, because the compressor is running. The fan circuit is the open item."
  ),
  nq(
    "hp-rev-1",
    "heat-pump",
    "reversing",
    "The reversing valve:",
    [
      "Changes which coil is the evaporator and which is the condenser",
      "Sets gas manifold pressure",
      "Is the indoor TXV",
      "Measures static pressure",
    ],
    0,
    "Cooling and heating are the same loop running in opposite directions."
  ),
  nq(
    "hp-rev-2",
    "heat-pump",
    "reversing",
    "The reversing-valve solenoid is energized in:",
    [
      "The same mode on every brand",
      "Whichever mode the wiring diagram shows. Some energize in cool, some in heat",
      "240 volts straight from the thermostat R wire",
      "No mode. The solenoid can stay unplugged",
    ],
    1,
    "The diagram tells you the default. A missing solenoid call leaves the system in one mode."
  ),
  nq(
    "hp-rev-3",
    "heat-pump",
    "reversing",
    "A reversing valve that will not shift shows up as:",
    [
      "The system stuck in one mode, with pressures that do not match the call",
      "Perfect heat and perfect cool",
      "Only a dirty filter",
      "A tripped furnace rollout",
    ],
    0,
    "Check the solenoid call and the pressures before you condemn the compressor."
  ),
  nq(
    "hp-rev-4",
    "heat-pump",
    "reversing",
    "In heat mode the outdoor coil is:",
    [
      "The condenser, rejecting heat",
      "The evaporator, picking up heat from outdoor air",
      "Empty of refrigerant",
      "The gas heat exchanger",
    ],
    1,
    "That is why it frosts in cold wet weather, and why defrost exists."
  ),
  nq(
    "hp-def-1",
    "heat-pump",
    "defrost",
    "Defrost exists because:",
    [
      "The outdoor coil is the evaporator in heat, and frost blocks it",
      "The indoor coil overheats in winter",
      "Gas pressure is high",
      "The filter is new",
    ],
    0,
    "Frosted fins cannot pick up heat. Capacity falls if the coil never clears."
  ),
  nq(
    "hp-def-2",
    "heat-pump",
    "defrost",
    "During a normal defrost, a typical heat pump:",
    [
      "Shifts toward cooling, often stops the outdoor fan, and brings on auxiliary heat",
      "Opens a gas valve on every house",
      "Vents refrigerant to melt the ice",
      "Locks out the indoor blower for an hour",
    ],
    0,
    "The outdoor coil becomes the condenser long enough to melt. Auxiliary heat keeps the supply air from going cold."
  ),
  nq(
    "hp-def-3",
    "heat-pump",
    "defrost",
    "A heat pump that ices solid and never defrosts needs:",
    [
      "The defrost sensor, the board, and the reversing-valve call checked",
      "Refrigerant added until the ice looks white",
      "To be left alone all winter",
      "The flame sensor cleaned",
    ],
    0,
    "Ice is the symptom. The board, the coil sensor, and the valve are the test."
  ),
  nq(
    "hp-def-4",
    "heat-pump",
    "defrost",
    "The outdoor fan keeps running the whole time the coil should be defrosting. You:",
    [
      "Check the diagram. Many boards are supposed to stop that fan",
      "Call the defrost perfect",
      "Add refrigerant",
      "Replace the thermostat batteries only",
    ],
    0,
    "If the board is supposed to stop the fan and the fan never stops, look at that relay before you blame the valve."
  ),
  nq(
    "hp-aux-1",
    "heat-pump",
    "aux",
    "Auxiliary heat is:",
    [
      "The extra heat that helps when the heat pump cannot carry the house, including during defrost",
      "A permanent replacement for the compressor",
      "The same switch position as emergency heat",
      "Used only in cooling",
    ],
    0,
    "Aux on a cold day or in defrost can be normal. It is not a failure by itself."
  ),
  nq(
    "hp-aux-2",
    "heat-pump",
    "aux",
    "Emergency heat on the thermostat:",
    [
      "Locks out the compressor and runs the backup heat only",
      "Is the normal defrost cycle",
      "Is how the system should be left all winter",
      "Charges the reversing valve",
    ],
    0,
    "Left in emergency heat, the heat pump never runs and the bill goes up. Use it when the compressor must stay off."
  ),
  nq(
    "hp-aux-3",
    "heat-pump",
    "aux",
    "Balance point is:",
    [
      "The outdoor temperature where the heat pump output matches what the house is losing",
      "The gas manifold pressure",
      "500 microns",
      "The TXV bulb clock position",
    ],
    0,
    "Below that, auxiliary heat has to help. The number belongs to that house and that equipment."
  ),
  nq(
    "hp-aux-4",
    "heat-pump",
    "aux",
    "A heat pump with a gas furnace (dual fuel) should:",
    [
      "Stage the furnace and the compressor the way the control manual describes",
      "Run the furnace, the strips, and the compressor together with no control",
      "Use oxygen to purge the furnace",
      "Ignore an outdoor sensor if one is installed",
    ],
    0,
    "The outdoor lockout decides when the furnace takes over. Set it. Do not leave every source on at once."
  ),
  nq(
    "hp-ch-1",
    "heat-pump",
    "charge-hp",
    "Most residential heat pumps are charged:",
    [
      "In cooling, using the manufacturer chart",
      "By feel, in heat only",
      "With oxygen",
      "To 70 psi suction on any refrigerant",
    ],
    0,
    "Heat-mode pressures move with the weather and with defrost. The cooling chart is the one the factory publishes for the weigh-in and the fine tune."
  ),
  nq(
    "hp-ch-2",
    "heat-pump",
    "charge-hp",
    "Adding refrigerant because the house feels cold, with no chart, can:",
    [
      "Overcharge a system that was low on airflow or stuck out of defrost",
      "Be the approved method on the rating plate",
      "Set the balance point",
      "Clean the outdoor coil",
    ],
    0,
    "Confirm the mode, defrost, airflow, and the chart before any refrigerant goes in."
  ),
  nq(
    "hp-ch-3",
    "heat-pump",
    "charge-hp",
    "A heat pump in heat, outdoor coil frosted, suction very low. First you:",
    [
      "Treat it as a defrost or airflow problem and measure again after the coil is clear",
      "Add one pound per ton",
      "Replace the flame sensor",
      "Replace the gas valve",
    ],
    0,
    "Frost is an insulator. Melt it, then measure, before you touch the charge."
  ),
  nq(
    "hp-ch-4",
    "heat-pump",
    "charge-hp",
    "Metering on a heat pump:",
    [
      "Has to feed whichever coil is evaporating. Many units meter indoors and outdoors",
      "Is removed for the winter",
      "Sets auxiliary kilowatts by itself",
      "Replaces the reversing valve",
    ],
    0,
    "The diagram shows which metering device is in the circuit in each mode."
  ),
  nq(
    "ad-st-1",
    "air-distribution",
    "static",
    "External static pressure is:",
    [
      "Supply static plus return static, in inches of water column",
      "Refrigerant discharge pressure",
      "Inlet gas pressure only",
      "A temperature difference",
    ],
    0,
    "Take the readings where the blower chart says, usually in the cabinet, not at a far register."
  ),
  nq(
    "ad-st-2",
    "air-distribution",
    "static",
    "You compare external static with:",
    [
      "The blower maximum on the nameplate",
      "500 microns",
      "3.5 inches of gas pressure on every job",
      "The thermostat software version",
    ],
    0,
    "Above the rated static, the cfm printed on the chart is no longer real."
  ),
  nq(
    "ad-st-3",
    "air-distribution",
    "static",
    "High static with a new filter and a clean coil often means:",
    [
      "The duct is small, a damper is shut, or the return is starved",
      "The refrigerant charge proves the duct is fine",
      "The flame is too blue",
      "The ladder angle is too steep",
    ],
    0,
    "The blower cannot invent duct. Measure before you sell a bigger motor into the same restriction."
  ),
  nq(
    "ad-st-4",
    "air-distribution",
    "static",
    "A dirty evaporator coil:",
    [
      "Adds static and cuts airflow",
      "Lowers static and raises cfm",
      "Sets gas pressure",
      "Only matters during heat-pump defrost",
    ],
    0,
    "Look at the coil, not only the filter."
  ),
  nq(
    "ad-st-5",
    "air-distribution",
    "static",
    "Static-pressure test holes should be:",
    [
      "In the place the chart names, and finished so the cabinet is not left open",
      "Half-inch holes left open in a bedroom return",
      "Drilled into the heat exchanger",
      "The same port as the gas-pressure tap",
    ],
    0,
    "A hole in the wrong panel measures turbulence. Close or plug the test hole when you are done."
  ),
  nq(
    "ad-cfm-1",
    "air-distribution",
    "cfm",
    "A rough sensible cfm estimate is:",
    [
      "CFM = BTU per hour divided by (1.08 times the temperature difference)",
      "CFM = volts times amps",
      "CFM = microns times 500",
      "CFM = tons times 100",
    ],
    0,
    "It estimates airflow from the temperature change. High static still sends you back to the blower chart."
  ),
  nq(
    "ad-cfm-2",
    "air-distribution",
    "cfm",
    "A 3-ton cooling coil, as a starting point, wants about:",
    ["400 cfm total", "1200 cfm", "3000 cfm", "40 cfm"],
    1,
    "About 400 cfm per ton is the usual start. 3 tons is about 1200 cfm."
  ),
  nq(
    "ad-cfm-3",
    "air-distribution",
    "cfm",
    "Furnace temperature rise can estimate airflow because:",
    [
      "Heat output and the air-temperature change tell you how much air is moving",
      "Gas pressure is the same number as cfm",
      "Superheat is cfm",
      "The filter size is the cfm",
    ],
    0,
    "If you know the output and the rise, you can estimate cfm. A high rise means fewer cfm."
  ),
  nq(
    "ad-cfm-4",
    "air-distribution",
    "cfm",
    "Balancing a new install means:",
    [
      "Each room gets air, and total external static is inside the blower rating",
      "Every damper is closed except the noisiest room",
      "The return can be ignored if the supplies are open",
      "One register is left fully shut as a spare",
    ],
    0,
    "A loud room and a furnace over the rise limit are the same problem seen from two ends."
  ),
  nq(
    "ad-duct-1",
    "air-distribution",
    "ducts",
    "A return that is too small:",
    [
      "Starves the blower, raises return static, and gets noisy",
      "Always improves cooling",
      "Sets subcooling",
      "Removes the need for a supply trunk",
    ],
    0,
    "The blower can only move what the return lets in."
  ),
  nq(
    "ad-duct-2",
    "air-distribution",
    "ducts",
    "Flex duct that is kinked, sagging, or pulled tight around a corner:",
    [
      "Can cut a lot of airflow even when the diameter on the plan looked right",
      "Is better than a straight metal run",
      "Drops static to zero",
      "Is required by the furnace plate",
    ],
    0,
    "Support it and keep the bends gentle. A crushed strap is a damper you did not mean to install."
  ),
  nq(
    "ad-duct-3",
    "air-distribution",
    "ducts",
    "Closing supply registers in unused rooms:",
    [
      "Raises static and can push temperature rise or a freezing coil the wrong way",
      "Is a free capacity upgrade",
      "Charges the refrigerant",
      "Cleans the coil",
    ],
    0,
    "If rooms must stay closed, the duct has to be able to live with that. Do not close half the house and leave."
  ),
  nq(
    "ad-duct-4",
    "air-distribution",
    "ducts",
    "The filter and the coil count in the air path because:",
    [
      "A restrictive filter or a dirty coil uses up the static budget",
      "Only the longest supply run counts",
      "Return size does not matter if the filter is thick",
      "Static is only measured outdoors",
    ],
    0,
    "A tight 1-inch filter on a larger system can spend the whole static budget by itself."
  ),
  nq(
    "ad-bl-1",
    "air-distribution",
    "blower",
    "A PSC blower speed is changed by:",
    [
      "The speed tap the chart names for heat or cool, with the power off",
      "Turning the gas-valve adjustment",
      "Moving the TXV bulb",
      "Adding refrigerant",
    ],
    0,
    "Heat and cool often want different speeds. Do not leave two taps energized."
  ),
  nq(
    "ad-bl-2",
    "air-distribution",
    "blower",
    "An ECM blower may be set for:",
    [
      "A target airflow or a torque profile, not only a color wire",
      "Manifold pressure",
      "Microns",
      "Flame microamps",
    ],
    0,
    "Use the manufacturer's setup. Guessing the wires will not give the cfm on the box."
  ),
  nq(
    "ad-bl-3",
    "air-distribution",
    "blower",
    "A blower wheel packed with dirt:",
    [
      "Moves less air and can raise motor amps and temperature rise",
      "Improves static pressure",
      "Is only a noise problem",
      "Weighs the refrigerant charge",
    ],
    0,
    "Clean the wheel, not only the filter."
  ),
  nq(
    "ad-bl-4",
    "air-distribution",
    "blower",
    "On a gas startup the lead should record:",
    [
      "Static pressure, temperature rise, and a combustion reading that includes CO",
      "Only that the thermostat clicked",
      "The color of the registers",
      "Suction pressure instead of any gas reading",
    ],
    0,
    "Those three say the ducts, the blower, and the fire are actually right."
  ),
];

const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

export function questionById(id: string): NateQuestion | undefined {
  return BY_ID.get(id);
}

export function isExamKey(value: string): value is ExamKey {
  return EXAMS.some((e) => e.key === value);
}

export function questionsFor(exam: ExamKey, topic?: string): NateQuestion[] {
  return QUESTIONS.filter((q) => q.exam === exam && (!topic || q.topic === topic));
}

export function examTopicKeys(exam: ExamKey): string[] {
  return TOPICS[exam].map((t) => t.key);
}

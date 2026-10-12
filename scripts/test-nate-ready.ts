/**
 * NATE ready rule and practice papers.
 * Run: npx esbuild scripts/test-nate-ready.ts --bundle --platform=node --outfile=$env:TEMP\test-nate-ready.mjs
 *      node $env:TEMP\test-nate-ready.mjs
 */
import { EXAMS, QUESTIONS, questionById, questionsFor, suggestedTrack } from "../worker/growthContent";
import {
  FULL_COUNT,
  buildQuestionIds,
  gradePaper,
  nateStatus,
  openMisses,
  type AttemptSnap,
} from "../worker/nateReady";

let failed = 0;
function eq(name: string, got: unknown, expect: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(expect);
  if (a === b) console.log("ok " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + "\n  got " + a + "\n  expect " + b);
  }
}

function seqRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

eq("install helper title", suggestedTrack("Install Helper"), "install_helper");
eq("lead installer", suggestedTrack("Lead Installer"), "install");
eq("service tech", suggestedTrack("Service Technician"), "service");
eq("maintenance", suggestedTrack("Maintenance Technician"), "service");
eq("apprentice", suggestedTrack("Apprentice"), "helper");
eq("office blank", suggestedTrack("CSR"), null);

const full = buildQuestionIds("core", "full", null, [], seqRng(3));
eq("full length", full.length, FULL_COUNT);
eq("full unique", new Set(full).size, FULL_COUNT);
const topicsHit = new Set(full.map((id) => questionById(id)?.topic));
eq("full covers topics", topicsHit.size >= 5, true);

const topicPaper = buildQuestionIds("gas-heat", "topic", "sequence", [], seqRng(2));
eq("topic size", topicPaper.length, 5);
eq(
  "topic only sequence",
  topicPaper.every((id) => questionById(id)?.topic === "sequence"),
  true
);

const sample = questionsFor("core", "safety").slice(0, 2);
const graded = gradePaper(
  sample.map((q) => q.id),
  { [sample[0].id]: sample[0].answer, [sample[1].id]: (sample[1].answer + 1) % 4 }
);
eq("grade one wrong", graded.correct, 1);
eq("grade total", graded.total, 2);

function snap(
  mode: AttemptSnap["mode"],
  score: number,
  topic: string | null,
  at: string
): AttemptSnap {
  return { mode, topic, score, questionIds: [], wrongIds: [], finishedAt: at };
}

const coreTopics = ["safety", "tools", "electrical", "heat", "customer"];
const topicPasses: AttemptSnap[] = coreTopics.map((topic, i) =>
  snap("topic", 0.8, topic, "2026-10-0" + (i + 1))
);

eq(
  "no work",
  nateStatus("core", [], false).status,
  "learning"
);

eq(
  "one full without topics",
  nateStatus("core", [snap("full", 0.8, null, "2026-10-08")], false).status,
  "learning"
);

const closeAttempts = [snap("full", 0.86, null, "2026-10-08"), ...topicPasses].sort((a, b) =>
  a.finishedAt < b.finishedAt ? 1 : -1
);
eq("one full and topics", nateStatus("core", closeAttempts, false).status, "close");

const twoFulls = [
  snap("full", 0.8, null, "2026-10-08"),
  snap("full", 0.93, null, "2026-10-07"),
  ...topicPasses,
].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
const unmarked = nateStatus("core", twoFulls, false);
eq("two fulls unmarked", unmarked.status, "close");
eq("can mark", unmarked.canMark, true);
eq("marked ready", nateStatus("core", twoFulls, true).status, "ready");

const dropped = [
  snap("full", 0.5, null, "2026-10-09"),
  ...twoFulls,
];
eq("newer weak full", nateStatus("core", dropped, true).status, "learning");

const weakTopic = twoFulls.map((a) =>
  a.topic === "heat" ? { ...a, score: 0.4 } : a
);
eq("weak topic blocks", nateStatus("core", weakTopic, true).status, "learning");

const reviewIgnored = [
  snap("review", 1, null, "2026-10-10"),
  snap("full", 0.2, null, "2026-10-06"),
  ...topicPasses,
].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
eq("review is not a full", nateStatus("core", reviewIgnored, true).status, "learning");

const misses = openMisses("core", [
  {
    mode: "full",
    topic: null,
    score: 0.5,
    questionIds: ["core-safety-1", "core-tools-1"],
    wrongIds: ["core-safety-1", "core-tools-1"],
    finishedAt: "2026-10-01",
  },
  {
    mode: "topic",
    topic: "safety",
    score: 1,
    questionIds: ["core-safety-1"],
    wrongIds: [],
    finishedAt: "2026-10-02",
  },
]);
eq("miss cleared", misses.includes("core-safety-1"), false);
eq("miss remains", misses.includes("core-tools-1"), true);

eq("exams present", EXAMS.length, 5);
eq("unique questions", new Set(QUESTIONS.map((q) => q.id)).size, QUESTIONS.length);
eq(
  "answers in range",
  QUESTIONS.every((q) => q.answer >= 0 && q.answer <= 3 && q.choices.length === 4),
  true
);

if (failed) {
  console.log(failed + " failed");
  process.exit(1);
}
console.log("all ok");

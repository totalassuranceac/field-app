/**
 * NATE practice papers and the ready rule. Pure besides the question bank.
 * Ready to schedule: two most recent full practices at 80% or better,
 * every topic's latest quiz at 70% or better, and the tech marked ready.
 */

import {
  examTopicKeys,
  questionById,
  questionsFor,
  type ExamKey,
} from "./growthContent";

export const FULL_COUNT = 15;
export const TOPIC_QUIZ_COUNT = 5;
export const FULL_PASS = 0.8;
export const TOPIC_PASS = 0.7;
export const REVIEW_COUNT = 10;

export type PaperMode = "full" | "topic" | "review";

export type TopicScore = { correct: number; total: number; score: number };

export type AttemptSnap = {
  mode: PaperMode;
  topic: string | null;
  score: number;
  questionIds: string[];
  wrongIds: string[];
  finishedAt: string;
};

export type TopicProgress = {
  key: string;
  score: number | null;
  ok: boolean;
};

export type NateStatusName = "learning" | "close" | "ready";

export type NateStatus = {
  status: NateStatusName;
  canMark: boolean;
  topicsOk: boolean;
  fullsOk: boolean;
  recentFullScore: number | null;
  topics: TopicProgress[];
};

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

export function buildQuestionIds(
  exam: ExamKey,
  mode: PaperMode,
  topic: string | null,
  reviewIds: string[],
  rng: () => number
): string[] {
  if (mode === "review") {
    const ids = reviewIds.filter((id) => questionById(id)?.exam === exam);
    return ids.slice(0, REVIEW_COUNT);
  }
  if (mode === "topic") {
    if (!topic || !examTopicKeys(exam).includes(topic)) return [];
    const pool = shuffle(
      questionsFor(exam, topic).map((q) => q.id),
      rng
    );
    return pool.slice(0, Math.min(TOPIC_QUIZ_COUNT, pool.length));
  }
  const topics = examTopicKeys(exam);
  const picked: string[] = [];
  const used = new Set<string>();
  for (let round = 0; round < 3; round++) {
    for (const topicKey of shuffle(topics, rng)) {
      if (picked.length >= FULL_COUNT) break;
      const pool = shuffle(
        questionsFor(exam, topicKey)
          .map((q) => q.id)
          .filter((id) => !used.has(id)),
        rng
      );
      if (!pool.length) continue;
      picked.push(pool[0]);
      used.add(pool[0]);
    }
  }
  if (picked.length < FULL_COUNT) {
    const rest = shuffle(
      questionsFor(exam)
        .map((q) => q.id)
        .filter((id) => !used.has(id)),
      rng
    );
    for (const id of rest) {
      if (picked.length >= FULL_COUNT) break;
      picked.push(id);
    }
  }
  return picked.slice(0, FULL_COUNT);
}

export function gradePaper(
  ids: string[],
  choices: Record<string, number>
): {
  correct: number;
  total: number;
  score: number;
  wrongIds: string[];
  topicScores: Record<string, TopicScore>;
  details: {
    id: string;
    ok: boolean;
    yourChoice: number | null;
    answer: number;
    why: string;
  }[];
} {
  let correct = 0;
  const wrongIds: string[] = [];
  const topicScores: Record<string, TopicScore> = {};
  const details: {
    id: string;
    ok: boolean;
    yourChoice: number | null;
    answer: number;
    why: string;
  }[] = [];
  for (const id of ids) {
    const q = questionById(id);
    if (!q) continue;
    const raw = choices[id];
    const yourChoice = Number.isInteger(raw) ? Number(raw) : null;
    const ok = yourChoice === q.answer;
    if (ok) correct += 1;
    else wrongIds.push(id);
    const bucket = topicScores[q.topic] || { correct: 0, total: 0, score: 0 };
    bucket.total += 1;
    if (ok) bucket.correct += 1;
    bucket.score = bucket.total ? bucket.correct / bucket.total : 0;
    topicScores[q.topic] = bucket;
    details.push({
      id,
      ok,
      yourChoice,
      answer: q.answer,
      why: q.why,
    });
  }
  const total = details.length;
  return {
    correct,
    total,
    score: total ? correct / total : 0,
    wrongIds,
    topicScores,
    details,
  };
}

export function openMisses(exam: ExamKey, attemptsOldestFirst: AttemptSnap[]): string[] {
  const wrong = new Set<string>();
  for (const attempt of attemptsOldestFirst) {
    for (const id of attempt.questionIds) {
      if (questionById(id)?.exam !== exam) continue;
      if (attempt.wrongIds.includes(id)) wrong.add(id);
      else wrong.delete(id);
    }
  }
  return [...wrong];
}

function latestTopicScore(attemptsNewestFirst: AttemptSnap[], topic: string): number | null {
  for (const attempt of attemptsNewestFirst) {
    if (attempt.mode === "topic" && attempt.topic === topic) return attempt.score;
  }
  return null;
}

export function nateStatus(
  exam: ExamKey,
  attemptsNewestFirst: AttemptSnap[],
  marked: boolean
): NateStatus {
  const topics = examTopicKeys(exam).map((key) => {
    const score = latestTopicScore(attemptsNewestFirst, key);
    return {
      key,
      score,
      ok: score != null && score + 1e-9 >= TOPIC_PASS,
    };
  });
  const topicsOk = topics.length > 0 && topics.every((t) => t.ok);
  const fulls = attemptsNewestFirst.filter((a) => a.mode === "full");
  const recent = fulls.slice(0, 2);
  const fullsOk = recent.length === 2 && recent.every((a) => a.score + 1e-9 >= FULL_PASS);
  const oneGood = fulls.length > 0 && fulls[0].score + 1e-9 >= FULL_PASS;
  const canMark = fullsOk && topicsOk;
  let status: NateStatusName = "learning";
  if (canMark && marked) status = "ready";
  else if (topicsOk && (fullsOk || oneGood)) status = "close";
  return {
    status,
    canMark,
    topicsOk,
    fullsOk,
    recentFullScore: fulls.length ? fulls[0].score : null,
    topics,
  };
}

export function statusLabel(status: NateStatusName): string {
  if (status === "ready") return "Ready to schedule";
  if (status === "close") return "Getting close";
  return "Still learning";
}

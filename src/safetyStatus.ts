/**
 * People x topics grid for Safety team status.
 * Latest stamp wins. A retake is still done. Inactive topics are left out.
 * When a topic has job audiences, a dash means that course is not part of that job.
 * Needs-it is an essential course that was never stamped, or one past its year.
 */

import {
  levelFor,
  parseAudiences,
  safetyDue,
  safetyTrack,
  type SafetyDueStatus,
  type SafetyLevel,
} from "./safetyAssign";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function safetyDoneLabel(completedAt: string | null | undefined): string {
  const match = String(completedAt || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "Done";
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || !day) return "Done";
  return `Done ${month} ${day}`;
}

export type SafetyTopicInput = {
  id: number;
  title: string;
  active?: number | boolean | string | null;
  for_new_hire?: number | boolean | string | null;
  audiences?: string | null;
};

export type SafetyUserInput = {
  id: number;
  display_name: string;
  role: string;
  position_title?: string | null;
};

export type SafetyStampInput = {
  user_id: number;
  topic_id: number;
  completed_at: string;
  is_retake?: number | boolean | null;
  id?: number | null;
};

export type SafetyStatusCell = {
  topic_id: number;
  done: boolean;
  applies: boolean;
  level: SafetyLevel | null;
  due_status: SafetyDueStatus;
  completed_at: string | null;
  is_retake: boolean;
  label: string;
};

export type SafetyStatusRow = {
  user: SafetyUserInput;
  cells: SafetyStatusCell[];
  done_count: number;
  needs_any: boolean;
};

export type SafetyStatusTopic = {
  id: number;
  title: string;
  for_new_hire?: number;
  audiences?: string | null;
};

export type SafetyStatusTotal = {
  topic_id: number;
  title: string;
  done: number;
  people: number;
  label: string;
};

export function topicIsActive(topic: SafetyTopicInput): boolean {
  if (topic.active === undefined || topic.active === null) return true;
  if (topic.active === false || topic.active === 0 || topic.active === "0") return false;
  return true;
}

function newerStamp(a: SafetyStampInput, b: SafetyStampInput): boolean {
  if (a.completed_at !== b.completed_at) return a.completed_at > b.completed_at;
  return Number(a.id || 0) > Number(b.id || 0);
}

export function safetyStatusTotals(
  topics: SafetyStatusTopic[],
  rows: SafetyStatusRow[]
): SafetyStatusTotal[] {
  return topics.map((topic) => {
    let done = 0;
    let people = 0;
    for (const row of rows) {
      const cell = row.cells.find((item) => item.topic_id === topic.id);
      if (cell && cell.applies === false) continue;
      people += 1;
      if (cell?.done) done += 1;
    }
    return {
      topic_id: topic.id,
      title: topic.title,
      done,
      people,
      label: `${done} of ${people} done`,
    };
  });
}

export function buildSafetyStatusGrid(input: {
  topics: SafetyTopicInput[];
  users: SafetyUserInput[];
  stamps: SafetyStampInput[];
}): { topics: SafetyStatusTopic[]; rows: SafetyStatusRow[]; totals: SafetyStatusTotal[] } {
  const topics = input.topics.filter(topicIsActive).map((topic) => ({
    id: Number(topic.id),
    title: String(topic.title || ""),
    for_new_hire: topic.for_new_hire === true || Number(topic.for_new_hire) === 1 ? 1 : 0,
    audiences: topic.audiences != null ? String(topic.audiences) : null,
  }));
  const usesJobs = topics.some((topic) => Object.keys(parseAudiences(topic.audiences)).length > 0);
  const topicIds = new Set(topics.map((topic) => topic.id));
  const latest = new Map<string, SafetyStampInput>();
  for (const stamp of input.stamps) {
    const topicId = Number(stamp.topic_id);
    if (!topicIds.has(topicId)) continue;
    const key = `${Number(stamp.user_id)}:${topicId}`;
    const prev = latest.get(key);
    if (!prev || newerStamp(stamp, prev)) latest.set(key, stamp);
  }

  const users = [...input.users].sort((a, b) => {
    const byName = String(a.display_name || "").localeCompare(String(b.display_name || ""), undefined, {
      sensitivity: "base",
    });
    if (byName) return byName;
    return Number(a.id) - Number(b.id);
  });

  const rows: SafetyStatusRow[] = users.map((user) => {
    const track = safetyTrack({
      role: user.role,
      position_title: user.position_title,
      is_warehouse: user.role === "warehouse",
    });
    const cells: SafetyStatusCell[] = topics.map((topic) => {
      const stamp = latest.get(`${Number(user.id)}:${topic.id}`);
      const isRetake = stamp ? stamp.is_retake === true || Number(stamp.is_retake) === 1 : false;
      const level = usesJobs ? levelFor(parseAudiences(topic.audiences), track) : null;
      if (usesJobs && !level) {
        return {
          topic_id: topic.id,
          done: false,
          applies: false,
          level: null,
          due_status: "none",
          completed_at: stamp?.completed_at || null,
          is_retake: isRetake,
          label: "—",
        };
      }
      if (!usesJobs) {
        if (!stamp) {
          return {
            topic_id: topic.id,
            done: false,
            applies: true,
            level: null,
            due_status: "none",
            completed_at: null,
            is_retake: false,
            label: "Needs it",
          };
        }
        return {
          topic_id: topic.id,
          done: true,
          applies: true,
          level: null,
          due_status: "current",
          completed_at: stamp.completed_at,
          is_retake: isRetake,
          label: safetyDoneLabel(stamp.completed_at),
        };
      }
      const due = safetyDue(stamp?.completed_at || null);
      const covered = due.status === "current" || due.status === "due_soon";
      const label =
        due.status === "none"
          ? "Needs it"
          : due.status === "overdue"
            ? "Past due"
            : due.status === "due_soon"
              ? "Refresh soon"
              : safetyDoneLabel(stamp?.completed_at);
      return {
        topic_id: topic.id,
        done: covered,
        applies: true,
        level,
        due_status: due.status,
        completed_at: stamp?.completed_at || null,
        is_retake: isRetake,
        label,
      };
    });
    const required = usesJobs ? cells.filter((cell) => cell.level === "essential") : cells.filter((cell) => cell.applies);
    const doneCount = required.filter((cell) => cell.done).length;
    return {
      user,
      cells,
      done_count: doneCount,
      needs_any: doneCount < required.length,
    };
  });

  return { topics, rows, totals: safetyStatusTotals(topics, rows) };
}

export function filterSafetyStatusRows(
  rows: SafetyStatusRow[],
  opts: { role?: string; onlyNeeds?: boolean }
): SafetyStatusRow[] {
  return rows.filter((row) => {
    if (opts.role && row.user.role !== opts.role) return false;
    if (opts.onlyNeeds && !row.needs_any) return false;
    return true;
  });
}

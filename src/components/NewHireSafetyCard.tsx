import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { safetyDateLabel } from "../safetyAssign";

type NewHireProgress = {
  mode?: "essentials" | "refresh" | "clear";
  done: number;
  total: number;
  next_id: number | null;
  next_title: string | null;
  track_label?: string | null;
  due_on?: string | null;
  last_taken?: string | null;
};

/** Home prompt for job essentials, then for a refresher before the year ends. */
export function NewHireSafetyCard() {
  const { user } = useAuth();
  const [progress, setProgress] = useState<NewHireProgress | null>(null);

  useEffect(() => {
    if (!user || user.role === "viewer") return;
    let cancelled = false;
    api<NewHireProgress>("/safety/new-hire")
      .then((row) => {
        if (!cancelled) setProgress(row);
      })
      .catch(() => {
        if (!cancelled) setProgress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || user.role === "viewer") return null;
  if (!progress || progress.mode === "clear" || progress.total < 1) return null;
  if (!progress.mode && progress.done >= progress.total) return null;
  const href = progress.next_id ? `/safety/topics/${progress.next_id}` : "/safety";
  const job = progress.track_label || "Your";

  return (
    <section className="home-section" aria-label="Safety essentials">
      <Link to={href} className="card safety-new-hire-home">
        <strong>{progress.mode === "refresh" ? "Safety refresher" : `${job} essentials`}</strong>
        <span>
          {progress.mode === "refresh"
            ? `${progress.next_title || "A course"} was last taken ${safetyDateLabel(progress.last_taken) || "earlier"}. Stamp it again before ${safetyDateLabel(progress.due_on) || "the year is up"} so the file stays covered.`
            : `${progress.done} of ${progress.total} essentials current. Finish these before the other courses for this job. Your stamp is the record.`}
        </span>
        {progress.mode !== "refresh" && progress.next_title ? (
          <span>Next: {progress.next_title}</span>
        ) : null}
      </Link>
    </section>
  );
}

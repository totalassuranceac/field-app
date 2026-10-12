import { useEffect, useState } from "react";
import { api, roleLabel } from "../api";
import { printWithLightTheme } from "../printTheme";
import { safetyDateLabel, type SafetyDueStatus, type SafetyLevel } from "../safetyAssign";

type FileCourse = {
  id: number;
  title: string;
  category: string | null;
  level: SafetyLevel;
  last_taken: string | null;
  due_on: string | null;
  status: SafetyDueStatus;
};

type FileStamp = {
  id: number;
  topic_title: string;
  completed_at: string;
  is_retake: boolean;
  notes: string | null;
};

type FilePerson = {
  user_id: number | null;
  employee_id: number | null;
  name: string;
  role: string | null;
  position_title: string | null;
  hire_date: string | null;
  track_label: string | null;
};

type FileResponse = {
  person: FilePerson | null;
  courses: FileCourse[];
  history: FileStamp[];
  note?: string;
  error?: string;
};

function statusLabel(course: FileCourse): string {
  if (course.status === "none") return "Not taken";
  if (course.status === "overdue") return `Past due ${safetyDateLabel(course.due_on)}`;
  if (course.status === "due_soon") return `Refresh before ${safetyDateLabel(course.due_on)}`;
  return `Current through ${safetyDateLabel(course.due_on)}`;
}

function printedOn(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SafetyTrainingFile({
  userId,
  employeeId,
}: {
  userId?: number | null;
  employeeId?: number | null;
}) {
  const [data, setData] = useState<FileResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = new URLSearchParams();
    if (userId) q.set("user_id", String(userId));
    else if (employeeId) q.set("employee_id", String(employeeId));
    let cancelled = false;
    api<FileResponse>(`/safety/file${q.toString() ? `?${q}` : ""}`)
      .then((row) => {
        if (cancelled) return;
        setData(row);
        if (row.error) setError(row.error);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the training file");
      });
    return () => {
      cancelled = true;
    };
  }, [userId, employeeId]);

  if (error) return <div className="error inv-flash">{error}</div>;
  if (!data?.person) return <p className="muted">Loading training file…</p>;

  const person = data.person;
  const essentials = data.courses.filter((course) => course.level === "essential");
  const extras = data.courses.filter((course) => course.level === "extra");
  const hire = safetyDateLabel(person.hire_date);

  return (
    <div className="card safety-file-sheet">
      <header className="safety-print-letterhead">
        <img src="/logo-form-primary.png" alt="Total Assurance" />
        <div>
          <div className="safety-print-title">Employee training file</div>
          <div className="muted">Printed {printedOn()}</div>
        </div>
      </header>
      <p style={{ marginTop: 0 }}>
        <strong>{person.name}</strong>
        {person.position_title ? ` · ${person.position_title}` : ""}
        {person.role ? ` · ${roleLabel(person.role)}` : ""}
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        {person.track_label ? `${person.track_label} courses. ` : ""}
        {hire ? `Hire date ${hire}. ` : ""}
        Each stamp keeps the wording that was on the course that day. A course is current for one year.
        The refresher opens 30 days before that year ends.
      </p>
      {data.note ? <p>{data.note}</p> : null}
      <div className="safety-status-tools no-print">
        <button
          type="button"
          className="btn"
          onClick={() => void printWithLightTheme("print-safety-file")}
        >
          Print training file
        </button>
      </div>
      <CourseTable title="Essentials for this job" courses={essentials} />
      <CourseTable title="More for this job" courses={extras} />
      <h2 className="safety-category">Stamp history</h2>
      {!data.history.length ? (
        <p className="muted">No stamps yet.</p>
      ) : (
        <table className="safety-file-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Course</th>
              <th>Record</th>
            </tr>
          </thead>
          <tbody>
            {data.history.map((stamp) => (
              <tr key={stamp.id}>
                <td>{safetyDateLabel(stamp.completed_at) || stamp.completed_at.slice(0, 16)}</td>
                <td>{stamp.topic_title}</td>
                <td>
                  {stamp.notes
                    ? stamp.notes
                    : stamp.is_retake
                      ? "Refresher"
                      : "First stamp"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted safety-file-foot">
        Total Assurance A/C & Heating · Company training record · Not a state license
      </p>
    </div>
  );
}

function CourseTable({ title, courses }: { title: string; courses: FileCourse[] }) {
  return (
    <>
      <h2 className="safety-category">{title}</h2>
      {!courses.length ? (
        <p className="muted">None for this job.</p>
      ) : (
        <table className="safety-file-table">
          <thead>
            <tr>
              <th>Course</th>
              <th>Last taken</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {courses.map((course) => (
              <tr key={course.id}>
                <td>
                  {course.title}
                  {course.category ? <div className="muted">{course.category}</div> : null}
                </td>
                <td>{course.last_taken ? safetyDateLabel(course.last_taken) : "—"}</td>
                <td>{statusLabel(course)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

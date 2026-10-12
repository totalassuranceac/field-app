import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, ApiError, can } from "../api";
import { isAzaliMiller } from "../lib/azaliRnc";
import { useAuth } from "../auth";
import {
  suggestAutoWhen,
  techOffOnInstallBookDate,
  type BoardRowLite,
} from "../millerInstallAutoWhen";
import { realMedianNote } from "../jobDurations";

type ArrivalWindow = { id: string; label: string };
type PresetOpt = {
  id: string;
  label: string;
  technician_ids: number[];
  kind?: "hard_lock" | "custom";
  custom_id?: number;
  lead_name?: string;
  helper_name?: string;
  lead_st_id?: number | null;
  helper_st_id?: number | null;
};
type TechOpt = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  label: string;
  standing_off_weekday?: number | null;
  standing_off_label?: string | null;
};
type JobTypeOpt = {
  id: number;
  name: string;
  st_name?: string;
  nc_key?: "rough" | "final" | "trim";
  unresolved?: boolean;
  duration_minutes?: number | null;
  duration_source?: "avg" | "estimated" | "heuristic" | string | null;
  avg_minutes?: number | null;
  estimated_minutes?: number | null;
};
type LocHit = {
  location_id: number;
  customer_id: number | null;
  name: string | null;
  address: string;
  customer_name: string | null;
  unit?: string | null;
  street_key?: string | null;
};

type ExistingJob = {
  job_id: number;
  job_number: string | null;
  job_type: string | null;
  status: string | null;
  technician_names: string[];
  appointment_start: string | null;
  location_id: number | null;
};

type ProposalStatus = {
  signed: boolean;
  estimate_id?: number | null;
  estimate_number?: string | null;
  status?: string | null;
  signed_on?: string | null;
  sold_on?: string | null;
  sold_by?: string | null;
  total?: number | null;
  message: string;
  detection?: string | null;
};

type Meta = {
  mode: "dry" | "live";
  nc_enabled?: boolean;
  dry_run: boolean;
  can_book?: boolean;
  st_configured: boolean;
  crews?: PresetOpt[];
  presets?: PresetOpt[];
  custom_presets?: PresetOpt[];
  technicians?: TechOpt[];
  job_types: JobTypeOpt[];
  arrival_windows: ArrivalWindow[];
  business_unit?: { id: number | null; name: string; error?: string };
  campaign?: { id: number | null; name: string | null; error?: string };
  enable_live_hint?: string;
  errors?: string[];
  error?: string;
};

type BookResult = {
  ok: boolean;
  mode: "dry" | "live";
  dry_run: boolean;
  message: string;
  not_listed?: boolean;
  board_job_id?: number | null;
  enable_live_hint?: string;
  st_job_number?: string | null;
  st_job_id?: number | null;
  error?: string;
  intended_payload?: unknown;
  resolved?: unknown;
  existing_jobs?: ExistingJob[];
  proposal_status?: ProposalStatus;
  projects?: { id: number; name: string; status: string | null }[];
};

type PresetMenuState = {
  preset: PresetOpt;
  x: number;
  y: number;
};

type DayBoardLiteResponse = {
  date?: string;
  rows?: BoardRowLite[];
};

type Props = {
  date: string;
  onBooked?: () => void;
  preferNc?: "rough" | "final";
  initialAddress?: string;
};

const LONG_PRESS_MS = 3000;


function extractUnitFromText(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m =
    /\b(?:apt(?:artment)?|unit|ste|suite|#)\s*([a-z0-9\-]+)\b/i.exec(s) ||
    /\s#\s*([a-z0-9\-]+)\s*$/i.exec(s);
  return m ? String(m[1]).toUpperCase() : "";
}

/** First name only (Miller chip short-name). */
function firstNameOnly(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return (t.split(/\s+/)[0] || "").trim();
}

function firstPlusLastInitial(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}`;
}

/** First only; First + last initial only when first names collide in the list. */
function shortLabelsForList(fullNames: string[]): string[] {
  const firsts = fullNames.map(firstNameOnly);
  const counts = new Map<string, number>();
  for (const f of firsts) {
    const k = f.toLowerCase();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return fullNames.map((full, i) => {
    const first = firsts[i];
    if (!first) return "";
    if ((counts.get(first.toLowerCase()) || 0) > 1) {
      return firstPlusLastInitial(full);
    }
    return first;
  });
}

/** Auto preset name from selected installer chips in click order: Name / Name2 / Name3. */
function autoPresetNameFromSelection(selectedIds: number[], technicians: TechOpt[]): string {
  const ordered = selectedIds
    .map((id) => technicians.find((t) => Number(t.st_technician_id) === id))
    .filter((t): t is TechOpt => !!t);
  if (!ordered.length) return "";
  const chipLabels = ordered.map((t) => String(t.label || "").trim());
  if (chipLabels.every(Boolean)) {
    return chipLabels.join(" / ");
  }
  const shorts = shortLabelsForList(ordered.map((t) => t.display_name || ""));
  return shorts.filter(Boolean).join(" / ");
}

export function MillerInstallQuickAdd({ date, onBooked, preferNc, initialAddress }: Props) {
  const { user } = useAuth();
  const officeOk =
    can(user, "viewOpsPerformance") ||
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "supervisor" ||
    isAzaliMiller(user);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaErr, setMetaErr] = useState("");
  const [addrQ, setAddrQ] = useState(initialAddress || "");
  const [projectId, setProjectId] = useState<number | "">("");
  const [hits, setHits] = useState<LocHit[]>([]);
  const [loc, setLoc] = useState<LocHit | null>(null);
  const [jobTypeId, setJobTypeId] = useState<number | "">("");
  const [selectedTechIds, setSelectedTechIds] = useState<number[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<number | null>(null);
  const [presetToast, setPresetToast] = useState<{ ok: boolean; message: string } | null>(null);
  const [presetMenu, setPresetMenu] = useState<PresetMenuState | null>(null);
  const [windowId, setWindowId] = useState("801-10");
  const [customStart, setCustomStart] = useState("8:01");
  const [customEnd, setCustomEnd] = useState("12:00");
  const [whenSummary, setWhenSummary] = useState("First free · 8:01–12");
  const [changeTimeOpen, setChangeTimeOpen] = useState(false);
  const [manualTime, setManualTime] = useState(false);
  const [boardRows, setBoardRows] = useState<BoardRowLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);
  /** Not listed = Day Board only, no ServiceTitan create */
  const [notListed, setNotListed] = useState(false);
  /** Open ST jobs already at selected location (anti-dupe) */
  const [existingJobs, setExistingJobs] = useState<ExistingJob[]>([]);
  const [existingJobsLoading, setExistingJobsLoading] = useState(false);
  /** Signed proposal (Sold estimate) HARD LOCK */
  const [proposalStatus, setProposalStatus] = useState<ProposalStatus | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  /** Office override — default false; only shown when blocked */
  const [forceDuplicate, setForceDuplicate] = useState(false);
  /** ST search says this street has apt/units */
  const [multiUnit, setMultiUnit] = useState(false);
  /** Typed unit when Not listed + multi-unit street */
  const [unitDraft, setUnitDraft] = useState("");
  const [searching, setSearching] = useState(false);
  const searchGen = useRef(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashPresetToast = useCallback((ok: boolean, message: string) => {
    setPresetToast({ ok, message });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setPresetToast(null), 3200);
  }, []);

  const loadMeta = useCallback(async () => {
    if (!officeOk) return;
    try {
      const m = await api<Meta>("/day-board/miller-book/meta", { timeoutMs: 45_000 });
      setMeta(m);
      setMetaErr("");
      if (!jobTypeId && preferNc && m.nc_enabled) {
        const hit = m.job_types?.find((t) => t.nc_key === preferNc && t.id > 0);
        if (hit) setJobTypeId(hit.id);
      } else if (!jobTypeId && m.job_types?.[0] && !preferNc) setJobTypeId(m.job_types[0].id);
    } catch (e) {
      setMetaErr(e instanceof Error ? e.message : "Could not load Miller book meta");
    }
  }, [officeOk, jobTypeId]);

  useEffect(() => {
    void loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officeOk]);

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // Day Board rows for same-day stack (lean existing source)
  useEffect(() => {
    if (!officeOk || !date) return;
    let cancelled = false;
    (async () => {
      try {
        const board = await api<DayBoardLiteResponse>(
          `/day-board?date=${encodeURIComponent(date)}`,
          { timeoutMs: 60_000 }
        );
        if (!cancelled) setBoardRows(board.rows || []);
      } catch {
        if (!cancelled) setBoardRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [officeOk, date]);


  // HARD LOCK: signed proposal (Sold) when location picked — also for Not listed
  useEffect(() => {
    if (!officeOk) return;
    let cancelled = false;
    const run = async () => {
      if (loc && loc.location_id > 0) {
        setProposalLoading(true);
        try {
          const qs = new URLSearchParams({
            location_id: String(loc.location_id),
          });
          if (loc.customer_id) qs.set("customer_id", String(loc.customer_id));
          const res = await api<ProposalStatus>(
            `/day-board/miller-book/proposal-status?${qs.toString()}`,
            { timeoutMs: 30_000 }
          );
          if (!cancelled) setProposalStatus(res);
        } catch {
          if (!cancelled) {
            setProposalStatus({
              signed: false,
              message: "Proposal not signed — get with the customer.",
            });
          }
        } finally {
          if (!cancelled) setProposalLoading(false);
        }
        return;
      }
      // Not listed without ST location: cannot verify — treat as unsigned (block)
      if (notListed) {
        setProposalStatus({
          signed: false,
          message: "Proposal not signed — get with the customer.",
          detection: "not_listed_without_location",
        });
        setProposalLoading(false);
        return;
      }
      setProposalStatus(null);
      setProposalLoading(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [officeOk, loc, notListed]);

  // Anti-dupe: when location picked (or Not listed address), load open ST jobs
  useEffect(() => {
    if (!officeOk) return;
    setForceDuplicate(false);
    let cancelled = false;
    const run = async () => {
      if (loc && loc.location_id > 0) {
        setExistingJobsLoading(true);
        try {
          const qs = new URLSearchParams({
            location_id: String(loc.location_id),
            date: date || "",
          });
          if (loc.customer_id) qs.set("customer_id", String(loc.customer_id));
          const res = await api<{ existing_jobs?: ExistingJob[]; proposal_status?: ProposalStatus }>(
            `/day-board/miller-book/open-jobs?${qs.toString()}`,
            { timeoutMs: 30_000 }
          );
          if (!cancelled) {
            setExistingJobs(res.existing_jobs || []);
            if (res.proposal_status) setProposalStatus(res.proposal_status);
          }
        } catch {
          if (!cancelled) setExistingJobs([]);
        } finally {
          if (!cancelled) setExistingJobsLoading(false);
        }
        return;
      }
      if (notListed) {
        const addr = (addrQ || "").trim();
        if (addr.length < 5) {
          setExistingJobs([]);
          return;
        }
        setExistingJobsLoading(true);
        try {
          const qs = new URLSearchParams({
            address: addr,
            date: date || "",
          });
          const res = await api<{ existing_jobs?: ExistingJob[]; proposal_status?: ProposalStatus }>(
            `/day-board/miller-book/open-jobs?${qs.toString()}`,
            { timeoutMs: 30_000 }
          );
          if (!cancelled) {
            setExistingJobs(res.existing_jobs || []);
            if (res.proposal_status) setProposalStatus(res.proposal_status);
          }
        } catch {
          if (!cancelled) setExistingJobs([]);
        } finally {
          if (!cancelled) setExistingJobsLoading(false);
        }
        return;
      }
      setExistingJobs([]);
    };
    const t = window.setTimeout(() => {
      void run();
    }, notListed && !loc ? 400 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [officeOk, loc, date, notListed, addrQ]);


  useEffect(() => {
    if (!officeOk) return;
    const q = addrQ.trim();
    if (q.length < 3) {
      setHits([]);
      setMultiUnit(false);
      return;
    }
    if (loc && loc.address === q) return;
    const gen = ++searchGen.current;
    const t = window.setTimeout(() => {
      setSearching(true);
      void (async () => {
        try {
          const res = await api<{ hits: LocHit[]; multi_unit?: boolean }>(
            `/day-board/miller-book/locations?q=${encodeURIComponent(q)}`,
            { timeoutMs: 30_000 }
          );
          if (searchGen.current !== gen) return;
          const next = res.hits || [];
          const isMulti = Boolean(res.multi_unit) || next.filter((h) => h.unit).length > 1;
          setMultiUnit(isMulti);
          setHits(next);
          // Auto-pick only when one clear hit and NOT a multi-unit street
          if (!isMulti && next.length === 1 && !loc) {
            setLoc(next[0]);
            setAddrQ(next[0].address);
            setHits([]);
          }
        } catch {
          if (searchGen.current !== gen) return;
          setHits([]);
          setMultiUnit(false);
        } finally {
          if (searchGen.current === gen) setSearching(false);
        }
      })();
    }, 280);
    return () => window.clearTimeout(t);
  }, [addrQ, loc, officeOk]);

  const modeLabel = meta?.mode === "live" ? "LIVE" : "Dry";

  const presets = useMemo(
    () => meta?.presets || meta?.crews || [],
    [meta]
  );
  const technicians = useMemo(() => {
    const rows = meta?.technicians || [];
    return rows.filter((t) => {
      const st = Number(t.st_technician_id);
      return Number.isFinite(st) && st > 0;
    });
  }, [meta]);

  const selectedJobType = useMemo(
    () => (meta?.job_types || []).find((t) => t.id === jobTypeId) || null,
    [meta, jobTypeId]
  );

  // Drop Omar (or any standing Wed-off) from selection when Install book date is Wednesday
  useEffect(() => {
    setSelectedTechIds((prev) => {
      const next = prev.filter((id) => {
        const tech = technicians.find((t) => Number(t.st_technician_id) === id);
        if (!tech) return true;
        return !techOffOnInstallBookDate(tech, date);
      });
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      setPresetNameDraft(autoPresetNameFromSelection(next, technicians));
      return next;
    });
  }, [date, technicians]);

  // Recompute auto-When whenever date / job type / selected techs / board change
  useEffect(() => {
    if (manualTime) return;
    const suggestion = suggestAutoWhen({
      dateIso: date,
      jobType: selectedJobType,
      selectedTechIds,
      boardRows,
    });
    setWindowId(suggestion.arrival_window_id);
    setCustomStart(suggestion.custom_start);
    setCustomEnd(suggestion.custom_end);
    setWhenSummary(suggestion.summary);
  }, [date, selectedJobType, selectedTechIds, boardRows, manualTime]);

  function toggleTech(stId: number) {
    const tech = technicians.find((t) => Number(t.st_technician_id) === stId);
    if (tech && techOffOnInstallBookDate(tech, date)) return;
    setManualTime(false);
    setSelectedTechIds((prev) => {
      const on = prev.includes(stId);
      const next = on ? prev.filter((x) => x !== stId) : [...prev, stId];
      setPresetId("");
      setPresetNameDraft(autoPresetNameFromSelection(next, technicians));
      return next;
    });
  }

  function applyPreset(crew: PresetOpt) {
    const ids = (
      (crew.technician_ids || []).filter((n) => n > 0) ||
      []
    ).filter((id) => {
      const tech = technicians.find((t) => Number(t.st_technician_id) === id);
      if (!tech) return true;
      return !techOffOnInstallBookDate(tech, date);
    });
    setPresetId(crew.id);
    setSelectedTechIds(ids);
    setManualTime(false);
    setPresetNameDraft(
      crew.kind === "custom" && editingCustomId
        ? presetNameDraft || crew.label
        : autoPresetNameFromSelection(ids, technicians)
    );
    if (ids.length < (crew.technician_ids || []).filter((n) => n > 0).length) {
      flashPresetToast(true, "Preset applied — Off Wed installer skipped for this date");
    }
  }

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function openPresetMenu(crew: PresetOpt, clientX: number, clientY: number) {
    longPressFired.current = true;
    setPresetMenu({ preset: crew, x: clientX, y: clientY });
  }

  function startLongPress(crew: PresetOpt, clientX: number, clientY: number) {
    clearLongPress();
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      openPresetMenu(crew, clientX, clientY);
    }, LONG_PRESS_MS);
  }

  function onPresetPointerDown(crew: PresetOpt, e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button != null && e.button !== 0) return;
    startLongPress(crew, e.clientX, e.clientY);
  }

  function onPresetPointerUp() {
    clearLongPress();
  }

  function onPresetPointerLeave() {
    clearLongPress();
  }

  function onPresetClick(crew: PresetOpt) {
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    setPresetMenu(null);
    applyPreset(crew);
  }

  function beginEditPreset(crew: PresetOpt) {
    setPresetMenu(null);
    if (crew.kind !== "custom" || !crew.custom_id) {
      flashPresetToast(false, "Starter presets are locked - save a new custom preset instead");
      return;
    }
    applyPreset(crew);
    setEditingCustomId(crew.custom_id);
    setPresetNameDraft(crew.label);
    nameInputRef.current?.focus();
    flashPresetToast(true, "Editing preset - change name/members, then Update preset");
  }

  async function reloadMetaPresets() {
    const m = await api<Meta>("/day-board/miller-book/meta", { timeoutMs: 45_000 });
    setMeta(m);
  }

  async function savePreset() {
    let name = presetNameDraft.trim();
    if (!selectedTechIds.length) {
      flashPresetToast(false, "Pick at least one installer before saving a preset");
      return;
    }
    if (!name) {
      name = autoPresetNameFromSelection(selectedTechIds, technicians).trim();
      if (!name) {
        flashPresetToast(false, "Preset name required");
        return;
      }
      setPresetNameDraft(name);
    }
    setPresetBusy(true);
    try {
      if (editingCustomId) {
        await api(`/day-board/miller-book/presets/${editingCustomId}`, {
          method: "PUT",
          body: JSON.stringify({ name, technician_ids: selectedTechIds }),
        });
        flashPresetToast(true, `Updated preset "${name}"`);
      } else {
        await api("/day-board/miller-book/presets", {
          method: "POST",
          body: JSON.stringify({ name, technician_ids: selectedTechIds }),
        });
        flashPresetToast(true, `Saved preset "${name}"`);
      }
      setPresetNameDraft("");
      setEditingCustomId(null);
      await reloadMetaPresets();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      flashPresetToast(false, msg || "Preset save failed");
      setResult({
        ok: false,
        mode: meta?.mode || "dry",
        dry_run: true,
        message: msg,
        error: "preset save failed",
      });
    } finally {
      setPresetBusy(false);
    }
  }

  async function deletePreset(customId: number, label?: string) {
    if (
      !window.confirm(
        `Delete preset${label ? ` "${label}"` : ""}? This cannot be undone.`
      )
    ) {
      return;
    }
    setPresetBusy(true);
    setPresetMenu(null);
    try {
      await api(`/day-board/miller-book/presets/${customId}`, { method: "DELETE" });
      if (editingCustomId === customId) {
        setEditingCustomId(null);
        setPresetNameDraft("");
        setPresetId("");
      }
      await reloadMetaPresets();
      flashPresetToast(true, label ? `Deleted "${label}"` : "Preset deleted");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      flashPresetToast(false, msg || "Preset delete failed");
      setResult({
        ok: false,
        mode: meta?.mode || "dry",
        dry_run: true,
        message: msg,
        error: "preset delete failed",
      });
    } finally {
      setPresetBusy(false);
    }
  }

  if (!officeOk) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    const addressText = (loc?.address || addrQ || "").trim();
    const typedUnit = (unitDraft || extractUnitFromText(addressText) || "").trim();
    if (notListed) {
      if (!addressText || !selectedTechIds.length || !windowId) {
        setResult({
          ok: false,
          mode: meta?.mode || "dry",
          dry_run: false,
          message: "Not listed needs address, at least one installer, and time",
          error: "incomplete",
          not_listed: true,
        });
        return;
      }
      if (multiUnit && !typedUnit && !(loc?.unit)) {
        setResult({
          ok: false,
          mode: meta?.mode || "dry",
          dry_run: false,
          message: "This address has units — enter which unit before saving",
          error: "unit_required",
          not_listed: true,
        });
        return;
      }
    } else if (!loc || !jobTypeId || !selectedTechIds.length || !windowId) {
      let message =
        "Need address (location), install/NC job type, at least one installer, and time";
      if (!loc && addressText) {
        message = multiUnit
          ? "This address has units — tap which unit from the list below"
          : hits.length > 0
            ? "Tap the matching address from the search list"
            : "No ST location match yet — wait for search hits, or check Not listed for Day Board only";
      } else if (multiUnit && loc && !loc.unit && !typedUnit) {
        message = "This address has units — pick the unit-specific location";
      }
      setResult({
        ok: false,
        mode: meta?.mode || "dry",
        dry_run: true,
        message,
        error: "incomplete",
      });
      return;
    } else if (multiUnit && loc && !loc.unit && !typedUnit) {
      setResult({
        ok: false,
        mode: meta?.mode || "dry",
        dry_run: true,
        message: "This address has units — pick which unit from the list",
        error: "unit_required",
      });
      return;
    }
    if (proposalStatus && !proposalStatus.signed && !selectedJobType?.nc_key) {
      setResult({
        ok: false,
        mode: meta?.mode || "dry",
        dry_run: meta?.mode !== "live",
        message: proposalStatus.message || "Proposal not signed — get with the customer.",
        error: "proposal_not_signed",
        proposal_status: proposalStatus,
        not_listed: notListed,
      });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        technician_ids: selectedTechIds,
        date,
        arrival_window_id: windowId,
        not_listed: notListed,
      };
      if (loc) {
        body.location_id = loc.location_id;
        body.customer_id = loc.customer_id;
      }
      if (jobTypeId) body.job_type_id = jobTypeId;
      if (notListed) {
        const withUnit =
          typedUnit && !extractUnitFromText(addressText)
            ? `${addressText} Unit ${typedUnit}`
            : addressText;
        body.address_text = withUnit;
      }
      if (presetId) body.crew_id = presetId;
      if (windowId === "custom") {
        body.custom_start = customStart;
        body.custom_end = customEnd;
      }
      if (forceDuplicate && !selectedJobType?.nc_key) body.force_duplicate = true;
      if (projectId) body.project_id = projectId;
      const res = await api<BookResult>("/day-board/miller-book", {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      });
      setResult(res);
      if (res.existing_jobs && res.existing_jobs.length) {
        setExistingJobs(res.existing_jobs);
      }
      if (res.ok && (!res.dry_run || res.not_listed)) {
        onBooked?.();
      }
    } catch (err) {
      if (err instanceof ApiError && err.data && typeof err.data === "object") {
        const d = err.data as BookResult;
        if (typeof d.message === "string") {
          setResult(d);
        } else {
          setResult({
            ok: false,
            mode: meta?.mode || "dry",
            dry_run: meta?.mode !== "live",
            message: err.message,
            error: err.message,
          });
        }
      } else {
        setResult({
          ok: false,
          mode: meta?.mode || "dry",
          dry_run: meta?.mode !== "live",
          message: err instanceof Error ? err.message : "Book failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="day-board-miller-quick card" aria-label="Book install">
      <div className="day-board-miller-quick-head">
        <h2>Book install</h2>
        <span
          className={`day-board-miller-mode ${meta?.mode === "live" ? "is-live" : "is-dry"}`}
          title={meta?.enable_live_hint || ""}
        >
          {modeLabel}
        </span>
      </div>
            <p className="muted day-board-miller-quick-hint">
        Auto time stacks after same-day work (1–2 jobs typical). Job type → address → who. Confirms OFF.
        Presets auto-name from chips; long-press custom (~3s) to Edit/Delete. Starter presets locked.{" "}
        {notListed
          ? "Not listed = Day Board only — never creates in ServiceTitan."
          : meta?.mode !== "live"
            ? "Dry-run only until live is enabled."
            : "LIVE creates in ST."}
      </p>
      <label className="day-board-miller-not-listed">
        <input
          type="checkbox"
          checked={notListed}
          onChange={(e) => setNotListed(e.target.checked)}
        />
        <span>Not listed</span>
        <span className="muted"> (Day Board only — no ServiceTitan)</span>
      </label>
      {metaErr ? <p className="error-text">{metaErr}</p> : null}
      {(meta?.errors || []).length ? (
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Setup notes: {(meta?.errors || []).join(" · ")}
        </p>
      ) : null}

      {presetToast ? (
        <div
          className={`day-board-miller-preset-toast ${presetToast.ok ? "is-ok" : "is-bad"}`}
          role="status"
          aria-live="polite"
        >
          {presetToast.message}
        </div>
      ) : null}

      <form className="day-board-miller-form day-board-miller-form-auto-when" onSubmit={submit}>
        <div className="day-board-miller-when-sticky" aria-live="polite">
          <div className="day-board-miller-when-label">When</div>
          <div className="day-board-miller-when-summary">{whenSummary}</div>
          {realMedianNote(selectedJobType?.name) ? (
            <p className="muted day-board-miller-real">{realMedianNote(selectedJobType?.name)}</p>
          ) : null}
          <button
            type="button"
            className="day-board-miller-when-change"
            onClick={() => setChangeTimeOpen((o) => !o)}
            aria-expanded={changeTimeOpen}
          >
            {changeTimeOpen ? "Hide time" : "Change time"}
          </button>
          {changeTimeOpen ? (
            <div className="day-board-miller-when-manual">
              <label className="day-board-miller-field">
                <span>Arrival window</span>
                <select
                  value={windowId}
                  onChange={(e) => {
                    setManualTime(true);
                    setWindowId(e.target.value);
                    const w = (meta?.arrival_windows || []).find((x) => x.id === e.target.value);
                    setWhenSummary(w ? `Manual · ${w.label}` : "Manual time");
                  }}
                >
                  {(meta?.arrival_windows || []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </label>
              {windowId === "custom" ? (
                <div className="day-board-miller-custom">
                  <label>
                    <span>Start</span>
                    <input
                      value={customStart}
                      onChange={(e) => {
                        setManualTime(true);
                        setCustomStart(e.target.value);
                        setWhenSummary(`Manual · ${e.target.value}–${customEnd}`);
                      }}
                      placeholder="8:01"
                    />
                  </label>
                  <label>
                    <span>End</span>
                    <input
                      value={customEnd}
                      onChange={(e) => {
                        setManualTime(true);
                        setCustomEnd(e.target.value);
                        setWhenSummary(`Manual · ${customStart}–${e.target.value}`);
                      }}
                      placeholder="12:00"
                    />
                  </label>
                </div>
              ) : null}
              {manualTime ? (
                <button
                  type="button"
                  className="btn secondary day-board-miller-when-reset"
                  onClick={() => setManualTime(false)}
                >
                  Back to auto
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <label className="day-board-miller-field">
          <span>{notListed ? "Job type (optional)" : "Job type"}</span>
          <select
            value={jobTypeId === "" ? "" : String(jobTypeId)}
            onChange={(e) => {
              setManualTime(false);
              setJobTypeId(e.target.value ? Number(e.target.value) : "");
            }}
          >
            <option value="">Select.</option>
            {(meta?.job_types || []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="day-board-miller-field day-board-miller-addr">
          <span>{notListed ? "Address (typed OK — no ST required)" : "Address"}</span>
          <input
            type="search"
            value={addrQ}
            placeholder="Street or customer name (e.g. Griessen)"
            autoComplete="off"
            onChange={(e) => {
              setAddrQ(e.target.value);
              setLoc(null);
              setUnitDraft("");
              setResult(null);
              setExistingJobs([]);
              setForceDuplicate(false);
            }}
          />
          {searching ? <span className="muted day-board-miller-searching">Searching.</span> : null}
          {!loc && !searching && addrQ.trim().length >= 3 && hits.length === 0 ? (
            <p className="day-board-miller-addr-hint muted">
              Not in ServiceTitan under that street yet (check spelling). Use{" "}
              <strong>Not listed</strong> for Day Board only, or add the location in ST first.
            </p>
          ) : null}
          {!loc && multiUnit && hits.length > 0 ? (
            <p className="day-board-miller-unit-ask" role="status">
              Which unit? Tap one below before Create.
            </p>
          ) : null}
          {!loc && !multiUnit && hits.length > 0 ? (
            <p className="day-board-miller-addr-hint muted">Tap the matching address.</p>
          ) : null}
          {!loc && hits.length > 0 ? (
            <ul className="day-board-miller-hits" role="listbox">
              {hits.map((h) => (
                <li key={h.location_id}>
                  <button
                    type="button"
                    onClick={() => {
                      setLoc(h);
                      setAddrQ(h.address);
                      if (h.unit) setUnitDraft(String(h.unit));
                      setHits([]);
                    }}
                  >
                    <strong>
                      {h.unit ? `Unit ${h.unit} · ` : ""}
                      {h.address}
                    </strong>
                    {h.customer_name ? (
                      <span className="muted"> · {h.customer_name}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {loc ? (
            <span className="day-board-miller-picked muted">
              Location #{loc.location_id}
              {loc.unit ? ` · Unit ${loc.unit}` : ""}
              {loc.customer_id ? ` · cust ${loc.customer_id}` : ""}
            </span>
          ) : null}
          {(multiUnit || notListed) && (multiUnit || hits.some((h) => h.unit)) ? (
            <label className="day-board-miller-field day-board-miller-unit-field">
              <span>Unit / apt</span>
              <input
                type="text"
                value={unitDraft}
                placeholder="e.g. 104"
                autoComplete="off"
                onChange={(e) => setUnitDraft(e.target.value)}
              />
            </label>
          ) : null}
        </label>

        <div className="day-board-miller-field day-board-miller-techs">
          <span>Installers / New Construction</span>
          <div className="day-board-miller-presets" role="group" aria-label="Optional presets">
            <span className="muted day-board-miller-presets-label">Optional presets</span>
            {presets.map((c) => (
              <span key={c.id} className="day-board-miller-preset-wrap">
                <button
                  type="button"
                  className={`day-board-miller-preset ${presetId === c.id ? "is-on" : ""} ${
                    c.kind === "custom" ? "is-custom" : "is-hard-lock"
                  }`}
                  onClick={() => onPresetClick(c)}
                  onPointerDown={(e) => onPresetPointerDown(c, e)}
                  onPointerUp={onPresetPointerUp}
                  onPointerLeave={onPresetPointerLeave}
                  onPointerCancel={onPresetPointerUp}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openPresetMenu(c, e.clientX, e.clientY);
                  }}
                  title={
                    c.kind === "custom"
                      ? `${c.label} — long-press to Edit/Delete`
                      : `${c.lead_name || ""} + ${c.helper_name || ""}`.trim() ||
                        `${c.label} — starter (locked)`
                  }
                >
                  {c.label}
                </button>
              </span>
            ))}
            <div className="day-board-miller-preset-save">
              <input
                ref={nameInputRef}
                type="text"
                value={presetNameDraft}
                onChange={(e) => setPresetNameDraft(e.target.value)}
                placeholder={editingCustomId ? "Rename preset" : "Auto from installers"}
                aria-label="Preset name"
                maxLength={60}
              />
              <button
                type="button"
                className="day-board-miller-preset-save-btn"
                disabled={presetBusy || !selectedTechIds.length}
                onClick={() => void savePreset()}
              >
                {editingCustomId ? "Update preset" : "Save preset"}
              </button>
            </div>
          </div>
          <div className="day-board-miller-tech-list" role="group" aria-label="Installer and new-construction techs">
            {technicians.length === 0 ? (
              <span className="muted">No install / NC techs loaded.</span>
            ) : (
              technicians.map((t) => {
                const stId = Number(t.st_technician_id);
                const checked = selectedTechIds.includes(stId);
                const offWed = techOffOnInstallBookDate(t, date);
                return (
                  <button
                    key={t.user_id}
                    type="button"
                    aria-pressed={checked}
                    disabled={offWed}
                    className={`day-board-miller-tech-chip ${checked ? "is-on" : ""} ${
                      offWed ? "is-off-wed" : ""
                    }`}
                    onClick={() => toggleTech(stId)}
                    title={offWed ? `${t.display_name} — Off Wed` : t.display_name}
                  >
                    {t.label || t.display_name}
                    {offWed ? <span className="day-board-miller-off-wed">Off Wed</span> : null}
                  </button>
                );
              })
            )}
          </div>
          {selectedTechIds.length ? (
            <span className="muted day-board-miller-tech-count">
              {selectedTechIds.length} selected
            </span>
          ) : null}
        </div>


        {proposalLoading ? (
          <p className="muted day-board-miller-existing-loading">Checking for signed proposal…</p>
        ) : null}
        {proposalStatus && !proposalStatus.signed ? (
          <div className="day-board-miller-existing-banner is-red day-board-miller-proposal-banner" role="alert">
            <strong>Proposal not signed — get with the customer.</strong>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              Miller Install requires a Sold (signed) estimate for this location before booking.
              {proposalStatus.detection ? ` (${proposalStatus.detection})` : ""}
            </p>
          </div>
        ) : null}
        {proposalStatus && proposalStatus.signed ? (
          <p className="muted day-board-miller-proposal-ok">
            Signed proposal on file
            {proposalStatus.estimate_number ? ` · #${proposalStatus.estimate_number}` : ""}
            {proposalStatus.status ? ` · ${proposalStatus.status}` : ""}
            {proposalStatus.sold_on ? ` · sold ${proposalStatus.sold_on}` : ""}
          </p>
        ) : null}

        {existingJobsLoading ? (
          <p className="muted day-board-miller-existing-loading">Checking for jobs already on board…</p>
        ) : null}
        {existingJobs.length > 0 ? (
          <div
            className={`day-board-miller-existing-banner ${notListed ? "is-amber" : "is-red"}`}
            role="alert"
          >
            <strong>Already on board — do not create another.</strong>
            <ul>
              {existingJobs.map((j) => {
                const numLabel = j.job_number ? `#${j.job_number}` : `job ${j.job_id}`;
                const tech =
                  j.technician_names && j.technician_names.length
                    ? ` · ${j.technician_names.join(" + ")}`
                    : "";
                return (
                  <li key={j.job_id}>
                    {numLabel}
                    {j.job_type ? ` ${j.job_type}` : ""}
                    {j.status ? ` · ${j.status}` : ""}
                    {tech}
                  </li>
                );
              })}
            </ul>
            {!notListed && !selectedJobType?.nc_key ? (
              <label className="day-board-miller-force">
                <input
                  type="checkbox"
                  checked={forceDuplicate}
                  onChange={(e) => setForceDuplicate(e.target.checked)}
                />
                Force create duplicate (office override)
              </label>
            ) : notListed ? (
              <p className="muted">
                Prefer the live ST job above. Not listed is only for addresses truly missing from ST.
              </p>
            ) : null}
          </div>
        ) : null}

        {selectedJobType?.nc_key ? (
          <label className="day-board-miller-field">
            <span>Project</span>
            <select
              value={projectId === "" ? "" : String(projectId)}
              onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Use the only open project, or pick</option>
              {(result?.projects || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.status ? ` (${p.status})` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {result?.error === "completed_same_type" ? (
          <p className="muted" role="status">
            {result.message}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn primary day-board-miller-submit"
          disabled={
            busy ||
            (!notListed && !meta?.st_configured) ||
            (!!proposalStatus && !proposalStatus.signed && !selectedJobType?.nc_key) ||
            (!notListed && existingJobs.length > 0 && !forceDuplicate && !selectedJobType?.nc_key)
          }
        >
          {busy
            ? "Working."
            : proposalStatus && !proposalStatus.signed
              ? "Proposal not signed"
              : !notListed && existingJobs.length > 0 && !forceDuplicate && !selectedJobType?.nc_key
                ? "Already booked"
                : notListed
                  ? "Save Not listed"
                  : meta?.mode === "live"
                    ? "Create in ST"
                    : "Dry-run Create"}
        </button>
      </form>

      {presetMenu ? (
        <div
          className="day-board-miller-preset-menu-backdrop"
          role="presentation"
          onClick={() => setPresetMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setPresetMenu(null);
          }}
        >
          <div
            className="day-board-miller-preset-menu"
            role="menu"
            style={{
              left: Math.min(presetMenu.x, typeof window !== "undefined" ? window.innerWidth - 180 : presetMenu.x),
              top: Math.min(presetMenu.y, typeof window !== "undefined" ? window.innerHeight - 120 : presetMenu.y),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="day-board-miller-preset-menu-title">{presetMenu.preset.label}</div>
            {presetMenu.preset.kind === "custom" && presetMenu.preset.custom_id ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => beginEditPreset(presetMenu.preset)}
                >
                  Edit name / members
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  disabled={presetBusy}
                  onClick={() =>
                    void deletePreset(presetMenu.preset.custom_id!, presetMenu.preset.label)
                  }
                >
                  Delete preset
                </button>
              </>
            ) : (
              <p className="day-board-miller-preset-menu-locked muted">
                Starter preset — locked (not deletable). Save your own custom preset instead.
              </p>
            )}
            <button type="button" role="menuitem" onClick={() => setPresetMenu(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div
          className={`day-board-miller-result ${result.ok ? "is-ok" : "is-bad"}`}
          role="status"
        >
          <strong>{result.ok ? (result.dry_run ? "Dry-run OK" : "Created") : "Blocked"}</strong>
          <span>{result.message}</span>
          {result.st_job_number ? <span>Job #{result.st_job_number}</span> : null}
          {result.existing_jobs && result.existing_jobs.length ? (
            <ul className="day-board-miller-existing-list">
              {result.existing_jobs.map((j) => (
                <li key={j.job_id}>
                  #{j.job_number || j.job_id}
                  {j.job_type ? ` · ${j.job_type}` : ""}
                  {j.status ? ` · ${j.status}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {result.dry_run && result.enable_live_hint ? (
            <span className="muted" style={{ display: "block", fontSize: "0.82em" }}>
              {result.enable_live_hint}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

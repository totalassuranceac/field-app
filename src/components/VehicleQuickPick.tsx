import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";

/** Vehicle fields used when auto-filling forms from plate / unit lookup. */
export type VehicleMatch = {
  id: number;
  unit_number: string;
  plate?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  vin?: string | null;
  status?: string | null;
  current_odometer?: number | null;
  assigned_driver?: string | null;
  driver_name?: string | null;
  phone?: string | null;
  is_my_default?: boolean;
  driver_employee_id?: number | null;
};

function normalizePlate(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Rank local matches: exact plate > plate prefix > exact unit > unit prefix > includes. */
export function matchVehiclesLocal(
  list: VehicleMatch[],
  query: string,
  limit = 8
): VehicleMatch[] {
  const q = query.trim();
  if (q.length < 1) return [];
  const alnum = normalizePlate(q);
  const qLower = q.toLowerCase();

  const scored: { v: VehicleMatch; score: number }[] = [];
  for (const v of list) {
    const plate = normalizePlate(v.plate || "");
    const unit = (v.unit_number || "").toUpperCase();
    const unitLower = (v.unit_number || "").toLowerCase();
    const vin = normalizePlate(v.vin || "");
    let score = -1;

    if (alnum.length >= 2 && plate && plate === alnum) score = 0;
    else if (alnum.length >= 2 && plate && plate.startsWith(alnum)) score = 1;
    else if (unit === q.toUpperCase() || unit === alnum) score = 2;
    else if (unit.startsWith(q.toUpperCase()) || unit.startsWith(alnum)) score = 3;
    else if (alnum.length >= 3 && plate.includes(alnum)) score = 4;
    else if (unitLower.includes(qLower)) score = 5;
    else if (alnum.length >= 4 && vin.includes(alnum)) score = 6;
    else if (
      qLower.length >= 3 &&
      `${v.make || ""} ${v.model || ""}`.toLowerCase().includes(qLower)
    ) {
      score = 7;
    }

    if (score >= 0) scored.push({ v, score });
  }

  scored.sort((a, b) => a.score - b.score || a.v.unit_number.localeCompare(b.v.unit_number));
  return scored.slice(0, limit).map((s) => s.v);
}

function vehicleHeadline(v: VehicleMatch): string {
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return ymm || `Unit ${v.unit_number}`;
}

function vehicleDetailLine(v: VehicleMatch): string {
  const bits: string[] = [];
  bits.push(`Unit ${v.unit_number}`);
  if (v.plate) bits.push(v.plate);
  if (v.assigned_driver || v.driver_name) bits.push(String(v.assigned_driver || v.driver_name));
  if (v.current_odometer != null && Number.isFinite(Number(v.current_odometer))) {
    bits.push(`${Number(v.current_odometer).toLocaleString()} mi`);
  }
  return bits.join(" · ");
}

type Props = {
  /** Selected vehicle id as string (empty = none). */
  value: string;
  onChange: (vehicleId: string, vehicle: VehicleMatch | null) => void;
  /** Optional already-loaded list for instant match (no wait). */
  vehicles?: VehicleMatch[];
  required?: boolean;
  disabled?: boolean;
  /** Field label above the plate input */
  label?: string;
  placeholder?: string;
  /** Also show unit dropdown under the plate field */
  showDropdown?: boolean;
  id?: string;
};

/**
 * Type license plate (or unit #) → auto-select vehicle and show filled details.
 * Uses local list first, then /vehicles/lookup for full fleet.
 */
export function VehicleQuickPick({
  value,
  onChange,
  vehicles = [],
  required = false,
  disabled = false,
  label = "License plate or unit #",
  placeholder = "Type plate or unit…",
  showDropdown = true,
  id = "vehicle-quick-pick",
}: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VehicleMatch[]>([]);
  const [looking, setLooking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [picked, setPicked] = useState<VehicleMatch | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextLookup = useRef(false);

  // Sync display when parent value changes (e.g. default unit)
  useEffect(() => {
    if (!value) {
      if (!query) setPicked(null);
      return;
    }
    const fromList = vehicles.find((v) => String(v.id) === value);
    if (fromList) {
      setPicked(fromList);
      if (!query) {
        skipNextLookup.current = true;
        setQuery(fromList.plate || fromList.unit_number || "");
      }
      return;
    }
    // Value set but not in local list — keep picked if same id
    if (picked && String(picked.id) === value) return;
    void api<{ vehicles: VehicleMatch[] }>(
      `/vehicles/lookup?q=${encodeURIComponent(value)}`
    )
      .then((r) => {
        const hit = (r.vehicles || []).find((v) => String(v.id) === value) || r.vehicles?.[0];
        if (hit && String(hit.id) === value) {
          setPicked(hit);
          if (!query) {
            skipNextLookup.current = true;
            setQuery(hit.plate || hit.unit_number || "");
          }
        }
      })
      .catch(() => {
        /* ignore */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when value/list change
  }, [value, vehicles]);

  const runLookup = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (trimmed.length < 2) {
        setHits([]);
        setNotFound(false);
        setLooking(false);
        return;
      }

      const local = matchVehiclesLocal(vehicles, trimmed);
      if (local.length) {
        setHits(local);
        setNotFound(false);
        // Auto-select only on strong unique match
        if (
          local.length === 1 &&
          (normalizePlate(local[0].plate || "") === normalizePlate(trimmed) ||
            local[0].unit_number.toUpperCase() === trimmed.toUpperCase() ||
            normalizePlate(local[0].plate || "") === normalizePlate(trimmed))
        ) {
          selectVehicle(local[0], false);
        }
      }

      setLooking(true);
      try {
        const r = await api<{ vehicles: VehicleMatch[] }>(
          `/vehicles/lookup?q=${encodeURIComponent(trimmed)}`
        );
        const remote = r.vehicles || [];
        // Merge local + remote by id
        const byId = new Map<number, VehicleMatch>();
        for (const v of local) byId.set(v.id, v);
        for (const v of remote) byId.set(v.id, { ...byId.get(v.id), ...v });
        const merged = matchVehiclesLocal([...byId.values()], trimmed, 12);
        const finalList = merged.length ? merged : [...byId.values()].slice(0, 12);
        setHits(finalList);
        setNotFound(finalList.length === 0);

        if (finalList.length === 1) {
          const only = finalList[0];
          const plateN = normalizePlate(only.plate || "");
          const qN = normalizePlate(trimmed);
          if (
            (plateN && (plateN === qN || plateN.startsWith(qN)) && qN.length >= 3) ||
            only.unit_number.toUpperCase() === trimmed.toUpperCase()
          ) {
            selectVehicle(only, false);
          }
        }
      } catch {
        if (!local.length) setNotFound(true);
      } finally {
        setLooking(false);
      }
    },
    // selectVehicle defined below — use functional updates carefully
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicles]
  );

  function selectVehicle(v: VehicleMatch, updateQuery: boolean) {
    setPicked(v);
    setHits([]);
    setNotFound(false);
    if (updateQuery) {
      skipNextLookup.current = true;
      setQuery(v.plate || v.unit_number);
    }
    onChange(String(v.id), v);
  }

  function clearPick() {
    setPicked(null);
    setQuery("");
    setHits([]);
    setNotFound(false);
    onChange("", null);
  }

  function onQueryChange(raw: string) {
    const next = raw.toUpperCase();
    setQuery(next);
    if (skipNextLookup.current) {
      skipNextLookup.current = false;
      return;
    }
    // Typing over a previous pick clears selection until rematch
    if (picked) {
      setPicked(null);
      onChange("", null);
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runLookup(next), 280);
  }

  const sortedDropdown = useMemo(
    () =>
      vehicles
        .slice()
        .sort((a, b) =>
          a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true })
        ),
    [vehicles]
  );

  return (
    <div className="vehicle-quick-pick">
      <label className="vehicle-quick-pick-label" htmlFor={id}>
        {label}
        {required ? " *" : ""}
        <input
          id={id}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="search"
        />
      </label>

      {looking && (
        <p className="vehicle-quick-pick-status muted">Looking up vehicle…</p>
      )}

      {picked && (
        <div className="vehicle-quick-pick-match" role="status">
          <div className="vehicle-quick-pick-match-main">
            <strong>{vehicleHeadline(picked)}</strong>
            <span className="muted">{vehicleDetailLine(picked)}</span>
            {picked.vin ? (
              <span className="muted vehicle-quick-pick-vin">VIN {picked.vin}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={clearPick}
            disabled={disabled}
          >
            Clear
          </button>
        </div>
      )}

      {!picked && hits.length > 0 && (
        <ul className="vehicle-quick-pick-hits" role="listbox">
          {hits.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                className="vehicle-quick-pick-hit"
                onClick={() => selectVehicle(v, true)}
                disabled={disabled}
              >
                <strong>
                  Unit {v.unit_number}
                  {v.plate ? ` · ${v.plate}` : ""}
                </strong>
                <span className="muted">
                  {[v.year, v.make, v.model].filter(Boolean).join(" ") || "—"}
                  {v.assigned_driver || v.driver_name
                    ? ` · ${v.assigned_driver || v.driver_name}`
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!picked && notFound && query.trim().length >= 2 && !looking && (
        <p className="vehicle-quick-pick-status warning-text">
          No vehicle matched “{query.trim()}”. Check the plate or pick from the list.
        </p>
      )}

      {/* Hidden required input so native form validation works when needed */}
      {required && (
        <input
          tabIndex={-1}
          aria-hidden
          value={value}
          required
          onChange={() => {}}
          style={{
            position: "absolute",
            opacity: 0,
            height: 0,
            width: 0,
            pointerEvents: "none",
          }}
        />
      )}

      {showDropdown && sortedDropdown.length > 0 && (
        <label className="vehicle-quick-pick-dropdown-label">
          Or pick unit
          <select
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const idStr = e.target.value;
              if (!idStr) {
                clearPick();
                return;
              }
              const v =
                vehicles.find((x) => String(x.id) === idStr) ||
                hits.find((x) => String(x.id) === idStr) ||
                null;
              if (v) selectVehicle(v, true);
              else onChange(idStr, null);
            }}
          >
            <option value="">— Select unit —</option>
            {sortedDropdown.map((v) => (
              <option key={v.id} value={v.id}>
                {v.unit_number}
                {v.plate ? ` · ${v.plate}` : ""}
                {v.assigned_driver || v.driver_name
                  ? ` — ${v.assigned_driver || v.driver_name}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

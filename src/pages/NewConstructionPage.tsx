import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  KNOWN_GROUPS,
  TONNAGE_OPTIONS,
  addMonthsIso,
  applyRncTemplate,
  DEFAULT_SINGLE_TEMPLATE,
  DEFAULT_TWO_TEMPLATE,
  firstMissing,
  formReady,
  formatContract,
  isAzaliMiller,
  projectNameFromStreet,
  todayChicago,
  type Stories,
  type SysLoc,
} from "../lib/azaliRnc";

const LAST_CITY = "azali_rnc_city";
const LAST_ZIP = "azali_rnc_zip";
const LAST_STATE = "azali_rnc_state";
const LAST_GROUP = "azali_rnc_group";
const badBorder = { borderColor: "#b91c1c", outline: "2px solid #b91c1c" };

function readLast(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function NewConstructionPage() {
  const { user } = useAuth();
  const allowed = isAzaliMiller(user);
  const [flagOn, setFlagOn] = useState(false);
  const [ncBook, setNcBook] = useState(false);
  const [groups, setGroups] = useState<string[]>(KNOWN_GROUPS);
  const [singleTpl, setSingleTpl] = useState(DEFAULT_SINGLE_TEMPLATE);
  const [twoTpl, setTwoTpl] = useState(DEFAULT_TWO_TEMPLATE);
  const [manualFields, setManualFields] = useState<string[]>([]);
  const [contractNote, setContractNote] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState(() => readLast(LAST_CITY));
  const [state, setState] = useState(() => readLast(LAST_STATE, "TX"));
  const [zip, setZip] = useState(() => readLast(LAST_ZIP));
  const [group, setGroup] = useState(() => readLast(LAST_GROUP));
  const [newGroup, setNewGroup] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [stories, setStories] = useState<Stories | "">("");
  const [tons1, setTons1] = useState("");
  const [loc1, setLoc1] = useState<SysLoc | "">("");
  const [tons2, setTons2] = useState("");
  const [loc2, setLoc2] = useState<SysLoc | "">("");
  const [fans, setFans] = useState<number | null>(null);
  const [brand, setBrand] = useState("American Standard");
  const [contract, setContract] = useState("");
  const [notes, setNotes] = useState("");
  const [estimateNo, setEstimateNo] = useState("");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [descTouched, setDescTouched] = useState(false);
  const [error, setError] = useState("");
  const [bad, setBad] = useState("");
  const [estimateBanner, setEstimateBanner] = useState("");
  const [others, setOthers] = useState<{ id: number; number: string; status: string }[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ location?: number; project?: number | null; location_url?: string; project_url?: string | null } | null>(null);
  const [dupe, setDupe] = useState<{ id?: number; url?: string; error?: string } | null>(null);
  const streetRef = useRef<HTMLInputElement>(null);
  const cityRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const groupSelectRef = useRef<HTMLSelectElement>(null);
  const newGroupRef = useRef<HTMLInputElement>(null);
  const storiesRef = useRef<HTMLDivElement>(null);
  const sysRef = useRef<HTMLDivElement>(null);
  const fansRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!allowed) return;
    void api<{
      flag_on?: boolean;
      nc_book_enabled?: boolean;
      groups?: string[];
      single_template?: string;
      two_template?: string;
      manual_fields?: string[];
    }>("/new-construction/access")
      .then((d) => {
        setFlagOn(Boolean(d.flag_on));
        setNcBook(Boolean(d.nc_book_enabled));
        if (d.groups?.length) setGroups(Array.from(new Set([...KNOWN_GROUPS, ...d.groups])));
        if (d.single_template) setSingleTpl(d.single_template);
        if (d.two_template) setTwoTpl(d.two_template);
        setManualFields(d.manual_fields || []);
      })
      .catch(() => setFlagOn(false));
  }, [allowed]);

  const start = todayChicago();
  const target = addMonthsIso(start, 6);
  const ready = formReady({ street, city, zip, group, stories, tons1, loc1, tons2, loc2, fans });
  const built = useMemo(() => {
    const tpl = stories === "two" ? twoTpl : singleTpl;
    return applyRncTemplate(tpl, { tons1, loc1, tons2, loc2, fans, brand });
  }, [stories, twoTpl, singleTpl, tons1, loc1, tons2, loc2, fans, brand]);

  useEffect(() => {
    if (!nameTouched) setProjectName(projectNameFromStreet(street));
  }, [street, nameTouched]);
  useEffect(() => {
    if (!descTouched) setDescription(built);
  }, [built, descTouched]);

  function changeStories(next: Stories) {
    setStories(next);
    setTons1("");
    setLoc1("");
    setTons2("");
    setLoc2("");
    if (bad === "stories") setBad("");
  }

  function bumpFans(dir: -1 | 1) {
    setFans((cur) => {
      if (cur == null) return dir === 1 ? 1 : 0;
      return Math.max(0, Math.min(10, cur + dir));
    });
    fansRef.current?.focus();
  }

  function remember() {
    try {
      localStorage.setItem(LAST_CITY, city);
      localStorage.setItem(LAST_ZIP, zip);
      localStorage.setItem(LAST_STATE, state);
      localStorage.setItem(LAST_GROUP, group);
    } catch {
      /* ignore */
    }
  }

  function showMissing() {
    const miss = firstMissing({ street, city, zip, group, stories, tons1, loc1, tons2, loc2, fans });
    setBad(miss);
    const labels: Record<string, string> = {
      street: "Street is required",
      city: "City is required",
      zip: "ZIP is required",
      group: "Pick the subdivision",
      stories: "Pick single story or two story",
      tons1: "Pick the tonnage",
      loc1: "Pick the air handler location",
      tons2: "Pick the 2nd floor tonnage",
      loc2: "Pick the 2nd floor location",
      fans: "Set the exhaust fan count",
    };
    setError(labels[miss] || "Fill the required fields");
    if (miss === "street") streetRef.current?.focus();
    if (miss === "city") cityRef.current?.focus();
    if (miss === "zip") zipRef.current?.focus();
    if (miss === "group") {
      groupRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (addingGroup) newGroupRef.current?.focus({ preventScroll: true });
      else groupSelectRef.current?.focus({ preventScroll: true });
    }
    if (miss === "stories") {
      storiesRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      storiesRef.current?.focus({ preventScroll: true });
    }
    if (miss === "tons1" || miss === "loc1" || miss === "tons2" || miss === "loc2") {
      sysRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      sysRef.current?.focus({ preventScroll: true });
    }
    if (miss === "fans") fansRef.current?.focus();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setError("");
    } catch {
      setError("Could not copy. Select the text and copy it.");
    }
  }

  async function checkEstimate() {
    if (!estimateNo.trim() || !flagOn) return;
    try {
      const d = await api<{
        found?: boolean;
        approved?: boolean;
        status?: string;
        others?: { id: number; number: string; status: string }[];
        error?: string;
      }>("/new-construction/estimate-check", {
        method: "POST",
        body: JSON.stringify({ estimate_no: estimateNo.trim() }),
      });
      if (d.error) {
        setEstimateBanner(d.error);
        return;
      }
      if (!d.found) {
        setEstimateBanner("Estimate was not found in ServiceTitan");
        setOthers([]);
        return;
      }
      setEstimateBanner(d.approved ? "" : "Not approved in ServiceTitan yet");
      setOthers(d.others || []);
    } catch (e) {
      setEstimateBanner(e instanceof Error ? e.message : "Estimate check failed");
    }
  }

  async function createInSt() {
    if (!ready) {
      showMissing();
      return;
    }
    setBusy(true);
    setDupe(null);
    remember();
    try {
      const d = await api<{
        ok?: boolean;
        error?: string;
        existing_location_id?: number;
        existing_location_url?: string;
        st_location_id?: number;
        st_project_id?: number | null;
        location_url?: string;
        project_url?: string | null;
      }>("/new-construction/create", {
        method: "POST",
        body: JSON.stringify({
          street,
          city,
          state,
          zip,
          group,
          stories,
          tons1,
          loc1,
          tons2,
          loc2,
          fans,
          brand,
          contract: formatContract(contract).ok ? formatContract(contract).text : contract,
          notes,
          project_name: projectName,
          description,
          start_date: start,
          target_date: target,
          estimate_no: estimateNo,
          confirm: true,
        }),
      });
      if (d.existing_location_id) {
        setDupe({ id: d.existing_location_id, url: d.existing_location_url, error: d.error });
        setConfirming(false);
        return;
      }
      if (!d.ok) {
        setError(d.error || "Create failed");
        return;
      }
      setResult({
        location: d.st_location_id,
        project: d.st_project_id,
        location_url: d.location_url,
        project_url: d.project_url,
      });
      setConfirming(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  function tons(value: string, set: (v: string) => void, field: string) {
    return (
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        {TONNAGE_OPTIONS.map((t) => (
          <button
            key={t}
            type="button"
            className={value === t ? "btn btn-sm" : "btn secondary btn-sm"}
            onClick={() => {
              set(t);
              if (bad === field) setBad("");
            }}
          >
            {t}
          </button>
        ))}
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="page">
        <h1>New Azali house</h1>
        <p className="error">This page is for admin and Miller only.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>New Azali house</h1>
          <p className="muted">Location and project only. Rough In stays a manual book.</p>
        </div>
      </header>

      <label>
        Street
        <input ref={streetRef} value={street} onChange={(e) => setStreet(e.target.value)} autoComplete="street-address" style={bad === "street" ? badBorder : undefined} />
      </label>
      <div className="toolbar" style={{ gap: "0.5rem" }}>
        <label style={{ flex: 1 }}>
          City
          <input ref={cityRef} value={city} onChange={(e) => setCity(e.target.value)} style={bad === "city" ? badBorder : undefined} />
        </label>
        <label style={{ width: "5rem" }}>
          State
          <input value={state} onChange={(e) => setState(e.target.value)} />
        </label>
        <label style={{ width: "7rem" }}>
          ZIP
          <input ref={zipRef} value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" style={bad === "zip" ? badBorder : undefined} />
        </label>
      </div>

      <div ref={groupRef} style={{ marginTop: "0.75rem", outline: bad === "group" ? "2px solid #b91c1c" : undefined, borderRadius: 8 }}>
        <div className="muted">Subdivision</div>
        <select
          ref={groupSelectRef}
          value={addingGroup ? "__new" : group}
          onChange={(e) => {
            if (bad === "group") setBad("");
            if (e.target.value === "__new") {
              setAddingGroup(true);
              setGroup("");
              return;
            }
            setAddingGroup(false);
            setGroup(e.target.value);
          }}
          style={bad === "group" ? badBorder : undefined}
        >
          <option value="">Select subdivision</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
          <option value="__new">Add new...</option>
        </select>
        {addingGroup ? (
          <label>
            New subdivision
            <input
              ref={newGroupRef}
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onBlur={() => {
                const name = newGroup.trim();
                if (!name) return;
                setGroups((cur) => (cur.includes(name) ? cur : [...cur, name]));
                setGroup(name);
              }}
            />
          </label>
        ) : null}
      </div>

      <div
        ref={storiesRef}
        tabIndex={-1}
        style={{ marginTop: "0.75rem", outline: bad === "stories" ? "2px solid #b91c1c" : undefined, borderRadius: 8 }}
      >
        <div className="muted">Stories</div>
        <div className="toolbar" style={{ marginTop: "0.35rem" }}>
          <button type="button" className={stories === "single" ? "btn" : "btn secondary"} onClick={() => changeStories("single")}>
            Single story
          </button>
          <button type="button" className={stories === "two" ? "btn" : "btn secondary"} onClick={() => changeStories("two")}>
            Two story
          </button>
        </div>
      </div>

      <div
        ref={sysRef}
        tabIndex={-1}
        style={{
          marginTop: "0.75rem",
          outline: bad === "tons1" || bad === "loc1" || bad === "tons2" || bad === "loc2" ? "2px solid #b91c1c" : undefined,
          borderRadius: 8,
        }}
      >
        {stories === "single" ? (
          <>
            <div className="muted">System</div>
            {tons(tons1, setTons1, "tons1")}
            <div className="toolbar" style={{ marginTop: "0.35rem" }}>
              <button type="button" className={loc1 === "attic" ? "btn btn-sm" : "btn secondary btn-sm"} onClick={() => { setLoc1("attic"); if (bad === "loc1") setBad(""); }}>Attic</button>
              <button type="button" className={loc1 === "closet" ? "btn btn-sm" : "btn secondary btn-sm"} onClick={() => { setLoc1("closet"); if (bad === "loc1") setBad(""); }}>Closet</button>
            </div>
          </>
        ) : null}
        {stories === "two" ? (
          <>
            <div className="muted">1st floor system</div>
            {tons(tons1, setTons1, "tons1")}
            <div className="toolbar" style={{ marginTop: "0.35rem" }}>
              <button type="button" className={loc1 === "attic" ? "btn btn-sm" : "btn secondary btn-sm"} onClick={() => { setLoc1("attic"); if (bad === "loc1") setBad(""); }}>Attic</button>
              <button type="button" className={loc1 === "closet" ? "btn btn-sm" : "btn secondary btn-sm"} onClick={() => { setLoc1("closet"); if (bad === "loc1") setBad(""); }}>Closet</button>
            </div>
            <div className="muted" style={{ marginTop: "0.6rem" }}>2nd floor system</div>
            {tons(tons2, setTons2, "tons2")}
            <div className="toolbar" style={{ marginTop: "0.35rem" }}>
              <button type="button" className={loc2 === "second_attic" ? "btn btn-sm" : "btn secondary btn-sm"} onClick={() => { setLoc2("second_attic"); if (bad === "loc2") setBad(""); }}>2nd floor attic</button>
              <button type="button" className={loc2 === "closet" ? "btn btn-sm" : "btn secondary btn-sm"} onClick={() => { setLoc2("closet"); if (bad === "loc2") setBad(""); }}>Closet</button>
            </div>
          </>
        ) : null}
      </div>

      <div ref={fansRef} tabIndex={-1} style={{ marginTop: "0.75rem", outline: bad === "fans" ? "2px solid #b91c1c" : undefined, borderRadius: 8 }}>
        <div className="muted">Exhaust fans</div>
        <div className="toolbar" style={{ marginTop: "0.35rem", alignItems: "center" }}>
          <button type="button" className="btn secondary" onClick={() => bumpFans(-1)}>-</button>
          <strong style={{ minWidth: "2rem", textAlign: "center" }}>{fans == null ? "Set" : fans}</strong>
          <button type="button" className="btn secondary" onClick={() => bumpFans(1)}>+</button>
        </div>
      </div>

      <label style={{ marginTop: "0.75rem" }}>
        Equipment brand
        <input value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>
      <label>
        Contract amount (optional)
        <input
          value={contract}
          onChange={(e) => {
            setContract(e.target.value);
            setContractNote("");
          }}
          onBlur={() => {
            if (!contract.trim()) {
              setContractNote("");
              return;
            }
            const parsed = formatContract(contract);
            setContract(parsed.text);
            setContractNote(parsed.ok ? "" : "Check amount");
          }}
          placeholder="$00,000.00"
          inputMode="decimal"
        />
      </label>
      {contractNote ? <p className="error">{contractNote}</p> : null}
      <label>
        Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </label>
      <label>
        Estimate # (optional)
        <input value={estimateNo} onChange={(e) => setEstimateNo(e.target.value)} onBlur={() => void checkEstimate()} />
      </label>
      {estimateBanner ? <div className="error">{estimateBanner}</div> : null}
      {others.length > 0 ? (
        <div className="card">
          <strong>Close these out</strong>
          <ul>
            {others.map((o) => (
              <li key={o.id}>
                <a href={`https://go.servicetitan.com/#/estimate/${o.id}`} target="_blank" rel="noreferrer">{o.number}</a>
                {" - "}{o.status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="card" style={{ marginTop: "0.9rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Preview</h2>
        <label>
          Name
          <input value={projectName} onChange={(e) => { setNameTouched(true); setProjectName(e.target.value); }} />
        </label>
        <p className="muted">Start {start}. Target completion {target}. Contract date stays blank. Status Scheduled.</p>
        <label>
          Description
          <textarea rows={6} value={description} onChange={(e) => { setDescTouched(true); setDescription(e.target.value); }} />
        </label>
        <div className="toolbar">
          <button type="button" className="btn secondary btn-sm" onClick={() => void copy(projectName)}>Copy name</button>
          <button type="button" className="btn secondary btn-sm" onClick={() => void copy(description)}>Copy description</button>
        </div>
      </section>

      {error ? <div className="error" style={{ marginTop: "0.75rem" }}>{error}</div> : null}
      {dupe ? (
        <div className="error">
          {dupe.error}{" "}
          {dupe.url ? <a href={dupe.url} target="_blank" rel="noreferrer">Open location {dupe.id}</a> : null}
        </div>
      ) : null}

      {flagOn ? (
        <div
          className="toolbar"
          style={{ marginTop: "0.75rem" }}
          onClick={() => {
            if (!ready) showMissing();
          }}
        >
          <button
            type="button"
            className="btn"
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation();
              setError("");
              setConfirming(true);
            }}
          >
            Create in ServiceTitan
          </button>
        </div>
      ) : (
        <p className="muted">ServiceTitan create is off. Copy the name and description into ServiceTitan.</p>
      )}

      {confirming ? (
        <section className="card" style={{ marginTop: "0.75rem" }}>
          <h2 style={{ fontSize: "1.05rem" }}>This will be written</h2>
          <p>Location {projectName} on Azali Homes. Invoice signature required. Non-taxable. No tags. Preferred tech none. No membership.</p>
          <p>{street}, {city}, {state} {zip}. Group: {group}.</p>
          <p>Project type New Construction. Business unit Residential Construction. Manager Chris Miller. Tag construction. Status Scheduled.</p>
          <p>Start {start}. Target {target}. Contract {contract ? (formatContract(contract).ok ? formatContract(contract).text : contract) : "blank"}.</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{description}</p>
          <p className="muted">No Rough In job is booked.</p>
          {manualFields.length ? (
            <p className="muted">Set by hand in ST: {manualFields.join(", ")}.</p>
          ) : null}
          {ncBook ? (
            <p>
              <Link to={`/install-book?nc=rough&street=${encodeURIComponent(street)}`}>Book Rough In</Link>
              {" · "}
              <Link to={`/install-book?nc=final&street=${encodeURIComponent(street)}`}>Book Final</Link>
            </p>
          ) : null}
          <div className="toolbar">
            <button type="button" className="btn" disabled={busy} onClick={() => void createInSt()}>{busy ? "Creating..." : "Confirm create"}</button>
            <button type="button" className="btn secondary" onClick={() => setConfirming(false)}>Back</button>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className="card">
          <strong>Created</strong>
          <p>Location {result.location} {result.location_url ? <a href={result.location_url} target="_blank" rel="noreferrer">open</a> : null}</p>
          <p>Project {result.project || "?"} {result.project_url ? <a href={result.project_url} target="_blank" rel="noreferrer">open</a> : null}</p>
        </section>
      ) : null}
    </div>
  );
}

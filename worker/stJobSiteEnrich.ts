/**
 * Shared ST job-site enrich for tech Today (Job Clock) and (optionally) Day Board.
 * CRM Locations often 403 on this tenant - Accounting invoices are the reliable street source.
 * Soft-fail all CRM/invoice calls; never invent addresses or phones.
 */

import type { Env } from "./types";
import { stApiGet } from "./servicetitan";

function looksLikeStreet(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || t.length < 4) return false;
  if (/^\d{1,6}[A-Za-z]?\s+\S/.test(t)) return true;
  if (/^(p\.?\s*o\.?\s*box|hwy|fm|ih|us|rr|cr)\b/i.test(t)) return true;
  return false;
}

function parseLeadingStreet(raw: unknown): string | null {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const spaced = s.match(/^(.+?)\s+[–—\-]\s+/);
  if (spaced) s = spaced[1].trim();
  else {
    const tight = s.match(
      /^(\d{1,6}[A-Za-z]?\s+[A-Za-z][A-Za-z0-9.'/# ]*?)\s*[–—\-]\s*[A-Za-z]/
    );
    if (tight) s = tight[1].trim();
  }
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!looksLikeStreet(s)) return null;
  if (s.length > 80) s = s.slice(0, 80).trim();
  return s;
}

function cleanStreet(raw: unknown): string | null {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  return s || null;
}

export function streetFromAddressShape(
  loc: unknown
): { street: string; source: string } | null {
  if (!loc) return null;
  if (typeof loc === "string") {
    const direct = cleanStreet(loc);
    if (direct && looksLikeStreet(direct)) {
      return { street: direct, source: "string" };
    }
    const parsed = parseLeadingStreet(loc);
    if (parsed) return { street: parsed, source: "string.leadingStreet" };
    return null;
  }
  if (typeof loc !== "object") return null;
  const o = loc as Record<string, unknown>;
  if (o.address && typeof o.address === "object") {
    const nested = streetFromAddressShape(o.address);
    if (nested) {
      return { street: nested.street, source: `address.${nested.source}` };
    }
  }
  const street = cleanStreet(
    o.street ||
      o.streetAddress ||
      o.addressLine1 ||
      o.line1 ||
      o.Address ||
      o.address1 ||
      ""
  );
  if (street) {
    const city = cleanStreet(o.city) || "";
    if (street.length < 12 && city) {
      return { street: `${street}, ${city}`, source: "street+city" };
    }
    return { street, source: "street" };
  }
  const nameParsed = parseLeadingStreet(o.name || o.customerName || "");
  if (nameParsed) return { street: nameParsed, source: "name.leadingStreet" };
  return null;
}

function jpmCustomerName(job: Record<string, unknown>): string | null {
  if (typeof job.customerName === "string" && job.customerName.trim()) {
    return job.customerName.trim();
  }
  if (job.customer && typeof job.customer === "object") {
    const name = (job.customer as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

function jobHasStreet(job: Record<string, unknown>): boolean {
  if (streetFromAddressShape(job._resolvedLocation)) return true;
  if (streetFromAddressShape(job.location)) return true;
  if (streetFromAddressShape(job.address)) return true;
  if (streetFromAddressShape(job.locationAddress)) return true;
  if (typeof job.locationAddress === "string" && looksLikeStreet(job.locationAddress)) {
    return true;
  }
  if (typeof job.address === "string" && looksLikeStreet(job.address)) return true;
  return false;
}

async function enrichLocations(
  env: Env,
  db: D1Database,
  tenantId: string,
  locationIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  const ids = [...new Set(locationIds.filter((n) => n > 0))];
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(
      env,
      db,
      `/crm/v2/tenant/${tenantId}/locations?${q.toString()}`
    );
    if (!res.ok) continue; // often 403 - invoice fallback covers it
    const body = res.json as { data?: Record<string, unknown>[] };
    for (const row of body.data || []) {
      const id = Number(row.id);
      if (id > 0) map.set(id, row);
    }
  }
  return map;
}

type InvoiceSiteInfo = {
  street: string | null;
  source: string | null;
  raw: Record<string, unknown> | null;
  customerName: string | null;
};

/** Invoice customer name. A street-shaped string is not a name. */
function invoiceCustomerName(inv: Record<string, unknown>): string | null {
  const custObj =
    inv.customer && typeof inv.customer === "object"
      ? (inv.customer as Record<string, unknown>)
      : null;
  const fromObj = custObj && typeof custObj.name === "string" ? custObj.name.trim() : "";
  const fromField = typeof inv.customerName === "string" ? inv.customerName.trim() : "";
  if (fromObj && !looksLikeStreet(fromObj)) return fromObj;
  if (fromField && !looksLikeStreet(fromField)) return fromField;
  return null;
}

async function enrichInvoiceAddresses(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<Map<number, InvoiceSiteInfo>> {
  const map = new Map<number, InvoiceSiteInfo>();
  const ids = [...new Set(jobIds.filter((n) => n > 0))];
  if (!ids.length) return map;

  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (jobId) => {
        const q = new URLSearchParams({
          jobId: String(jobId),
          pageSize: "5",
        });
        const res = await stApiGet(
          env,
          db,
          `/accounting/v2/tenant/${tenantId}/invoices?${q.toString()}`
        );
        if (!res.ok) return;
        const body = res.json as { data?: Record<string, unknown>[] };
        let customerName: string | null = null;
        let street: string | null = null;
        let source: string | null = null;
        let raw: Record<string, unknown> | null = null;
        for (const inv of body.data || []) {
          if (!customerName) {
            const name = invoiceCustomerName(inv);
            if (name) customerName = name;
          }
          if (street) continue;
          const locAddr = streetFromAddressShape(inv.locationAddress);
          if (locAddr) {
            street = locAddr.street;
            source = `invoice.locationAddress.${locAddr.source}`;
            raw =
              inv.locationAddress && typeof inv.locationAddress === "object"
                ? (inv.locationAddress as Record<string, unknown>)
                : { street: locAddr.street };
            continue;
          }
          const locName = streetFromAddressShape(inv.location);
          if (locName) {
            street = locName.street;
            source = `invoice.location.${locName.source}`;
            raw =
              inv.location && typeof inv.location === "object"
                ? (inv.location as Record<string, unknown>)
                : { street: locName.street };
            continue;
          }
          const cust = streetFromAddressShape(inv.customerAddress);
          if (cust) {
            street = cust.street;
            source = `invoice.customerAddress.${cust.source}`;
            raw =
              inv.customerAddress && typeof inv.customerAddress === "object"
                ? (inv.customerAddress as Record<string, unknown>)
                : { street: cust.street };
          }
        }
        if (street || customerName) {
          map.set(jobId, { street, source, raw, customerName });
        }
      })
    );
  }
  return map;
}

/**
 * JPM jobs + CRM location (soft-fail) + invoice locationAddress.
 * Mutates jobs with `_resolvedLocation` + `_addressSource`.
 */
export async function enrichJobsWithSite(
  env: Env,
  db: D1Database,
  tenantId: string,
  jobIds: number[]
): Promise<Map<number, Record<string, unknown>>> {
  const map = new Map<number, Record<string, unknown>>();
  const ids = [...new Set(jobIds.filter((n) => n > 0))];
  if (!ids.length) return map;

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = new URLSearchParams({
      ids: chunk.join(","),
      pageSize: String(Math.max(chunk.length, 10)),
    });
    const res = await stApiGet(env, db, `/jpm/v2/tenant/${tenantId}/jobs?${q.toString()}`);
    if (!res.ok) continue;
    const body = res.json as { data?: Record<string, unknown>[] };
    for (const row of body.data || []) {
      const id = Number(row.id);
      if (id > 0) map.set(id, row);
    }
  }

  const needLoc: number[] = [];
  for (const job of map.values()) {
    if (jobHasStreet(job)) continue;
    const lid = Number(job.locationId);
    if (lid > 0) needLoc.push(lid);
  }
  if (needLoc.length) {
    const locMap = await enrichLocations(env, db, tenantId, needLoc);
    for (const job of map.values()) {
      if (jobHasStreet(job)) continue;
      const lid = Number(job.locationId);
      const loc = lid > 0 ? locMap.get(lid) : undefined;
      if (!loc) continue;
      const got = streetFromAddressShape(loc);
      if (got) {
        job._resolvedLocation = loc;
        job._addressSource = `crm.location.${got.source}`;
      }
    }
  }

  const needInv: number[] = [];
  for (const [id, job] of map) {
    if (jobHasStreet(job) && jpmCustomerName(job)) continue;
    needInv.push(id);
  }
  if (needInv.length) {
    const invMap = await enrichInvoiceAddresses(env, db, tenantId, needInv);
    for (const [id, info] of invMap) {
      const job = map.get(id);
      if (!job) continue;
      if (!jobHasStreet(job) && info.street) {
        job._resolvedLocation = info.raw;
        job._addressSource = info.source;
      }
      if (info.customerName) job._invoiceCustomerName = info.customerName;
    }
  }

  return map;
}

export function customerPhoneFromRecord(a: Record<string, unknown>): string | null {
  const direct =
    (typeof a.customerPhone === "string" && a.customerPhone) ||
    (typeof a.phone === "string" && a.phone) ||
    (typeof a.mobilePhone === "string" && a.mobilePhone) ||
    "";
  if (direct.trim()) return direct.trim();
  const cust =
    a.customer && typeof a.customer === "object"
      ? (a.customer as Record<string, unknown>)
      : null;
  if (cust) {
    for (const k of ["phone", "mobilePhone", "mobile", "primaryPhone"]) {
      const v = cust[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

type StContact = { id?: number; type?: string; value?: string };

function phoneFromContacts(rows: StContact[] | undefined | null): string | null {
  if (!rows?.length) return null;
  let mobile: string | null = null;
  let phone: string | null = null;
  for (const c of rows) {
    const typ = String(c.type || "").toLowerCase();
    const val = typeof c.value === "string" ? c.value.trim() : "";
    if (!val) continue;
    if (typ === "mobilephone" || typ === "mobile") {
      if (!mobile) mobile = val;
    } else if (typ === "phone" || typ === "landline" || typ === "home" || typ === "work") {
      if (!phone) phone = val;
    }
  }
  return mobile || phone;
}

/** CRM customer + location contacts. Soft-fail 403. */
export async function enrichCrmPhones(
  env: Env,
  db: D1Database,
  tenantId: string,
  customerIds: number[],
  locationIds: number[]
): Promise<{ byCustomerId: Map<number, string>; byLocationId: Map<number, string> }> {
  const byCustomerId = new Map<number, string>();
  const byLocationId = new Map<number, string>();
  const custIds = [...new Set(customerIds.filter((n) => n > 0))];
  const locIds = [...new Set(locationIds.filter((n) => n > 0))];
  const CONCURRENCY = 6;

  async function pull(kind: "customer" | "location", id: number): Promise<void> {
    const path =
      kind === "customer"
        ? `/crm/v2/tenant/${tenantId}/customers/${id}/contacts`
        : `/crm/v2/tenant/${tenantId}/locations/${id}/contacts`;
    const res = await stApiGet(env, db, path);
    if (!res.ok) return;
    const body = res.json as { data?: StContact[] };
    const phone = phoneFromContacts(body.data || []);
    if (!phone) return;
    if (kind === "customer") byCustomerId.set(id, phone);
    else byLocationId.set(id, phone);
  }

  for (let i = 0; i < locIds.length; i += CONCURRENCY) {
    await Promise.all(locIds.slice(i, i + CONCURRENCY).map((id) => pull("location", id)));
  }
  for (let i = 0; i < custIds.length; i += CONCURRENCY) {
    await Promise.all(custIds.slice(i, i + CONCURRENCY).map((id) => pull("customer", id)));
  }
  return { byCustomerId, byLocationId };
}

/** CRM customer name by id when JPM omits customerName. Soft-fail. */
export async function enrichCustomerNames(
  env: Env,
  db: D1Database,
  tenantId: string,
  customerIds: number[]
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const ids = [...new Set(customerIds.filter((n) => n > 0))];
  const CONCURRENCY = 6;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    await Promise.all(
      ids.slice(i, i + CONCURRENCY).map(async (id) => {
        const res = await stApiGet(env, db, `/crm/v2/tenant/${tenantId}/customers/${id}`);
        if (!res.ok || !res.json || typeof res.json !== "object") return;
        const row = res.json as Record<string, unknown>;
        const name =
          (typeof row.name === "string" && row.name.trim()) ||
          (typeof row.customerName === "string" && row.customerName.trim()) ||
          "";
        if (name) map.set(id, name);
      })
    );
  }
  return map;
}

/** Prefer tech-useful dispatch notes; skip address-only streets as note body. */
export function dispatchNote(raw: unknown, max = 400): string | null {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const leading = parseLeadingStreet(s);
  if (leading) {
    const escaped = leading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = s
      .replace(new RegExp("^" + escaped + "\\s*[–—\\-]\\s*", "i"), "")
      .trim();
    if (stripped && !looksLikeStreet(stripped)) {
      s = stripped;
    } else if (looksLikeStreet(s) || s.length <= leading.length + 3) {
      return null;
    }
  } else if (looksLikeStreet(s) && s.length <= 80 && !/[;:]/.test(s)) {
    return null;
  }
  if (s.length > max) return `${s.slice(0, max - 1)}…`;
  return s;
}

/**
 * Soft extract gate/entry/lockbox from specialInstructions or customFields.
 * Returns null when nothing clear - never invent.
 */
export function extractAccessCode(opts: {
  specialInstructions?: unknown;
  notes?: unknown;
  customFields?: Array<{ name?: string; value?: string }> | unknown;
}): string | null {
  const cf = Array.isArray(opts.customFields) ? opts.customFields : [];
  for (const row of cf) {
    if (!row || typeof row !== "object") continue;
    const r = row as { name?: string; value?: string };
    const name = String(r.name || "").toLowerCase();
    const val = typeof r.value === "string" ? r.value.trim() : "";
    if (!val) continue;
    if (
      /gate|entry|access|lock\s*box|lockbox|door\s*code|gate\s*code|keypad|alarm/.test(name)
    ) {
      return val.length > 80 ? val.slice(0, 80) : val;
    }
  }
  const blobs = [opts.specialInstructions, opts.notes]
    .map((x) => String(x || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const text of blobs) {
    const m = text.match(
      /(?:gate\s*(?:code)?|entry\s*(?:code)?|access\s*(?:code)?|lock\s*box|lockbox|door\s*code|keypad|code)\s*[:=\-#]?\s*([A-Za-z0-9][A-Za-z0-9#\-* ]{1,24})/i
    );
    if (m && m[1]) {
      const code = m[1].trim().replace(/[.,;]+$/, "");
      if (code && !looksLikeStreet(code)) return code;
    }
  }
  return null;
}

export function resolveCustomerId(
  job?: Record<string, unknown> | null,
  appt?: Record<string, unknown> | null
): number {
  const from = (o?: Record<string, unknown> | null): number => {
    if (!o) return 0;
    const direct = Number(o.customerId);
    if (direct > 0) return direct;
    if (o.customer && typeof o.customer === "object") {
      const id = Number((o.customer as Record<string, unknown>).id);
      if (id > 0) return id;
    }
    return 0;
  };
  return from(job) || from(appt) || 0;
}

export function resolveLocationId(
  job?: Record<string, unknown> | null,
  appt?: Record<string, unknown> | null
): number {
  const from = (o?: Record<string, unknown> | null): number => {
    if (!o) return 0;
    const direct = Number(o.locationId);
    if (direct > 0) return direct;
    if (o.location && typeof o.location === "object") {
      const id = Number((o.location as Record<string, unknown>).id);
      if (id > 0) return id;
    }
    return 0;
  };
  return from(job) || from(appt) || 0;
}

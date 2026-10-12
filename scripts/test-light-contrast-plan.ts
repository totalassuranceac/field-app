// Run: npx esbuild scripts/test-light-contrast-plan.ts --bundle --platform=node --format=esm --outfile=tmp-light-contrast-test.mjs; node tmp-light-contrast-test.mjs
import { readFileSync } from "node:fs";

let fails = 0, n = 0;
function check(name: string, ok: boolean, got?: unknown) {
  n++;
  if (ok) console.log("PASS", name);
  else { fails++; console.log("FAIL", name, got === undefined ? "" : JSON.stringify(got)); }
}
const hex = (h: string) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = (rgb: number[]) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
const cr = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (c: string, p: number, base = "#ffffff") => { const a = hex(c), b = hex(base); return a.map((v, i) => Math.round(v * p + b[i] * (1 - p))); };

const css = readFileSync("src/styles.css", "utf8");
const start = css.indexOf("2026-10-02 light-mode contrast (Field App)");
const end = css.indexOf("end 2026-10-02 light-mode contrast");
check("light block present once", start > 0 && end > start && css.indexOf("2026-10-02 light-mode contrast (Field App)", start + 10) < 0);
const block = css.slice(start, end);

// 1) tokens exist in the light token block and pass AA on white, page bg and a 28% tint of their hue
const TOKENS: Record<string, [string, string]> = {
  "--ink-ok": ["#05603a", "#22c55e"], "--ink-warn": ["#93370d", "#f59e0b"], "--ink-bad": ["#912018", "#ef4444"],
  "--ink-info": ["#1849a9", "#3b82f6"], "--ink-violet": ["#6b21a8", "#a855f7"], "--ink-cyan": ["#155e75", "#06b6d4"], "--ink-slate": ["#475569", "#64748b"],
};
const head = css.slice(0, css.indexOf('[data-theme="dark"]'));
for (const [tok, [val, hue]] of Object.entries(TOKENS)) {
  check(`${tok} defined in light block`, new RegExp(`${tok}:\\s*${val}`, "i").test(head));
  const worst = Math.min(cr(hex(val), hex("#ffffff")), cr(hex(val), hex("#f0f3f6")), cr(hex(val), mix(hue, 0.28)));
  check(`${tok} >= 4.5 (worst ${worst.toFixed(2)})`, worst >= 4.5);
}
for (const [v, hue] of [["#735600", "#c9a227"], ["#854d0e", "#eab308"]] as const)
  check(`${v} >= 4.5`, Math.min(cr(hex(v), hex("#ffffff")), cr(hex(v), hex("#f0f3f6")), cr(hex(v), mix(hue, 0.28))) >= 4.5);
check("white on #c2410c >= 4.5", cr(hex("#ffffff"), hex("#c2410c")) >= 4.5);

// 2) every selector from the fix list is covered in the block
const FIX = [".feedback-status.st-reviewed", ".feedback-status.st-done", ".inv-vendor-remove:hover", ".pickup-addr-vendor",
  ".bottle-total-chip .full", ".bottle-loc-peek .full", ".bottle-loc-counts .full", ".bottle-total-chip .empty", ".bottle-loc-peek .empty", ".bottle-loc-counts .empty",
  ".asset-loc-needs", ".log-item-badge-needs", ".yard-auto-shop-hint", ".log-item-badge.confirm-badge.is-confirmed", ".log-item-badge.confirm-badge.is-declined",
  ".schedule-confirm-ok", ".confirm-text-ok", ".confirm-text-bad", ".confirm-text-pending", ".warranty-need-photo", ".warranty-status-approved",
  ".warranty-status-rejected", ".warranty-status-not_warranty", ".warranty-status-return_to_vendor", ".warranty-status-delivered", ".msg-delete-btn",
  ".warranty-days.overdue", ".warranty-days.urgent", ".topbar-fav-btn.is-on", ".home-focus-count-n", ".home-focus-count.is-clear .home-focus-count-label",
  ".review-stars", ".vendor-run-sheet-hero strong", ".vendor-run-sheet-tally", ".vendor-run-sheet-qty", ".vendor-run-sheet-part.is-bulk .vendor-run-sheet-qty",
  ".vendor-run-sheet-part.is-warranty-return .vendor-run-sheet-qty", ".vendor-run-chip-later", ".vendor-run-sheet-later-tag", ".vendor-run-sheet-arrives",
  ".vendor-run-chip-return", ".vendor-run-sheet-takeback", ".pp-arrives-pill", ".pp-ready-pill", ".pp-ticket-badge.st-open", ".pp-ticket-badge.st-partial",
  ".pp-ticket-badge.st-done", ".pp-status-pill.st-picked", ".pp-status-pill.st-not_ready", ".pp-status-pill.st-partial", ".pp-status-pill.st-cancelled",
  ".pp-status-pill.st-voided", ".pp-not-needed-btn", ".pp-void-btn", ".tsc-status.st-open", ".tsc-status.st-submitted", ".tsc-status.st-applied",
  ".onboard-field-hint", ".job-clock-policy strong", ".job-clock-check", ".ops-name-btn", ".ops-delta.is-up", ".ops-delta.is-down", ".vendor-history-sep",
  ".pto-hist-hrs-use", ".pto-emp-history .pto-neg", ".pto-emp-history-hrs.use", ".pto-hist-hrs-credit", ".pto-emp-history .pto-pos", ".pto-emp-history-hrs.credit"];
const missing = FIX.filter((s) => !block.includes(`:root:not([data-theme="dark"]) ${s}`));
check(`all ${FIX.length} fix selectors light-scoped in block`, missing.length === 0, missing);
check("block never targets dark", !/\[data-theme="dark"\]\s*\./.test(block));
for (const s of [".nav-badge.is-hot", ".topbar-vendor-chip-n", ".issue-needs-count", ".vendor-waiting-count.is-hot", ".vendor-run-sheet-toc-n", ".vendor-run-chip-n", ".vendor-run-count-pill.is-hot"])
  check(`orange badge ${s}`, block.includes(s) && block.includes("#c2410c"));

// 3) print block (Part B) and mojibake arrows (Part C)
check("print token block", /@media print\s*\{\s*:root, \[data-theme="dark"\], \[data-theme="light"\]/.test(css) && css.includes("2026-10-02 PTO + global print"));
check("overage preview paper", css.includes(".pto-overage-wrap .pto-overage-form {"));
check("no mojibake in content:", !/content:\s*"[^"]*\u00C3/.test(css));
check("6 arrow escapes", (css.match(/content: "\\25B8 ";/g) || []).length >= 3 && (css.match(/content: "\\25BE ";/g) || []).length >= 3);
check("job-note css", css.includes(".job-note-bring"));

// 4) printTheme helper wired
const pto = readFileSync("src/pages/TimeOffPage.tsx", "utf8");
check("printWithLightTheme used 3x", (pto.match(/printWithLightTheme\(/g) || []).length >= 3);
check("no bare window.print in TimeOffPage", !/window\.print\(\)/.test(pto));
const pt = readFileSync("src/printTheme.ts", "utf8");
check("printTheme restores + no localStorage", pt.includes("afterprint") && !pt.includes("localStorage"));

console.log(`${n - fails}/${n} PASS`);
process.exit(fails ? 1 : 0);

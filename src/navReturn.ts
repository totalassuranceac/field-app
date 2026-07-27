/**
 * Remember where the user came from (e.g. Notifications) so any page
 * can show ← Back and return them there.
 *
 * Uses both React Router location.state and sessionStorage so PWA
 * navigation still works if state is dropped.
 */

export const RETURN_TO_KEY = "fieldapp_returnTo";
export const RETURN_LABEL_KEY = "fieldapp_returnLabel";

export type NavReturnState = {
  returnTo: string;
  returnLabel?: string;
};

export function notificationsReturnState(): NavReturnState {
  return { returnTo: "/notifications", returnLabel: "Back to notifications" };
}

export function setNavReturn(returnTo: string, returnLabel?: string): void {
  try {
    if (!returnTo.startsWith("/")) return;
    sessionStorage.setItem(RETURN_TO_KEY, returnTo);
    if (returnLabel) sessionStorage.setItem(RETURN_LABEL_KEY, returnLabel);
    else sessionStorage.removeItem(RETURN_LABEL_KEY);
  } catch {
    /* private mode */
  }
}

export function clearNavReturn(): void {
  try {
    sessionStorage.removeItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_LABEL_KEY);
  } catch {
    /* ignore */
  }
}

export function readNavReturn(locationState: unknown): NavReturnState | null {
  const st =
    locationState && typeof locationState === "object"
      ? (locationState as Record<string, unknown>)
      : null;
  let returnTo =
    st && typeof st.returnTo === "string" && st.returnTo.startsWith("/")
      ? st.returnTo
      : null;
  let returnLabel =
    st && typeof st.returnLabel === "string" ? st.returnLabel : undefined;

  if (!returnTo) {
    try {
      const s = sessionStorage.getItem(RETURN_TO_KEY);
      if (s && s.startsWith("/")) returnTo = s;
      const lab = sessionStorage.getItem(RETURN_LABEL_KEY);
      if (lab) returnLabel = lab;
    } catch {
      /* ignore */
    }
  }

  if (!returnTo) return null;
  return { returnTo, returnLabel };
}

/** Label for the back control. */
export function returnBarLabel(r: NavReturnState): string {
  if (r.returnLabel) return r.returnLabel;
  if (r.returnTo.startsWith("/notifications")) return "Back to notifications";
  return "Back";
}

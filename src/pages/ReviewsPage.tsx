import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

const FALLBACK_GOOGLE_URL = "https://share.google/p9PJud1fI4iSmPCpq";

type Review = {
  id: number;
  author_name: string | null;
  rating: number | null;
  review_text: string;
  tech_mentioned: string | null;
  review_date: string | null;
  source_url: string | null;
  created_at: string;
  posted_by_name?: string | null;
};

function stars(n: number | null | undefined) {
  if (n == null || n < 1) return null;
  const r = Math.min(5, Math.max(1, Math.round(n)));
  return "★".repeat(r) + "☆".repeat(5 - r);
}

export function ReviewsPage() {
  const { user } = useAuth();
  const canPost = can(user, "manageEmployees") || user?.role === "admin" || user?.role === "office";
  const isAdmin = user?.role === "admin";

  const [reviews, setReviews] = useState<Review[]>([]);
  const [googleUrl, setGoogleUrl] = useState(FALLBACK_GOOGLE_URL);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [author, setAuthor] = useState("");
  const [rating, setRating] = useState("5");
  const [text, setText] = useState("");
  const [tech, setTech] = useState("");
  const [reviewDate, setReviewDate] = useState("");
  const [notify, setNotify] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await api<{ reviews: Review[]; google_reviews_url?: string; error?: string }>(
        "/reviews"
      );
      setReviews(d.reviews || []);
      if (d.google_reviews_url) setGoogleUrl(d.google_reviews_url);
      if (d.error) setError(d.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load reviews");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function postReview(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) {
      setError("Paste the customer review text.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/reviews", {
        method: "POST",
        body: JSON.stringify({
          author_name: author.trim() || undefined,
          rating: rating ? Number(rating) : undefined,
          review_text: text.trim(),
          tech_mentioned: tech.trim() || undefined,
          review_date: reviewDate || undefined,
          notify,
        }),
      });
      setOk(
        notify
          ? "Review posted — the whole team got a notification."
          : "Review posted to the board."
      );
      setAuthor("");
      setText("");
      setTech("");
      setReviewDate("");
      setRating("5");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post review");
    } finally {
      setBusy(false);
    }
  }

  async function hideReview(id: number) {
    if (!isAdmin) return;
    if (!window.confirm("Hide this review from the board?")) return;
    try {
      await api(`/reviews/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not hide");
    }
  }

  return (
    <div className="page reviews-page">
      <div className="page-header">
        <div>
          <h1>Our reviews</h1>
          <p>Customer praise · celebrate the team · represent Total Assurance well</p>
        </div>
      </div>

      <div className="card reviews-hero">
        <p className="reviews-hero-copy">
          Happy customers put our name on Google. Read the latest shout-outs, cheer the tech who was
          mentioned, and keep delivering the work that earns five stars.
        </p>
        <a
          className="btn reviews-google-btn"
          href={googleUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Google reviews
        </a>
        <p className="muted reviews-hero-hint">
          Opens our public Google review page so you can read everything live.
        </p>
      </div>

      {error && <div className="error">{error}</div>}
      {ok && (
        <div className="success" style={{ marginBottom: "0.75rem" }}>
          {ok}
        </div>
      )}

      {canPost && (
        <div className="card reviews-post-card">
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Share a new review with the team</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            When a new Google review drops, paste it here. Everyone gets a notification so they can
            celebrate — especially if a tech is named.
          </p>
          <form className="form" onSubmit={(ev) => void postReview(ev)}>
            <div className="form-row-2">
              <label>
                Customer name (optional)
                <input
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="e.g. Maria G."
                  autoComplete="off"
                />
              </label>
              <label>
                Stars
                <select value={rating} onChange={(e) => setRating(e.target.value)}>
                  <option value="5">5 ★</option>
                  <option value="4">4 ★</option>
                  <option value="3">3 ★</option>
                  <option value="2">2 ★</option>
                  <option value="1">1 ★</option>
                  <option value="">—</option>
                </select>
              </label>
            </div>
            <label>
              Review text
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                required
                placeholder="Paste the customer’s words…"
              />
            </label>
            <div className="form-row-2">
              <label>
                Tech / employee shout-out (optional)
                <input
                  value={tech}
                  onChange={(e) => setTech(e.target.value)}
                  placeholder="Name on the review"
                  autoComplete="off"
                />
              </label>
              <label>
                Review date (optional)
                <input
                  type="date"
                  value={reviewDate}
                  onChange={(e) => setReviewDate(e.target.value)}
                />
              </label>
            </div>
            <label className="reviews-notify-check">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
              />
              Notify everyone in the app (so the team can congratulate)
            </label>
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Posting…" : "Post to team board"}
            </button>
          </form>
        </div>
      )}

      <section className="reviews-feed" aria-label="Latest reviews">
        <h2 className="reviews-feed-title">
          Latest on the board
          {!loading && (
            <span className="muted" style={{ fontWeight: 500, fontSize: "0.85rem" }}>
              {" "}
              · {reviews.length}
            </span>
          )}
        </h2>
        {loading && <p className="muted">Loading…</p>}
        {!loading && !reviews.length && (
          <div className="card empty">
            No reviews posted yet.{" "}
            <a href={googleUrl} target="_blank" rel="noopener noreferrer">
              Read us on Google
            </a>
            {canPost ? " — then share a highlight here for the crew." : "."}
          </div>
        )}
        <ul className="reviews-list">
          {reviews.map((r) => (
            <li key={r.id} className="card review-card">
              <div className="review-card-head">
                <div>
                  {r.rating != null && (
                    <span className="review-stars" aria-label={`${r.rating} stars`}>
                      {stars(r.rating)}
                    </span>
                  )}
                  <strong className="review-author">
                    {r.author_name?.trim() || "Google customer"}
                  </strong>
                  {(r.review_date || r.created_at) && (
                    <span className="muted review-date">
                      {r.review_date || String(r.created_at).replace("T", " ").slice(0, 10)}
                    </span>
                  )}
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    className="btn ghost btn-sm no-print"
                    onClick={() => void hideReview(r.id)}
                  >
                    Hide
                  </button>
                )}
              </div>
              <p className="review-text">{r.review_text}</p>
              {r.tech_mentioned && (
                <p className="review-shoutout">
                  <span className="badge ok">Shout-out</span> {r.tech_mentioned}
                </p>
              )}
              <div className="review-card-foot muted">
                {r.posted_by_name ? `Shared by ${r.posted_by_name}` : "Shared with the team"}
                {" · "}
                <a href={r.source_url || googleUrl} target="_blank" rel="noopener noreferrer">
                  View on Google
                </a>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

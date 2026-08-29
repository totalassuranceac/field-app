import { Link } from "react-router-dom";
import { canOpenStudio } from "../api";
import { useAuth } from "../auth";

/**
 * One Home door into live Studio. Official A mark + the word Studio.
 * Hidden for technicians / installers (and anyone not on the allow list).
 */
export function StudioDoor({ variant = "home" }: { variant?: "home" | "office" }) {
  const { user } = useAuth();
  if (!canOpenStudio(user)) return null;

  const className =
    variant === "office" ? "office-action studio-door" : "home-action studio-door";

  if (variant === "office") {
    return (
      <Link to="/studio" className={className} aria-label="Studio">
        <span className="office-action-icon" aria-hidden>
          <img src="/logo-mark.png" alt="" className="studio-door-mark" width={28} height={28} />
        </span>
        <span>
          <strong>Studio</strong>
          <span className="office-action-hint">Rate and review ads</span>
        </span>
      </Link>
    );
  }

  return (
    <Link to="/studio" className={className} aria-label="Studio">
      <span className="home-action-icon" aria-hidden>
        <img src="/logo-mark.png" alt="" className="studio-door-mark" width={28} height={28} />
      </span>
      <span className="home-action-text">
        <strong>Studio</strong>
        <span>Rate and review ads</span>
      </span>
    </Link>
  );
}

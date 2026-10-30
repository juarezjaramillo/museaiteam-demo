import { useEffect, useState } from "react";
import {
  CLASSIC_ROLES,
  PLAYBOOK_BY_VERTICAL,
  VERTICALS,
  type Playbook,
  type VerticalId,
} from "@museaiteam/shared";
import { api } from "../api.js";
import { GoButton } from "./GoButton.js";

type Step = "signup" | "goal" | "team";
const STEPS: Step[] = ["signup", "goal", "team"];
const STEP_KEY = "wizard-step";

const ROLE_WORDS: Record<string, string> = {
  pm: "Planner",
  marketer: "Marketer",
  engineer: "Engineer",
  analyst: "Analyst",
};

function savedStep(): Step {
  const s = localStorage.getItem(STEP_KEY);
  return STEPS.includes(s as Step) ? (s as Step) : "signup";
}

/** First-run guide: account → goal → team → start.
 *  The step persists across reloads; every step moves forward without
 *  requiring anything, so skips never strand. Connections happen later,
 *  after the customer sees value. */
export function Wizard({
  me,
  authReady,
  onPrefill,
  onStart,
  onDone,
}: {
  me: { email?: string } | null;
  authReady: boolean;
  org: string;
  onPrefill: (p: Playbook) => void;
  onStart: () => Promise<boolean>;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>(savedStep);
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [starting, setStarting] = useState(false);

  function go(s: Step) {
    setStep(s);
    localStorage.setItem(STEP_KEY, s);
  }

  function choose(v: VerticalId) {
    const p = PLAYBOOK_BY_VERTICAL[v];
    setPlaybook(p);
    onPrefill(p);
    go("team");
  }

  function custom() {
    setPlaybook(null);
    go("team");
  }

  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setStarting(true);
    try {
      if (await onStart()) onDone();
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDone();
      }}
    >
    <section className="card modal-card" role="dialog" aria-label="First-run guide">
      <div className="page-head">
        <h2>First goal in minutes</h2>
        <button className="sm" onClick={onDone}>Skip guide</button>
      </div>
      <div className="wizard-steps" aria-hidden="true">
        {STEPS.map((s) => (
          <span
            key={s}
            className={STEPS.indexOf(s) <= STEPS.indexOf(step) ? "done" : ""}
          />
        ))}
      </div>

      {step === "signup" && (
        <div>
          <p>Sign in so the team can save its work.</p>
          {!authReady ? (
            <p className="dim">…</p>
          ) : me ? (
            <p>
              Signed in as {me.email}.{" "}
              <button className="primary sm" onClick={() => go("goal")}>Continue</button>
            </p>
          ) : (
            <div className="row">
              <GoButton href={api.signInUrl()} className="primary sm">Sign in</GoButton>
              <span className="dim">You return here after signing in.</span>
              <button className="sm" onClick={() => go("goal")}>Skip for now</button>
            </div>
          )}
        </div>
      )}

      {step === "goal" && (
        <div>
          <p>What do you want done first?</p>
          <div className="pick-grid">
            {VERTICALS.map((v) => (
              <button className="pick-card" key={v.id} onClick={() => choose(v.id)}>
                <strong>{v.title}</strong>
                <span>
                  {v.blurb} Start with: {PLAYBOOK_BY_VERTICAL[v.id].title}.
                </span>
              </button>
            ))}
            <button className="pick-card" onClick={custom}>
              <strong>Something else</strong>
              <span>Write your own goal on the next screen.</span>
            </button>
          </div>
          <div className="row">
            <button className="sm" onClick={() => go("signup")}>Back</button>
          </div>
        </div>
      )}

      {step === "team" && (
        <div>
          {playbook ? (
            <div>
              <p>
                <strong>{playbook.title}.</strong> {playbook.why}
              </p>
              <p className="dim">
                {playbook.goal} · {playbook.metricName}
                {playbook.metricBaseline !== undefined &&
                  ` ${playbook.metricBaseline}`}
                {playbook.metricTarget !== undefined &&
                  ` → ${playbook.metricTarget}`}
                {" "}· {playbook.timeboxDays} days.
              </p>
            </div>
          ) : (
            <p className="dim">
              Custom goal — close this, fill in the form, then start.
            </p>
          )}
          <p>
            Your starting team:{" "}
            {CLASSIC_ROLES.map((r) => ROLE_WORDS[r] ?? r).join(" · ")}.
          </p>
          <p className="dim">
            Nothing to connect yet — the team lists what it would do, and
            you connect your tools when you see value.
          </p>
          <div className="row">
            <button className="sm" onClick={() => go("goal")}>Back</button>
            {me ? (
              <>
                <button className="primary sm" onClick={start} disabled={starting}>
                  {starting ? "Starting…" : "Start team"}
                </button>
                <button className="sm" onClick={onDone}>Close and edit first</button>
              </>
            ) : (
              <GoButton href={api.signInUrl()} className="primary sm">Sign in to start</GoButton>
            )}
          </div>
        </div>
      )}
    </section>
    </div>
  );
}

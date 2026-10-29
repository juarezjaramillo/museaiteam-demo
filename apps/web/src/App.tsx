import { useEffect, useRef, useState } from "react";
import { FeedEvent, type Playbook } from "@museaiteam/shared";
import { api, wsUrl, type RunRow, type TeamRow } from "./api.js";
import { Approvals } from "./components/Approvals.js";
import { Baseline } from "./components/Baseline.js";
import { Billing } from "./components/Billing.js";
import { Feed } from "./components/Feed.js";
import { Goals } from "./components/Goals.js";
import { Hires } from "./components/Hires.js";
import { Home } from "./components/Home.js";
import { Notifications } from "./components/Notifications.js";
import { Lessons } from "./components/Lessons.js";
import { RunDetailView, Runs } from "./components/Runs.js";
import { statusLabel } from "@museaiteam/shared";
import { Setup } from "./components/Setup.js";
import { Team } from "./components/Team.js";
import { Wizard } from "./components/Wizard.js";

type Tab =
  | "home"
  | "goals"
  | "runs"
  | "approvals"
  | "hires"
  | "lessons"
  | "team"
  | "alerts"
  | "billing"
  | "setup";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

interface NavEntry {
  section: string | null;
  id: Tab;
  label: string;
  icon: string;
}

const NAV: NavEntry[] = [
  { section: null, id: "home", label: "Home", icon: "M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5" },
  { section: "Work", id: "goals", label: "Goals", icon: "M12 3v3M12 18v3M3 12h3M18 12h3M12 12h.01M12 8a4 4 0 100 8 4 4 0 000-8zM12 5a7 7 0 100 14 7 7 0 000-14z" },
  { section: "Work", id: "runs", label: "Progress", icon: "M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z" },
  { section: "Work", id: "approvals", label: "Approvals", icon: "M9 12l2 2 4-4M12 3a9 9 0 100 18 9 9 0 000-18z" },
  { section: "Team", id: "hires", label: "Hires", icon: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" },
  { section: "Team", id: "lessons", label: "Lessons", icon: "M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" },
  { section: "Team", id: "team", label: "Members", icon: "M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM19 8v6M22 11h-6" },
  { section: null, id: "alerts", label: "Alerts", icon: "M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" },
  { section: "Manage", id: "billing", label: "Billing", icon: "M3 5h18v14H3zM3 10h18" },
  { section: "Manage", id: "setup", label: "Setup", icon: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" },
];

const GROUPS: Array<{ section: string | null; items: NavEntry[] }> = [];
for (const t of NAV) {
  const g = GROUPS.find((x) => x.section === t.section);
  if (g) g.items.push(t);
  else GROUPS.push({ section: t.section, items: [t] });
}

export function App() {
  const [org, setOrg] = useState("demo");
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [role, setRole] = useState("owner");
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [teamId, setTeamId] = useState("");
  const [trial, setTrial] = useState<
    import("@museaiteam/shared").TrialStatus | null
  >(null);
  const [me, setMe] = useState<{ email?: string } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [goal, setGoal] = useState("Lift onboarding activation by 15%");
  const [metricName, setMetricName] = useState("activation_rate");
  const [baseline, setBaseline] = useState("0.32");
  const [target, setTarget] = useState("0.37");
  const [timebox, setTimebox] = useState("14");
  const [windowSecs, setWindowSecs] = useState("60");
  const [wizardOpen, setWizardOpen] = useState(
    () => localStorage.getItem("wizard-done") !== "1",
  );
  const [tab, setTab] = useState<Tab>("home");
  const [goalId, setGoalId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [error, setError] = useState("");
  const [notifTick, setNotifTick] = useState(0);
  const [unread, setUnread] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => () => wsRef.current?.close(), []);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m.user);
        setOrg(m.orgId);
        api
          .getOrg(m.orgId)
          .then((g) => setTrial(g.trial))
          .catch(() => setTrial(null));
        api
          .getTeams(m.orgId)
          .then((t) => setTeams(t.teams))
          .catch(() => setTeams([]));
        api
          .myOrgs()
          .then((o) => {
            setOrgs(o.orgs);
            const cur = o.orgs.find((x) => x.id === m.orgId);
            if (cur) setRole(cur.role);
          })
          .catch(() => setOrgs([]));
      })
      .catch(() => setMe(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!me) return;
    api
      .getNotifications(org, true)
      .then((n) => setUnread(n.notifications.length))
      .catch(() => setUnread(0));
  }, [org, me, notifTick, tab]);

  useEffect(() => {
    if (!runId) return;
    const ws = new WebSocket(wsUrl(`/api/runs/${runId}/events`));
    ws.onmessage = (msg) => {
      const parsed = FeedEvent.safeParse(JSON.parse(msg.data));
      if (parsed.success) setEvents((prev) => [...prev, parsed.data]);
    };
    wsRef.current = ws;
    const poll = setInterval(async () => {
      try {
        setRun(await api.getRun(runId));
      } catch (e) {
        setError(String(e));
      }
    }, 5000);
    return () => {
      ws.close();
      clearInterval(poll);
    };
  }, [runId]);

  function prefill(p: Playbook) {
    setGoal(p.goal);
    setMetricName(p.metricName);
    setBaseline(p.metricBaseline?.toString() ?? "");
    setTarget(p.metricTarget?.toString() ?? "");
    setTimebox(String(p.timeboxDays));
  }

  function doneWizard() {
    localStorage.setItem("wizard-done", "1");
    localStorage.removeItem("wizard-step");
    setWizardOpen(false);
  }

  function openGuide() {
    localStorage.removeItem("wizard-done");
    localStorage.removeItem("wizard-step");
    setWizardOpen(true);
  }

  async function start(): Promise<boolean> {
    setError("");
    try {
      const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
      const { runId: id } = await api.createRun({
        orgId: org,
        ...(teamId ? { teamId } : {}),
        goal,
        metricName: metricName.trim() || undefined,
        metricBaseline: num(baseline),
        metricTarget: num(target),
        timeboxDays: num(timebox),
        voteWindowMs: Math.max(5, Number(windowSecs) || 60) * 1000,
      });
      setRunId(id);
      setRun(null);
      setEvents([]);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  function openRun(id: string) {
    setRunId(id);
    setRun(null);
    setEvents([]);
    setTab("runs");
  }

  function openGoal(id: string) {
    setGoalId(id);
    setTab("goals");
  }

  const active =
    run && !["done", "failed", "halted"].includes(run.status);

  const params = new URLSearchParams(location.search);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-mark"
            src="/brand/svg/muse-ai-team-mark.svg"
            alt="Muse AI Team"
          />
          <div>
            <div className="brand-name">Muse AI Team</div>
            <div className="brand-sub">AI employees that ship</div>
          </div>
        </div>
        <nav>
          {GROUPS.map((g) => (
            <div key={g.section ?? "top"}>
              {g.section && <div className="nav-section">{g.section}</div>}
              <div className="nav-group">
                {g.items.map((t) => (
                  <button
                    key={t.id}
                    className={`nav-item${tab === t.id ? " on" : ""}`}
                    onClick={() => setTab(t.id)}
                  >
                    <Icon d={t.icon} />
                    {t.label}
                    {t.id === "alerts" && unread > 0 && (
                      <span className="nav-badge">{unread}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="side-foot">
          {orgs.length > 1 && (
            <select
              value={org}
              onChange={(e) => {
                setOrg(e.target.value);
                const cur = orgs.find((x) => x.id === e.target.value);
                if (cur) setRole(cur.role);
              }}
              aria-label="Organization"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.role})
                </option>
              ))}
            </select>
          )}
          <div className="side-links">
            <button onClick={openGuide}>Guide</button>
            <a href="/site.html">Tour</a>
          </div>
          <div className="side-user">
            {authChecked ? (
              me ? (
                <>
                  {me.email} · <a href={api.signOutUrl()}>Sign out</a>
                </>
              ) : (
                <a href={api.signInUrl()}>Sign in</a>
              )
            ) : (
              "…"
            )}
          </div>
        </div>
      </aside>

      <main className="content">
        {error && <p className="error">{error}</p>}
        {trial && trial.state !== "active" && (
          <div
            className={`banner${trial.state === "expired" ? " bad" : trial.state === "grace" ? " warn" : ""}`}
          >
            {trial.state === "trial" && `Trial: ${trial.daysLeft} days left.`}
            {trial.state === "grace" &&
              `Trial expired — extra time: ${trial.daysLeft} days left.`}
            {trial.state === "expired" && (
              <>
                Trial expired — subscribe to keep running ($499/worker).{" "}
                <button className="sm" onClick={() => setTab("billing")}>
                  See plans
                </button>
              </>
            )}
          </div>
        )}
        {params.get("connected") && (
          <div className="banner">Connected {params.get("connected")}.</div>
        )}
        {params.get("error") && (
          <div className="banner bad">{params.get("error")}</div>
        )}
        {params.get("billing") === "success" && (
          <div className="banner">
            Subscribed — welcome aboard. Receipts come from Stripe.
          </div>
        )}
        {params.get("billing") === "cancelled" && (
          <div className="banner">Checkout cancelled — nothing was charged.</div>
        )}

        {wizardOpen && (
          <Wizard
            me={me}
            authReady={authChecked}
            org={org}
            onPrefill={prefill}
            onStart={start}
            onDone={doneWizard}
          />
        )}

        {tab === "home" && (
          <Home org={org} go={(t) => setTab(t)} onGoal={openGoal} onRun={openRun} />
        )}

        {tab === "goals" && (
          <Goals org={org} onRun={openRun} selected={goalId} onSelect={setGoalId} />
        )}

        {tab === "runs" &&
          (runId ? (
            <>
              <RunDetailView runId={runId} onRun={openRun} onBack={() => setRunId(null)} />
              {run && (
                <section className="runbar">
                  <span className={`status status-${run.status}`}>{statusLabel(run.status)}</span>
                  <span className="dim">session {run.id.slice(0, 8)}</span>
                  <span className="meter">
                    {run.tokens_used.toLocaleString()} words
                  </span>
                  <div className="row">
                    {active && (
                      <button className="sm danger" onClick={() => runId && api.killRun(runId)}>
                        Stop
                      </button>
                    )}
                    <button className="sm" onClick={() => runId && api.revertRun(runId)}>
                      Undo all
                    </button>
                  </div>
                </section>
              )}
              <section>
                <h2>Organizing</h2>
                <Feed events={events} />
              </section>
              {runId && <Baseline runId={runId} teamTokens={run?.tokens_used ?? 0} />}
            </>
          ) : (
            <>
              <Runs org={org} onRun={openRun} />
              <section>
                <h2>Quick session</h2>
                {teams.length > 1 && (
                  <div className="row">
                    <label>
                      Team{" "}
                      <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                        <option value="">First team</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                <input className="goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
                <div className="row">
                  <label>
                    Number <input value={metricName} onChange={(e) => setMetricName(e.target.value)} />
                  </label>
                </div>
                <details>
                  <summary>More options</summary>
                  <div className="row">
                    <label>
                      Start <input className="narrow" value={baseline} onChange={(e) => setBaseline(e.target.value)} />
                    </label>
                    <label>
                      Aim for <input className="narrow" value={target} onChange={(e) => setTarget(e.target.value)} />
                    </label>
                    <label>
                      Days <input className="narrow" value={timebox} onChange={(e) => setTimebox(e.target.value)} />
                    </label>
                    <label>
                      Think time (sec){" "}
                      <input className="narrow" value={windowSecs} onChange={(e) => setWindowSecs(e.target.value)} />
                    </label>
                  </div>
                </details>
                <div className="row">
                  <button className="primary" onClick={start}>Start team</button>
                </div>
              </section>
            </>
          ))}

        {tab === "approvals" && <Approvals org={org} onRun={openRun} />}
        {tab === "hires" && <Hires org={org} />}
        {tab === "lessons" && <Lessons org={org} />}
        {tab === "team" && <Team org={org} role={role} />}
        {tab === "alerts" && (
          <Notifications
            org={org}
            onRun={openRun}
            refreshKey={notifTick}
            onRead={() => setNotifTick((n) => n + 1)}
          />
        )}
        {tab === "billing" && <Billing org={org} />}
        {tab === "setup" && <Setup org={org} />}
      </main>
    </div>
  );
}

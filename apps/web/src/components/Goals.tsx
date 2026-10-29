import { useEffect, useState } from "react";
import { api, type GoalRow, type MetricPoint, type TimelineEntry } from "../api.js";
import { eventLabel, kindLabel, modeLabel, scheduleLabel, sessionTitle, shipCount, statusLabel } from "@museaiteam/shared";

function Chart({ series }: { series: MetricPoint[] }) {
  if (series.length === 0) {
    return (
      <div className="empty">
        <strong>No data yet</strong>
        Fetch the number or enter a value below.
      </div>
    );
  }
  const vals = series.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 640;
  const H = 180;
  const coords = vals.map(
    (v, i) =>
      [
        (i / Math.max(1, vals.length - 1)) * (W - 16) + 8,
        H - 16 - ((v - min) / span) * (H - 32),
      ] as const,
  );
  const pts = coords.map(([x, y]) => `${x},${y}`).join(" ");
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Number chart">
        <polyline points={pts} fill="none" className="chart-line" />
        {coords.map(([cx, cy], i) => {
          const pull = series[i].source === "pull";
          return (
            <circle key={i} cx={cx} cy={cy} r="5" className={pull ? "pt-pull" : "pt-entry"}>
              <title>{`${vals[i]} (${series[i].source})`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="chart-legend">
        <span><span className="dot pull" />auto fetch</span>
        <span><span className="dot entry" />entered</span>
      </div>
    </div>
  );
}

function GoalForm({ org, onDone }: { org: string; onDone: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState("");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [deadline, setDeadline] = useState("");
  const [schedule, setSchedule] = useState("weekly:1");
  const [mode, setMode] = useState("posthoc");
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    try {
      const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
      const { id } = await api.createGoal(org, {
        title,
        metricName: metric.trim() || undefined,
        metricSource: source.trim() || undefined,
        metricTarget: num(target),
        deadline: deadline.trim() || undefined,
        schedule,
        approvalMode: mode,
      });
      onDone(id);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="card card-hi">
      <h3>New goal</h3>
      {error && <p className="error">{error}</p>}
      <input className="goal" placeholder="Goal title (8+ characters)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="row">
        <label>Number <input value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="activation_rate" /></label>
      </div>
      <details>
        <summary>More options</summary>
        <div className="row">
          <label>Where from <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="auto or manual" /></label>
          <label>Aim for <input className="narrow" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
          <label>Deadline <input value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="YYYY-MM-DD" /></label>
        </div>
        <div className="row">
          <label>How often
            <select value={schedule} onChange={(e) => setSchedule(e.target.value)}>
              <option value="manual">Manual</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly:1">Every Monday</option>
              <option value="weekly:5">Every Friday</option>
            </select>
          </label>
          <label>Checks
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="posthoc">Review after</option>
              <option value="preapprove">Check first</option>
            </select>
          </label>
        </div>
      </details>
      <div className="row">
        <button className="primary" onClick={submit}>Create goal</button>
      </div>
    </div>
  );
}

export function GoalDetail({
  org,
  goalId,
  onRun,
  onBack,
}: {
  org: string;
  goalId: string;
  onRun: (runId: string) => void;
  onBack: () => void;
}) {
  const [goal, setGoal] = useState<GoalRow | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [series, setSeries] = useState<MetricPoint[]>([]);
  const [runs, setRuns] = useState<Array<{ id: string; kind: string; goal: string; status: string; created_at: string; outcome: string | null; top_suggestion: string | null; ships: number }>>([]);
  const [point, setPoint] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    const g = await api.getGoal(org, goalId);
    setGoal(g.goal);
    setTimeline(g.timeline);
    setSeries(g.series);
    const r = await api.getOrgRuns(org, `?goal=${goalId}&limit=20`);
    setRuns(r.runs);
  }

  useEffect(() => {
    load().catch((e) => setMsg(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  if (!goal) return <p className="dim">Loading…</p>;

  async function act(fn: () => Promise<unknown>, done = "Saved") {
    setMsg("");
    try {
      await fn();
      setMsg(done);
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div>
      <button className="link" onClick={onBack}>← All goals</button>
      <h1>{goal.title}</h1>
      {msg && <p className="dim">{msg}</p>}
      {timeline.some((t) => t.kind === "goal.stalled") && (
        <div className="banner warn">
          This goal is stalled — the number has not moved in 2 weeks. Change it, or pause it.
        </div>
      )}
      <div className="row">
        <span className={`status status-${goal.status}`}>{statusLabel(goal.status)}</span>
        <span className="dim">team: {goal.squad.join(", ") || "—"}</span>
        <span className="dim">{scheduleLabel(goal.schedule)} · {modeLabel(goal.approval_mode)}</span>
        {goal.deadline && <span className="dim">due {goal.deadline}</span>}
      </div>
      <div className="row">
        <label>How often
          <select value={goal.schedule} onChange={(e) => act(() => api.patchGoal(org, goalId, { schedule: e.target.value }))}>
            <option value="manual">Manual</option>
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly:1">Every Monday</option>
            <option value="weekly:5">Every Friday</option>
          </select>
        </label>
        <label>Checks
          <select value={goal.approval_mode} onChange={(e) => act(() => api.patchGoal(org, goalId, { approval_mode: e.target.value }))}>
            <option value="posthoc">Review after</option>
            <option value="preapprove">Check first</option>
          </select>
        </label>
        <label>Status
          <select value={goal.status} onChange={(e) => act(() => api.patchGoal(org, goalId, { status: e.target.value }))}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="done">Done</option>
            <option value="overdue">Overdue</option>
          </select>
        </label>
        <button onClick={() => act(() => api.restaffGoal(org, goalId), "Team re-picked")} title="Pick a new team for this goal">New team</button>
      </div>
      <section>
        <h2>Number{goal.metric_name ? `: ${goal.metric_name}` : ""}</h2>
        <Chart series={series} />
        <div className="row">
          <input className="narrow" placeholder="number" value={point} onChange={(e) => setPoint(e.target.value)} />
          <button onClick={() => act(() => api.addMetricPoint(org, goalId, Number(point)), "Saved")}>Save number</button>
          <button onClick={() => act(() => api.pullMetric(org, goalId).then((r) => { if (!r.ok) throw new Error(r.reason); }), "Fetched")}>
            Fetch now{goal.metric_source ? ` (${goal.metric_source.split(".")[0]})` : ""}
          </button>
        </div>
      </section>
      <section>
        <h2>Progress</h2>
        {runs.length === 0 && (
          <div className="empty">
            <strong>No progress yet</strong>
            Work sessions for this goal will appear here.
          </div>
        )}
        <ul className="list">
          {runs.map((r) => (
            <li key={r.id}>
              <div className="card-head">
                <button className="link" onClick={() => onRun(r.id)}>{sessionTitle(r).slice(0, 90)}</button>
                <span className={`status status-${r.status}`}>{statusLabel(r.status)}</span>
              </div>
              <span className="dim">{kindLabel(r.kind)} · {r.created_at.slice(0, 16)} · {r.ships > 0 ? shipCount(r.ships) : "no results yet"}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Timeline</h2>
        <ul className="list">
          {timeline.map((t, i) => (
            <li key={i}>
              <span className="dim">{t.created_at.slice(0, 16)}</span>{" "}
              <strong>{eventLabel(t.kind)}</strong> — {t.title}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function Goals({
  org,
  onRun,
  selected,
  onSelect,
}: {
  org: string;
  onRun: (runId: string) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    api.getGoals(org).then((g) => setGoals(g.goals)).catch(() => setGoals([]));
  }, [org, selected]);

  if (selected) {
    return <GoalDetail org={org} goalId={selected} onRun={onRun} onBack={() => onSelect(null)} />;
  }

  return (
    <div>
      <div className="page-head">
        <h1>Goals</h1>
        <button
          className={showForm ? "" : "primary"}
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? "Cancel" : "New goal"}
        </button>
      </div>
      <p className="page-sub">Outcomes you assign; the team figures out the work.</p>
      {showForm && <GoalForm org={org} onDone={(id) => { setShowForm(false); onSelect(id); }} />}
      {goals.length === 0 && !showForm ? (
        <div className="empty">
          <strong>No goals yet</strong>
          Create the first one — the team assembles itself.
        </div>
      ) : (
        <ul className="list">
          {goals.map((g) => (
            <li key={g.id}>
              <div className="card-head">
                <button className="link" onClick={() => onSelect(g.id)}>{g.title}</button>
                <span className={`status status-${g.status}`}>{statusLabel(g.status)}</span>
              </div>
              <span className="dim">{scheduleLabel(g.schedule)} · {modeLabel(g.approval_mode)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

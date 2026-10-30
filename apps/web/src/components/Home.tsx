import { useEffect, useState } from "react";
import { api, type ActivityItem, type ApprovalRow, type GoalRow, type NotificationRow } from "../api.js";
import { actionLabel, statusLabel, targetHref } from "@museaiteam/shared";

/** One row per entity: alerts sharing a link are the same thing. */
function dedupeAlerts(rows: NotificationRow[]): NotificationRow[] {
  const seen = new Set<string>();
  return rows.filter((n) => {
    if (!n.link) return true;
    if (seen.has(n.link)) return false;
    seen.add(n.link);
    return true;
  });
}

export function Home({
  org,
  go,
  onGoal,
  onRun,
}: {
  org: string;
  go: (t: "goals" | "approvals" | "alerts" | "setup" | "runs") => void;
  onGoal: (id: string) => void;
  onRun: (id: string) => void;
}) {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [alerts, setAlerts] = useState<NotificationRow[]>([]);
  const [connected, setConnected] = useState(0);
  const [ideas, setIdeas] = useState<{ cap: number; spent: number; left: number } | null>(null);

  useEffect(() => {
    api.getGoals(org).then((g) => setGoals(g.goals)).catch(() => setGoals([]));
    api.getApprovals(org, "pending").then((r) => setPending(r.approvals)).catch(() => setPending([]));
    api.getActivity(org).then((r) => setActivity(r.activity)).catch(() => setActivity([]));
    api.getNotifications(org, true).then((n) => setAlerts(n.notifications)).catch(() => setAlerts([]));
    api.getConnections(org)
      .then((c) => setConnected(Object.values(c.status).filter((s) => s === "connected").length))
      .catch(() => setConnected(0));
    api.getOrg(org).then((g) => setIdeas(g.ideas)).catch(() => setIdeas(null));
  }, [org]);

  const fresh = dedupeAlerts(alerts);
  const needsYou = pending.length + fresh.length;
  const shipped = activity.filter((a) => a.status === "done" && !a.target.startsWith("closeout:")).slice(0, 6);

  return (
    <div>
      <div className="page-head">
        <h1>Home</h1>
      </div>
      <p className="page-sub">What needs you, and what the team just did.</p>
      {ideas && (
        <p className="dim">
          Ideas tonight: {ideas.left.toLocaleString()} of {ideas.cap.toLocaleString()} words left.
        </p>
      )}

      <section>
        <h2>Needs you{needsYou > 0 ? ` (${needsYou})` : ""}</h2>
        {needsYou === 0 ? (
          <div className="empty">
            <strong>All clear</strong>
            Nothing needs you. The team keeps working.
          </div>
        ) : (
          <ul className="list">
            {pending.slice(0, 3).map((a) => (
              <li key={a.id}>
                <button className="link" onClick={() => go("approvals")}>
                  {a.actionKind ? actionLabel(a.actionKind) : "Plan"}: {(a.runGoal ?? "a session").slice(0, 80)}
                </button>
                <span className="dim"> waiting on your call</span>
              </li>
            ))}
            {fresh.slice(0, 3).map((n) => (
              <li key={n.id}>
                <button className="link" onClick={() => go("alerts")}>{n.title}</button>
                {n.body && <span className="dim"> {n.body.slice(0, 100)}</span>}
              </li>
            ))}
            {(pending.length > 3 || fresh.length > 3) && (
              <li>
                <button className="link" onClick={() => go("approvals")}>
                  Review all {needsYou} →
                </button>
              </li>
            )}
          </ul>
        )}
      </section>

      {connected === 0 && (
        <div className="banner">
          Connect your tools so the team can do real work.{" "}
          <button className="link" onClick={() => go("setup")}>Connect →</button>
        </div>
      )}

      <section>
        <h2>Latest results</h2>
        {shipped.length === 0 ? (
          <div className="empty">
            <strong>No results yet</strong>
            Finished work will show up here.
          </div>
        ) : (
          <ul className="list">
            {shipped.map((a) => {
              const href = targetHref(a.target);
              return (
                <li key={a.id}>
                  <strong>{actionLabel(a.kind)}</strong>{" "}
                  <span className="dim">for {a.goal.slice(0, 60)}</span>
                  <div className="dim">
                    {a.createdAt.slice(5, 16).replace("T", " ")} ·{" "}
                    <button className="link" onClick={() => onRun(a.runId)}>open session</button>
                    {href && (
                      <>
                        {" "}· <a href={href} target="_blank" rel="noreferrer">open it</a>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>Goals</h2>
        {goals.length === 0 ? (
          <div className="empty">
            <strong>No goals yet</strong>
            <button className="link" onClick={() => go("goals")}>Create the first one →</button>
          </div>
        ) : (
          <ul className="list">
            {goals.map((g) => (
              <li key={g.id}>
                <div className="card-head">
                  <button className="link" onClick={() => onGoal(g.id)}>{g.title}</button>
                  <span className={`status status-${g.status}`}>{statusLabel(g.status)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

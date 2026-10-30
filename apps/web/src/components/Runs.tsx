import { useEffect, useState } from "react";
import { api, type RunDetail, type RunListRow } from "../api.js";
import { ThumbDown, ThumbUp } from "./icons.js";
import {
  actionLabel,
  crewName,
  isHiddenAction,
  kindLabel,
  ownerFor,
  sessionTitle,
  shipCount,
  statusLabel,
  targetHref,
  type Proof,
} from "@museaiteam/shared";

function parseProof(raw: string | null): Proof | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Proof;
  } catch {
    return null;
  }
}

export function RunDetailView({
  runId,
  onRun,
  onBack,
}: {
  runId: string;
  onRun: (id: string) => void;
  onBack: () => void;
}) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState("");
  const [pendingApprovals, setPendingApprovals] = useState(0);

  useEffect(() => {
    api
      .getRunDetail(runId)
      .then((detail) => {
        setD(detail);
        api
          .getApprovals(detail.run.org_id)
          .then((a) =>
            setPendingApprovals(
              a.approvals.filter((x) => x.runId === runId && x.status === "pending").length,
            ),
          )
          .catch(() => setPendingApprovals(0));
      })
      .catch((e) => setMsg(String(e)));
  }, [runId]);

  if (!d) return <p className="dim">{msg || "Loading…"}</p>;

  async function act(fn: () => Promise<unknown>, done = "Saved") {
    setMsg("");
    try {
      await fn();
      setMsg(done);
      setD(await api.getRunDetail(runId));
    } catch (e) {
      setMsg(String(e));
    }
  }

  const rated = new Map(d.ratings.map((r) => [r.actionId, r]));
  const visibleActions = d.actions.filter((a) => !isHiddenAction(a));
  const shipped = visibleActions.filter((a) => a.status === "done").length;
  const inFlight = visibleActions.filter(
    (a) => a.status === "pending" || a.status === "running",
  ).length;
  const fors = new Map<string, number>();
  for (const v of d.votes) {
    if (v.choice === "for") fors.set(v.proposal_id, (fors.get(v.proposal_id) ?? 0) + 1);
  }
  const topProposal = [...d.proposals].sort(
    (a, b) => (fors.get(b.id) ?? 0) - (fors.get(a.id) ?? 0),
  )[0];
  const winner = topProposal?.title ?? d.ruling?.decision ?? null;
  const title = winner ?? `Session ${d.run.id.slice(0, 8)}`;
  const outcome = d.ruling
    ? `${winner} (decided by ${crewName(d.ruling.decided_by)})`
    : d.run.status === "awaiting_approval"
      ? "Waiting on your approval."
      : d.run.status === "failed"
        ? "This session failed."
        : d.run.status === "halted"
          ? "Stopped."
          : d.run.status === "done"
            ? "Finished."
            : "The team is getting organized…";
  const why = d.ruling?.rationale ?? null;
  const ships =
    shipped === 0 && inFlight === 0
      ? "No results yet."
      : [
          shipped > 0 ? shipCount(shipped) : null,
          inFlight > 0
            ? `${inFlight} in progress`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
  const next =
    pendingApprovals > 0
      ? "Waiting on your approval — see the Approvals tab."
      : d.children.length > 0
        ? `${d.children.length} follow-up session${d.children.length === 1 ? "" : "s"} below.`
        : d.run.status === "done"
          ? "Rate the results to teach the team."
          : d.run.status === "failed"
            ? "Start a new session or adjust the goal."
            : "In progress — check back soon.";

  return (
    <div>
      <button className="link" onClick={onBack}>← All progress</button>
      <h1>{title.slice(0, 90)}</h1>
      {msg && <p className="dim">{msg}</p>}
      <div className="row">
        <span className={`status status-${d.run.status}`}>{statusLabel(d.run.status)}</span>
        <span className="dim">{kindLabel(d.run.kind)}</span>
        <span className="dim">{d.run.tokens_used.toLocaleString()} tokens</span>
      </div>
      <p>{d.run.goal}</p>
      {d.run.brief_note.startsWith("Metric trigger:") && (
        <p><span className="dim">Why this session — </span>{d.run.brief_note}</p>
      )}
      <div className="card card-hi">
        <div className="card-head">
          <strong>Summary</strong>
        </div>
        <p><span className="dim">Outcome — </span>{outcome}</p>
        {why && <p><span className="dim">Why — </span>{why.slice(0, 200)}</p>}
        <p><span className="dim">Results — </span>{ships}</p>
        <p><span className="dim">Next — </span>{next}</p>
        {d.run.self_critique && (
          <p><span className="dim">Morgan's take — </span>{d.run.self_critique}</p>
        )}
        {(d.reviews ?? []).map((r, i) => (
          <p key={i}>
            <span className="dim">Checked by {crewName(r.reviewer)} — </span>
            {r.verdict === "pass" ? "passed" : "sent back"}
            {r.note ? `: ${r.note}` : ""}
          </p>
        ))}
      </div>
      <section>
        <h2>Results</h2>
        {visibleActions.length === 0 ? (
          <div className="empty">
            <strong>No results yet</strong>
            Everything the team makes lands here.
          </div>
        ) : (
          <>
            <ul className="list">
              {visibleActions.map((a) => {
                const r = rated.get(a.id);
                const href = targetHref(a.target);
                const proof = parseProof(a.proof);
                return (
                  <li key={a.id}>
                    <div className="card-head">
                      <span className="badge soft">{actionLabel(a.kind)}</span>
                      <span className={`status status-${a.status}`}>{statusLabel(a.status)}</span>
                    </div>
                    <span className="dim">by {crewName(ownerFor(a.kind))}</span>
                    {proof ? (
                      <p>
                        {proof.summary}
                        {proof.before && proof.after && (
                          <span className="dim"> ({proof.before} → {proof.after})</span>
                        )}
                        {!proof.before && proof.after && (
                          <span className="dim"> — {proof.after}</span>
                        )}
                      </p>
                    ) : a.status === "done" ? (
                      <p className="dim">no proof recorded</p>
                    ) : null}
                    {href || proof?.url ? (
                      <a href={(href ?? proof!.url)!} target="_blank" rel="noreferrer">
                        Open it ↗
                      </a>
                    ) : (
                      <span className="dim">{a.target}</span>
                    )}
                    <div className="row">
                      <button className="sm" onClick={() => act(() => api.approveAction(runId, a.id))}>
                        Approve
                      </button>
                      <button
                        className="sm"
                        onClick={() =>
                          act(
                            () =>
                              api
                                .requestChanges(runId, a.id, note || "Please revise")
                                .then((x) => onRun(x.runId)),
                            "Revision started",
                          )
                        }
                      >
                        Request changes
                      </button>
                      <button
                        className={`icon-btn${r?.thumb === "up" ? " on" : ""}`}
                        title="Looks good — teach the team"
                        onClick={() => act(() => api.rateAction(runId, a.id, "up"))}
                      >
                        <ThumbUp />
                      </button>
                      <button
                        className={`icon-btn${r?.thumb === "down" ? " on" : ""}`}
                        title="Not good enough — teach the team"
                        onClick={() => act(() => api.rateAction(runId, a.id, "down"))}
                      >
                        <ThumbDown />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <input
              placeholder="What should change?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        )}
      </section>
      {d.children.length > 0 && (
        <section>
          <h3>Follow-up sessions</h3>
          <ul className="list">
            {d.children.map((c) => (
              <li key={c.id}>
                <button className="link" onClick={() => onRun(c.id)}>
                  {c.id.slice(0, 8)}
                </button>{" "}
                <span className="dim">
                  {kindLabel(c.kind)} · {statusLabel(c.status)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function Runs({
  org,
  onRun,
}: {
  org: string;
  onRun: (id: string) => void;
}) {
  const [runs, setRuns] = useState<RunListRow[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    api
      .getOrgRuns(org, `${status ? `?status=${status}` : ""}`)
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, [org, status]);

  return (
    <div>
      <div className="page-head">
        <h1>Progress</h1>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option>
            <option value="open">open</option>
            <option value="queued">queued</option>
            <option value="awaiting_approval">awaiting approval</option>
            <option value="done">done</option>
            <option value="failed">failed</option>
            <option value="halted">halted</option>
          </select>
        </label>
      </div>
      <p className="page-sub">Every work session, check-in, and revision.</p>
      {runs.length === 0 ? (
        <div className="empty">
          <strong>No progress yet</strong>
          Start a quick session below or create a goal.
        </div>
      ) : (
        <ul className="list">
          {runs.map((r) => {
            const titled = Boolean(r.top_suggestion ?? r.outcome);
            return (
              <li key={r.id}>
                <div className="card-head">
                  <button className="link" onClick={() => onRun(r.id)}>
                    {sessionTitle(r).slice(0, 90)}
                  </button>
                  <span className={`status status-${r.status}`}>{statusLabel(r.status)}</span>
                </div>
                <span className="dim">
                  {kindLabel(r.kind)} · {r.created_at.slice(0, 16)} ·{" "}
                  {r.ships > 0 ? shipCount(r.ships) : "no results yet"}
                </span>
                {titled && <p className="dim">{r.goal.replace(/^Check:\s*/, "").slice(0, 120)}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

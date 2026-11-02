import { useEffect, useState } from "react";
import { api, type ReviewPayload } from "../api.js";
import { SUPPORT_BRIEF_TEMPLATE, SUPPORT_METRIC, actionLabel, statusLabel } from "@museaiteam/shared";

export function Review({ org, teamId, onBack }: { org: string; teamId: string; onBack: () => void }) {
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [brief, setBrief] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await api.getReview(org, teamId);
    setData(r);
    setBrief(r.brief.text);
  }

  useEffect(() => {
    load().catch((e) => setMsg(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, teamId]);

  async function saveBrief() {
    setMsg("");
    try {
      const b = await api.putBrief(org, teamId, brief);
      setData((d) => (d ? { ...d, brief: b } : d));
      setMsg("Saved — tonight's work follows this brief.");
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function approve(runId: string, actionId: string) {
    setMsg("");
    try {
      await api.approveAction(runId, actionId);
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function done() {
    setMsg("");
    try {
      await api.markReviewed(org, teamId);
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  if (!data) return <p className="dim">Loading…</p>;
  const reviewed = data.brief.reviewedAt !== null;

  return (
    <div>
      <button className="sm" onClick={onBack}>
        ← All teams
      </button>
      <div className="page-head">
        <h1>{data.team.name}: today's review</h1>
      </div>
      {msg && <p className="dim">{msg}</p>}

      <h2>Overnight</h2>
      <p className="page-sub">What your team did since your last review.</p>
      {data.overnight.length === 0 && <p className="dim">Nothing new since your last review.</p>}
      <ul className="list">
        {data.overnight.map((r) => (
          <li key={r.id}>
            <strong>{r.goal || "Nightly work"}</strong>{" "}
            <span className="dim">
              {statusLabel(r.status)}
            </span>
          </li>
        ))}
      </ul>

      <h2>Waiting on you</h2>
      <p className="page-sub">Results that need your yes before they go out.</p>
      {data.pending.length === 0 && <p className="dim">Nothing waiting — you're all caught up.</p>}
      <ul className="list">
        {data.pending.map((a) => (
          <li key={a.id}>
            <div className="card-head">
              <span>
                <strong>{actionLabel(a.kind)}</strong>{" "}
                <span className="dim">
                  {a.target} · for “{a.runGoal}”
                </span>
              </span>
              <button className="sm" onClick={() => approve(a.runId, a.id)}>
                Approve
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>Today's brief</h2>
      <p className="page-sub">Tell the team what matters today. They read this before tonight's work.</p>
      {brief.trim() === "" && (
        <p>
          <button className="sm" onClick={() => setBrief(SUPPORT_BRIEF_TEMPLATE)}>
            Start from the support template
          </button>{" "}
          <span className="dim">Suggested metric: {SUPPORT_METRIC.name}.</span>
        </p>
      )}
      <textarea
        aria-label="Today's brief"
        rows={3}
        value={brief}
        placeholder="Today matters: the Acme tickets and the refund queue."
        onChange={(e) => setBrief(e.target.value)}
      />
      <div className="row">
        <button className="sm" onClick={saveBrief}>
          Save brief
        </button>
        {reviewed ? (
          <span className="badge">Reviewed ✓</span>
        ) : (
          <button className="sm primary" onClick={done}>
            Mark reviewed
          </button>
        )}
      </div>
    </div>
  );
}

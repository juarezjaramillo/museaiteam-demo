import { useEffect, useState } from "react";
import { api, type ApprovalRow, type ProposalRow } from "../api.js";
import { actionLabel, approvalKindLabel, statusLabel } from "@museaiteam/shared";

const OUTCOME_WORDS: Record<string, string> = {
  approved: "Approved",
  resubmitted: "Sent back for a retry",
  failed: "Failed — retry cap reached",
};

export function Approvals({
  org,
  onRun,
}: {
  org: string;
  onRun: (id: string) => void;
}) {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [ideas, setIdeas] = useState<ProposalRow[]>([]);
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState("");

  async function load(s = status) {
    const r = await api.getApprovals(org, s);
    setRows(r.approvals);
    try {
      const p = await api.getProposals(org);
      setIdeas(p.proposals.filter((x) => x.status === "proposed" || x.status === "reminded"));
    } catch {
      setIdeas([]);
    }
  }

  useEffect(() => {
    load(status).catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, status]);

  async function decide(runId: string, decision: "approve" | "reject") {
    setMsg("");
    try {
      const r = await api.decideApproval(runId, decision, note || undefined);
      const outcome = OUTCOME_WORDS[r.outcome] ?? r.outcome;
      setMsg(`${outcome}${r.resubmits ? ` (attempt ${r.resubmits})` : ""}`);
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function approveOne(runId: string, actionId: string) {
    setMsg("");
    try {
      await api.approveAction(runId, actionId, note || undefined);
      setMsg("Approved");
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function approveEverything() {
    setMsg("");
    try {
      const r = await api.approveAll(org);
      setMsg(
        r.failed.length === 0
          ? `Approved ${r.approved}`
          : `Approved ${r.approved}, ${r.failed.length} still need you`,
      );
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function decideIdea(id: string, decision: "approve" | "reject") {
    setMsg("");
    try {
      await api.decideProposal(org, id, decision, note || undefined);
      setMsg(decision === "approve" ? "Idea started" : "Idea rejected");
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  const pendCount = rows.filter((a) => a.status === "pending").length;

  return (
    <div>
      <div className="page-head">
        <h1>Approvals</h1>
        <div className="row">
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">all</option>
              <option value="pending">pending</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
            </select>
          </label>
          {pendCount > 1 && (
            <button className="primary sm" onClick={approveEverything}>
              Approve all {pendCount}
            </button>
          )}
        </div>
      </div>
      <p className="page-sub">Results waiting on your decision.</p>
      {msg && <p className="dim">{msg}</p>}
      {ideas.length > 0 && (
        <section>
          <h2>Ideas from the team</h2>
          <ul className="list">
            {ideas.map((p) => (
              <li key={p.id}>
                <div className="card-head">
                  <strong>{p.title}</strong>
                  <span className="dim">{p.kind === "new-goal" ? "new goal" : p.kind}</span>
                </div>
                <p className="dim">{p.body.slice(0, 200)}</p>
                <p className="dim">Starts on its own {p.start_at.slice(5, 16).replace("T", " ")} unless you answer.</p>
                <div className="row">
                  <button
                    className="primary sm"
                    onClick={() => decideIdea(p.id, "approve")}
                  >
                    Start now
                  </button>
                  <button className="danger sm" onClick={() => decideIdea(p.id, "reject")}>
                    Reject
                  </button>
                  {p.run_id && (
                    <button className="link" onClick={() => onRun(p.run_id!)}>Open session</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <label>
        Note{" "}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
      </label>
      <ul className="list">
        {rows.map((a) => (
          <li key={a.id}>
            <span className={`status status-${a.status}`}>{statusLabel(a.status)}</span>{" "}
            <span className="dim">
              {approvalKindLabel(a.kind)} · try {a.attempt}
              {a.resubmits > 0 ? ` · ${a.resubmits} retr${a.resubmits === 1 ? "y" : "ies"}` : ""}
            </span>{" "}
            <button className="link" onClick={() => onRun(a.runId)}>
              {a.runId.slice(0, 8)}
            </button>
            {a.actionKind && (
              <span className="dim">
                {" "}
                · {actionLabel(a.actionKind)} {a.actionTarget}
              </span>
            )}
            {a.runGoal && <p className="dim">{a.runGoal.slice(0, 140)}</p>}
            {a.note && <p>Note: {a.note}</p>}
            {a.revisionRunId && (
              <p>
                Fix:{" "}
                <button className="link" onClick={() => onRun(a.revisionRunId!)}>
                  open session
                </button>
              </p>
            )}
            {a.status === "pending" && a.kind === "pre" && (
              <div className="row">
                <button className="primary sm" onClick={() => decide(a.runId, "approve")}>Approve</button>
                <button className="danger sm" onClick={() => decide(a.runId, "reject")}>Reject</button>
              </div>
            )}
            {a.status === "pending" && a.kind === "post" && a.actionId && (
              <div className="row">
                <button className="primary sm" onClick={() => approveOne(a.runId, a.actionId!)}>Approve</button>
                <button className="link" onClick={() => onRun(a.runId)}>Open session</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {rows.length === 0 && (
        <div className="empty">
          <strong>All clear</strong>
          Nothing waiting on you.
        </div>
      )}
    </div>
  );
}

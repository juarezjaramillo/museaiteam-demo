import { useEffect, useState } from "react";
import { hireDisplayName } from "@museaiteam/shared";
import { api, type ApprovalRow, type ProposalRow } from "../api.js";
import { actionLabel, approvalKindLabel, statusLabel } from "@museaiteam/shared";

const OUTCOME_WORDS: Record<string, string> = {
  approved: "Approved",
  resubmitted: "Sent back for a retry",
  failed: "Failed — retry cap reached",
};

interface SeatAsk {
  id: string;
  seatId: string;
  role: string;
  email: string | null;
  tools: string[];
  paid: string[];
  status: string;
}

function SeatAskCard({ org, ask, done }: { org: string; ask: SeatAsk; done: () => void }) {
  const [off, setOff] = useState<string[]>([]);
  const [msg, setMsg] = useState("");

  function toggle(tool: string) {
    setOff((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
  }

  async function decide(approve: boolean) {
    setMsg("");
    try {
      await api.decideSeatRequest(org, ask.id, approve, approve ? off : []);
      done();
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <li>
      <div className="card-head">
        <strong>{hireDisplayName(ask.role)}</strong>
        <span className="dim">{ask.email ?? ""}</span>
        {ask.paid.length > 0 && <span className="badge warn">paid: {ask.paid.join(", ")}</span>}
      </div>
      <ul className="list">
        {ask.tools.map((t) => (
          <li key={t}>
            <label className="ask-tool">
              <input type="checkbox" checked={!off.includes(t)} onChange={() => toggle(t)} />
              <span>{t}</span>
              {ask.paid.includes(t) && <span className="dim">(paid seat)</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="primary sm" onClick={() => decide(true)}>
          Approve{off.length > 0 ? ` (${ask.tools.length - off.length})` : " all"}
        </button>
        <button className="danger sm" onClick={() => decide(false)}>Deny</button>
      </div>
      {msg && <p className="dim">{msg}</p>}
    </li>
  );
}

export function Approvals({
  org,
  onRun,
}: {
  org: string;
  onRun: (id: string) => void;
}) {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [ideas, setIdeas] = useState<ProposalRow[]>([]);
  const [asks, setAsks] = useState<SeatAsk[]>([]);
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
    try {
      const q = await api.getSeatRequests(org);
      setAsks(q.requests.filter((x) => x.status === "proposed"));
    } catch {
      setAsks([]);
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

  async function decideTool(id: string, decision: "approve" | "reject") {
    setMsg("");
    try {
      await api.decideTool(org, id, decision);
      setMsg(decision === "approve" ? "Tool call approved" : "Tool call rejected");
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
      {asks.length > 0 && (
        <section>
          <h2>Seat asks from the team</h2>
          <ul className="list">
            {asks.map((a) => (
              <SeatAskCard key={a.id} org={org} ask={a} done={() => load()} />
            ))}
          </ul>
        </section>
      )}
      {ideas.length > 0 && (
        <section>
          <h2>Ideas from the team</h2>
          <ul className="list">
            {ideas.map((p) => (
              <li key={p.id}>
                <div className="card-head">
                  <strong>{p.title}</strong>
                  <span className="dim">{p.kind === "new-goal" ? "new goal" : p.kind === "signup" ? "needs an account" : p.kind}</span>
                </div>
                <p className="dim">{p.body.slice(0, 200)}</p>
                {p.kind === "signup" ? (
                  <p className="dim">This one waits for you — it never starts on its own.</p>
                ) : (
                  <p className="dim">Starts on its own {p.start_at.slice(5, 16).replace("T", " ")} unless you answer.</p>
                )}
                <div className="row">
                  <button
                    className="primary sm"
                    onClick={() => decideIdea(p.id, "approve")}
                  >
                    {p.kind === "signup" ? "Show me the steps" : "Start now"}
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
            {a.mcpServerId && (
              <p className="dim">
                {a.mcpTool
                  ? `Tool call: ${a.mcpServerName ?? "a server"} → ${a.mcpTool.replace(/_/g, " ")}`
                  : `First use: the team wants to start using ${a.mcpServerName ?? "a new tool server"}`}
              </p>
            )}
            {a.mcpArgs && <p className="dim">Details: {a.mcpArgs.slice(0, 200)}</p>}
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
            {a.status === "pending" && a.mcpServerId && (
              <div className="row">
                <button className="primary sm" onClick={() => decideTool(a.id, "approve")}>
                  {a.mcpTool ? "Run it" : "Trust it"}
                </button>
                <button className="danger sm" onClick={() => decideTool(a.id, "reject")}>
                  {a.mcpTool ? "Skip it" : "Block it"}
                </button>
                <button className="link" onClick={() => onRun(a.runId)}>Open session</button>
              </div>
            )}
            {a.status === "pending" && a.kind === "post" && a.actionId && !a.mcpServerId && (
              <div className="row">
                <button className="primary sm" onClick={() => approveOne(a.runId, a.actionId!)}>Approve</button>
                <button className="link" onClick={() => onRun(a.runId)}>Open session</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {rows.length === 0 && ideas.length === 0 && asks.length === 0 && (
        <div className="empty">
          <strong>All clear</strong>
          Nothing waiting on you.
        </div>
      )}
    </div>
  );
}

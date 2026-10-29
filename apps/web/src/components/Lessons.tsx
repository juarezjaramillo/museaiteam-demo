import { useEffect, useState } from "react";
import { api, type PlaybookRow } from "../api.js";
import { statusLabel } from "@museaiteam/shared";

export function Lessons({ org }: { org: string }) {
  const [rows, setRows] = useState<PlaybookRow[]>([]);
  const [msg, setMsg] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});

  async function load() {
    const r = await api.getPlaybook(org);
    setRows(r.entries);
  }

  useEffect(() => {
    load().catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function save(id: string, status: string, tactic?: string) {
    setMsg("");
    try {
      await api.patchPlaybook(org, id, {
        status,
        ...(tactic !== undefined ? { tactic } : {}),
      });
      setMsg("Saved");
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Lessons</h1>
      </div>
      <p className="page-sub">What the team learned. Approve what works, reject what doesn't.</p>
      {msg && <p className="dim">{msg}</p>}
      <ul className="list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className={`status status-${r.status}`}>{statusLabel(r.status)}</span>{" "}
            <span className="dim">{r.system}</span>
            <p>{edits[r.id] ?? r.tactic}</p>
            <textarea
              value={edits[r.id] ?? r.tactic}
              onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
              rows={2}
            />
            <div className="row">
              <button className="primary sm" onClick={() => save(r.id, "approved", edits[r.id] ?? r.tactic)}>
                Approve{edits[r.id] && edits[r.id] !== r.tactic ? " + save edit" : ""}
              </button>
              <button className="danger sm" onClick={() => save(r.id, "vetoed")}>Reject</button>
              {r.status !== "draft" && <button className="sm" onClick={() => save(r.id, "draft")}>Back to draft</button>}
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 0 && (
        <div className="empty">
          <strong>Nothing learned yet</strong>
          Rate shipped work and the team distills what works here.
        </div>
      )}
    </div>
  );
}

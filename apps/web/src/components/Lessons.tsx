import { useEffect, useState } from "react";
import { api, type PlaybookRow } from "../api.js";
import { providerLabel, statusLabel } from "@museaiteam/shared";

function LessonCard({
  org,
  row,
  onDone,
}: {
  org: string;
  row: PlaybookRow;
  onDone: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.tactic);

  async function save(status: string, tactic?: string) {
    try {
      await api.patchPlaybook(org, row.id, {
        status,
        ...(tactic !== undefined ? { tactic } : {}),
      });
      setEditing(false);
      onDone("Saved");
    } catch (e) {
      onDone(String(e));
    }
  }

  return (
    <li>
      <span className={`status status-${row.status}`}>{statusLabel(row.status)}</span>{" "}
      <span className="dim">{providerLabel(row.system)}</span>
      {editing ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <div className="row">
            <button className="primary sm" onClick={() => save(row.status, text)}>
              Save edit
            </button>
            <button
              className="link"
              onClick={() => {
                setText(row.tactic);
                setEditing(false);
              }}
            >
              cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{row.tactic}</p>
          <div className="row">
            {row.status !== "approved" && (
              <button className="primary sm" onClick={() => save("approved")}>
                Approve
              </button>
            )}
            {row.status !== "vetoed" && (
              <button className="danger sm" onClick={() => save("vetoed")}>Reject</button>
            )}
            {row.status !== "draft" && (
              <button className="sm" onClick={() => save("draft")}>Back to draft</button>
            )}
            <button className="link" onClick={() => setEditing(true)}>Edit</button>
          </div>
        </>
      )}
    </li>
  );
}

export function Lessons({ org }: { org: string }) {
  const [rows, setRows] = useState<PlaybookRow[]>([]);
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await api.getPlaybook(org);
    setRows(r.entries);
  }

  useEffect(() => {
    load().catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  return (
    <div>
      <div className="page-head">
        <h1>Lessons</h1>
      </div>
      <p className="page-sub">What the team learned. Approve what works, reject what doesn't.</p>
      {msg && <p className="dim">{msg}</p>}
      <ul className="list">
        {rows.map((r) => (
          <LessonCard
            key={r.id}
            org={org}
            row={r}
            onDone={(m) => {
              setMsg(m);
              load().catch(() => undefined);
            }}
          />
        ))}
      </ul>
      {rows.length === 0 && (
        <div className="empty">
          <strong>Nothing learned yet</strong>
          Rate finished work and the team distills what works here.
        </div>
      )}
    </div>
  );
}

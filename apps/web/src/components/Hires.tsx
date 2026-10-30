import { useEffect, useState } from "react";
import { crewName, hireDisplayName } from "@museaiteam/shared";
import { api, type HireRow } from "../api.js";
import { ThumbDown, ThumbUp } from "./icons.js";

interface SeatView {
  id: string;
  role: string;
  email: string | null;
  approved: boolean;
  keystone: string | null;
  keystoneReady: boolean;
  sessionOne: boolean;
  on: string[];
  waiting: Array<{ tool: string; step: string; status: string; detail: string }>;
  box: string;
  spend: { seconds: number; cents: number } | null;
  request: { id: string; status: string; tools: string[]; paid: string[] } | null;
  logins: Array<{ tool: string; kind: string; status: string; expires: string | null }>;
}

type HireStatus = "approval" | "attention" | "readying" | "working";

function statusOf(s: SeatView): { kind: HireStatus; label: string } {
  if (!s.approved) return { kind: "approval", label: "Needs approval" };
  if (s.request?.status === "proposed") return { kind: "approval", label: "Needs approval" };
  if (s.logins.some((l) => l.status === "lost")) return { kind: "attention", label: "Needs attention" };
  if (!s.keystoneReady) return { kind: "readying", label: "Getting ready" };
  return { kind: "working", label: "Working" };
}

function computerWords(box: string): string {
  if (box === "running") return "On";
  if (box === "sleeping") return "Asleep";
  return "No computer yet";
}

function RelayForm({ org, seatId, tool, done }: { org: string; seatId: string; tool: string; done: () => void }) {
  const [secret, setSecret] = useState("");
  const [days, setDays] = useState("30");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        paste a login for {tool}
      </button>
    );
  }
  async function save() {
    setMsg("");
    try {
      await api.saveSeatSession(org, seatId, tool, secret.trim(), Math.max(1, Number(days) || 30));
      setSecret("");
      setOpen(false);
      done();
    } catch (e) {
      setMsg(String(e));
    }
  }
  return (
    <span className="row">
      <input
        type="password"
        placeholder={`${tool} session or token`}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      <input
        placeholder="days ok"
        value={days}
        onChange={(e) => setDays(e.target.value)}
        style={{ width: 70 }}
      />
      <button className="primary" onClick={save}>Save login</button>
      <button className="link" onClick={() => setOpen(false)}>cancel</button>
      {msg && <span className="dim">{msg}</span>}
    </span>
  );
}

function GrantForm({ org, seatId, done }: { org: string; seatId: string; done: () => void }) {
  const [tools, setTools] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        give tools
      </button>
    );
  }
  async function grant() {
    setMsg("");
    try {
      const r = await api.grantSeatTools(org, seatId, tools.split(/[,\s]+/).filter(Boolean));
      setTools("");
      setOpen(false);
      done();
      if (r.granted.length === 0) setMsg("Nothing new — all covered.");
    } catch (e) {
      setMsg(String(e));
    }
  }
  return (
    <span className="row">
      <input
        placeholder="figma, linear"
        value={tools}
        onChange={(e) => setTools(e.target.value)}
      />
      <button className="primary" onClick={grant}>Give</button>
      <button className="link" onClick={() => setOpen(false)}>cancel</button>
      {msg && <span className="dim">{msg}</span>}
    </span>
  );
}

function HireCard({
  org,
  seat: s,
  role,
  canDecide,
  open,
  onToggle,
  menuOpen,
  onMenu,
  act,
  reload,
}: {
  org: string;
  seat: SeatView;
  role: string;
  canDecide: boolean;
  open: boolean;
  onToggle: () => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  act: (fn: () => Promise<unknown>, fail: string) => void;
  reload: () => void;
}) {
  const st = statusOf(s);
  const lost = s.logins.filter((l) => l.status === "lost");

  function primary() {
    if (!canDecide) return null;
    if (!s.approved) {
      return (
        <button className="primary sm" onClick={(e) => { e.stopPropagation(); act(() => api.approveSeat(org, s.id), "Could not approve."); }}>
          Approve
        </button>
      );
    }
    if (s.request?.status === "proposed") {
      return (
        <button className="primary sm" onClick={(e) => { e.stopPropagation(); act(() => api.decideSeatRequest(org, s.request!.id, true, []), "Could not approve."); }}>
          Approve ({s.request.tools.length})
        </button>
      );
    }
    return null;
  }

  return (
    <li className="hire">
      <div className="hire-row" onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}>
        <span className={`avatar role-${s.role}`}>{crewName(s.role).slice(0, 1)}</span>
        <span className="hire-id">
          <strong>{hireDisplayName(s.role)}</strong>
          <span className="dim">{s.role} · {s.email ?? "no inbox yet"}</span>
        </span>
        <span className={`badge ${st.kind === "working" ? "good" : st.kind === "readying" ? "soft" : "warn"}`}>{st.label}</span>
        {primary()}
        <span className="menu-wrap">
          <button
            className="icon-btn"
            aria-label="More actions"
            onClick={(e) => { e.stopPropagation(); onMenu(!menuOpen); }}
          >
            ⋮
          </button>
          {menuOpen && (
            <span className="menu" onClick={(e) => e.stopPropagation()}>
              {s.box === "sleeping" && canDecide && (
                <button className="link" onClick={() => { onMenu(false); act(() => api.wakeBox(org, s.id), "Computer is busy or offline."); }}>
                  Wake computer
                </button>
              )}
              {role === "owner" && (
                <button
                  className="link danger-text"
                  onClick={() => {
                    onMenu(false);
                    if (window.confirm(`Offboard ${hireDisplayName(s.role)}? Logins wiped, computer destroyed, inbox frozen.`)) {
                      act(() => api.fireSeat(org, s.id), "Could not offboard.");
                    }
                  }}
                >
                  Offboard
                </button>
              )}
            </span>
          )}
        </span>
        <span className={`chev ${open ? "up" : ""}`}>›</span>
      </div>
      {open && (
        <div className="hire-detail">
          {s.request?.status === "proposed" && (
            <p>
              Asked for: {s.request.tools.join(", ")}
              {s.request.paid.length > 0 && <span className="dim"> (paid seats: {s.request.paid.join(", ")})</span>}{" "}
              <a href="#/approvals">pick tools</a>
            </p>
          )}
          {lost.length > 0 && (
            <p>
              {lost.map((l) => l.tool).join(", ")} stopped working.{" "}
              {role === "owner" ? "Paste a fresh login below." : "Ask the owner for a fresh login."}
            </p>
          )}
          {s.on.length > 0 && <p>Ready: {s.on.join(", ")}</p>}
          {s.waiting.map((w) => (
            <p key={w.tool} className="dim">
              {w.tool} — {w.detail || w.status}{" "}
              {role === "owner" && <RelayForm org={org} seatId={s.id} tool={w.tool} done={reload} />}
            </p>
          ))}
          {s.logins.length > 0 && (
            <p className="dim">
              Logins: {s.logins.map((l) => (
                <span key={l.tool}>
                  {l.tool} ({l.status === "ok" ? (l.expires ? `ok till ${l.expires.slice(0, 10)}` : "ok") : l.status}){" "}
                </span>
              ))}
            </p>
          )}
          <p className="dim">
            Computer: {computerWords(s.box)}
            {s.spend && s.spend.seconds > 0 && (
              <> · {Math.round(s.spend.seconds / 60)} min · about ${(s.spend.cents / 100).toFixed(2)}</>
            )}
          </p>
          {canDecide && <GrantForm org={org} seatId={s.id} done={reload} />}
        </div>
      )}
    </li>
  );
}

export function Hires({ org, role }: { org: string; role: string }) {
  const [hires, setHires] = useState<HireRow[]>([]);
  const [seats, setSeats] = useState<SeatView[]>([]);
  const [meanwhile, setMeanwhile] = useState<string[]>([]);
  const [cutover, setCutover] = useState<{ cutOver: boolean; providers: string[]; servers: string[]; kept: string[] } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const canDecide = role === "owner" || role === "approver";

  async function load() {
    const t = await api.getTeamSeats(org);
    setSeats(t.seats);
    setMeanwhile(t.meanwhile);
    const h = await api.getHires(org);
    setHires(h.hires);
    if (role === "owner") {
      setCutover(await api.getCutover(org));
    }
  }

  useEffect(() => {
    load().catch(() => {
      setSeats([]);
      setHires([]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function act(fn: () => Promise<unknown>, fail: string) {
    setMsg("");
    try {
      await fn();
      await load();
    } catch {
      setMsg(fail);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Hires</h1>
      </div>
      <p className="page-sub">Your AI employees and what they need.</p>
      {msg && <p className="dim">{msg}</p>}
      <ul className="list">
        {seats.map((s) => (
          <HireCard
            key={s.id}
            org={org}
            seat={s}
            role={role}
            canDecide={canDecide}
            open={expanded === s.id}
            onToggle={() => setExpanded((cur) => (cur === s.id ? null : s.id))}
            menuOpen={menu === s.id}
            onMenu={(o) => setMenu(o ? s.id : null)}
            act={act}
            reload={load}
          />
        ))}
      </ul>
      {meanwhile.length > 0 && (
        <section>
          <h3>Doing meanwhile</h3>
          <ul className="list">
            {meanwhile.map((m, i) => (
              <li key={i}><span className="dim">{m}</span></li>
            ))}
          </ul>
        </section>
      )}
      {role === "owner" && cutover && !cutover.cutOver && (
        <section>
          <h3>One login per hire</h3>
          <p className="dim">
            Shared logins still on: {[...cutover.providers, ...cutover.servers].join(", ") || "none"}.
            Move each hire to its own login, then flip the switch.
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={() => act(async () => {
                const r = await api.migrateCutover(org);
                setCutover(r.status);
                setMsg(r.retired.length > 0 ? `Retired: ${r.retired.join(", ")}.` : "Checklist ready — approve each hire above.");
              }, "Migration failed.")}
            >
              Move hires to own logins
            </button>
            <button
              className="link"
              onClick={() => act(async () => {
                await api.flipCutover(org);
                setCutover(await api.getCutover(org));
              }, "Shared logins remain — move them first.")}
            >
              Flip the switch
            </button>
          </div>
        </section>
      )}
      <h3>Records</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>Role</th>
            <th>Sessions</th>
            <th>Suggestions</th>
            <th>Agreement</th>
            <th>Shipped</th>
            <th title="Thumbs up"><ThumbUp /></th>
            <th title="Thumbs down"><ThumbDown /></th>
            <th>Words</th>
          </tr>
        </thead>
        <tbody>
          {hires.map((h) => (
            <tr key={h.role}>
              <td><span className={`role role-${h.role}`}>{h.role}</span></td>
              <td>{h.runs}</td>
              <td>{h.proposals}</td>
              <td>{h.votes}</td>
              <td>{h.shipped}</td>
              <td>{h.up}</td>
              <td>{h.down}</td>
              <td>
                {h.tokens.toLocaleString()}
                {h.tokensEstimated && <span title="Split evenly across the team"> (guess)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hires.length === 0 && (
        <div className="empty">
          <strong>No activity yet</strong>
          Hire records appear after the first session.
        </div>
      )}
    </div>
  );
}

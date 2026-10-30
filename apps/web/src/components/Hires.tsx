import { useEffect, useState } from "react";
import { hireDisplayName } from "@museaiteam/shared";
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

export function Hires({ org, role }: { org: string; role: string }) {
  const [hires, setHires] = useState<HireRow[]>([]);
  const [seats, setSeats] = useState<SeatView[]>([]);
  const [meanwhile, setMeanwhile] = useState<string[]>([]);
  const [cutover, setCutover] = useState<{ cutOver: boolean; providers: string[]; servers: string[]; kept: string[] } | null>(null);
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
      <p className="page-sub">Each hire's desk: what is ready, what is waiting, what it costs.</p>
      {msg && <p className="dim">{msg}</p>}
      <ul className="list">
        {seats.map((s) => (
          <li key={s.id}>
            <div className="card-head">
              <strong><span className={`role role-${s.role}`}>{hireDisplayName(s.role)}</span></strong>
              <span className="dim">{s.email ?? "no inbox yet"}</span>
              {s.approved ? (
                <span className="badge soft">working</span>
              ) : (
                canDecide && (
                  <button
                    className="primary"
                    onClick={() => act(() => api.approveSeat(org, s.id), "Could not approve.")}
                  >
                    Approve all
                  </button>
                )
              )}
              {s.sessionOne && <span className="badge soft">started</span>}
              {role === "owner" && (
                <button
                  className="link"
                  onClick={() => {
                    if (window.confirm(`Offboard ${hireDisplayName(s.role)}? Logins wiped, desk destroyed, inbox frozen.`)) {
                      act(() => api.fireSeat(org, s.id), "Could not offboard.");
                    }
                  }}
                >
                  offboard
                </button>
              )}
            </div>
            <div className="dim">
              {s.keystone && (
                <>Main tool: {s.keystone} {s.keystoneReady ? "ready" : "not ready yet"} · </>
              )}
              Desk: {s.box}
              {s.box === "sleeping" && canDecide && (
                <> · <button className="link" onClick={() => act(() => api.wakeBox(org, s.id), "Desk is busy or offline.")}>wake</button></>
              )}
              {s.spend && s.spend.seconds > 0 && (
                <> · {Math.round(s.spend.seconds / 60)} min on the desk (${(s.spend.cents / 100).toFixed(2)} guess)</>
              )}
            </div>
            {s.request && s.request.status === "proposed" && (
              <div>
                Asked for: {s.request.tools.map((t) => (
                  <span key={t} className="badge warn">{t}</span>
                ))}
                {s.request.paid.length > 0 && (
                  <span className="dim"> (paid: {s.request.paid.join(", ")})</span>
                )}{" "}
                <span className="dim">— answer in Approvals</span>
              </div>
            )}
            {s.on.length > 0 && (
              <div>Ready: {s.on.map((t) => (
                <span key={t} className="badge soft">{t}</span>
              ))}</div>
            )}
            {s.logins.length > 0 && (
              <div className="dim">
                Logins: {s.logins.map((l) => (
                  <span key={l.tool}>
                    {l.tool} ({l.status}{l.status === "ok" && l.expires ? `, ok till ${l.expires.slice(0, 10)}` : ""}){" "}
                  </span>
                ))}
              </div>
            )}
            {canDecide && (
              <div><GrantForm org={org} seatId={s.id} done={load} /></div>
            )}
            {s.waiting.length > 0 && (
              <ul className="list">
                {s.waiting.map((w) => (
                  <li key={w.tool}>
                    <strong>{w.tool}</strong> <span className="dim">{w.detail || w.status}</span>{" "}
                    {role === "owner" && (
                      <RelayForm org={org} seatId={s.id} tool={w.tool} done={load} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
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

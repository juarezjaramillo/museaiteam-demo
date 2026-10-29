import { useEffect, useState } from "react";
import { api, type InviteRow, type MemberRow } from "../api.js";

export function Team({ org, role }: { org: string; role: string }) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("approver");
  const [msg, setMsg] = useState("");
  const owner = role === "owner";

  async function load() {
    const m = await api.getMembers(org);
    setMembers(m.members);
    if (owner) {
      const i = await api.getInvites(org);
      setInvites(i.invites);
    }
  }

  useEffect(() => {
    load().catch(() => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function invite() {
    setMsg("");
    try {
      const r = await api.createInvite(org, email.trim(), inviteRole);
      setMsg(r.emailed ? "Invite sent." : "Invite created (email not delivered).");
      setEmail("");
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>Members</h1>
      </div>
      <p className="page-sub">Humans who can watch, approve, or manage.</p>
      {msg && <p className="dim">{msg}</p>}
      <ul className="list">
        {members.map((m) => (
          <li key={m.id}>
            <div className="card-head">
              <strong>{m.email ?? m.id.slice(0, 8)}</strong>
              <span className="badge soft">{m.role}</span>
            </div>
          </li>
        ))}
      </ul>
      {owner && (
        <section>
          <h3>Invite</h3>
          <div className="row">
            <input
              placeholder="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="approver">approver</option>
              <option value="viewer">viewer</option>
            </select>
            <button className="primary" onClick={invite}>Send invite</button>
          </div>
          <ul className="list">
            {invites.map((i) => (
              <li key={i.id}>
                {i.email} <span className="dim">{i.role} · ends {i.expiresAt.slice(0, 10)}</span>{" "}
                <button className="link" onClick={() => api.revokeInvite(org, i.id).then(load)}>
                  cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

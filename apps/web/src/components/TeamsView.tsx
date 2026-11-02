import { useEffect, useState } from "react";
import { api, type MemberRow, type TeamRow } from "../api.js";
import { hireDisplayName, roleLabel } from "@museaiteam/shared";
import { Review } from "./Review.js";

function ownerName(team: TeamRow, members: MemberRow[]): string {
  if (!team.ownerUserId) return "Founder's bench";
  return members.find((m) => m.id === team.ownerUserId)?.email ?? "Former member";
}

const REVIEW_WORDS: Record<TeamRow["review"], string> = {
  reviewed: "Reviewed ✓",
  waiting: "Needs review",
  never: "New",
};

export function Teams({ org, role }: { org: string; role: string }) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const canDecide = role === "owner";

  async function load() {
    const [t, m] = await Promise.all([api.getTeams(org), api.getMembers(org)]);
    setTeams(t.teams);
    setMembers(m.members);
  }

  useEffect(() => {
    load().catch((e) => setMsg(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  async function assign(teamId: string, userId: string) {
    setMsg("");
    try {
      await api.setTeamOwner(org, teamId, userId === "" ? null : userId);
      await load();
    } catch (e) {
      setMsg(String(e));
    }
  }

  async function move(seatId: string, teamId: string) {
    setMsg("");
    try {
      await api.moveSeat(org, seatId, teamId);
      await load();
    } catch (e) {
      setMsg(e instanceof Error && /409|duplicate/i.test(e.message) ? "That team already has this role." : String(e));
    }
  }

  if (reviewId) {
    return (
      <Review
        org={org}
        teamId={reviewId}
        onBack={() => {
          setReviewId(null);
          load().catch(() => {});
        }}
      />
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1>Teams</h1>
      </div>
      <p className="page-sub">One team per person, from the shared bench. Move hires freely.</p>
      {msg && <p className="dim">{msg}</p>}
      <ul className="list">
        {teams.map((t) => (
          <li key={t.id}>
            <div className="card-head">
              <span>
                <strong>{t.name}</strong> <span className="badge">{REVIEW_WORDS[t.review]}</span>
              </span>
              <button className="sm" onClick={() => setReviewId(t.id)}>
                Review
              </button>
            </div>
            <div className="card-head">
              {canDecide ? (
                <label className="dim">
                  Serves{" "}
                  <select
                    aria-label={`Who ${t.name} serves`}
                    value={t.ownerUserId ?? ""}
                    onChange={(e) => assign(t.id, e.target.value)}
                  >
                    <option value="">Founder's bench</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.email ?? "Member"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="dim">Serves {ownerName(t, members)}</span>
              )}
            </div>
            {t.seats.length === 0 && (
              <p className="dim">No hires yet — add them in Setup.</p>
            )}
            {t.seats.map((s) => (
              <div className="conn-row" key={s.id}>
                <span>
                  {hireDisplayName(s.role)}{" "}
                  <span className="dim">
                    {roleLabel(s.role)}{s.email ? ` · ${s.email}` : ""}
                  </span>
                </span>
                {canDecide && teams.length > 1 && (
                  <select
                    aria-label={`Move ${hireDisplayName(s.role)} to`}
                    value={t.id}
                    onChange={(e) => {
                      if (e.target.value !== t.id) move(s.id, e.target.value);
                    }}
                  >
                    {teams.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.id === t.id ? "This team" : `Move to ${o.name}`}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </li>
        ))}
      </ul>
      {teams.length === 0 && (
        <div className="empty">
          <strong>No teams yet</strong>
          The founder's first team appears after setup.
        </div>
      )}
    </div>
  );
}

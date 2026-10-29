import type { FeedEvent, Proposal } from "@museaiteam/shared";
import { actionLabel, choiceLabel, statusLabel } from "@museaiteam/shared";

function tallyFor(proposalId: string, events: FeedEvent[]) {
  let fors = 0;
  let againsts = 0;
  let abstains = 0;
  for (const e of events) {
    if (e.type === "vote" && e.vote.proposalId === proposalId) {
      if (e.vote.choice === "for") fors++;
      else if (e.vote.choice === "against") againsts++;
      else abstains++;
    }
  }
  return { fors, againsts, abstains };
}

export function Feed({ events }: { events: FeedEvent[] }) {
  const titles = new Map<string, Proposal>();
  for (const e of events) {
    if (e.type === "proposal") titles.set(e.proposal.id, e.proposal);
  }
  if (!events.length) {
    return <p className="dim">The team is getting organized…</p>;
  }
  return (
    <ol className="feed">
      {events.map((e, i) => {
        if (e.type === "proposal") {
          const t = tallyFor(e.proposal.id, events);
          const total = t.fors + t.againsts + t.abstains;
          const pct = (n: number) => (total > 0 ? `${(100 * n) / total}%` : "0%");
          return (
            <li key={i} className="card proposal">
              <div className="card-head">
                <span className={`role role-${e.proposal.agentRole}`}>
                  {e.proposal.agentRole}
                </span>
                <strong>{e.proposal.title}</strong>
              </div>
              <div
                className="meter-bar"
                role="img"
                aria-label={`${t.fors} agree, ${t.againsts} disagree, ${t.abstains} pass`}
              >
                <i className="m-for" style={{ width: pct(t.fors) }} />
                <i className="m-against" style={{ width: pct(t.againsts) }} />
                <i className="m-abstain" style={{ width: pct(t.abstains) }} />
              </div>
              <div className="tally dim">
                {t.fors} agree · {t.againsts} disagree · {t.abstains} pass
              </div>
              <details>
                <summary>Details</summary>
                <pre>{e.proposal.body}</pre>
              </details>
            </li>
          );
        }
        if (e.type === "vote") {
          const p = titles.get(e.vote.proposalId);
          return (
            <li key={i} className="vote">
              <span className={`role role-${e.vote.agentRole}`}>
                {e.vote.agentRole}
              </span>
              <span className={`choice choice-${e.vote.choice}`}>
                {choiceLabel(e.vote.choice)}
              </span>
              <span className="dim">
                {p ? `${p.agentRole}'s “${p.title}”` : e.vote.proposalId}
              </span>
              <div className="reason">{e.vote.reason}</div>
            </li>
          );
        }
        if (e.type === "ruling") {
          return (
            <li key={i} className="card ruling">
              <div className="card-head">
                <span className="badge">
                  decision · {e.ruling.decidedBy}
                </span>
              </div>
              <strong>{e.ruling.decision}</strong>
              <p className="dim">{e.ruling.rationale}</p>
            </li>
          );
        }
        if (e.type === "action") {
          const reason = e.action.payload?.reason;
          return (
            <li key={i} className="vote">
              <span className="badge">{actionLabel(e.action.kind)}</span>
              <code>{e.action.target}</code>
              <span className={`status status-${e.action.status}`}>
                {statusLabel(e.action.status)}
              </span>
              {typeof reason === "string" && (
                <span className="dim">{reason}</span>
              )}
            </li>
          );
        }
        if (e.type === "baseline") {
          return (
            <li key={i} className="card baseline">
              <div className="card-head">
                <span className="badge">
                  comparison · {e.baseline.tokens.toLocaleString()} words
                </span>
              </div>
              <strong>{e.baseline.title}</strong>
              <details>
                <summary>The single try</summary>
                <pre>{e.baseline.body}</pre>
              </details>
            </li>
          );
        }
        if (e.type === "status") {
          return (
            <li key={i} className="status-line">
              <span className={`status status-${e.status}`}>{statusLabel(e.status)}</span>
            </li>
          );
        }
        return (
          <li key={i} className="status-line dim">
            unknown event
          </li>
        );
      })}
    </ol>
  );
}

export interface MatrixProposal {
  id: string;
}

export interface RawVote {
  proposalId: string;
  choice: "for" | "against" | "abstain";
  reason: string;
}

export interface RoleBallot<R = string> {
  role: R;
  votes: RawVote[];
}

export interface CastVote<R = string> {
  role: R;
  proposalId: string;
  choice: "for" | "against" | "abstain";
  reason: string;
}

/**
 * Normalizes role ballots into a guaranteed full matrix: one vote per
 * role per proposal. Unknown proposal ids are dropped, duplicate votes
 * keep the first, and missing votes become explicit abstentions — so no
 * caller can ever observe a partial matrix.
 */
export function normalizeVoteMatrix<R = string>(
  proposals: MatrixProposal[],
  ballots: Array<RoleBallot<R>>,
): Array<CastVote<R>> {
  const known = new Set(proposals.map((p) => p.id));
  const votes: Array<CastVote<R>> = [];
  for (const { role, votes: ballot } of ballots) {
    const seen = new Set<string>();
    for (const v of ballot) {
      if (!known.has(v.proposalId) || seen.has(v.proposalId)) continue;
      seen.add(v.proposalId);
      votes.push({ role, ...v });
    }
    for (const p of proposals) {
      if (!seen.has(p.id)) {
        votes.push({
          role,
          proposalId: p.id,
          choice: "abstain",
          reason: "No vote returned; defaulted to abstain.",
        });
      }
    }
  }
  return votes;
}

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  CLASSIC_ROLES,
  MAX_DEBATE_ROUNDS,
  VOTE_TIMEOUT_MS,
  actionLabel,
  buildProof,
  nextAttempt,
  type Action,
  type Proposal,
  type SeatRole,
  type Vote,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { autoReviewRun, runGate } from "./approvals.js";
import { maybeSendFairUseAlert } from "./billing.js";
import { audit, checkLiveness, getRun, touchRun } from "./db.js";
import { notify } from "./notify.js";
import { approvedPlaybook } from "./learning.js";
import { sendRunDigest } from "./digest.js";
import { publishEvent } from "./events.js";
import { checkGuard } from "./guards.js";
import {
  openCodePr,
  openPlanPr,
  readFile,
  readTree,
} from "./integrations/github.js";
import {
  commentOnIssue,
  createIssue,
  createSubIssue,
  findTeamId,
  transitionIssue,
} from "./integrations/linear.js";
import {
  findChannelId,
  postMessage,
  replyToThread,
} from "./integrations/slack.js";
import {
  createTargetedDiscount,
  getProduct,
  updateProductDescription,
} from "./integrations/shopify.js";
import {
  associateNoteToTicket,
  createNote,
  findNewestOpenTicket,
  getTicketContent,
  getTicketFields,
  isScopeError,
  ticketStages,
  updateTicketContent,
  updateTicketFields,
} from "./integrations/hubspot.js";
import { createRunRecord, ensureDecisionDb } from "./integrations/notion.js";
import { commitRunMemory, recall } from "./memory.js";
import { recallFeedback } from "./feedback.js";
import { getProviderConfig, loadToken } from "./oauth.js";
import {
  metricLineFor,
  runCritique,
  runDiscountPlan,
  runEngineerDiff,
  runManagerRuling,
  runPmSplit,
  runProductCopy,
  runProposals,
  runSupportTriage,
  runVotes,
  type GoalContext,
} from "./agents.js";
import { addEvent, recordRunSummary } from "./goals.js";
import { promoteQueued, settleFailedRun } from "./staffing.js";

export interface GoalRunParams {
  runId: string;
  /** Approval resume path: skip straight to act, or re-rule first. */
  resume?: "act" | "rerule";
}

interface TallyRow {
  proposal_id: string;
  fors: number;
  againsts: number;
  total: number;
}

type StepOutcome = "ok" | "halted" | "failed";

/**
 * One Workflow per goal run: propose → vote → rule → act.
 * Every step persists to D1 first, checks liveness, and publishes to the
 * run's feed object. Steps report outcomes as return values; only
 * unexpected failures throw (and retry, then fail the run).
 */
export class GoalRunWorkflow extends WorkflowEntrypoint<Env, GoalRunParams> {
  private async finishHalted(runId: string): Promise<void> {
    await touchRun(this.env, runId, { status: "halted" });
    await publishEvent(this.env, runId, {
      type: "status",
      runId,
      status: "halted",
    });
    await audit(this.env, runId, "human", "run.halted");
    await this.recordRunSummary(runId, "halted");
    const run = await getRun(this.env, runId);
    if (run) await maybeSendFairUseAlert(this.env, run.org_id).catch(() => {});
    await promoteQueued(this.env);
  }

  private async finishFailed(runId: string, message: string): Promise<void> {
    await settleFailedRun(this.env, runId, message);
  }

  /** Closes the run's chapter in its goal history: ruling + artifacts + cost. */
  private async recordRunSummary(runId: string, status: string): Promise<void> {
    await recordRunSummary(this.env, runId, status);
  }

  private async proposeBody(runId: string): Promise<StepOutcome> {
    const { liveness, run } = await checkLiveness(
      this.env,
      runId,
      MAX_DEBATE_ROUNDS,
    );
    if (liveness !== "alive" || !run) {
      return liveness === "halted" ? "halted" : "failed";
    }
    await touchRun(this.env, runId, { status: "debating" });
    await publishEvent(this.env, runId, {
      type: "status",
      runId,
      status: "debating",
    });

    const memory = await this.recallSafe(runId, run.org_id, run.goal);
    const playbook = await approvedPlaybook(this.env, run.org_id).catch(() => []);
    const ctx: GoalContext = {
      goal: run.brief_note
        ? `${run.goal}\n\nFounder brief: ${run.brief_note}`
        : run.goal,
      metricLine: metricLineFor({
        metric_name: run.metric_name,
        metric_baseline: run.metric_baseline,
        metric_target: run.metric_target,
        timebox_days: run.timebox_days,
      }),
      round: run.rounds_used + 1,
      memory,
      playbook,
    };

    // The squad was fixed at creation (goal squad or org pick) and stored
    // on the lineup, so retries, the queue, and the feed see the same
    // debaters. The workflow never staffs.
    let squad: SeatRole[] = [];
    try {
      const parsed = JSON.parse(run.lineup) as unknown;
      if (Array.isArray(parsed)) {
        squad = parsed.filter((r): r is SeatRole => typeof r === "string");
      }
    } catch {
      /* falls through to the fallback below */
    }
    if (squad.length === 0) {
      squad = [...CLASSIC_ROLES];
      await audit(this.env, runId, "workflow", "squad.fallback", {
        reason: "empty lineup",
      });
    }


    // Idempotent resume: a retried step reuses complete stages from D1 and
    // regenerates incomplete ones wholesale, so retries can never duplicate.
    const EXPECTED_PROPOSALS = squad.length;
    let proposalTokens = 0;
    let voteTokens = 0;
    const stored: Proposal[] = [];
    const existing = await this.env.DB.prepare(
      "SELECT id, agent_role, title, body FROM proposals WHERE run_id = ?",
    )
      .bind(runId)
      .all<{ id: string; agent_role: Proposal["agentRole"]; title: string; body: string }>();
    let proposalsFresh = false;
    if ((existing.results ?? []).length === EXPECTED_PROPOSALS) {
      for (const p of existing.results ?? []) {
        stored.push({
          id: p.id,
          runId,
          agentRole: p.agent_role,
          title: p.title,
          body: p.body,
          artifactRefs: [],
        });
      }
    } else {
      await this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM votes WHERE run_id = ?").bind(runId),
        this.env.DB.prepare("DELETE FROM proposals WHERE run_id = ?").bind(runId),
      ]);
      const { proposals, tokens } = await runProposals(this.env, ctx, squad);
      proposalTokens = tokens;
      proposalsFresh = true;
      for (const { role, draft } of proposals) {
        stored.push({
          id: crypto.randomUUID(),
          runId,
          agentRole: role,
          title: draft.title,
          body: draft.body,
          artifactRefs: [],
        });
      }
    }
    for (const proposal of stored) {
      if (proposalsFresh) {
        await this.env.DB.prepare(
          `INSERT INTO proposals (id, run_id, agent_role, title, body,
            artifact_refs) VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            proposal.id,
            runId,
            proposal.agentRole,
            proposal.title,
            proposal.body,
            JSON.stringify(proposal.artifactRefs),
          )
          .run();
      }
      await publishEvent(this.env, runId, { type: "proposal", proposal });
    }

    const EXPECTED_VOTES = stored.length * stored.length;
    const voteCount = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM votes WHERE run_id = ?",
    )
      .bind(runId)
      .first<{ n: number }>();
    let votes: Array<{
      role: Proposal["agentRole"];
      proposalId: string;
      choice: "for" | "against" | "abstain";
      reason: string;
    }>;
    let votesFresh = false;
    if ((voteCount?.n ?? 0) === EXPECTED_VOTES && EXPECTED_VOTES > 0) {
      const rows = await this.env.DB.prepare(
        "SELECT agent_role, proposal_id, choice, reason FROM votes WHERE run_id = ?",
      )
        .bind(runId)
        .all<{
          agent_role: Proposal["agentRole"];
          proposal_id: string;
          choice: "for" | "against" | "abstain";
          reason: string;
        }>();
      votes = (rows.results ?? []).map((r) => ({
        role: r.agent_role,
        proposalId: r.proposal_id,
        choice: r.choice,
        reason: r.reason,
      }));
    } else {
      await this.env.DB.prepare("DELETE FROM votes WHERE run_id = ?")
        .bind(runId)
        .run();
      const fresh = await runVotes(
        this.env,
        ctx,
        stored.map((p) => ({
          id: p.id,
          role: p.agentRole,
          title: p.title,
          body: p.body,
        })),
        squad,
      );
      votes = fresh.votes;
      voteTokens = fresh.tokens;
      votesFresh = true;
    }
    for (const v of votes) {
      const vote: Vote = {
        id: crypto.randomUUID(),
        runId,
        proposalId: v.proposalId,
        agentRole: v.role,
        choice: v.choice,
        reason: v.reason,
      };
      if (votesFresh) {
        await this.env.DB.prepare(
          `INSERT INTO votes (id, run_id, proposal_id, agent_role, choice,
            reason) VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            vote.id,
            runId,
            vote.proposalId,
            vote.agentRole,
            vote.choice,
            vote.reason,
          )
          .run();
      }
      await publishEvent(this.env, runId, { type: "vote", vote });
    }
    await touchRun(this.env, runId, {
      tokens_used: proposalTokens + voteTokens,
    });
    await audit(this.env, runId, "workflow", "propose.done", {
      proposals: stored.length,
      votes: votes.length,
      tokens: proposalTokens + voteTokens,
      memoryChunks: memory.length,
      playbook: playbook.map((t) => t.slice(0, 120)),
    });
    return "ok";
  }

  private async recallSafe(
    runId: string,
    orgId: string,
    goal: string,
  ): Promise<string[]> {
    try {
      const hits = await recall(this.env, orgId, goal);
      const corrections = await recallFeedback(this.env, orgId).catch(() => []);
      return [
        ...hits.map((h) => h.text),
        ...corrections.map((c) => `Correction to follow: ${c}`),
      ];
    } catch (err) {
      await audit(this.env, runId, "workflow", "memory.recall_failed", {
        message: String(err),
      });
      return [];
    }
  }

  private async ruleBody(runId: string): Promise<StepOutcome> {
    const { liveness, run } = await checkLiveness(
      this.env,
      runId,
      MAX_DEBATE_ROUNDS,
    );
    if (liveness !== "alive" || !run) {
      return liveness === "halted" ? "halted" : "failed";
    }
    // Re-ruling after a rejection: the attempt derives from the rejection
    // count (deterministic across retries) and the latest note forces a
    // manager ruling with the note attached — a majority can't silently
    // re-adopt a rejected plan.
    const rejections = await this.env.DB.prepare(
      `SELECT note FROM approvals WHERE run_id = ? AND kind = 'pre'
       AND status = 'rejected' ORDER BY created_at DESC, rowid DESC`,
    )
      .bind(runId)
      .all<{ note: string }>();
    const resubmitNotes = rejections.results ?? [];
    const attempt = nextAttempt(resubmitNotes.length);
    const resubmitNote = resubmitNotes[0]?.note || null;
    const tally = await this.env.DB.prepare(
      `SELECT v.proposal_id AS proposal_id, pr.agent_role AS role,
        SUM(CASE WHEN v.choice = 'for' THEN 1 ELSE 0 END) AS fors,
        SUM(CASE WHEN v.choice = 'against' THEN 1 ELSE 0 END) AS againsts,
        COUNT(*) AS total
       FROM votes v JOIN proposals pr ON pr.id = v.proposal_id
       WHERE v.run_id = ? GROUP BY v.proposal_id, pr.agent_role`,
    )
      .bind(runId)
      .all<TallyRow & { role: string }>();
    const winner = (tally.results ?? []).find((t) => t.fors > t.total / 2);

    let decidedBy: "majority" | "manager";
    let decision: string;
    let rationale: string;
    if (winner && !resubmitNote) {
      decidedBy = "majority";
      decision = `Adopted by majority (${winner.fors}/${winner.total})`;
      rationale = "Majority of roles voted for; no manager call needed.";
    } else {
      const stored = await this.env.DB.prepare(
        "SELECT id, agent_role, title, body FROM proposals WHERE run_id = ?",
      )
        .bind(runId)
        .all<{ id: string; agent_role: string; title: string; body: string }>();
      const tallyLine = (tally.results ?? [])
        .map((t) => `${t.role}: ${t.fors} for / ${t.againsts} against`)
        .join("; ");
      const ctx: GoalContext = {
        goal: run.goal,
        metricLine: metricLineFor({
          metric_name: run.metric_name,
          metric_baseline: run.metric_baseline,
          metric_target: run.metric_target,
          timebox_days: run.timebox_days,
        }),
        round: run.rounds_used + 1,
        memory: await this.recallSafe(runId, run.org_id, run.goal),
        playbook: await approvedPlaybook(this.env, run.org_id).catch(() => []),
      };
      const { ruling, tokens } = await runManagerRuling(
        this.env,
        ctx,
        (stored.results ?? []).map((p) => ({
          id: p.id,
          role: p.agent_role,
          title: p.title,
          body: p.body,
        })),
        tallyLine,
        resubmitNote,
      );
      decidedBy = "manager";
      decision = ruling.decision;
      rationale = ruling.rationale;
      await touchRun(this.env, runId, { tokens_used: tokens });
    }
    // Idempotent by (run_id, attempt): a retried rule step reuses its
    // own row instead of stacking duplicate rulings.
    await this.env.DB.prepare(
      `INSERT INTO rulings (id, run_id, decision, rationale, decided_by,
         attempt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(crypto.randomUUID(), runId, decision, rationale, decidedBy, attempt)
      .run();
    const final = await this.env.DB.prepare(
      `SELECT id, decision, rationale FROM rulings
       WHERE run_id = ? AND attempt = ?`,
    )
      .bind(runId, attempt)
      .first<{ id: string; decision: string; rationale: string }>();
    await publishEvent(this.env, runId, {
      type: "ruling",
      ruling: {
        id: final?.id ?? crypto.randomUUID(),
        runId,
        decision: final?.decision ?? decision,
        rationale: final?.rationale ?? rationale,
        decidedBy,
      },
    });
    // Debate rounds measure propose/vote effort; re-rulings reuse the same
    // ballots, so only the first ruling consumes a round. Human patience
    // has its own counter (resubmits) — the two caps can never collide.
    await touchRun(this.env, runId, {
      status: "ruled",
      ...(attempt === 1 ? { rounds_used: run.rounds_used + 1 } : {}),
    });
    await publishEvent(this.env, runId, {
      type: "status",
      runId,
      status: "ruled",
    });
    return "ok";
  }

  private async addTokens(runId: string, n: number): Promise<void> {
    if (!n) return;
    const run = await getRun(this.env, runId);
    await touchRun(this.env, runId, {
      tokens_used: (run?.tokens_used ?? 0) + n,
    });
  }

  private async recordAction(
    runId: string,
    kind: Action["kind"],
    target: string,
    status: Action["status"],
    revertPayload?: Record<string, unknown>,
    payload: Record<string, unknown> = {},
  ): Promise<string> {
    const action: Action = {
      id: crypto.randomUUID(),
      runId,
      kind,
      target,
      payload,
      status,
      ...(revertPayload ? { revertPayload } : {}),
    };
    const proof = buildProof(kind, target, status, actionLabel(kind), revertPayload, payload);
    await this.env.DB.prepare(
      `INSERT INTO actions (id, run_id, kind, target, payload, status,
        revert_payload, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        action.id,
        runId,
        kind,
        target,
        JSON.stringify(payload),
        status,
        revertPayload ? JSON.stringify(revertPayload) : null,
        proof ? JSON.stringify(proof) : null,
      )
      .run();
    const { revertPayload: _omit, ...feedAction } = action;
    await publishEvent(this.env, runId, { type: "action", action: feedAction });
    return action.id;
  }

  /** Done action kinds for a run: the resume-not-replay guard. */
  private async doneKindSet(runId: string): Promise<Set<string>> {
    const rows = await this.env.DB.prepare(
      "SELECT kind FROM actions WHERE run_id = ? AND status = 'done'",
    )
      .bind(runId)
      .all<{ kind: string }>();
    return new Set((rows.results ?? []).map((r) => r.kind));
  }

  /** Rank repo files by ruling-word overlap; README/package first. */
  private pickContextFiles(tree: string[], decision: string): string[] {
    const words = new Set(
      decision
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
    return tree
      .filter((p) => /\.(ts|tsx|js|jsx|py|md|json)$/.test(p) && !/test|spec|lock/i.test(p))
      .map((p) => ({
        p,
        s:
          p
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => words.has(w)).length + (/(readme|package\.json)$/i.test(p) ? 2 : 0),
      }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 4)
      .map((x) => x.p);
  }

  private async githubAction(
    orgId: string,
    runId: string,
    short: string,
    decision: string,
    rationale: string,
    plan: string,
  ): Promise<void> {
    const token = await loadToken(this.env, orgId, "github");
    if (!token) {
      await this.recordAction(runId, "github.code_pr", "code-pr", "skipped", undefined, {
        reason: "not_connected",
      });
      await audit(this.env, runId, "engineer", "action.skipped", {
        system: "github",
        reason: "not_connected",
      });
      return;
    }
    const codeGuard = await checkGuard(this.env, orgId, "engineer", "github", "code");
    const prGuard = await checkGuard(this.env, orgId, "engineer", "github", "pr");
    if (!codeGuard.allowed && !prGuard.allowed) {
      await this.recordAction(runId, "github.code_pr", "code-pr", "skipped", undefined, {
        reason: codeGuard.reason,
      });
      await audit(this.env, runId, "engineer", "action.skipped", {
        system: "github",
        reason: codeGuard.reason,
      });
      return;
    }
    const repo = this.env.DEMO_GITHUB_REPO;
    const branch = `ai/${short}`;
    const title = `[ai-team] ${decision.slice(0, 80)}`;
    // Real diff first; a ruling with no technical content falls back to
    // the decision doc, so the run still ships something reviewable.
    if (codeGuard.allowed) {
      try {
        const tree = await readTree(token, repo);
        const picked = this.pickContextFiles(tree, decision);
        const contents: Array<{ path: string; content: string }> = [];
        for (const p of picked) {
          const content = await readFile(token, repo, p).catch(() => null);
          if (content) contents.push({ path: p, content });
        }
        const diff = await runEngineerDiff(this.env, decision, rationale, tree, contents);
        await this.addTokens(runId, diff.tokens);
        if (diff.files.length > 0) {
          const pr = await openCodePr(token, repo, branch, diff.files, title, `${plan}\n\n${diff.summary}`);
          await this.recordAction(runId, "github.code_pr", pr.url, "done", {
            repo,
            pr: pr.number,
            branch,
          });
          return;
        }
        await audit(this.env, runId, "engineer", "diff.empty", { summary: diff.summary });
      } catch (err) {
        await this.recordAction(runId, "github.code_pr", "code-pr", "failed");
        await audit(this.env, runId, "engineer", "action.failed", {
          system: "github",
          error: String(err).slice(0, 600),
        });
        return;
      }
    }
    if (!prGuard.allowed) {
      await this.recordAction(runId, "github.open_pr", "plan-pr", "skipped", undefined, {
        reason: prGuard.reason,
      });
      return;
    }
    try {
      const path = `docs/decisions/${short}.md`;
      const pr = await openPlanPr(token, repo, branch, path, plan, title, plan);
      await this.recordAction(runId, "github.open_pr", pr.url, "done", {
        repo,
        pr: pr.number,
        branch,
      });
    } catch (err) {
      await this.recordAction(runId, "github.open_pr", "plan-pr", "failed");
      await audit(this.env, runId, "engineer", "action.failed", {
        system: "github",
        error: String(err).slice(0, 600),
      });
    }
  }

  private async linearAction(
    orgId: string,
    runId: string,
    title: string,
    description: string,
    decision: string,
    rationale: string,
  ): Promise<void> {
    const token = await loadToken(this.env, orgId, "linear");
    if (!token) {
      await this.recordAction(runId, "linear.manage_issue", "issue", "skipped", undefined, {
        reason: "not_connected",
      });
      await audit(this.env, runId, "pm", "action.skipped", {
        system: "linear",
        reason: "not_connected",
      });
      return;
    }
    const ticketGuard = await checkGuard(this.env, orgId, "pm", "linear", "ticket");
    if (!ticketGuard.allowed) {
      await this.recordAction(runId, "linear.manage_issue", "issue", "skipped", undefined, {
        reason: ticketGuard.reason,
      });
      await audit(this.env, runId, "pm", "action.skipped", {
        system: "linear",
        reason: ticketGuard.reason,
      });
      return;
    }
    try {
      const teamId = await findTeamId(token, this.env.DEMO_LINEAR_TEAM);
      if (!teamId) {
        await this.recordAction(runId, "linear.manage_issue", "issue", "skipped", undefined, {
          reason: `team not found: ${this.env.DEMO_LINEAR_TEAM}`,
        });
        await audit(this.env, runId, "pm", "action.skipped", {
          system: "linear",
          reason: `team not found: ${this.env.DEMO_LINEAR_TEAM}`,
        });
        return;
      }
      const issue = await createIssue(token, teamId, title, description);
      const subIds: string[] = [];
      const subtaskGuard = await checkGuard(this.env, orgId, "pm", "linear", "subtask");
      if (subtaskGuard.allowed) {
        const split = await runPmSplit(this.env, decision, rationale);
        await this.addTokens(runId, split.tokens);
        for (const sub of split.subtasks) {
          try {
            const created = await createSubIssue(token, teamId, issue.id, sub);
            subIds.push(created.id);
          } catch (err) {
            await audit(this.env, runId, "pm", "subtask.failed", {
              title: sub,
              error: String(err).slice(0, 200),
            });
          }
        }
      }
      const transitionGuard = await checkGuard(this.env, orgId, "pm", "linear", "transition");
      if (transitionGuard.allowed) {
        try {
          await transitionIssue(token, teamId, issue.id, "started");
        } catch (err) {
          await audit(this.env, runId, "pm", "transition.failed", {
            error: String(err).slice(0, 200),
          });
        }
      }
      const commentGuard = await checkGuard(this.env, orgId, "pm", "linear", "comment");
      if (commentGuard.allowed) {
        try {
          await commentOnIssue(
            token,
            issue.id,
            `AI team run ${runId.slice(0, 8)} started: ${subIds.length} sub-tasks tracked here. This issue closes when the run ships.`,
          );
        } catch (err) {
          await audit(this.env, runId, "pm", "comment.failed", {
            error: String(err).slice(0, 200),
          });
        }
      }
      await this.recordAction(runId, "linear.manage_issue", issue.url, "done", {
        issueId: issue.id,
        teamId,
        subIds,
      });
    } catch (err) {
      await this.recordAction(runId, "linear.manage_issue", "issue", "failed");
      await audit(this.env, runId, "pm", "action.failed", {
        system: "linear",
        error: String(err).slice(0, 600),
      });
    }
  }

  /** End-of-act fan-out: the Linear issue and Slack thread get results. */
  private async runCloseouts(
    runId: string,
    orgId: string,
    decision: string,
  ): Promise<void> {
    const rows = await this.env.DB.prepare(
      "SELECT kind, status, target FROM actions WHERE run_id = ? ORDER BY rowid",
    )
      .bind(runId)
      .all<{ kind: string; status: string; target: string }>();
    const lines = (rows.results ?? []).map(
      (a) => `- ${a.kind}: ${a.status} (${a.target.slice(0, 80)})`,
    );
    const head = `Run ${runId.slice(0, 8)} shipped "${decision.slice(0, 120)}"`;
    await this.linearCloseout(orgId, runId, `${head}:\n${lines.join("\n")}`);
    await this.slackCloseout(orgId, runId, `${head} — results:\n${lines.join("\n")}`);
  }

  /** Close-out marker: a retried act step never double-closes. */
  private async closeoutDone(runId: string, marker: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT 1 AS x FROM actions WHERE run_id = ? AND target = ? AND status = 'done' LIMIT 1",
    )
      .bind(runId, marker)
      .first<{ x: number }>();
    return !!row;
  }

  /** End-of-act close-out: results comment + Done transition. */
  private async linearCloseout(
    orgId: string,
    runId: string,
    summary: string,
  ): Promise<void> {
    if (await this.closeoutDone(runId, "closeout:linear")) return;
    const row = await this.env.DB.prepare(
      `SELECT revert_payload FROM actions
       WHERE run_id = ? AND kind = 'linear.manage_issue' AND status = 'done'`,
    )
      .bind(runId)
      .first<{ revert_payload: string | null }>();
    if (!row?.revert_payload) return;
    let payload: { issueId?: string; teamId?: string };
    try {
      payload = JSON.parse(row.revert_payload) as { issueId?: string; teamId?: string };
    } catch {
      return;
    }
    if (!payload.issueId || !payload.teamId) return;
    const token = await loadToken(this.env, orgId, "linear");
    if (!token) return;
    try {
      if ((await checkGuard(this.env, orgId, "pm", "linear", "comment")).allowed) {
        await commentOnIssue(token, payload.issueId, summary);
      }
      if ((await checkGuard(this.env, orgId, "pm", "linear", "transition")).allowed) {
        await transitionIssue(token, payload.teamId, payload.issueId, "completed");
      }
      await this.recordAction(runId, "linear.manage_issue", "closeout:linear", "done");
    } catch (err) {
      await this.recordAction(runId, "linear.manage_issue", "closeout", "failed", undefined, {
        reason: String(err).slice(0, 200),
      });
      await audit(this.env, runId, "pm", "closeout.failed", {
        error: String(err).slice(0, 600),
      });
    }
  }

  private async slackAction(
    orgId: string,
    runId: string,
    text: string,
  ): Promise<void> {
    const token = await loadToken(this.env, orgId, "slack");
    if (!token) {
      await this.recordAction(runId, "slack.post_message", "message", "skipped", undefined, {
        reason: "not_connected",
      });
      await audit(this.env, runId, "marketer", "action.skipped", {
        system: "slack",
        reason: "not_connected",
      });
      return;
    }
    const guard = await checkGuard(this.env, orgId, "marketer", "slack", "message");
    if (!guard.allowed) {
      await this.recordAction(runId, "slack.post_message", "message", "skipped", undefined, {
        reason: guard.reason,
      });
      await audit(this.env, runId, "marketer", "action.skipped", {
        system: "slack",
        reason: guard.reason,
      });
      return;
    }
    try {
      const channelId = await findChannelId(token, this.env.DEMO_SLACK_CHANNEL);
      if (!channelId) {
        await this.recordAction(runId, "slack.post_message", "message", "skipped", undefined, {
          reason: `channel not found: ${this.env.DEMO_SLACK_CHANNEL}`,
        });
        await audit(this.env, runId, "marketer", "action.skipped", {
          system: "slack",
          reason: `channel not found: ${this.env.DEMO_SLACK_CHANNEL}`,
        });
        return;
      }
      const posted = await postMessage(token, channelId, text);
      const replies: string[] = [];
      const threadGuard = await checkGuard(this.env, orgId, "marketer", "slack", "thread");
      if (threadGuard.allowed) {
        try {
          replies.push(
            await replyToThread(
              token,
              posted.channel,
              posted.ts,
              `Run ${runId.slice(0, 8)} executing: shop, tickets, and docs update below as each system ships.`,
            ),
          );
        } catch (err) {
          await audit(this.env, runId, "marketer", "thread.failed", {
            error: String(err).slice(0, 200),
          });
        }
      }
      await this.recordAction(
        runId,
        replies.length > 0 ? "slack.thread_update" : "slack.post_message",
        `#${this.env.DEMO_SLACK_CHANNEL}`,
        "done",
        { channel: posted.channel, ts: posted.ts, replies },
      );
    } catch (err) {
      await this.recordAction(runId, "slack.post_message", "message", "failed");
      await audit(this.env, runId, "marketer", "action.failed", {
        system: "slack",
        error: String(err).slice(0, 600),
      });
    }
  }

  /** End-of-act close-out: results land in the decision thread. */
  private async slackCloseout(
    orgId: string,
    runId: string,
    summary: string,
  ): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT id, revert_payload FROM actions
       WHERE run_id = ? AND kind IN ('slack.thread_update', 'slack.post_message')
       AND status = 'done'`,
    )
      .bind(runId)
      .first<{ id: string; revert_payload: string | null }>();
    if (!row?.revert_payload) return;
    let payload: { channel?: string; ts?: string; replies?: string[] };
    try {
      payload = JSON.parse(row.revert_payload) as {
        channel?: string;
        ts?: string;
        replies?: string[];
      };
    } catch {
      return;
    }
    if (!payload.channel || !payload.ts) return;
    if (!(await checkGuard(this.env, orgId, "marketer", "slack", "thread")).allowed) return;
    if (await this.closeoutDone(runId, "closeout:slack")) return;
    const token = await loadToken(this.env, orgId, "slack");
    if (!token) return;
    try {
      const ts = await replyToThread(token, payload.channel, payload.ts, summary);
      const replies = [...(payload.replies ?? []), ts];
      await this.env.DB.prepare("UPDATE actions SET revert_payload = ? WHERE id = ?")
        .bind(JSON.stringify({ ...payload, replies }), row.id)
        .run();
      await this.env.DB.prepare(
        "UPDATE actions SET kind = 'slack.thread_update' WHERE id = ? AND kind = 'slack.post_message'",
      )
        .bind(row.id)
        .run();
      await this.recordAction(runId, "slack.thread_update", "closeout:slack", "done");
    } catch (err) {
      await this.recordAction(runId, "slack.thread_update", "closeout", "failed", undefined, {
        reason: String(err).slice(0, 200),
      });
      await audit(this.env, runId, "marketer", "closeout.failed", {
        error: String(err).slice(0, 600),
      });
    }
  }

  private async shopifyAction(
    orgId: string,
    runId: string,
    goal: string,
    decision: string,
    short: string,
  ): Promise<void> {
    const token = await loadToken(this.env, orgId, "shopify");
    if (!token) {
      await this.recordAction(runId, "shopify.targeted_discount", "discount", "skipped", undefined, {
        reason: "not_connected",
      });
      await audit(this.env, runId, "marketer", "action.skipped", {
        system: "shopify",
        reason: "not_connected",
      });
      return;
    }
    const { shop, product_id: productId } = await getProviderConfig(this.env, orgId, "shopify");
    if (typeof shop !== "string" || !shop) {
      await this.recordAction(runId, "shopify.targeted_discount", "discount", "skipped", undefined, {
        reason: "shop not configured",
      });
      await audit(this.env, runId, "marketer", "action.skipped", {
        system: "shopify",
        reason: "shop not configured",
      });
      return;
    }
    const done = await this.doneKindSet(runId);
    if (!done.has("shopify.targeted_discount") && !done.has("shopify.create_discount")) {
      const discountGuard = await checkGuard(this.env, orgId, "marketer", "shopify", "discount");
      if (!discountGuard.allowed) {
        await this.recordAction(runId, "shopify.targeted_discount", "discount", "skipped", undefined, {
          reason: discountGuard.reason,
        });
        await audit(this.env, runId, "marketer", "action.skipped", {
          system: "shopify",
          reason: discountGuard.reason,
        });
      } else {
        try {
          const { plan, tokens } = await runDiscountPlan(this.env, goal, decision);
          await this.addTokens(runId, tokens);
          const discount = await createTargetedDiscount(
            shop,
            token,
            plan.title,
            `AITEAM-${short.toUpperCase()}`,
            plan.percent,
            plan.startInDays,
          );
          await this.recordAction(runId, "shopify.targeted_discount", discount.code, "done", {
            shop,
            id: discount.id,
          });
        } catch (err) {
          await this.recordAction(runId, "shopify.targeted_discount", "discount", "failed");
          await audit(this.env, runId, "marketer", "action.failed", {
            system: "shopify",
            error: String(err).slice(0, 600),
          });
        }
      }
    }
    if (done.has("shopify.product_copy")) return;
    const productGuard = await checkGuard(this.env, orgId, "marketer", "shopify", "product");
    if (!productGuard.allowed) {
      await this.recordAction(runId, "shopify.product_copy", "product", "skipped", undefined, {
        reason: productGuard.reason,
      });
      return;
    }
    if (typeof productId !== "string" || !productId) {
      await this.recordAction(runId, "shopify.product_copy", "product", "skipped", undefined, {
        reason: "no showcase product picked (save one in Setup)",
      });
      await audit(this.env, runId, "marketer", "action.skipped", {
        system: "shopify",
        reason: "showcase product not configured",
      });
      return;
    }
    try {
      const product = await getProduct(shop, token, productId);
      if (!product) {
        await this.recordAction(runId, "shopify.product_copy", "product", "skipped", undefined, {
          reason: "showcase product not found",
        });
        return;
      }
      const copy = await runProductCopy(this.env, decision, product.title, product.description);
      await this.addTokens(runId, copy.tokens);
      await updateProductDescription(shop, token, product.id, copy.description);
      await this.recordAction(runId, "shopify.product_copy", product.title, "done", {
        shop,
        productId: product.id,
        priorDescription: product.description,
      });
    } catch (err) {
      await this.recordAction(runId, "shopify.product_copy", "product", "failed");
      await audit(this.env, runId, "marketer", "action.failed", {
        system: "shopify",
        error: String(err).slice(0, 600),
      });
    }
  }

  private async hubspotAction(
    orgId: string,
    runId: string,
    body: string,
    decision: string,
  ): Promise<void> {
    const token = await loadToken(this.env, orgId, "hubspot");
    if (!token) {
      await this.recordAction(runId, "hubspot.update_ticket", "ticket", "skipped", undefined, {
        reason: "not_connected",
      });
      await audit(this.env, runId, "analyst", "action.skipped", {
        system: "hubspot",
        reason: "not_connected",
      });
      return;
    }
    const done = await this.doneKindSet(runId);
    const updateDone = done.has("hubspot.update_ticket");
    const followupDone =
      done.has("hubspot.followup_note") ||
      done.has("hubspot.create_note") ||
      done.has("hubspot.triage_ticket");
    if (updateDone && followupDone) return;
    const ticket = await this.hubspotTicket(runId, orgId, token);
    if (!ticket) return;
    const triage = await runSupportTriage(this.env, decision, ticket.subject);
    await this.addTokens(runId, triage.tokens);
    if (!updateDone) {
      const followupGuard = await checkGuard(this.env, orgId, "analyst", "hubspot", "followup");
      if (!followupGuard.allowed) {
        await this.recordAction(runId, "hubspot.update_ticket", "ticket", "skipped", undefined, {
          reason: followupGuard.reason,
        });
        await audit(this.env, runId, "analyst", "action.skipped", {
          system: "hubspot",
          reason: followupGuard.reason,
        });
      } else {
        try {
          const prior = await getTicketFields(token, ticket.id);
          let stage: string | undefined;
          if (triage.resolve) {
            const stages = await ticketStages(token);
            stage = stages.find((s) => s.closed)?.id;
            if (!stage) {
              await audit(this.env, runId, "analyst", "resolve.skipped", {
                reason: "no closed stage in pipeline",
              });
            }
          }
          await updateTicketFields(token, ticket.id, {
            priority: triage.priority,
            ...(stage ? { stage } : {}),
          });
          await this.recordAction(runId, "hubspot.update_ticket", `ticket ${ticket.id}`, "done", {
            ticketId: ticket.id,
            priorPriority: prior.priority ?? "",
            priorStage: prior.stage ?? "",
          });
        } catch (err) {
          await this.recordAction(runId, "hubspot.update_ticket", "ticket", "failed");
          await audit(this.env, runId, "analyst", "action.failed", {
            system: "hubspot",
            error: String(err).slice(0, 600),
          });
        }
      }
    }
    if (followupDone) return;
    const noteGuard = await checkGuard(this.env, orgId, "analyst", "hubspot", "note");
    const triageGuard = await checkGuard(this.env, orgId, "analyst", "hubspot", "triage");
    if (!noteGuard.allowed && !triageGuard.allowed) {
      await this.recordAction(runId, "hubspot.followup_note", "note", "skipped", undefined, {
        reason: noteGuard.reason,
      });
      await audit(this.env, runId, "analyst", "action.skipped", {
        system: "hubspot",
        reason: noteGuard.reason,
      });
      return;
    }
    const followupBody = `Ticket: ${ticket.subject}\n\n${triage.followup}\n\n---\n${body}`;
    // Preferred path: a pinned note. Some portals can't grant the notes
    // scope at all — those fall through to content triage below.
    if (noteGuard.allowed) {
      try {
        const noteId = await createNote(token, followupBody);
        await associateNoteToTicket(token, noteId, ticket.id);
        await this.recordAction(runId, "hubspot.followup_note", `ticket ${ticket.id}`, "done", {
          noteId,
        });
        return;
      } catch (err) {
        if (!isScopeError(err)) {
          await this.recordAction(runId, "hubspot.followup_note", "note", "failed");
          await audit(this.env, runId, "analyst", "action.failed", {
            system: "hubspot",
            error: String(err).slice(0, 600),
          });
          return;
        }
      }
    }
    if (!triageGuard.allowed) {
      await this.recordAction(runId, "hubspot.followup_note", "note", "skipped", undefined, {
        reason: "notes scope not granted on this portal",
      });
      await audit(this.env, runId, "analyst", "action.skipped", {
        system: "hubspot",
        reason: "notes scope not granted on this portal",
      });
      return;
    }
    try {
      const prior = await getTicketContent(token, ticket.id);
      const stamp = `--- AI triage (${runId.slice(0, 8)}) ---\n${followupBody}`;
      await updateTicketContent(
        token,
        ticket.id,
        prior ? `${prior}\n\n${stamp}` : stamp,
      );
      await this.recordAction(runId, "hubspot.triage_ticket", `ticket ${ticket.id}`, "done", {
        ticketId: ticket.id,
        priorContent: prior,
      });
    } catch (err) {
      await this.recordAction(runId, "hubspot.triage_ticket", "ticket", "failed");
      await audit(this.env, runId, "analyst", "action.failed", {
        system: "hubspot",
        error: String(err).slice(0, 600),
      });
    }
  }

  /** Newest open ticket or a recorded skip; null means the caller is done. */
  private async hubspotTicket(
    runId: string,
    orgId: string,
    token: string,
  ): Promise<{ id: string; subject: string } | null> {
    try {
      const ticket = await findNewestOpenTicket(token);
      if (!ticket) {
        await this.recordAction(runId, "hubspot.update_ticket", "ticket", "skipped", undefined, {
          reason: "no open tickets in portal",
        });
        await audit(this.env, runId, "analyst", "action.skipped", {
          system: "hubspot",
          reason: "no open tickets in portal",
        });
        return null;
      }
      return ticket;
    } catch (err) {
      if (isScopeError(err)) {
        await this.recordAction(runId, "hubspot.update_ticket", "ticket", "skipped", undefined, {
          reason: "ticket scopes not granted — reconnect HubSpot",
        });
        await audit(this.env, runId, "analyst", "action.skipped", {
          system: "hubspot",
          reason: "ticket scopes not granted — reconnect HubSpot",
        });
      } else {
        await this.recordAction(runId, "hubspot.update_ticket", "ticket", "failed");
        await audit(this.env, runId, "analyst", "action.failed", {
          system: "hubspot",
          error: String(err).slice(0, 600),
        });
      }
      return null;
    }
  }

  private async notionAction(
    orgId: string,
    runId: string,
    short: string,
    title: string,
    paragraphs: string[],
    followups: string[],
  ): Promise<void> {
    const token = await loadToken(this.env, orgId, "notion");
    if (!token) {
      await this.recordAction(runId, "notion.run_page", "page", "skipped", undefined, {
        reason: "not_connected",
      });
      await audit(this.env, runId, "pm", "action.skipped", {
        system: "notion",
        reason: "not_connected",
      });
      return;
    }
    const guard = await checkGuard(this.env, orgId, "pm", "notion", "db");
    if (!guard.allowed) {
      await this.recordAction(runId, "notion.run_page", "page", "skipped", undefined, {
        reason: guard.reason,
      });
      await audit(this.env, runId, "pm", "action.skipped", {
        system: "notion",
        reason: guard.reason,
      });
      return;
    }
    try {
      const { parentPageId } = await getProviderConfig(this.env, orgId, "notion");
      if (typeof parentPageId !== "string" || !parentPageId) {
        await this.recordAction(runId, "notion.run_page", "page", "skipped", undefined, {
          reason: "notion parent page not set (save one in Setup)",
        });
        await audit(this.env, runId, "pm", "action.skipped", {
          system: "notion",
          reason: "notion parent page not set",
        });
        return;
      }
      const dbId = await ensureDecisionDb(token, parentPageId);
      const record = await createRunRecord(token, dbId, title, short, paragraphs, followups);
      await this.recordAction(runId, "notion.run_page", record.url, "done", {
        dbId,
        pageId: record.pageId,
        followupId: record.followupId,
      });
    } catch (err) {
      await this.recordAction(runId, "notion.run_page", "page", "failed");
      await audit(this.env, runId, "pm", "action.failed", {
        system: "notion",
        error: String(err).slice(0, 600),
      });
    }
  }

  private async actBody(runId: string): Promise<StepOutcome> {
    const { liveness, run } = await checkLiveness(
      this.env,
      runId,
      MAX_DEBATE_ROUNDS,
    );
    if (liveness !== "alive" || !run) {
      return liveness === "halted" ? "halted" : "failed";
    }
    await touchRun(this.env, runId, { status: "acting" });
    await publishEvent(this.env, runId, {
      type: "status",
      runId,
      status: "acting",
    });
    const ruling = await this.env.DB.prepare(
      `SELECT decision, rationale, decided_by FROM rulings WHERE run_id = ?
       ORDER BY attempt DESC LIMIT 1`,
    )
      .bind(runId)
      .first<{ decision: string; rationale: string; decided_by: string }>();
    if (ruling && run.kind === "sandbox") {
      await this.sandboxAct(
        runId,
        run.goal,
        ruling.decision,
        ruling.rationale,
        ruling.decided_by,
      );
    } else if (ruling) {
      // A retried act step resumes, not replays: kinds already done are
      // never posted twice.
      const doneKinds = await this.doneKindSet(runId);
      const short = runId.slice(0, 8);
      const plan = [
        `# ${ruling.decision}`,
        "",
        `Goal: ${run.goal}`,
        `Decided by: ${ruling.decided_by}`,
        "",
        ruling.rationale,
        "",
        `_Adopted by the AI team, run ${short}. Revert from the dashboard._`,
      ].join("\n");
      if (!doneKinds.has("github.code_pr") && !doneKinds.has("github.open_pr")) {
        await this.githubAction(
          run.org_id,
          runId,
          short,
          ruling.decision,
          ruling.rationale,
          plan,
        );
      }
      if (!doneKinds.has("linear.manage_issue") && !doneKinds.has("linear.create_issue")) {
        await this.linearAction(
          run.org_id,
          runId,
          ruling.decision.slice(0, 120),
          plan,
          ruling.decision,
          ruling.rationale,
        );
      }
      if (!doneKinds.has("slack.thread_update") && !doneKinds.has("slack.post_message")) {
        await this.slackAction(
          run.org_id,
          runId,
          `Team decision (${ruling.decided_by}): ${ruling.decision}\nGoal: ${run.goal}`,
        );
      }
      // Shopify and HubSpot ship two writes each; per-write guards live
      // inside the methods so a partial retry resumes instead of duping.
      await this.shopifyAction(run.org_id, runId, run.goal, ruling.decision, short);
      await this.hubspotAction(
        run.org_id,
        runId,
        `Team decision (${ruling.decided_by}): ${ruling.decision}\nGoal: ${run.goal}\n\n${ruling.rationale}`,
        ruling.decision,
      );
      if (!doneKinds.has("notion.run_page") && !doneKinds.has("notion.create_page")) {
        await this.notionAction(
          run.org_id,
          runId,
          short,
          ruling.decision.slice(0, 80),
          [
            `Goal: ${run.goal} (decided by ${ruling.decided_by})`,
            ruling.rationale,
          ],
          [
            `Verify the shipped artifacts for run ${short}.`,
            `Record the metric movement toward: ${run.goal.slice(0, 120)}.`,
          ],
        );
      }
      await this.runCloseouts(runId, run.org_id, ruling.decision);
    } else {
      await audit(this.env, runId, "workflow", "action.skipped", {
        reason: "no ruling recorded",
      });
    }
    await touchRun(this.env, runId, { status: "done" });
    await publishEvent(this.env, runId, {
      type: "status",
      runId,
      status: "done",
    });
    await audit(this.env, runId, "workflow", "run.done");
    return "ok";
  }

  /**
   * Sandbox act: no provider calls, no closeouts — the six intents a
   * connected run would have shipped, recorded as would-do.
   */
  private async sandboxAct(
    runId: string,
    goal: string,
    decision: string,
    rationale: string,
    decidedBy: string,
  ): Promise<void> {
    // would-do rows are never "done", so the resume guard is presence:
    // any recorded intent means a retry, not a replay.
    const existing = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM actions WHERE run_id = ?",
    )
      .bind(runId)
      .first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) return;
    const intents: Array<{ kind: Action["kind"]; target: string }> = [
      { kind: "github.open_pr", target: "sample repo: PR with the plan" },
      { kind: "linear.create_issue", target: "sample project: tracking issue" },
      { kind: "slack.post_message", target: "sample channel: team update" },
      { kind: "shopify.targeted_discount", target: "sample store: targeted discount" },
      { kind: "hubspot.triage_ticket", target: "sample pipeline: triaged ticket" },
      { kind: "notion.create_page", target: "sample workspace: decision page" },
    ];
    for (const intent of intents) {
      await this.recordAction(runId, intent.kind, intent.target, "would_do", undefined, {
        goal: goal.slice(0, 200),
        decision: decision.slice(0, 200),
        rationale: rationale.slice(0, 500),
        decidedBy,
        sample: true,
      });
    }
    await audit(this.env, runId, "workflow", "sandbox.intents_recorded", {
      count: intents.length,
    });
  }

  /** Write-back never fails a run: memory loss is audited, not thrown. */
  private async memorizeBody(runId: string): Promise<void> {
    try {
      const run = await getRun(this.env, runId);
      if (!run || run.kind === "sandbox") return;
      const ruling = await this.env.DB.prepare(
        `SELECT decision, rationale, decided_by FROM rulings WHERE run_id = ?
         ORDER BY attempt DESC LIMIT 1`,
      )
        .bind(runId)
        .first<{ decision: string; rationale: string; decided_by: string }>();
      const summary = [
        `Goal: ${run.goal}`,
        `Outcome: ${run.status} after ${run.rounds_used} rounds, ${run.tokens_used} tokens.`,
        ruling
          ? `Decision (${ruling.decided_by}): ${ruling.decision} — ${ruling.rationale}`
          : "No ruling recorded.",
      ].join("\n");
      try {
        const acts = await this.env.DB.prepare(
          "SELECT kind, target, status FROM actions WHERE run_id = ? AND status = 'done' ORDER BY rowid",
        )
          .bind(runId)
          .all<{ kind: string; target: string; status: string }>();
        const lines = (acts.results ?? [])
          .map((a) => `- ${a.kind}: ${a.target}`.slice(0, 160))
          .join("\n");
        const { critique, tokens } = await runCritique(this.env, {
          goal: run.goal,
          metricLine: metricLineFor(run),
          decision: ruling?.decision ?? "(none)",
          rationale: ruling?.rationale ?? "",
          actions: lines || "(no finished results)",
        });
        await this.env.DB.prepare("UPDATE runs SET self_critique = ? WHERE id = ?")
          .bind(critique, runId)
          .run();
        await touchRun(this.env, runId, { tokens_used: tokens });
        await commitRunMemory(this.env, run.org_id, runId, `${summary}\nSelf-critique: ${critique}`);
      } catch {
        await commitRunMemory(this.env, run.org_id, runId, summary);
      }
    } catch (err) {
      await audit(this.env, runId, "workflow", "memory.commit_failed", {
        message: String(err),
      });
    }
  }

  /** The email half of a run: never fails it, never double-sends. */
  private async digestBody(runId: string): Promise<void> {
    const run = await getRun(this.env, runId);
    // Sandbox samples are silent: no email, no notifications, no alerts.
    if (run && run.kind !== "sandbox") {
      try {
        await sendRunDigest(this.env, runId);
      } catch (err) {
        await audit(this.env, runId, "workflow", "digest.failed", {
          message: String(err),
        });
      }
      await autoReviewRun(this.env, runId).catch(() => {});
      await notify(this.env, run.org_id, {
        kind: "run.completed",
        title: `Done: ${run.goal.slice(0, 80)}`,
        body: `The team finished. Review what's done in Progress.`,
      }).catch(() => {});
      await maybeSendFairUseAlert(this.env, run.org_id).catch(() => {});
    }
    await this.recordRunSummary(runId, "done");
    await promoteQueued(this.env);
  }

  /**
   * The pre-approve gate: post-hoc runs pass through; pre-approve runs
   * pause here with no instance held — the approve endpoint resumes via
   * a fresh instance, so a wait of days costs nothing. A kill landing
   * mid-gate settles as halted instead of stranding awaiting.
   */
  private async gateBody(runId: string): Promise<"proceed" | "paused"> {
    const run = await getRun(this.env, runId);
    if (!run || run.kill_flag === 1 || run.status === "halted") {
      await this.finishHalted(runId);
      return "paused";
    }
    const verdict = await runGate(this.env, runId);
    if (verdict === "paused") {
      await publishEvent(this.env, runId, {
        type: "status",
        runId,
        status: "awaiting_approval",
      });
    }
    return verdict;
  }

  private async settle(
    step: WorkflowStep,
    name: string,
    outcome: StepOutcome,
    runId: string,
  ): Promise<boolean> {
    if (outcome === "ok") return true;
    await step.do(name, async () => {
      if (outcome === "halted") await this.finishHalted(runId);
      else await this.finishFailed(runId, "liveness verdict: capped/missing");
    });
    return false;
  }

  async run(event: WorkflowEvent<GoalRunParams>, step: WorkflowStep) {
    const { runId, resume } = event.payload;
    try {
      if (!resume) {
        const proposed = await step.do("propose", () => this.proposeBody(runId));
        if (!(await this.settle(step, "settle-propose", proposed, runId))) return;

        const windowMs = await step.do("window", async () => {
          const run = await getRun(this.env, runId);
          return run?.vote_window_ms ?? VOTE_TIMEOUT_MS;
        });
        await step.sleep("vote-window", windowMs);
      }

      if (!resume || resume === "rerule") {
        const ruled = await step.do("rule", () => this.ruleBody(runId));
        if (!(await this.settle(step, "settle-rule", ruled, runId))) return;

        const gate = await step.do("gate", () => this.gateBody(runId));
        if (gate === "paused") return;
      }

      const acted = await step.do("act", () => this.actBody(runId));
      if (!(await this.settle(step, "settle-act", acted, runId))) return;

      await step.do("memorize", () => this.memorizeBody(runId));
      await step.do("digest", () => this.digestBody(runId));
    } catch (err) {
      // Only genuinely unexpected failures reach here (exhausted retries).
      await this.finishFailed(runId, String(err));
      throw err;
    }
  }
}

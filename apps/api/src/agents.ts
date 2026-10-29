import { z } from "zod";
import {
  SEAT_ROLES,
  normalizeVoteMatrix,
  playbookBlock,
  saneDiscount,
  saneFiles,
  saneSubtasks,
  saneTactics,
  sanitizeSquad,
  triagePriority,
  type AgentRole,
  type CastVote as SharedVote,
  type SaneTactic,
  type SeatRole,
  type SaneDiscount,
  type TicketPriority,
} from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { SparkClient } from "./spark.js";

// Vote and ruling calls carry every proposal and must emit long reasoned
// replies, so they get double the default reasoning budget.
const VOTE_MAX_TOKENS = 4000;
const RULING_MAX_TOKENS = 4000;

export const ProposalDraft = z.object({
  title: z.string().min(8).max(140),
  body: z.string().min(40),
});
export type ProposalDraft = z.infer<typeof ProposalDraft>;

export const ProposalRef = z.enum(SEAT_ROLES);
export type ProposalRef = z.infer<typeof ProposalRef>;

export const SquadPick = z.object({
  roles: z.array(ProposalRef).min(1).max(7),
});
export type SquadPick = z.infer<typeof SquadPick>;

// Voters reference proposals by stable role ref, not by random row id, so
// identical goals produce identical vote prompts — and replay fixtures hit.
export const VoteBatch = z.object({
  votes: z
    .array(
      z.object({
        proposalRef: ProposalRef,
        choice: z.enum(["for", "against", "abstain"]),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});
export type VoteBatch = z.infer<typeof VoteBatch>;

export const RulingDraft = z.object({
  decision: z.string().min(8),
  rationale: z.string().min(20),
});
export type RulingDraft = z.infer<typeof RulingDraft>;

interface RoleConfig {
  role: AgentRole;
  temperature: number;
  lens: string;
}

const ROLES: RoleConfig[] = [
  {
    role: "pm",
    temperature: 0.5,
    lens: "You are the product manager. You scope ruthlessly, sequence for learning speed, and kill scope that doesn't move the metric.",
  },
  {
    role: "marketer",
    temperature: 0.8,
    lens: "You are the growth marketer. You think in messaging, positioning, and experiments that change user behavior fast.",
  },
  {
    role: "engineer",
    temperature: 0.4,
    lens: "You are the product engineer. You bias to small shippable diffs, flag technical risk honestly, and distrust plans with no code path.",
  },
  {
    role: "analyst",
    temperature: 0.2,
    lens: "You are the data analyst. You ground everything in the metric, distrust gut feel, and ask what evidence would change your mind.",
  },
  {
    role: "designer",
    temperature: 0.7,
    lens: "You are the product designer. You think in user flows and friction, prototype in words, and kill confusing journeys.",
  },
  {
    role: "qa",
    temperature: 0.3,
    lens: "You are the QA engineer. You hunt edge cases, demand reproducibility, and never trust a plan with no rollback.",
  },
  {
    role: "researcher",
    temperature: 0.5,
    lens: "You are the user researcher. You bring the customer's voice, challenge internal assumptions, and ask what users actually do.",
  },
  {
    role: "writer",
    temperature: 0.7,
    lens: "You are the content writer. You think in clarity and persuasion, cut jargon, and make every message earn attention.",
  },
  {
    role: "support",
    temperature: 0.5,
    lens: "You are the support lead. You know every ticket by heart, spot the patterns behind complaints, and push fixes that silence queues.",
  },
  {
    role: "ops",
    temperature: 0.4,
    lens: "You are the operations lead. You think in checklists and capacity, spot the bottleneck, and keep the machine running.",
  },
];

const CONFIG_BY_ROLE = new Map<SeatRole, RoleConfig>(
  ROLES.map((c) => [c.role as SeatRole, c]),
);

export function configsFor(squad: SeatRole[]): RoleConfig[] {
  return squad.map((role) => {
    const config = CONFIG_BY_ROLE.get(role);
    if (!config) throw new Error(`no lens for role ${role}`);
    return config;
  });
}

const MANAGER_TEMPERATURE = 0.2;

export interface GoalContext {
  goal: string;
  metricLine: string;
  round: number;
  memory: string[];
  playbook: string[];
}

function memoryBlock(memory: string[]): string {
  if (!memory.length) return "Org memory: (none yet)";
  return `Org memory:\n${memory.map((m, i) => `[${i + 1}] ${m}`).join("\n")}`;
}

export function metricLineFor(run: {
  metric_name: string | null;
  metric_baseline: number | null;
  metric_target: number | null;
  timebox_days: number | null;
}): string {
  const parts = [
    run.metric_name ? `metric: ${run.metric_name}` : "metric: (none set)",
    run.metric_baseline != null ? `baseline: ${run.metric_baseline}` : null,
    run.metric_target != null ? `target: ${run.metric_target}` : null,
    run.timebox_days != null ? `timebox: ${run.timebox_days} days` : null,
  ].filter(Boolean);
  return parts.join("; ");
}

function proposalUser(ctx: GoalContext): string {
  return [
    `Goal: ${ctx.goal}`,
    ctx.metricLine,
    `Round: ${ctx.round}`,
    memoryBlock(ctx.memory),
    playbookBlock(ctx.playbook),
    "",
    "Propose the highest-leverage initiative from your lens.",
    'Reply JSON: {"title": "...", "body": "..."}. Body is a short Markdown plan: steps, owner roles, expected metric impact.',
  ].join("\n");
}

export interface ProposalResult {
  role: AgentRole;
  draft: ProposalDraft;
}

export async function runProposals(
  env: Env,
  ctx: GoalContext,
  squad: SeatRole[],
): Promise<{ proposals: ProposalResult[]; tokens: number }> {
  const client = new SparkClient(env);
  const user = proposalUser(ctx);
  const calls = configsFor(squad).map(async ({ role, temperature, lens }) => {
    const res = await client.chat(ProposalDraft, { system: lens, user, temperature });
    return { role, draft: res.data, tokens: res.tokensUsed };
  });
  const done = await Promise.all(calls);
  return {
    proposals: done.map(({ role, draft }) => ({ role, draft })),
    tokens: done.reduce((n, r) => n + r.tokens, 0),
  };
}

function voteUser(
  ctx: GoalContext,
  proposals: Array<{ id: string; role: string; title: string; body: string }>,
  squad: SeatRole[],
): string {
  const list = proposals
    .map((p) => `---\nproposalRef: ${p.role}\ntitle: ${p.title}\n${p.body}`)
    .join("\n");
  return [
    `Goal: ${ctx.goal}`,
    ctx.metricLine,
    memoryBlock(ctx.memory),
    playbookBlock(ctx.playbook),
    "",
    list,
    "",
    "Vote on EVERY proposal from your lens. Be honest: vote against weak plans, splits are fine, the manager breaks ties. Keep each reason to one sentence.",
    `Reply JSON: {"votes": [{"proposalRef": "${squad.join("|")}", "choice": "for|against|abstain", "reason": "..."}]}.`,
  ].join("\n");
}

export type CastVote = SharedVote<AgentRole>;

export async function runVotes(
  env: Env,
  ctx: GoalContext,
  proposals: Array<{ id: string; role: string; title: string; body: string }>,
  squad: SeatRole[],
): Promise<{ votes: CastVote[]; tokens: number }> {
  const client = new SparkClient(env);
  const user = voteUser(ctx, proposals, squad);
  const calls = configsFor(squad).map(async ({ role, temperature, lens }) => {
    const res = await client.chat(VoteBatch, {
      system: `${lens} You vote; you do not re-propose.`,
      user,
      temperature,
      maxTokens: VOTE_MAX_TOKENS,
    });
    return { role, batch: res.data, tokens: res.tokensUsed };
  });
  const done = await Promise.all(calls);
  const refToId = new Map(proposals.map((p) => [p.role, p.id]));
  const votes = normalizeVoteMatrix(
    proposals,
    done.map(({ role, batch }) => ({
      role,
      votes: batch.votes
        .filter((v) => refToId.has(v.proposalRef))
        .map((v) => ({
          proposalId: refToId.get(v.proposalRef)!,
          choice: v.choice,
          reason: v.reason,
        })),
    })),
  );
  return { votes, tokens: done.reduce((n, r) => n + r.tokens, 0) };
}

/**
 * The manager staffs the goal from the approved roster. The prompt is built
 * from the sorted roster + goal + metric only, so identical inputs replay
 * to identical squads; the pick is sanitized, so no output can field an
 * illegal squad.
 */
export async function runSquadPick(
  env: Env,
  goal: string,
  metricLine: string,
  roster: SeatRole[],
): Promise<{ squad: SeatRole[]; tokens: number }> {
  const client = new SparkClient(env);
  const sorted = [...roster].sort();
  const user = [
    `Goal: ${goal}`,
    metricLine,
    `Approved roster: ${sorted.join(", ")}`,
    "",
    "Pick the at-most-7 roles best suited to this goal.",
    'Reply JSON: {"roles": ["pm", ...]}. Use only roles from the roster.',
  ].join("\n");
  const res = await client.chat(SquadPick, {
    system:
      "You are the team manager. You staff each goal with the smallest squad that covers it: no passengers, no missing lenses.",
    user,
    temperature: MANAGER_TEMPERATURE,
  });
  return { squad: sanitizeSquad(res.data.roles, sorted), tokens: res.tokensUsed };
}

export const CheckDecision = z.object({
  action: z.enum(["run", "monitor"]),
  note: z.string().min(1).max(500),
});
export type CheckDecision = z.infer<typeof CheckDecision>;

/**
 * The scheduled check-in: given the goal, its metric series, and recent
 * history, the manager decides whether this tick warrants a full work
 * run or just a monitoring note. Small prompt, small bill.
 */
export async function runCheckDecide(
  env: Env,
  goalTitle: string,
  metricLine: string,
  historyLine: string,
): Promise<{ decision: CheckDecision; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    `Goal: ${goalTitle}`,
    metricLine,
    `Recent history: ${historyLine || "(none yet)"}`,
    "",
    "Scheduled check-in. Should the team run a full work session now, or just keep monitoring?",
    'Reply JSON: {"action": "run|monitor", "note": "..."}. Choose run when progress stalled, the metric slipped, or new information demands action.',
  ].join("\n");
  const res = await client.chat(CheckDecision, {
    system:
      "You are the team manager. You spend the team's effort where it moves the metric and you say so plainly when waiting beats acting.",
    user,
    temperature: MANAGER_TEMPERATURE,
  });
  return { decision: res.data, tokens: res.tokensUsed };
}

const Critique = z.object({ critique: z.string().max(2000) });

/** Session close: the manager judges the finished work honestly. */
export async function runCritique(
  env: Env,
  input: {
    goal: string;
    metricLine: string;
    decision: string;
    rationale: string;
    actions: string;
  },
): Promise<{ critique: string; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    `Goal: ${input.goal}`,
    input.metricLine,
    `Decision: ${input.decision} — ${input.rationale}`,
    `Finished results:\n${input.actions}`,
    "",
    "The session is over. In 2-4 plain sentences: what moved the goal, what you doubt, what you would change next time.",
    'Reply JSON: {"critique": "..."}.',
  ].join("\n");
  const res = await client.chat(Critique, {
    system:
      "You are the team manager. You judge finished work bluntly and plainly: credit what worked, name what you doubt, say what changes next time.",
    user,
    temperature: MANAGER_TEMPERATURE,
  });
  return { critique: res.data.critique, tokens: res.tokensUsed };
}

const Retro = z.object({
  retro: z.string().max(1500),
  tactics: z.array(z.string().max(300)).max(3),
});

/** Weekly retro: the manager reviews the week's sessions. */
export async function runRetro(
  env: Env,
  input: { weekLine: string; sessions: string },
): Promise<{ retro: string; tactics: string[]; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    input.weekLine,
    `Sessions:\n${input.sessions}`,
    "",
    "Write the week's retro in plain words: one line on wins, one on misses. Then up to 3 tactics the team should follow from now on, each self-contained.",
    'Reply JSON: {"retro": "...", "tactics": ["...", "..."]}.',
  ].join("\n");
  const res = await client.chat(Retro, {
    system:
      "You are the team manager. You review the week bluntly and turn misses into short tactics the team can follow.",
    user,
    temperature: MANAGER_TEMPERATURE,
  });
  return { retro: res.data.retro, tactics: res.data.tactics, tokens: res.tokensUsed };
}

const Answer = z.object({ text: z.string().max(1500) });

/** Slack reply: the manager answers in plain words with memory. */
export async function runAnswer(
  env: Env,
  input: { question: string; thread: string; memory: string[]; feedback: string[] },
): Promise<{ text: string; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    `Thread so far:\n${input.thread || "(just this message)"}`,
    input.memory.length ? `Org memory:\n${input.memory.map((m) => `- ${m}`).join("\n")}` : "Org memory: (none yet)",
    input.feedback.length ? `Past corrections:\n${input.feedback.map((f) => `- ${f}`).join("\n")}` : "",
    `Question: ${input.question}`,
    "",
    "Answer in plain words, under 120 words. If you do not know, say so and say what you would check.",
    'Reply JSON: {"text": "..."}.',
  ]
    .filter(Boolean)
    .join("\n");
  const res = await client.chat(Answer, {
    system:
      "You are Morgan, the team's manager. You answer teammates plainly and briefly, never with jargon, and you never invent results.",
    user,
    temperature: MANAGER_TEMPERATURE,
  });
  return { text: res.data.text, tokens: res.tokensUsed };
}

const Triage = z.object({ kind: z.enum(["question", "brief"]) });

/** DM triage: is this a question to answer or work to queue? */
export async function runTriage(
  env: Env,
  text: string,
): Promise<{ kind: "question" | "brief"; tokens: number }> {
  const client = new SparkClient(env);
  const res = await client.chat(Triage, {
    system:
      'You are the team manager. Classify the message: "brief" if it asks the team to do, make, fix, check, or start something; "question" otherwise.',
    user: `Message: ${text.slice(0, 800)}\nReply JSON: {"kind": "question|brief"}.`,
    temperature: 0,
  });
  return { kind: res.data.kind, tokens: res.tokensUsed };
}

const Themes = z.object({ tactics: z.array(z.string().max(300)).max(3) });

/** Ticket themes: recurring complaint patterns become draft tactics. */
export async function runTicketThemes(
  env: Env,
  tickets: string,
): Promise<{ tactics: string[]; tokens: number }> {
  const client = new SparkClient(env);
  const res = await client.chat(Themes, {
    system:
      "You are the support lead. You read closed tickets, spot the complaint patterns behind them, and write short self-contained tactics that would prevent repeats. At most 3, only for real repeats.",
    user: `Closed tickets:\n${tickets}\nReply JSON: {"tactics": ["..."]}. Empty array when nothing repeats.`,
    temperature: MANAGER_TEMPERATURE,
  });
  return { tactics: res.data.tactics, tokens: res.tokensUsed };
}

const Proposal = z.object({
  kind: z.enum(["next-work", "new-goal"]),
  goalId: z.string().nullable(),
  title: z.string().max(140),
  body: z.string().max(1000),
});

/** Idle proposal: the manager drafts the next work or a new goal. */
export async function runPropose(
  env: Env,
  input: { goals: string; numbers: string; memory: string[] },
): Promise<{ kind: "next-work" | "new-goal"; goalId: string | null; title: string; body: string; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    `Active goals:\n${input.goals || "(none)"}`,
    `Numbers: ${input.numbers || "(none yet)"}`,
    input.memory.length ? `What worked before:\n${input.memory.map((m) => `- ${m}`).join("\n")}` : "",
    "",
    "The team is out of work. Draft ONE proposal: next-work under one of the goals above (use its exact goal id), or — only when no goal fits — a brand-new goal.",
    'Reply JSON: {"kind": "next-work|new-goal", "goalId": "<id or null>", "title": "...", "body": "why now, first number to watch"}.',
  ]
    .filter(Boolean)
    .join("\n");
  const res = await client.chat(Proposal, {
    system:
      "You are the team manager. You notice what the business needs next and propose one concrete step, plainly. Never propose busywork.",
    user,
    temperature: MANAGER_TEMPERATURE,
  });
  return { ...res.data, tokens: res.tokensUsed };
}

export async function runManagerRuling(
  env: Env,
  ctx: GoalContext,
  proposals: Array<{ id: string; role: string; title: string; body: string }>,
  tallyLine: string,
  resubmitNote?: string | null,
): Promise<{ ruling: RulingDraft; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    `Goal: ${ctx.goal}`,
    ctx.metricLine,
    memoryBlock(ctx.memory),
    playbookBlock(ctx.playbook),
    ...(resubmitNote
      ? ["", `Founder's rejection note (address this directly): ${resubmitNote}`]
      : []),
    "",
    ...proposals.map(
      (p) => `---\nproposalRef: ${p.role}\ntitle: ${p.title}\n${p.body}`,
    ),
    "",
    `Vote tally: ${tallyLine}`,
    resubmitNote
      ? "A previous ruling was rejected. As the manager, rule again with the note above addressed."
      : "No majority. As the manager, make the final call.",
    'Reply JSON: {"decision": "...", "rationale": "..."}. Name the winning proposal and why it wins.',
  ].join("\n");
  const res = await client.chat(RulingDraft, {
    system:
      "You are the team manager. You decide ties with crisp judgment, own the call, and record dissent fairly.",
    user,
    temperature: MANAGER_TEMPERATURE,
    maxTokens: RULING_MAX_TOKENS,
  });
  return { ruling: res.data, tokens: res.tokensUsed };
}

export const EngineerDiff = z.object({
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .max(5),
  summary: z.string().min(1).max(500),
});
export type EngineerDiff = z.infer<typeof EngineerDiff>;

/**
 * The engineer's build step: given the ruling and repo context, write the
 * diff. Empty files = no code change warranted (the caller ships a
 * decision doc instead). Outputs pass through saneFiles at the boundary.
 */
export async function runEngineerDiff(
  env: Env,
  decision: string,
  rationale: string,
  tree: string[],
  files: Array<{ path: string; content: string }>,
): Promise<{ files: Array<{ path: string; content: string }>; summary: string; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    `Decision: ${decision}`,
    `Rationale: ${rationale}`,
    "",
    `Repo tree (${tree.length} files):`,
    tree.slice(0, 120).join("\n") || "(empty repo)",
    "",
    ...files.map((f) => `--- ${f.path}\n${f.content.slice(0, 6000)}`),
    "",
    "Write the smallest diff that implements the decision: at most 3 files, 200 lines each.",
    "Reply JSON: {\"files\": [{\"path\": \"...\", \"content\": \"<full new file content>\"}], \"summary\": \"...\"}.",
    "Full contents, not patches. If the decision needs no code change, reply {\"files\": [], \"summary\": \"<why>\"}.",
  ].join("\n");
  const res = await client.chat(EngineerDiff, {
    system:
      "You are the product engineer. You ship small correct diffs that merge cleanly: complete files, no placeholders, no TODOs.",
    user,
    temperature: 0.4,
    maxTokens: 6000,
  });
  return { files: saneFiles(res.data.files), summary: res.data.summary, tokens: res.tokensUsed };
}

export const PmSplit = z.object({
  subtasks: z.array(z.string()).max(7),
});
export type PmSplit = z.infer<typeof PmSplit>;

/** The PM's breakdown: ruling into trackable sub-tasks. */
export async function runPmSplit(
  env: Env,
  decision: string,
  rationale: string,
): Promise<{ subtasks: string[]; tokens: number }> {
  const client = new SparkClient(env);
  const res = await client.chat(PmSplit, {
    system:
      "You are the product manager. You break decisions into small verifiable work items, each done-able in one sitting.",
    user: [
      `Decision: ${decision}`,
      `Rationale: ${rationale}`,
      "",
      "Split this into at most 5 sub-tasks.",
      'Reply JSON: {"subtasks": ["...", ...]}.',
    ].join("\n"),
    temperature: 0.5,
  });
  return { subtasks: saneSubtasks(res.data.subtasks), tokens: res.tokensUsed };
}

export const DiscountPlan = z.object({
  percent: z.number(),
  title: z.string(),
  startInDays: z.number(),
});
export type DiscountPlan = z.infer<typeof DiscountPlan>;

/** The marketer's offer: ruling into bounded discount params. */
export async function runDiscountPlan(
  env: Env,
  goal: string,
  decision: string,
): Promise<{ plan: SaneDiscount; tokens: number }> {
  const client = new SparkClient(env);
  const res = await client.chat(DiscountPlan, {
    system:
      "You are the growth marketer. You turn strategy into concrete offers: a real percent off, a real title, a real start.",
    user: [
      `Goal: ${goal}`,
      `Decision: ${decision}`,
      "",
      "Design the discount: percent off, short title, days until it starts.",
      'Reply JSON: {"percent": 15, "title": "...", "startInDays": 0}.',
    ].join("\n"),
    temperature: 0.8,
  });
  return {
    plan: saneDiscount({
      percent: res.data.percent,
      title: res.data.title,
      startInDays: res.data.startInDays,
    }),
    tokens: res.tokensUsed,
  };
}

export const SupportTriage = z.object({
  priority: z.string(),
  resolve: z.boolean(),
  followup: z.string().min(1).max(1000),
});
export type SupportTriage = z.infer<typeof SupportTriage>;

/** The analyst's triage: ruling into ticket priority + follow-up. */
export async function runSupportTriage(
  env: Env,
  decision: string,
  ticketSubject: string,
): Promise<{ priority: TicketPriority; resolve: boolean; followup: string; tokens: number }> {
  const client = new SparkClient(env);
  const res = await client.chat(SupportTriage, {
    system:
      "You are the support analyst. You triage with a customer's patience and an owner's judgment: right priority, honest follow-up, resolve only when truly resolved.",
    user: [
      `Decision: ${decision}`,
      `Ticket: ${ticketSubject}`,
      "",
      "Triage this ticket: priority (HIGH/MEDIUM/LOW), whether the decision resolves it, and the follow-up note.",
      'Reply JSON: {"priority": "MEDIUM", "resolve": false, "followup": "..."}.',
    ].join("\n"),
    temperature: 0.2,
  });
  return {
    priority: triagePriority(res.data.priority),
    resolve: res.data.resolve,
    followup: res.data.followup,
    tokens: res.tokensUsed,
  };
}

export const ProductCopy = z.object({
  description: z.string().min(20).max(5000),
});
export type ProductCopy = z.infer<typeof ProductCopy>;

/** The marketer's rewrite: ruling into product copy. */
export async function runProductCopy(
  env: Env,
  decision: string,
  title: string,
  current: string,
): Promise<{ description: string; tokens: number }> {
  const client = new SparkClient(env);
  const res = await client.chat(ProductCopy, {
    system:
      "You are the growth marketer. You rewrite product copy so it sells the decision's promise in the customer's words: concrete, short, no hype.",
    user: [
      `Decision: ${decision}`,
      `Product: ${title}`,
      `Current description: ${current || "(empty)"}`,
      "",
      "Rewrite the description. Keep every true fact; cut fluff.",
      'Reply JSON: {"description": "..."}.',
    ].join("\n"),
    temperature: 0.8,
  });
  return { description: res.data.description, tokens: res.tokensUsed };
}

export const DistilledTactics = z.object({
  tactics: z
    .array(z.object({ system: z.string(), tactic: z.string() }))
    .max(12),
});
export type DistilledTactics = z.infer<typeof DistilledTactics>;

export interface RatingInput {
  actionKind: string;
  thumb: string;
  note: string;
}

/**
 * Nightly learning: founder ratings become draft playbook tactics. The
 * founder approves or vetoes in the playbook tab; only approved
 * tactics ever reach a squad prompt.
 */
export async function runDistill(
  env: Env,
  items: RatingInput[],
): Promise<{ tactics: SaneTactic[]; tokens: number }> {
  const client = new SparkClient(env);
  const user = [
    "Founder ratings on shipped artifacts (kind / thumb / note):",
    ...items.map(
      (r) => `- ${r.actionKind} / ${r.thumb}${r.note ? ` / ${r.note}` : ""}`,
    ),
    "",
    "Distill these into reusable tactics: what should the team do more of, or stop doing?",
    'Reply JSON: {"tactics": [{"system": "slack|github|...", "tactic": "..."}]}.',
    "One tactic per lesson, each self-contained. At most 10.",
  ].join("\n");
  const res = await client.chat(DistilledTactics, {
    system:
      "You are the team's coach. You turn scattered feedback into crisp tactics the team can follow without explanation.",
    user,
    temperature: 0.3,
  });
  return { tactics: saneTactics(res.data.tactics), tokens: res.tokensUsed };
}

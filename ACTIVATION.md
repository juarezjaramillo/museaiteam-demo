# Activation Metric — Locked

## 1. Definition (locked, do not redefine)
- **Activation = % new signups completing first-value action within 7 days.**
- `activated = first_value_ts - signup_ts in [0, 7d]`.
- Report as `rate + n + 95% CI (Wilson)`.
- **Baseline: 32%.** Baseline is only trusted with instrument audit + n + CI.
- Rejected: 24h redefinition (breaks comparability). Rejected: reporting rate without n/CI.

## 2. Instrument audit (must pass before diagnosis)
1. Every signup has unique `signup_id` + `signup_ts`.
2. Every first-value action has `signup_id` + `event_ts` + immutable definition.
3. No future timestamps, no duplicates, no null IDs.
4. Funnel logging verified end-to-end (signup -> first-value). Do not assume leak location.

## 3. Sliced diagnosis (find the leak)
- Slice activation by channel, cohort/week, platform, and signup-to-value step.
- Identify the step with the largest absolute drop; quantify with n + CI per slice.
- Do not ship a fix until the slice with the leak is named with data.

## 4. Pre-registered A/B (one test to 37%)
- **H: fix lifts activation 32% -> 37% (+5pp).**
- **n = ~1500 / arm** for 80% power, alpha 0.05 two-sided (see `activation.py`).
- Rejected: n=500 (underpowered).
- **Keep iff:** two-prop z-test p < 0.05 AND treatment >= 37% (or >= +5pp vs concurrent control).
- **Kill otherwise.** Inconclusive = kill.
- **Falsifiability:** if at 1500/arm there is no significant +5pp lift, the tested fix hypothesis is false; kill it and return to diagnosis. No peeking, no redefinition, no extension without pre-registration.

## 5. Candidate fix queue
- Held: auto-workspace + 3-item checklist (fastest shippable, assumes unverified 68% workspace leak, risks sprawl). Test only if step 3 diagnoses workspace-setup as the leak.
- Nudge (3-touch) may recover edge cases but cannot close 5pp structural leak alone; not the A/B candidate.

## 6. Dissent recorded
- Speed favors shipping auto-workspace now. Decision: rigor > speed until baseline and leak are trusted.

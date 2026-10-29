# Pre-registered Guard Toggle A/B Probe — Baseline Protocol

## Ownership
Analyst owns this protocol and the ship decision. Engineer flag and PM kill-switch execute inside it.

## Metrics
- Primary: `task_success_rate` (non-inferiority, margin 2%)
- Guards: `false_block_rate`, `p95_latency_ms`
- Cost: `p95_latency_ms`

## Baseline
- Collect 7d control baseline before any comparison.
- Gate returns `collecting_baseline` until `days_collected >= 7`.
- No 1%/24h shortcut: 24h risks 5-10% hidden regression.

## Power
- Require power for 2% change (alpha 0.05, power 0.8).
- Required n per arm computed from baseline rate; gate returns `underpowered` until met.
- No opt-in messaging: neutral enrollment only to avoid marketer bias.

## Ship rule (pre-registered, all must pass)
1. False-Block < 1% (`treatment.false_block_rate < 0.01`)
2. Success non-inferior (`treatment.success >= control.success - 0.02`)
3. p95 delta < +50ms (`treatment.p95 - control.p95 < 50`)
- Else `block`. Kill-switch `killed` overrides to `block`.

## Execution
- Engineer `ToggleFlag`: deterministic 50/50 hash routing, infra only, not efficacy.
- PM `KillSwitch`: immediate stop, checked first in `probe_gate`.
- See `guard_probe.py`: `baseline_ready`, `required_n_per_arm`, `decide_ship`, `probe_gate`.

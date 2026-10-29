"""Locked activation metric + pre-registered A/B decision."""
from __future__ import annotations
import math
from collections import defaultdict

ACTIVATION_WINDOW_DAYS = 7
BASELINE_RATE = 0.32
TARGET_RATE = 0.37
N_PER_ARM = 1500
ALPHA = 0.05
Z_95 = 1.96


def is_activated(signup_ts: float, first_value_ts: float | None) -> bool:
    if first_value_ts is None:
        return False
    delta_days = (first_value_ts - signup_ts) / 86400.0
    return 0 <= delta_days <= ACTIVATION_WINDOW_DAYS


def activation_rate(activated: int, total: int) -> float:
    if total <= 0:
        raise ValueError("total must be > 0")
    if not 0 <= activated <= total:
        raise ValueError("activated out of range")
    return activated / total


def wilson_ci(successes: int, n: int, z: float = Z_95) -> tuple[float, float]:
    if n <= 0:
        raise ValueError("n must be > 0")
    p = successes / n
    denom = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((center - margin) / denom, (center + margin) / denom)


def summarize(successes: int, n: int) -> dict:
    rate = activation_rate(successes, n)
    lo, hi = wilson_ci(successes, n)
    return {"rate": rate, "n": n, "ci95": (lo, hi)}


def audit_events(signups: list[dict], values: list[dict]) -> list[str]:
    issues: list[str] = []
    seen: set = set()
    for s in signups:
        if not s.get("signup_id") or s.get("signup_ts") is None:
            issues.append(f"bad signup row: {s}")
        elif s["signup_id"] in seen:
            issues.append(f"duplicate signup_id: {s['signup_id']}")
        else:
            seen.add(s["signup_id"])
    signup_ts = {s["signup_id"]: s["signup_ts"] for s in signups if s.get("signup_id")}
    for v in values:
        sid = v.get("signup_id")
        if sid not in signup_ts:
            issues.append(f"orphan value event: {v}")
        elif v.get("event_ts") is None:
            issues.append(f"missing event_ts: {v}")
        elif v["event_ts"] < signup_ts[sid]:
            issues.append(f"event before signup: {v}")
    return issues


def slice_rates(rows: list[dict], key: str) -> dict[str, dict]:
    groups: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        groups[str(r[key])].append(bool(r["activated"]))
    out: dict[str, dict] = {}
    for name, flags in groups.items():
        n = len(flags)
        s = sum(1 for f in flags if f)
        out[name] = summarize(s, n)
    return out


def required_n_per_arm(p1: float = BASELINE_RATE, p2: float = TARGET_RATE) -> int:
    z_alpha = 1.96
    z_beta = 0.84
    p_bar = (p1 + p2) / 2
    num = (z_alpha * math.sqrt(2 * p_bar * (1 - p_bar)) + z_beta * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
    den = (p2 - p1) ** 2
    return int(math.ceil(num / den))


def two_prop_z(control_s: int, control_n: int, treat_s: int, treat_n: int) -> tuple[float, float]:
    p1 = control_s / control_n
    p2 = treat_s / treat_n
    p_pool = (control_s + treat_s) / (control_n + treat_n)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / control_n + 1 / treat_n))
    if se == 0:
        return (0.0, 1.0)
    z = (p2 - p1) / se
    p_val = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    return (z, p_val)


def decide_experiment(control_s: int, control_n: int, treat_s: int, treat_n: int) -> str:
    _, p_val = two_prop_z(control_s, control_n, treat_s, treat_n)
    treat_rate = treat_s / treat_n
    control_rate = control_s / control_n
    lift = treat_rate - control_rate
    if p_val < ALPHA and (treat_rate >= TARGET_RATE or lift >= (TARGET_RATE - BASELINE_RATE)):
        return "KEEP: significant +5pp lift, roll out"
    return "KILL: hypothesis falsified at 1500/arm, no significant 32->37% lift"

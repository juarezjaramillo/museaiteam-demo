"""Pre-registered Guard Toggle A/B Probe with Baseline.
Analyst protocol owns the ship decision. Engineer flag + PM kill-switch
execute inside that protocol (infra only, not efficacy).
"""
from __future__ import annotations
from dataclasses import dataclass, field
import hashlib

BASELINE_DAYS = 7
MDE = 0.02
FALSE_BLOCK_MAX = 0.01
P95_MAX_DELTA_MS = 50.0
Z_SUM_SQ = 7.84

PRIMARY = "task_success_rate"
GUARDS = ["false_block_rate", "p95_latency_ms"]
COST = "p95_latency_ms"

@dataclass
class ToggleFlag:
    """Engineer-owned infra flag. Tests routing only, not guard efficacy."""
    enabled: bool = False
    name: str = "guard_toggle_v1"

@dataclass
class KillSwitch:
    """PM-owned emergency stop. Checked before any ship logic."""
    tripped: bool = False
    reason: str = ""
    def trip(self, reason: str) -> None:
        self.tripped = True
        self.reason = reason
    def clear(self) -> None:
        self.tripped = False
        self.reason = ""

@dataclass
class ArmMetrics:
    n: int
    success_rate: float
    false_block_rate: float
    p95_ms: float

@dataclass
class ProbeDecision:
    ship: bool
    reasons: list[str] = field(default_factory=list)

def _hash01(key: str) -> float:
    h = hashlib.sha256(key.encode()).hexdigest()
    return int(h[:8], 16) / 4294967295.0

def assign_arm(user_id: str, flag: ToggleFlag) -> str:
    if not flag.enabled:
        return "control"
    return "treatment" if _hash01(flag.name + ":" + user_id) < 0.5 else "control"

def baseline_ready(days_collected: int) -> bool:
    return days_collected >= BASELINE_DAYS

def required_n_per_arm(baseline_rate: float, mde: float = MDE) -> int:
    p = min(max(baseline_rate, 0.01), 0.99)
    var = 2 * p * (1 - p)
    n = Z_SUM_SQ * var / (mde * mde)
    return max(1, int(n) + 1)

def has_power(control: ArmMetrics, treatment: ArmMetrics, baseline_rate: float) -> bool:
    need = required_n_per_arm(baseline_rate)
    return control.n >= need and treatment.n >= need

def decide_ship(control: ArmMetrics, treatment: ArmMetrics) -> ProbeDecision:
    reasons: list[str] = []
    ok_block = treatment.false_block_rate < FALSE_BLOCK_MAX
    reasons.append(f"False-Block {treatment.false_block_rate:.4f} {'<' if ok_block else '>='} {FALSE_BLOCK_MAX}")
    non_inferior = treatment.success_rate >= control.success_rate - MDE
    reasons.append(f"Success non-inferior: treat {treatment.success_rate:.4f} vs ctrl {control.success_rate:.4f} - {MDE} {'pass' if non_inferior else 'fail'}")
    delta = treatment.p95_ms - control.p95_ms
    ok_lat = delta < P95_MAX_DELTA_MS
    reasons.append(f"p95 delta {delta:.1f}ms {'<' if ok_lat else '>='} +{P95_MAX_DELTA_MS:.0f}ms")
    return ProbeDecision(ship=(ok_block and non_inferior and ok_lat), reasons=reasons)

def probe_gate(kill: KillSwitch, flag: ToggleFlag, days_collected: int, control: ArmMetrics | None, treatment: ArmMetrics | None, baseline_rate: float) -> dict:
    if kill.tripped:
        return {"status": "killed", "ship": False, "reason": kill.reason}
    if not baseline_ready(days_collected):
        return {"status": "collecting_baseline", "ship": False, "reason": f"need {BASELINE_DAYS}d, have {days_collected}d"}
    if control is None or treatment is None:
        return {"status": "collecting_baseline", "ship": False, "reason": "missing arms"}
    if not has_power(control, treatment, baseline_rate):
        return {"status": "underpowered", "ship": False, "reason": f"need {required_n_per_arm(baseline_rate)} per arm for 2% change"}
    d = decide_ship(control, treatment)
    return {"status": "ship" if d.ship else "block", "ship": d.ship, "reasons": d.reasons}

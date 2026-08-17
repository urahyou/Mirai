"""多维情绪投影：事件有限扰动，随后向角色基线平滑回归。"""
from __future__ import annotations

import math
from typing import Any

HOUR_MS = 60 * 60 * 1000
MAX_INFLUENCES = 32
BASELINE = {"valence": .15, "arousal": .45, "security": .65, "attachment": .35, "curiosity": .55, "focus": .50}
HALF_LIFE_HOURS = {"valence": 6, "arousal": 3, "security": 18, "attachment": 96, "curiosity": 12, "focus": 4}
EVENT_DELTAS = {
    "pet:greeting": {"valence": .08, "security": .04, "attachment": .03, "arousal": .03},
    "pet:conversation": {"valence": .04, "security": .025, "attachment": .025, "curiosity": .02},
    "pet:praise": {"valence": .13, "security": .08, "attachment": .04},
    "pet:late_night": {"valence": -.04, "arousal": .10, "security": -.03, "focus": -.15},
    "pet:long_session": {"valence": -.04, "arousal": .05, "focus": -.10},
    "pet:neglect": {"valence": -.10, "security": -.07, "attachment": -.02},
    "pet:feed": {"valence": .05, "security": .05, "attachment": .02},
    "life:activity:rest": {"valence": .02, "arousal": -.08, "security": .03},
    "life:activity:study": {"curiosity": .06, "focus": .12, "arousal": .03},
    "life:activity:work": {"focus": .08, "arousal": .05, "valence": -.01},
    "life:activity:play": {"valence": .10, "arousal": .06, "curiosity": .04},
    "life:activity:walk": {"valence": .05, "arousal": -.04, "security": .02},
    "life:activity:shopping": {"valence": .04, "arousal": .04, "curiosity": .06},
}


def _clamp(value: Any) -> float:
    try: return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError): return 0.0


def default() -> dict[str, Any]:
    return {**BASELINE, "updatedAt": None, "recentInfluences": []}


def normalize(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    state = default()
    for key, baseline in BASELINE.items(): state[key] = _clamp(source.get(key, baseline))
    state["updatedAt"] = source.get("updatedAt") if isinstance(source.get("updatedAt"), (int, float)) else None
    state["recentInfluences"] = list(source.get("recentInfluences", []))[-MAX_INFLUENCES:] if isinstance(source.get("recentInfluences"), list) else []
    return state


def evolve(raw: Any, now: int) -> dict[str, Any]:
    if not isinstance(now, (int, float)) or isinstance(now, bool): raise ValueError("now 必须是时间戳")
    state = normalize(raw)
    if state["updatedAt"] and now > state["updatedAt"]:
        hours = min((int(now) - int(state["updatedAt"])) / HOUR_MS, 24 * 30)
        for key, baseline in BASELINE.items():
            state[key] = _clamp(baseline + (state[key] - baseline) * math.exp(-math.log(2) * hours / HALF_LIFE_HOURS[key]))
    state["updatedAt"] = int(now)
    return state


def apply(raw: Any, event_type: str, now: int) -> dict[str, Any]:
    state = evolve(raw, now)
    delta = EVENT_DELTAS.get(event_type, {})
    for key, change in delta.items(): state[key] = _clamp(state[key] + change)
    if delta:
        state["recentInfluences"].append({"eventType": event_type, "occurredAt": int(now), "delta": delta})
        state["recentInfluences"] = state["recentInfluences"][-MAX_INFLUENCES:]
    return state


def describe(raw: Any) -> str:
    state = normalize(raw)
    valence = "愉快" if state["valence"] >= .6 else "低落" if state["valence"] <= .35 else "平和"
    arousal = "活跃" if state["arousal"] >= .65 else "安静" if state["arousal"] <= .35 else "平稳"
    return f"情绪维度：{valence}、{arousal}；安全感 {round(state['security'] * 100)}/100；依恋 {round(state['attachment'] * 100)}/100；好奇 {round(state['curiosity'] * 100)}/100；专注 {round(state['focus'] * 100)}/100。"

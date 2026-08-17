"""与现有 Node pet-state 等价的纯 Python 领域规则。"""
from __future__ import annotations
import math
from copy import deepcopy
from typing import Any

HOUR = 3600000
DAY = 24 * HOUR
BASE = {"moodScore": 60, "energy": 80, "stress": 15, "loneliness": 30}
HALF = {"moodScore": 6, "energy": 10, "stress": 8, "loneliness": 36}
DELTAS = {
    "pet:greeting": {"moodScore": 6, "loneliness": -8, "stress": -2, "energy": 2},
    "pet:conversation": {"moodScore": 3, "loneliness": -3, "stress": -1, "energy": -2},
    "pet:praise": {"moodScore": 10, "stress": -3, "loneliness": -2, "energy": -2},
    "pet:late_night": {"stress": 5, "energy": -10, "moodScore": -3},
    "pet:long_session": {"energy": -8, "stress": 3, "moodScore": -2},
    "pet:neglect": {"loneliness": 8, "stress": 2, "moodScore": -3},
    "pet:feed": {"health": 25, "moodScore": 3, "energy": 5},
}
AFF = {"pet:greeting": 1, "pet:conversation": 2, "pet:praise": 3, "pet:feed": 2, "pet:late_night": .5, "pet:long_session": .5, "pet:neglect": 0}
XP = {"pet:greeting": 3, "pet:conversation": 2, "pet:praise": 4, "pet:feed": 6}

def default() -> dict[str, Any]:
    return {"emotion": {"moodScore": 60, "energy": 80, "stress": 15, "loneliness": 25, "health": 100, "mood": "平静", "updatedAt": None}, "affection": {"value": 0, "updatedAt": None, "lastInteractionAt": None, "day": "", "dayGain": 0}, "nurture": {"experience": 0, "stage": "幼年", "updatedAt": None}, "events": []}

def clamp(value: float) -> float: return max(0, min(100, value))
def mood(value: float) -> str: return "低沉" if value <= 30 else "平静" if value <= 65 else "开心" if value <= 85 else "兴奋"
def stage(exp: float) -> str: return "成熟" if exp >= 300 else "成长" if exp >= 100 else "幼年"
def day_of(now: int) -> str:
    from datetime import datetime
    return datetime.fromtimestamp(now / 1000).strftime("%Y-%m-%d")

def normalize(raw: Any) -> dict[str, Any]:
    out = default(); raw = raw if isinstance(raw, dict) else {}
    for key in ("emotion", "affection", "nurture"):
        if isinstance(raw.get(key), dict): out[key].update(raw[key])
    out["events"] = list(raw.get("events", []))[-50:] if isinstance(raw.get("events"), list) else []
    e = out["emotion"]
    for key, base in BASE.items():
        try: e[key] = clamp(float(e[key]))
        except (TypeError, ValueError): e[key] = base
    try: e["health"] = clamp(float(e["health"]))
    except (TypeError, ValueError): e["health"] = 100
    e["mood"] = mood(e["moodScore"])
    a, n = out["affection"], out["nurture"]
    for key in ("value", "dayGain"):
        try: a[key] = float(a[key])
        except (TypeError, ValueError): a[key] = 0
    try: n["experience"] = max(0, float(n["experience"]))
    except (TypeError, ValueError): n["experience"] = 0
    n["stage"] = stage(n["experience"]); return out

def evolve(raw: Any, now: int) -> dict[str, Any]:
    s = normalize(raw); e = s["emotion"]; updated = e.get("updatedAt")
    if isinstance(updated, (int, float)) and updated and now > updated:
        hours = (now - updated) / HOUR
        for key in BASE: e[key] = clamp(BASE[key] + (e[key] - BASE[key]) * math.exp(-math.log(2) * hours / HALF[key]))
        e["health"] = clamp(e["health"] - hours / 12 * 5)
    e["mood"] = mood(e["moodScore"]); e["updatedAt"] = now
    a = s["affection"]; last = a.get("lastInteractionAt")
    if isinstance(last, (int, float)) and last:
        idle = (now - last) / DAY
        if idle > 1: a["value"] = max(10, a["value"] - (idle - 1) * .5)
    today = day_of(now)
    if a.get("day") != today: a["day"], a["dayGain"] = today, 0
    a["updatedAt"] = now; s["nurture"]["updatedAt"] = now; return s

def apply(raw: Any, event_type: str, now: int) -> tuple[dict[str, Any], dict[str, Any] | None]:
    s = evolve(raw, now); d = DELTAS.get(event_type)
    if d:
        e = s["emotion"]
        for key in ("moodScore", "energy", "stress", "loneliness", "health"): e[key] = clamp(e[key] + d.get(key, 0))
        e["mood"] = mood(e["moodScore"]); a = s["affection"]
        gain = min(AFF.get(event_type, 0) * (.5 + e["moodScore"] / 200), max(0, 12 - a["dayGain"]))
        a["value"] += gain; a["dayGain"] += gain; a["lastInteractionAt"] = now; a["updatedAt"] = now
        before = s["nurture"]["stage"]; n = s["nurture"]; n["experience"] += XP.get(event_type, 0); n["stage"] = stage(n["experience"])
        upgrade = {"from": before, "to": n["stage"], "experience": n["experience"]} if before != n["stage"] else None
    else: upgrade = None
    s["events"].append({"type": event_type, "value": 0, "createdAt": now}); s["events"] = s["events"][-50:]
    return s, upgrade

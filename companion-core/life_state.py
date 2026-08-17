"""小未来的确定性虚拟生活状态机。活动是规则，不让 LLM 直接改状态。"""
from __future__ import annotations

from typing import Any
import uuid

SCHEMA_VERSION = 1
MAX_RECENT_ACTIVITIES = 32
HOUR_MS = 60 * 60 * 1000

ACTIVITIES: dict[str, dict[str, Any]] = {
    "rest": {"durationMinutes": 30, "cost": {"energy": -1}, "effect": {"energy": 15, "stress": -3}, "tags": ["休息"], "location": "home"},
    "meal": {"durationMinutes": 30, "cost": {}, "effect": {"hunger": -55, "energy": 3, "health": 2}, "tags": ["吃饭"], "location": "home"},
    "school": {"durationMinutes": 120, "cost": {"energy": 16}, "effect": {"boredom": -10, "stress": 3}, "tags": ["上学", "学习"], "location": "school"},
    "study": {"durationMinutes": 60, "cost": {"energy": 10}, "effect": {"boredom": -5, "stress": 2}, "tags": ["学习"], "location": "home"},
    "work": {"durationMinutes": 120, "cost": {"energy": 20}, "effect": {"stress": 5, "money": 100}, "tags": ["工作"], "location": "work"},
    "play": {"durationMinutes": 45, "cost": {"energy": 8}, "effect": {"boredom": -25, "stress": -2}, "tags": ["玩耍"], "location": "home"},
    "walk": {"durationMinutes": 30, "cost": {"energy": 5}, "effect": {"boredom": -10, "stress": -4}, "tags": ["散步"], "location": "outside"},
    "think": {"durationMinutes": 25, "cost": {"energy": 2}, "effect": {"boredom": -6, "stress": -2}, "tags": ["思考"], "location": "home"},
    "shopping": {"durationMinutes": 60, "cost": {"energy": 12, "money": 100}, "effect": {"boredom": -12}, "tags": ["逛街", "虚拟商店"], "location": "mall"},
}


def default() -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "updatedAt": None, "location": "home", "currentActivityId": "rest", "health": 100, "energy": 80, "hunger": 20, "boredom": 20, "stress": 10, "money": 1200, "inventory": [], "goals": [], "schedule": [], "recentActivities": []}


def _clamp(value: Any, low: float = 0, high: float = 100) -> float:
    try: return max(low, min(high, float(value)))
    except (TypeError, ValueError): return low


def normalize(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    state = {**default(), **source}
    for key in ("health", "energy", "hunger", "boredom", "stress"): state[key] = _clamp(state.get(key), 0, 100)
    try: state["money"] = max(0, int(state.get("money", 1200)))
    except (TypeError, ValueError): state["money"] = 1200
    state["inventory"] = list(state["inventory"])[:64] if isinstance(state.get("inventory"), list) else []
    state["goals"] = list(state["goals"])[:32] if isinstance(state.get("goals"), list) else []
    state["schedule"] = list(state["schedule"])[:32] if isinstance(state.get("schedule"), list) else []
    state["recentActivities"] = list(state["recentActivities"])[-MAX_RECENT_ACTIVITIES:] if isinstance(state.get("recentActivities"), list) else []
    return state


def advance(raw: Any, now: int) -> dict[str, Any]:
    if not isinstance(now, (int, float)) or isinstance(now, bool): raise ValueError("now 必须是时间戳")
    state = normalize(raw)
    previous = state.get("updatedAt")
    hours = max(0.0, (int(now) - int(previous)) / HOUR_MS) if isinstance(previous, (int, float)) else 0.0
    # 关机期间按时间差一次性结算，最多补算 30 天，避免长期离线时数值失控。
    hours = min(hours, 24 * 30)
    state["hunger"] = _clamp(state["hunger"] + hours * 4)
    state["boredom"] = _clamp(state["boredom"] + hours * 3)
    state["energy"] = _clamp(state["energy"] - hours * 2)
    if state["hunger"] > 80: state["health"] = _clamp(state["health"] - hours * 0.8)
    if state["stress"] > 70: state["health"] = _clamp(state["health"] - hours * 0.3)
    state["updatedAt"] = int(now)
    return state


def perform(raw: Any, activity_id: str, now: int) -> dict[str, Any]:
    if activity_id not in ACTIVITIES: raise ValueError("未知生活活动")
    state = advance(raw, now)
    activity = ACTIVITIES[activity_id]
    if state["health"] < 20 and activity_id not in ("rest", "walk"): raise ValueError("健康状态不适合进行该活动")
    if state["energy"] < activity["cost"].get("energy", 0): raise ValueError("体力不足")
    if state["money"] < activity["cost"].get("money", 0): raise ValueError("虚拟零钱不足")
    for key, value in activity["cost"].items():
        if key == "money": state[key] = max(0, state[key] - value)
        else: state[key] = _clamp(state[key] - value)
    for key, value in activity["effect"].items():
        if key == "money": state[key] = max(0, state[key] + value)
        else: state[key] = _clamp(state[key] + value)
    if activity_id == "shopping": state["inventory"].append("item:小礼物")
    state["currentActivityId"] = activity_id
    state["location"] = activity.get("location", state["location"])
    state["updatedAt"] = int(now) + int(activity["durationMinutes"] * 60 * 1000)
    # 活动本身也是日记与回忆的可追溯来源；不能只靠时间戳拼接身份。
    state["recentActivities"].append({"id": "activity:" + uuid.uuid4().hex, "activityId": activity_id, "completedAt": int(now), "durationMinutes": activity["durationMinutes"], "tags": activity["tags"]})
    state["recentActivities"] = state["recentActivities"][-MAX_RECENT_ACTIVITIES:]
    return state

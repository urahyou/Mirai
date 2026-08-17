"""小未来 Python 自主后端的最小领域内核。

本阶段只持久化低敏感的时钟投影，验证 Electron <-> Python 协议和数据目录。
生活、记忆、情绪等领域将在后续版本迁入同一 Core。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import pet_state
import life_state
import emotion_state
from memory_store import MemoryStore

SCHEMA_VERSION = 1
STATE_FILE = "companion-core-state.json"
MAX_RECENT_EVENTS = 64


class CoreError(ValueError):
    """协议请求或领域数据不符合约束。"""


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _validate_event(event: Any) -> dict[str, Any]:
    if not _is_object(event):
        raise CoreError("event 必须是对象")
    event_type = event.get("type")
    if not isinstance(event_type, str) or not event_type or len(event_type) > 120:
        raise CoreError("event.type 必须是长度受限的字符串")
    payload = event.get("payload", {})
    if not _is_object(payload):
        raise CoreError("event.payload 必须是对象")
    occurred_at = event.get("occurredAt")
    if occurred_at is not None and (not isinstance(occurred_at, str) or len(occurred_at) > 64):
        raise CoreError("event.occurredAt 不合法")
    return {
        "type": event_type,
        "occurredAt": occurred_at,
        "source": str(event.get("source", "unknown"))[:80],
        "privacy": str(event.get("privacy", "local-only"))[:40],
        "payload": payload,
    }


class CompanionCore:
    def __init__(self) -> None:
        self.data_dir: Path | None = None
        self.state: dict[str, Any] = self._default_state()
        self.memory: MemoryStore | None = None

    @staticmethod
    def _default_state() -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "tickCount": 0,
            "lastTickAt": None,
            "recentEvents": [],
            "petState": pet_state.default(),
            "petStateImported": False,
            "lifeState": life_state.default(),
            "emotionState": emotion_state.default(),
        }

    def bootstrap(self, data_dir: str) -> dict[str, Any]:
        if not isinstance(data_dir, str) or not data_dir.strip():
            raise CoreError("dataDir 必须是非空字符串")
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.state = self._read_state()
        if self.memory: self.memory.close()
        self.memory = MemoryStore(self.data_dir / "memory.db")
        return self.snapshot()

    def close(self) -> None:
        if self.memory:
            self.memory.close()
            self.memory = None

    def ingest(self, event: Any) -> dict[str, Any]:
        if self.data_dir is None:
            raise CoreError("Core 尚未 bootstrap")
        normalized = _validate_event(event)
        recent = list(self.state.get("recentEvents", []))
        recent.append({
            "type": normalized["type"],
            "occurredAt": normalized["occurredAt"],
            "source": normalized["source"],
        })
        self.state["recentEvents"] = recent[-MAX_RECENT_EVENTS:]
        if normalized["type"] == "sensing:tick":
            now = normalized["payload"].get("now")
            if not isinstance(now, (int, float)) or isinstance(now, bool):
                raise CoreError("sensing:tick payload.now 必须是时间戳")
            self.state["tickCount"] = int(self.state.get("tickCount", 0)) + 1
            self.state["lastTickAt"] = int(now)
        elif self.memory:
            # 高频感知节拍不进入日记来源；其余明确输入事件可被日后审计与引用。
            normalized["occurredAt"] = normalized["occurredAt"] or datetime.now(timezone.utc).isoformat()
            self.memory.record_event(normalized)
        self._write_state()
        return {"accepted": True, "state": self.snapshot()}

    def pet_get_state(self, now: int) -> dict[str, Any]:
        return pet_state.evolve(self.state.get("petState"), now)

    def pet_apply_event(self, event_type: str, now: int) -> dict[str, Any]:
        if self.data_dir is None: raise CoreError("Core 尚未 bootstrap")
        if not isinstance(event_type, str) or not event_type: raise CoreError("eventType 不合法")
        if not isinstance(now, (int, float)) or isinstance(now, bool): raise CoreError("now 必须是时间戳")
        next_state, upgrade = pet_state.apply(self.state.get("petState"), event_type, int(now))
        self.state["petState"] = next_state
        self.state["emotionState"] = emotion_state.apply(self.state.get("emotionState"), event_type, int(now))
        if self.memory:
            self.memory.record_event({"type": event_type, "occurredAt": self._iso_from_ms(int(now)), "source": "core.pet", "privacy": "local-only", "payload": {}})
        self._write_state()
        return {"state": next_state, "stageUp": upgrade}

    def pet_seed_if_empty(self, state: Any) -> dict[str, Any]:
        if self.data_dir is None: raise CoreError("Core 尚未 bootstrap")
        if not self.state.get("petStateImported"):
            self.state["petState"] = pet_state.normalize(state)
            self.state["petStateImported"] = True
            self._write_state()
            return {"seeded": True, "state": self.state["petState"]}
        return {"seeded": False, "state": self.state["petState"]}

    def life_get_state(self, now: Any) -> dict[str, Any]:
        self._validate_now(now)
        next_state = life_state.advance(self.state.get("lifeState"), int(now))
        self.state["lifeState"] = next_state; self._write_state()
        return next_state

    def life_advance(self, now: Any) -> dict[str, Any]:
        return self.life_get_state(now)

    def life_perform_activity(self, activity_id: Any, now: Any) -> dict[str, Any]:
        self._validate_now(now)
        if not isinstance(activity_id, str) or not activity_id: raise CoreError("activityId 不合法")
        try: next_state = life_state.perform(self.state.get("lifeState"), activity_id, int(now))
        except ValueError as error: raise CoreError(str(error)) from error
        self.state["lifeState"] = next_state
        self.state["emotionState"] = emotion_state.apply(self.state.get("emotionState"), f"life:activity:{activity_id}", int(now))
        self._write_state()
        return next_state

    def emotion_get_state(self, now: Any) -> dict[str, Any]:
        self._validate_now(now)
        self.state["emotionState"] = emotion_state.evolve(self.state.get("emotionState"), int(now))
        self._write_state()
        return self.state["emotionState"]

    def memory_add_episode(self, messages: Any, created_at: Any) -> bool:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        if not isinstance(messages, list) or not isinstance(created_at, str): raise CoreError("episode 参数不合法")
        try: return self.memory.add_episode(messages, created_at)
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_search(self, query: Any) -> list[dict[str, Any]]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        if not isinstance(query, str): raise CoreError("query 必须是字符串")
        return self.memory.search(query)

    def memory_import_messages(self, messages: Any) -> int:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        try: return self.memory.import_messages(messages)
        except (TypeError, ValueError) as error: raise CoreError(str(error)) from error

    def memory_list(self, kind: Any, limit: Any = 30) -> list[dict[str, Any]]:
        if not self.memory or not isinstance(kind, str): raise CoreError("记忆列表参数不合法")
        methods = {
            "episodes": self.memory.list_episodes,
            "messages": self.memory.list_messages,
            "vectors": self.memory.list_vectors,
            "facts": self.memory.list_facts,
            "profiles": self.memory.list_profiles,
            "edges": self.memory.list_edges,
            "events": self.memory.list_events,
        }
        handler = methods.get(kind)
        if not handler: raise CoreError("未知记忆类别")
        return handler(limit)

    def memory_graph(self, limit: Any = 50) -> dict[str, list[dict[str, Any]]]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        return self.memory.graph_snapshot(limit)

    def mind_record_thought(self, thought: Any) -> dict[str, Any]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        try: return self.memory.record_thought(thought)
        except (TypeError, ValueError) as error: raise CoreError(str(error)) from error

    def mind_record_dream(self, dream: Any) -> dict[str, Any]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        try: return self.memory.record_dream(dream)
        except (TypeError, ValueError) as error: raise CoreError(str(error)) from error

    def mind_record_reflection(self, reflection: Any) -> dict[str, Any]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        try: return self.memory.record_reflection(reflection)
        except (TypeError, ValueError) as error: raise CoreError(str(error)) from error

    def mind_list(self, kind: Any, limit: Any = 30) -> list[dict[str, Any]]:
        if not self.memory or not isinstance(kind, str): raise CoreError("内心活动查询参数不合法")
        try: return self.memory.list_mind(kind, limit)
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_forget_source(self, source_id: Any) -> int:
        if not self.memory or not isinstance(source_id, str) or not source_id: raise CoreError("sourceId 不合法")
        return self.memory.delete_by_source(source_id)

    def memory_upsert_fact(self, fact: Any) -> dict[str, Any]:
        if not self.memory or not isinstance(fact, dict): raise CoreError("fact 必须是对象")
        try: return self.memory.upsert_fact(fact)
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_find_facts(self, query: Any = "", subject_id: Any = None, limit: Any = 8) -> list[dict[str, Any]]:
        if not self.memory or not isinstance(query, str) or (subject_id is not None and not isinstance(subject_id, str)): raise CoreError("事实查询参数不合法")
        try: return self.memory.find_facts(query, subject_id, limit)
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_upsert_profile(self, profile: Any) -> dict[str, Any]:
        if not self.memory or not isinstance(profile, dict): raise CoreError("profile 必须是对象")
        try: return self.memory.upsert_profile(profile, datetime.now(timezone.utc).isoformat())
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_get_profile(self, profile_id: Any) -> dict[str, Any] | None:
        if not self.memory or not isinstance(profile_id, str) or not profile_id: raise CoreError("profileId 不合法")
        return self.memory.get_profile(profile_id)

    def memory_upsert_edge(self, edge: Any) -> dict[str, Any]:
        if not self.memory or not isinstance(edge, dict): raise CoreError("edge 必须是对象")
        try: return self.memory.upsert_edge(edge)
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_neighbors(self, entity_id: Any, limit: Any = 8) -> list[dict[str, Any]]:
        if not self.memory or not isinstance(entity_id, str): raise CoreError("entityId 不合法")
        try: return self.memory.neighbors(entity_id, limit)
        except ValueError as error: raise CoreError(str(error)) from error

    def memory_stats(self) -> dict[str, int]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        return self.memory.stats()

    def journal_build_daily_material(self, day: Any, timezone_offset_minutes: Any = 0) -> dict[str, Any]:
        if not self.memory or not isinstance(day, str): raise CoreError("日记日期不合法")
        try: return self.memory.build_daily_material(day, timezone_offset_minutes, self.state.get("lifeState", {}).get("recentActivities", []), datetime.now(timezone.utc).isoformat())
        except ValueError as error: raise CoreError(str(error)) from error

    def journal_get_daily_material(self, day: Any) -> dict[str, Any] | None:
        if not self.memory or not isinstance(day, str): raise CoreError("日记日期不合法")
        try: return self.memory.get_daily_material(day)
        except ValueError as error: raise CoreError(str(error)) from error

    def journal_list_daily(self, limit: Any = 50) -> list[dict[str, Any]]:
        if not self.memory: raise CoreError("Core 尚未 bootstrap")
        return self.memory.list_daily_journals(limit)

    def journal_save_daily_prose(self, day: Any, prose: Any, reflection: Any = None) -> dict[str, Any]:
        if not self.memory or not isinstance(day, str): raise CoreError("日记日期不合法")
        try: return self.memory.save_daily_prose(day, prose, reflection)
        except ValueError as error: raise CoreError(str(error)) from error

    def journal_build_weekly_material(self, day: Any, timezone_offset_minutes: Any = 0) -> dict[str, Any]:
        if not self.memory or not isinstance(day, str): raise CoreError("周记日期不合法")
        try: return self.memory.build_weekly_material(day, timezone_offset_minutes, self.state.get("lifeState", {}).get("recentActivities", []), datetime.now(timezone.utc).isoformat())
        except ValueError as error: raise CoreError(str(error)) from error

    def journal_get_weekly_material(self, day: Any) -> dict[str, Any] | None:
        if not self.memory or not isinstance(day, str): raise CoreError("周记日期不合法")
        try: return self.memory.get_weekly_material(day)
        except ValueError as error: raise CoreError(str(error)) from error

    def journal_save_weekly_prose(self, day: Any, prose: Any, reflection: Any = None) -> dict[str, Any]:
        if not self.memory or not isinstance(day, str): raise CoreError("周记日期不合法")
        try: return self.memory.save_weekly_prose(day, prose, reflection)
        except ValueError as error: raise CoreError(str(error)) from error

    def snapshot(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.state.get("schemaVersion", SCHEMA_VERSION),
            "tickCount": self.state.get("tickCount", 0),
            "lastTickAt": self.state.get("lastTickAt"),
            "recentEventCount": len(self.state.get("recentEvents", [])),
        }

    def _read_state(self) -> dict[str, Any]:
        if self.data_dir is None:
            return self._default_state()
        state_file = self.data_dir / STATE_FILE
        try:
            parsed = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return self._default_state()
        if not _is_object(parsed) or parsed.get("schemaVersion") != SCHEMA_VERSION:
            return self._default_state()
        merged = self._default_state()
        merged.update(parsed)
        if not isinstance(merged.get("recentEvents"), list):
            merged["recentEvents"] = []
        return merged

    def _write_state(self) -> None:
        if self.data_dir is None:
            raise CoreError("Core 尚未 bootstrap")
        state_file = self.data_dir / STATE_FILE
        temp_file = state_file.with_suffix(".tmp")
        temp_file.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_file.replace(state_file)

    @staticmethod
    def _validate_now(now: Any) -> None:
        if not isinstance(now, (int, float)) or isinstance(now, bool): raise CoreError("now 必须是时间戳")

    @staticmethod
    def _iso_from_ms(value: int) -> str:
        return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat().replace("+00:00", "Z")

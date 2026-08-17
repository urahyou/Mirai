"""本地分层记忆 SQLite 仓储。只用标准库，不依赖图数据库或向量服务。"""
from __future__ import annotations
import json, sqlite3, uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

class MemoryStore:
    def __init__(self, file: Path) -> None:
        self.db = sqlite3.connect(file)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, predicate TEXT NOT NULL, object_text TEXT NOT NULL, confidence REAL NOT NULL, importance REAL NOT NULL, valid_from TEXT, valid_to TEXT, source_id TEXT REFERENCES episodes(id), state TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, role TEXT NOT NULL, core_json TEXT NOT NULL DEFAULT '{}', learned_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY, from_id TEXT NOT NULL, predicate TEXT NOT NULL, to_id TEXT NOT NULL, source_id TEXT REFERENCES episodes(id), valid_from TEXT, valid_to TEXT, state TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, type TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL, privacy TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS daily_journals(date TEXT PRIMARY KEY, timezone_offset_minutes INTEGER NOT NULL, material_json TEXT NOT NULL, source_ids_json TEXT NOT NULL, prose TEXT, reflection TEXT, built_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS weekly_journals(week_start TEXT PRIMARY KEY, timezone_offset_minutes INTEGER NOT NULL, material_json TEXT NOT NULL, source_ids_json TEXT NOT NULL, prose TEXT, reflection TEXT, built_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS episode_created ON episodes(created_at DESC);
        CREATE INDEX IF NOT EXISTS event_occurred ON events(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS fact_subject ON facts(subject_id, predicate, state);
        CREATE INDEX IF NOT EXISTS edge_from ON edges(from_id, state);
        """)
        self.db.commit()

    def record_event(self, event: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(event, dict): raise ValueError("事件必须是对象")
        event_type = self._required_text(event.get("type"), "事件缺少 type", 120)
        occurred_at = self._required_text(event.get("occurredAt"), "事件缺少 occurredAt", 64)
        self._parse_time(occurred_at)
        payload = event.get("payload", {})
        if not isinstance(payload, dict): raise ValueError("事件 payload 必须是对象")
        try: payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as error: raise ValueError("事件 payload 无法保存") from error
        ident = "event:" + uuid.uuid4().hex
        self.db.execute("INSERT INTO events VALUES(?,?,?,?,?,?)", (ident, event_type, occurred_at, str(event.get("source", "unknown"))[:80], str(event.get("privacy", "local-only"))[:40], payload_json))
        self.db.commit()
        return {"id": ident}

    def add_episode(self, messages: list[dict[str, Any]], created_at: str) -> bool:
        self._parse_time(self._required_text(created_at, "episode 时间不合法", 64))
        rows = []
        for item in messages[:20]:
            if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"): continue
            text = str(item.get("content", "")).strip()[:4000]
            if text: rows.append(("主人" if item["role"] == "user" else "小未来") + "：" + text)
        if not rows: return False
        self.db.execute("INSERT INTO episodes VALUES(?,?,?,?)", ("episode:" + uuid.uuid4().hex, created_at, "\n".join(rows), "chat"))
        self.db.commit(); return True

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        terms = [term for term in query.strip().split() if term][:5]
        if not query.strip(): return []
        clause = " AND ".join("content LIKE ?" for _ in terms) if terms else "content LIKE ?"
        values = [f"%{term}%" for term in terms] if terms else [f"%{query.strip()}%"]
        rows = self.db.execute(f"SELECT id, content, created_at FROM episodes WHERE {clause} ORDER BY created_at DESC LIMIT ?", (*values, limit)).fetchall()
        return [{"id": row["id"], "content": row["content"], "created_at": row["created_at"]} for row in rows]

    def upsert_fact(self, fact: dict[str, Any]) -> dict[str, Any]:
        required = ("subjectId", "predicate", "objectText")
        if not isinstance(fact, dict) or any(not isinstance(fact.get(k), str) or not fact[k].strip() for k in required): raise ValueError("事实缺少主体、关系或内容")
        ident = fact.get("id") if isinstance(fact.get("id"), str) else "fact:" + uuid.uuid4().hex
        source_id = self._source_id(fact.get("sourceId"))
        values = (ident, fact["subjectId"].strip()[:120], fact["predicate"].strip()[:120], fact["objectText"].strip()[:2000], self._score(fact.get("confidence"), .7), self._score(fact.get("importance"), .5), self._optional_text(fact.get("validFrom"), 64), self._optional_text(fact.get("validTo"), 64), source_id, self._state(fact.get("state")))
        self.db.execute("""INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET subject_id=excluded.subject_id, predicate=excluded.predicate,
            object_text=excluded.object_text, confidence=excluded.confidence, importance=excluded.importance,
            valid_from=excluded.valid_from, valid_to=excluded.valid_to, source_id=excluded.source_id, state=excluded.state""", values)
        self.db.commit()
        return {"id": ident}

    def find_facts(self, query: str = "", subject_id: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
        limit = self._limit(limit)
        where, values = ["state='active'"], []
        if subject_id:
            where.append("subject_id=?"); values.append(str(subject_id)[:120])
        if query.strip():
            where.append("(subject_id LIKE ? OR predicate LIKE ? OR object_text LIKE ?)")
            needle = f"%{query.strip()[:500]}%"; values.extend((needle, needle, needle))
        rows = self.db.execute(f"SELECT id, subject_id, predicate, object_text, confidence, importance, valid_from, valid_to, source_id, state FROM facts WHERE {' AND '.join(where)} ORDER BY importance DESC, confidence DESC, id ASC LIMIT ?", (*values, limit)).fetchall()
        return [self._fact_row(row) for row in rows]

    def upsert_profile(self, profile: dict[str, Any], updated_at: str) -> dict[str, Any]:
        if not isinstance(profile, dict): raise ValueError("画像必须是对象")
        ident = self._required_text(profile.get("id"), "画像缺少 id", 120)
        role = self._required_text(profile.get("role"), "画像缺少 role", 80)
        core = profile.get("core", {})
        learned = profile.get("learned", {})
        if not isinstance(core, dict) or not isinstance(learned, dict): raise ValueError("画像层必须是对象")
        self.db.execute("""INSERT INTO profiles VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET role=excluded.role, core_json=excluded.core_json,
            learned_json=excluded.learned_json, updated_at=excluded.updated_at""",
            (ident, role, json.dumps(core, ensure_ascii=False), json.dumps(learned, ensure_ascii=False), updated_at))
        self.db.commit()
        return self.get_profile(ident) or {}

    def get_profile(self, ident: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT id, role, core_json, learned_json, updated_at FROM profiles WHERE id=?", (str(ident)[:120],)).fetchone()
        if not row: return None
        return {"id": row["id"], "role": row["role"], "core": json.loads(row["core_json"]), "learned": json.loads(row["learned_json"]), "updatedAt": row["updated_at"]}

    def upsert_edge(self, edge: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(edge, dict): raise ValueError("关系边必须是对象")
        ident = edge.get("id") if isinstance(edge.get("id"), str) and edge["id"].strip() else "edge:" + uuid.uuid4().hex
        from_id = self._required_text(edge.get("fromId"), "关系边缺少起点", 120)
        predicate = self._required_text(edge.get("predicate"), "关系边缺少关系", 120)
        to_id = self._required_text(edge.get("toId"), "关系边缺少终点", 120)
        values = (ident[:120], from_id, predicate, to_id, self._source_id(edge.get("sourceId")), self._optional_text(edge.get("validFrom"), 64), self._optional_text(edge.get("validTo"), 64), self._state(edge.get("state")))
        self.db.execute("""INSERT INTO edges VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET from_id=excluded.from_id, predicate=excluded.predicate,
            to_id=excluded.to_id, source_id=excluded.source_id, valid_from=excluded.valid_from,
            valid_to=excluded.valid_to, state=excluded.state""", values)
        self.db.commit()
        return {"id": values[0]}

    def neighbors(self, entity_id: str, limit: int = 8) -> list[dict[str, Any]]:
        ident = self._required_text(entity_id, "实体 id 不合法", 120)
        rows = self.db.execute("SELECT id, from_id, predicate, to_id, source_id, valid_from, valid_to, state FROM edges WHERE state='active' AND (from_id=? OR to_id=?) ORDER BY id ASC LIMIT ?", (ident, ident, self._limit(limit))).fetchall()
        return [{"id": row["id"], "fromId": row["from_id"], "predicate": row["predicate"], "toId": row["to_id"], "sourceId": row["source_id"], "validFrom": row["valid_from"], "validTo": row["valid_to"], "state": row["state"]} for row in rows]

    def delete_by_source(self, source_id: str) -> int:
        with self.db:
            count = self.db.execute("DELETE FROM facts WHERE source_id=?", (source_id,)).rowcount
            count += self.db.execute("DELETE FROM edges WHERE source_id=?", (source_id,)).rowcount
            count += self.db.execute("DELETE FROM episodes WHERE id=?", (source_id,)).rowcount
            count += self.db.execute("DELETE FROM events WHERE id=?", (source_id,)).rowcount
            # 素材快照可随时由尚存来源重建；删除它们不会删除原始记忆。
            if count:
                count += self.db.execute("DELETE FROM daily_journals").rowcount
                count += self.db.execute("DELETE FROM weekly_journals").rowcount
        return count

    def build_daily_material(self, day_text: str, timezone_offset_minutes: Any, activities: Any, built_at: str) -> dict[str, Any]:
        day = self._parse_day(day_text)
        offset = self._timezone_offset(timezone_offset_minutes)
        tz = timezone(timedelta(minutes=offset))
        chat_sources = self._episodes_for_day(day, tz)
        event_sources = self._events_for_day(day, tz)
        activity_sources = self._activities_for_day(activities, day, tz)
        material = {
            "schemaVersion": 1,
            "date": day.isoformat(),
            "timezoneOffsetMinutes": offset,
            "constraints": ["仅包含已保存的聊天、明确事件和已完成的虚拟活动", "这是一份事实素材，不是小未来自动生成的日记正文"],
            "sources": {"episodes": chat_sources, "events": event_sources, "activities": activity_sources},
            "facts": {
                "chatCount": len(chat_sources),
                "eventTypes": self._counts(event_sources, "type"),
                "activityTypes": self._counts(activity_sources, "activityId"),
            },
        }
        source_ids = [row["sourceId"] for group in material["sources"].values() for row in group]
        self._upsert_journal("daily_journals", "date", day.isoformat(), offset, material, source_ids, built_at)
        return material

    def get_daily_material(self, day_text: str) -> dict[str, Any] | None:
        return self._get_journal("daily_journals", "date", self._parse_day(day_text).isoformat())

    def build_weekly_material(self, day_text: str, timezone_offset_minutes: Any, activities: Any, built_at: str) -> dict[str, Any]:
        day = self._parse_day(day_text)
        week_start = day - timedelta(days=day.weekday())
        days = [self.build_daily_material((week_start + timedelta(days=index)).isoformat(), timezone_offset_minutes, activities, built_at) for index in range(7)]
        sources = {"episodes": [], "events": [], "activities": []}
        for daily in days:
            for kind, rows in daily["sources"].items(): sources[kind].extend(rows)
        material = {
            "schemaVersion": 1,
            "weekStart": week_start.isoformat(),
            "weekEnd": (week_start + timedelta(days=6)).isoformat(),
            "timezoneOffsetMinutes": self._timezone_offset(timezone_offset_minutes),
            "constraints": ["周素材由每日事实素材汇总而成", "不得据此编造未记录的经历"],
            "dailyDates": [item["date"] for item in days],
            "sources": sources,
            "facts": {"chatCount": len(sources["episodes"]), "eventTypes": self._counts(sources["events"], "type"), "activityTypes": self._counts(sources["activities"], "activityId")},
        }
        source_ids = [row["sourceId"] for group in sources.values() for row in group]
        self._upsert_journal("weekly_journals", "week_start", week_start.isoformat(), material["timezoneOffsetMinutes"], material, source_ids, built_at)
        return material

    def get_weekly_material(self, day_text: str) -> dict[str, Any] | None:
        day = self._parse_day(day_text)
        return self._get_journal("weekly_journals", "week_start", (day - timedelta(days=day.weekday())).isoformat())

    def stats(self) -> dict[str, int]:
        def count(table: str) -> int:
            return int(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        return {"episodes": count("episodes"), "facts": count("facts"), "profiles": count("profiles"), "edges": count("edges"), "events": count("events"), "dailyJournals": count("daily_journals"), "weeklyJournals": count("weekly_journals")}

    def close(self) -> None: self.db.close()

    def _episodes_for_day(self, day: date, tz: timezone) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, content, created_at FROM episodes ORDER BY created_at ASC").fetchall()
        result = []
        for row in rows:
            if self._parse_time(row["created_at"]).astimezone(tz).date() == day:
                result.append({"sourceId": row["id"], "createdAt": row["created_at"], "excerpt": row["content"][:1200]})
        return result

    def _events_for_day(self, day: date, tz: timezone) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, type, occurred_at, source FROM events ORDER BY occurred_at ASC").fetchall()
        result = []
        for row in rows:
            if self._parse_time(row["occurred_at"]).astimezone(tz).date() == day:
                result.append({"sourceId": row["id"], "type": row["type"], "occurredAt": row["occurred_at"], "source": row["source"]})
        return result

    def _activities_for_day(self, activities: Any, day: date, tz: timezone) -> list[dict[str, Any]]:
        result = []
        if not isinstance(activities, list): return result
        for index, activity in enumerate(activities):
            if not isinstance(activity, dict): continue
            completed = activity.get("completedAt")
            if not isinstance(completed, (int, float)) or isinstance(completed, bool): continue
            occurred = datetime.fromtimestamp(completed / 1000, timezone.utc)
            if occurred.astimezone(tz).date() != day: continue
            activity_id = activity.get("activityId")
            if not isinstance(activity_id, str) or not activity_id: continue
            source_id = activity.get("id") if isinstance(activity.get("id"), str) and activity["id"] else f"activity:legacy:{int(completed)}:{index}"
            result.append({"sourceId": source_id, "activityId": activity_id, "completedAt": int(completed), "durationMinutes": int(activity.get("durationMinutes", 0) or 0), "tags": list(activity.get("tags", []))[:8] if isinstance(activity.get("tags"), list) else []})
        return result

    def _upsert_journal(self, table: str, key: str, value: str, offset: int, material: dict[str, Any], source_ids: list[str], built_at: str) -> None:
        previous = self.db.execute(f"SELECT prose, reflection FROM {table} WHERE {key}=?", (value,)).fetchone()
        prose = previous["prose"] if previous else None
        reflection = previous["reflection"] if previous else None
        self.db.execute(f"INSERT INTO {table}({key}, timezone_offset_minutes, material_json, source_ids_json, prose, reflection, built_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT({key}) DO UPDATE SET timezone_offset_minutes=excluded.timezone_offset_minutes, material_json=excluded.material_json, source_ids_json=excluded.source_ids_json, prose=excluded.prose, reflection=excluded.reflection, built_at=excluded.built_at", (value, offset, json.dumps(material, ensure_ascii=False), json.dumps(source_ids, ensure_ascii=False), prose, reflection, built_at))
        self.db.commit()

    def _get_journal(self, table: str, key: str, value: str) -> dict[str, Any] | None:
        row = self.db.execute(f"SELECT material_json, source_ids_json, prose, reflection, built_at FROM {table} WHERE {key}=?", (value,)).fetchone()
        if not row: return None
        material = json.loads(row["material_json"])
        return {"material": material, "sourceIds": json.loads(row["source_ids_json"]), "prose": row["prose"], "reflection": row["reflection"], "builtAt": row["built_at"]}

    @staticmethod
    def _counts(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in rows:
            value = row.get(key)
            if isinstance(value, str) and value: counts[value] = counts.get(value, 0) + 1
        return counts

    @staticmethod
    def _parse_day(value: Any) -> date:
        if not isinstance(value, str): raise ValueError("日期必须是 YYYY-MM-DD")
        try: return date.fromisoformat(value)
        except ValueError as error: raise ValueError("日期必须是 YYYY-MM-DD") from error

    @staticmethod
    def _parse_time(value: str) -> datetime:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
        except ValueError as error: raise ValueError("时间必须是 ISO 8601") from error

    @staticmethod
    def _timezone_offset(value: Any) -> int:
        if value is None: return 0
        try: offset = int(value)
        except (TypeError, ValueError) as error: raise ValueError("时区偏移必须是分钟数") from error
        if not -14 * 60 <= offset <= 14 * 60: raise ValueError("时区偏移超出范围")
        return offset

    def _source_id(self, value: Any) -> str | None:
        if value is None: return None
        source_id = self._required_text(value, "sourceId 不合法", 120)
        if not self.db.execute("SELECT 1 FROM episodes WHERE id=?", (source_id,)).fetchone(): raise ValueError("sourceId 不存在")
        return source_id

    @staticmethod
    def _required_text(value: Any, message: str, maximum: int) -> str:
        if not isinstance(value, str) or not value.strip(): raise ValueError(message)
        return value.strip()[:maximum]

    @staticmethod
    def _optional_text(value: Any, maximum: int) -> str | None:
        return value.strip()[:maximum] if isinstance(value, str) and value.strip() else None

    @staticmethod
    def _score(value: Any, default: float) -> float:
        try: return max(0.0, min(1.0, float(default if value is None else value)))
        except (TypeError, ValueError): raise ValueError("置信度和重要性必须是数字")

    @staticmethod
    def _state(value: Any) -> str:
        state = value if isinstance(value, str) else "active"
        if state not in ("active", "archived", "forgotten", "invalidated"): raise ValueError("记忆状态不合法")
        return state

    @staticmethod
    def _limit(value: Any) -> int:
        try: return max(1, min(50, int(value)))
        except (TypeError, ValueError): return 8

    @staticmethod
    def _fact_row(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "subjectId": row["subject_id"], "predicate": row["predicate"], "objectText": row["object_text"], "confidence": row["confidence"], "importance": row["importance"], "validFrom": row["valid_from"], "validTo": row["valid_to"], "sourceId": row["source_id"], "state": row["state"]}

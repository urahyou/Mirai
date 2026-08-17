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
        CREATE TABLE IF NOT EXISTS conversation_messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, created_at TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS thoughts(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, emotion_json TEXT NOT NULL DEFAULT '{}', source_ids_json TEXT NOT NULL DEFAULT '[]', certainty REAL NOT NULL, expires_at TEXT, state TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE IF NOT EXISTS dreams(id TEXT PRIMARY KEY, dream_date TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL, emotion_json TEXT NOT NULL DEFAULT '{}', source_ids_json TEXT NOT NULL DEFAULT '[]', is_fiction INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE IF NOT EXISTS reflections(id TEXT PRIMARY KEY, period_start TEXT NOT NULL, period_end TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, source_ids_json TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
        CREATE TABLE IF NOT EXISTS memory_vectors(id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL, content TEXT NOT NULL, vector_json TEXT NOT NULL, source_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');
        CREATE INDEX IF NOT EXISTS episode_created ON episodes(created_at DESC);
        CREATE INDEX IF NOT EXISTS event_occurred ON events(occurred_at DESC);
        CREATE INDEX IF NOT EXISTS fact_subject ON facts(subject_id, predicate, state);
        CREATE INDEX IF NOT EXISTS edge_from ON edges(from_id, state);
        CREATE INDEX IF NOT EXISTS message_conversation ON conversation_messages(conversation_id, sequence_no);
        CREATE INDEX IF NOT EXISTS thought_created ON thoughts(created_at DESC);
        CREATE INDEX IF NOT EXISTS dream_date ON dreams(dream_date DESC);
        CREATE INDEX IF NOT EXISTS reflection_period ON reflections(period_end DESC);
        CREATE INDEX IF NOT EXISTS vector_created ON memory_vectors(created_at DESC);
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
        episode_id = "episode:" + uuid.uuid4().hex
        self.db.execute("INSERT INTO episodes VALUES(?,?,?,?)", (episode_id, created_at, "\n".join(rows), "chat"))
        for sequence_no, item in enumerate(messages[:20]):
            if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"): continue
            content = str(item.get("content", "")).strip()[:4000]
            if not content: continue
            self.db.execute("INSERT INTO conversation_messages VALUES(?,?,?,?,?,?,?)", ("message:" + uuid.uuid4().hex, episode_id, sequence_no, created_at, item["role"], content, "chat"))
        self.db.commit(); return True

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        terms = [term for term in query.strip().split() if term][:5]
        if not query.strip(): return []
        clause = " AND ".join("content LIKE ?" for _ in terms) if terms else "content LIKE ?"
        values = [f"%{term}%" for term in terms] if terms else [f"%{query.strip()}%"]
        rows = self.db.execute(f"SELECT id, content, created_at FROM episodes WHERE {clause} ORDER BY created_at DESC LIMIT ?", (*values, limit)).fetchall()
        return [{"id": row["id"], "content": row["content"], "created_at": row["created_at"]} for row in rows]

    def list_episodes(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, content, created_at, source FROM episodes ORDER BY created_at DESC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"id": row["id"], "content": row["content"], "createdAt": row["created_at"], "source": row["source"]} for row in rows]

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

    def list_facts(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, subject_id, predicate, object_text, confidence, importance, valid_from, valid_to, source_id, state FROM facts ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, importance DESC, confidence DESC, id ASC LIMIT ?", (self._limit(limit),)).fetchall()
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

    def list_profiles(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, role, core_json, learned_json, updated_at FROM profiles ORDER BY updated_at DESC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"id": row["id"], "role": row["role"], "core": json.loads(row["core_json"]), "learned": json.loads(row["learned_json"]), "updatedAt": row["updated_at"]} for row in rows]

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

    def list_edges(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, from_id, predicate, to_id, source_id, valid_from, valid_to, state FROM edges ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, id ASC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"id": row["id"], "fromId": row["from_id"], "predicate": row["predicate"], "toId": row["to_id"], "sourceId": row["source_id"], "validFrom": row["valid_from"], "validTo": row["valid_to"], "state": row["state"]} for row in rows]

    def graph_snapshot(self, limit: Any = 50) -> dict[str, list[dict[str, Any]]]:
        edges = [edge for edge in self.list_edges(limit) if edge["state"] == "active"]
        nodes: dict[str, dict[str, Any]] = {}
        for edge in edges:
            for ident in (edge["fromId"], edge["toId"]):
                if ident not in nodes:
                    nodes[ident] = {"id": ident, "kind": self._entity_kind(ident), "degree": 0}
                nodes[ident]["degree"] += 1
        return {"nodes": sorted(nodes.values(), key=lambda node: (-node["degree"], node["id"])), "edges": edges}

    def list_events(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, type, occurred_at, source, privacy, payload_json FROM events ORDER BY occurred_at DESC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"id": row["id"], "type": row["type"], "occurredAt": row["occurred_at"], "source": row["source"], "privacy": row["privacy"], "payload": json.loads(row["payload_json"])} for row in rows]

    def list_messages(self, limit: Any = 100) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, conversation_id, sequence_no, created_at, role, content, source FROM conversation_messages ORDER BY created_at DESC, sequence_no DESC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"id": row["id"], "conversationId": row["conversation_id"], "sequence": row["sequence_no"], "createdAt": row["created_at"], "role": row["role"], "content": row["content"], "source": row["source"]} for row in rows]

    def import_messages(self, messages: Any) -> int:
        if not isinstance(messages, list): raise ValueError("聊天记录必须是数组")
        inserted = 0
        for sequence_no, item in enumerate(messages[:10000]):
            if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"): continue
            raw_id = item.get("id")
            if not isinstance(raw_id, str) or not raw_id.strip(): continue
            created_at = self._required_text(item.get("createdAt"), "聊天记录缺少时间", 64); self._parse_time(created_at)
            content = self._required_text(item.get("content"), "聊天记录内容不能为空", 4000)
            cursor = self.db.execute("INSERT OR IGNORE INTO conversation_messages VALUES(?,?,?,?,?,?,?)", ("message:history:" + raw_id[:80], "conversation:chat-history", sequence_no, created_at, item["role"], content, "chat-history"))
            inserted += max(0, cursor.rowcount)
        self.db.commit(); return inserted

    def record_thought(self, thought: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(thought, dict): raise ValueError("内心活动必须是对象")
        ident = thought.get("id") if isinstance(thought.get("id"), str) and thought["id"].strip() else "thought:" + uuid.uuid4().hex
        created_at = self._required_text(thought.get("createdAt"), "内心活动缺少时间", 64); self._parse_time(created_at)
        content = self._required_text(thought.get("content"), "内心活动不能为空", 2000)
        sources = self._source_ids(thought.get("sourceIds", []))
        emotion = thought.get("emotion", {})
        if not isinstance(emotion, dict): raise ValueError("内心活动情绪必须是对象")
        self.db.execute("INSERT OR REPLACE INTO thoughts VALUES(?,?,?,?,?,?,?,?,?)", (ident[:120], created_at, str(thought.get("kind", "reflection"))[:80], content, json.dumps(emotion, ensure_ascii=False), json.dumps(sources, ensure_ascii=False), self._score(thought.get("certainty"), .5), self._optional_text(thought.get("expiresAt"), 64), self._state(thought.get("state"))))
        self.db.commit(); return self.get_thought(ident) or {}

    def record_dream(self, dream: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(dream, dict): raise ValueError("梦境必须是对象")
        ident = dream.get("id") if isinstance(dream.get("id"), str) and dream["id"].strip() else "dream:" + uuid.uuid4().hex
        dream_date = self._parse_day(dream.get("dreamDate")).isoformat(); created_at = self._required_text(dream.get("createdAt"), "梦境缺少时间", 64); self._parse_time(created_at)
        content = self._required_text(dream.get("content"), "梦境不能为空", 3000)
        emotion = dream.get("emotion", {})
        if not isinstance(emotion, dict): raise ValueError("梦境情绪必须是对象")
        self.db.execute("INSERT OR REPLACE INTO dreams VALUES(?,?,?,?,?,?,?,?)", (ident[:120], dream_date, created_at, content, json.dumps(emotion, ensure_ascii=False), json.dumps(self._source_ids(dream.get("sourceIds", [])), ensure_ascii=False), 1, self._state(dream.get("state"))))
        self.db.commit(); return self.get_dream(ident) or {}

    def record_reflection(self, reflection: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(reflection, dict): raise ValueError("反思必须是对象")
        ident = reflection.get("id") if isinstance(reflection.get("id"), str) and reflection["id"].strip() else "reflection:" + uuid.uuid4().hex
        start = self._parse_day(reflection.get("periodStart")).isoformat(); end = self._parse_day(reflection.get("periodEnd")).isoformat()
        created_at = self._required_text(reflection.get("createdAt"), "反思缺少时间", 64); self._parse_time(created_at)
        content = self._required_text(reflection.get("content"), "反思不能为空", 3000)
        self.db.execute("INSERT OR REPLACE INTO reflections VALUES(?,?,?,?,?,?,?,?,?)", (ident[:120], start, end, str(reflection.get("kind", "daily"))[:80], content, json.dumps(self._source_ids(reflection.get("sourceIds", [])), ensure_ascii=False), self._score(reflection.get("confidence"), .5), created_at, self._state(reflection.get("state"))))
        self.db.commit(); return self.get_reflection(ident) or {}

    def get_thought(self, ident: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM thoughts WHERE id=?", (ident,)).fetchone()
        return self._thought_row(row) if row else None

    def get_dream(self, ident: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM dreams WHERE id=?", (ident,)).fetchone()
        return self._dream_row(row) if row else None

    def get_reflection(self, ident: str) -> dict[str, Any] | None:
        row = self.db.execute("SELECT * FROM reflections WHERE id=?", (ident,)).fetchone()
        return self._reflection_row(row) if row else None

    def list_mind(self, kind: str, limit: Any = 30) -> list[dict[str, Any]]:
        if kind == "thoughts":
            rows = self.db.execute("SELECT * FROM thoughts ORDER BY created_at DESC LIMIT ?", (self._limit(limit),)).fetchall(); return [self._thought_row(row) for row in rows]
        if kind == "dreams":
            rows = self.db.execute("SELECT * FROM dreams ORDER BY dream_date DESC, created_at DESC LIMIT ?", (self._limit(limit),)).fetchall(); return [self._dream_row(row) for row in rows]
        if kind == "reflections":
            rows = self.db.execute("SELECT * FROM reflections ORDER BY period_end DESC, created_at DESC LIMIT ?", (self._limit(limit),)).fetchall(); return [self._reflection_row(row) for row in rows]
        raise ValueError("未知内心活动类别")

    def list_vectors(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT id, chunk_id, model, dimensions, content, source_ids_json, created_at, state FROM memory_vectors ORDER BY created_at DESC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"id": row["id"], "chunkId": row["chunk_id"], "model": row["model"], "dimensions": row["dimensions"], "content": row["content"], "sourceIds": json.loads(row["source_ids_json"]), "createdAt": row["created_at"], "state": row["state"]} for row in rows]

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

    def list_daily_journals(self, limit: Any = 50) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT date, prose, reflection, source_ids_json, built_at FROM daily_journals ORDER BY date DESC LIMIT ?", (self._limit(limit),)).fetchall()
        return [{"date": row["date"], "exists": bool(row["prose"]), "excerpt": (row["prose"] or "").replace("\n", " ")[:100], "reflection": row["reflection"], "sourceCount": len(json.loads(row["source_ids_json"])), "builtAt": row["built_at"]} for row in rows]

    def save_daily_prose(self, day_text: str, prose: Any, reflection: Any = None) -> dict[str, Any]:
        return self._save_journal_prose("daily_journals", "date", self._parse_day(day_text).isoformat(), prose, reflection)

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

    def save_weekly_prose(self, day_text: str, prose: Any, reflection: Any = None) -> dict[str, Any]:
        day = self._parse_day(day_text)
        return self._save_journal_prose("weekly_journals", "week_start", (day - timedelta(days=day.weekday())).isoformat(), prose, reflection)

    def stats(self) -> dict[str, int]:
        def count(table: str) -> int:
            return int(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        return {"episodes": count("episodes"), "messages": count("conversation_messages"), "facts": count("facts"), "profiles": count("profiles"), "edges": count("edges"), "events": count("events"), "vectors": count("memory_vectors"), "thoughts": count("thoughts"), "dreams": count("dreams"), "reflections": count("reflections"), "dailyJournals": count("daily_journals"), "weeklyJournals": count("weekly_journals")}

    def close(self) -> None:
        if self.db is not None:
            self.db.close()
            self.db = None

    def __del__(self) -> None:
        # Short-lived CLI clients and tests may not reach the explicit shutdown RPC.
        self.close()

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

    def _source_ids(self, values: Any) -> list[str]:
        if not isinstance(values, list): raise ValueError("来源必须是数组")
        return [self._required_text(value, "来源 id 不合法", 120) for value in values[:50] if isinstance(value, str) and value.strip()]

    @staticmethod
    def _thought_row(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "createdAt": row["created_at"], "kind": row["kind"], "content": row["content"], "emotion": json.loads(row["emotion_json"]), "sourceIds": json.loads(row["source_ids_json"]), "certainty": row["certainty"], "expiresAt": row["expires_at"], "state": row["state"]}

    @staticmethod
    def _dream_row(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "dreamDate": row["dream_date"], "createdAt": row["created_at"], "content": row["content"], "emotion": json.loads(row["emotion_json"]), "sourceIds": json.loads(row["source_ids_json"]), "isFiction": bool(row["is_fiction"]), "state": row["state"]}

    @staticmethod
    def _reflection_row(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "periodStart": row["period_start"], "periodEnd": row["period_end"], "kind": row["kind"], "content": row["content"], "sourceIds": json.loads(row["source_ids_json"]), "confidence": row["confidence"], "createdAt": row["created_at"], "state": row["state"]}

    def _save_journal_prose(self, table: str, key: str, value: str, prose: Any, reflection: Any) -> dict[str, Any]:
        body = self._required_text(prose, "日记正文不能为空", 6000)
        note = self._optional_text(reflection, 1500)
        if not self.db.execute(f"SELECT 1 FROM {table} WHERE {key}=?", (value,)).fetchone():
            raise ValueError("请先构建日记事实素材")
        self.db.execute(f"UPDATE {table} SET prose=?, reflection=? WHERE {key}=?", (body, note, value))
        self.db.commit()
        return self._get_journal(table, key, value) or {}

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
    def _entity_kind(ident: str) -> str:
        if ident.startswith("character:"): return "character"
        if ident.startswith("owner:"): return "owner"
        return "entity"

    @staticmethod
    def _limit(value: Any) -> int:
        try: return max(1, min(50, int(value)))
        except (TypeError, ValueError): return 8

    @staticmethod
    def _fact_row(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "subjectId": row["subject_id"], "predicate": row["predicate"], "objectText": row["object_text"], "confidence": row["confidence"], "importance": row["importance"], "validFrom": row["valid_from"], "validTo": row["valid_to"], "sourceId": row["source_id"], "state": row["state"]}

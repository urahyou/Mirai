"""本地分层记忆 SQLite 仓储。只用标准库，不依赖图数据库或向量服务。"""
from __future__ import annotations
import json, sqlite3, uuid
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
        CREATE INDEX IF NOT EXISTS episode_created ON episodes(created_at DESC);
        CREATE INDEX IF NOT EXISTS fact_subject ON facts(subject_id, predicate, state);
        CREATE INDEX IF NOT EXISTS edge_from ON edges(from_id, state);
        """)
        self.db.commit()

    def add_episode(self, messages: list[dict[str, Any]], created_at: str) -> bool:
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
        return count

    def close(self) -> None: self.db.close()

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

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
        values = (ident, fact["subjectId"][:120], fact["predicate"][:120], fact["objectText"][:2000], float(fact.get("confidence", .7)), float(fact.get("importance", .5)), fact.get("validFrom"), fact.get("validTo"), fact.get("sourceId"), "active")
        self.db.execute("INSERT OR REPLACE INTO facts VALUES(?,?,?,?,?,?,?,?,?,?)", values); self.db.commit()
        return {"id": ident}

    def delete_by_source(self, source_id: str) -> int:
        with self.db:
            count = self.db.execute("DELETE FROM facts WHERE source_id=?", (source_id,)).rowcount
            count += self.db.execute("DELETE FROM edges WHERE source_id=?", (source_id,)).rowcount
            count += self.db.execute("DELETE FROM episodes WHERE id=?", (source_id,)).rowcount
        return count

    def close(self) -> None: self.db.close()

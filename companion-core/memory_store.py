"""本地分层记忆 SQLite 仓储。只用标准库，不依赖图数据库或向量服务。"""
from __future__ import annotations
import json, math, re, sqlite3, uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

class MemoryStore:
    SCHEMA_VERSION = 5
    VECTOR_MAX_DIMENSIONS = 4096
    VECTOR_SCAN_LIMIT = 1000
    VECTOR_RESULT_LIMIT = 12

    def __init__(self, file: Path) -> None:
        self.db = sqlite3.connect(file)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self._migrate_schema()

    def _migrate_schema(self) -> None:
        version = int(self.db.execute("PRAGMA user_version").fetchone()[0])
        if version > self.SCHEMA_VERSION:
            raise RuntimeError(f"memory.db schema {version} is newer than supported {self.SCHEMA_VERSION}")
        if version < 1:
            self.db.executescript("""
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
            self.db.execute("PRAGMA user_version=1")
            self.db.commit()
            version = 1
        if version < 2:
            self._migrate_v2()
            version = 2
        if version < 3:
            self._migrate_v3()
            version = 3
        if version < 4:
            self._migrate_v4()
            version = 4
        if version < 5:
            self._migrate_v5()

    def _migrate_v5(self) -> None:
        with self.db:
            self.db.execute("""CREATE TABLE IF NOT EXISTS memory_vectors(
                id TEXT PRIMARY KEY,
                chunk_id TEXT NOT NULL,
                model TEXT NOT NULL,
                dimensions INTEGER NOT NULL,
                content TEXT NOT NULL,
                vector_json TEXT NOT NULL,
                source_ids_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'active',
                valid_from TEXT,
                valid_to TEXT,
                updated_at TEXT
            )""")
            columns = {row["name"] for row in self.db.execute("PRAGMA table_info(memory_vectors)").fetchall()}
            additions = {
                "valid_from": "TEXT",
                "valid_to": "TEXT",
                "updated_at": "TEXT",
            }
            for name, definition in additions.items():
                if name not in columns:
                    self.db.execute(f"ALTER TABLE memory_vectors ADD COLUMN {name} {definition}")
            self.db.execute("UPDATE memory_vectors SET updated_at=COALESCE(updated_at, created_at)")
            self.db.execute("CREATE INDEX IF NOT EXISTS vector_created ON memory_vectors(created_at DESC)")
            self.db.execute("""CREATE INDEX IF NOT EXISTS vector_search
                ON memory_vectors(model, dimensions, state, updated_at DESC)""")
            self.db.execute("PRAGMA user_version=5")

    def _migrate_v4(self) -> None:
        with self.db:
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS assertion_candidates(
                id TEXT PRIMARY KEY,
                source_episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                subject_id TEXT NOT NULL,
                predicate TEXT NOT NULL,
                object_kind TEXT NOT NULL CHECK(object_kind IN ('literal', 'entity')),
                object_text TEXT,
                object_entity_id TEXT,
                scope TEXT NOT NULL DEFAULT 'companion',
                confidence REAL NOT NULL,
                importance REAL NOT NULL,
                observed_at TEXT NOT NULL,
                valid_from TEXT,
                valid_to TEXT,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'stale')),
                conflicts_json TEXT NOT NULL DEFAULT '[]',
                extraction_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                reviewed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS assertion_candidate_status
                ON assertion_candidates(status, observed_at DESC);
            CREATE INDEX IF NOT EXISTS assertion_candidate_source
                ON assertion_candidates(source_episode_id);
            CREATE UNIQUE INDEX IF NOT EXISTS assertion_candidate_identity
                ON assertion_candidates(source_episode_id, subject_id, predicate, object_kind, object_text, object_entity_id);
            """)
            self.db.execute("PRAGMA user_version=4")

    def _migrate_v2(self) -> None:
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS entities(
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assertions(
            id TEXT PRIMARY KEY,
            subject_id TEXT NOT NULL REFERENCES entities(id),
            predicate TEXT NOT NULL,
            object_kind TEXT NOT NULL CHECK(object_kind IN ('literal', 'entity')),
            object_text TEXT,
            object_entity_id TEXT REFERENCES entities(id),
            scope TEXT NOT NULL DEFAULT 'companion',
            confidence REAL NOT NULL,
            importance REAL NOT NULL,
            valid_from TEXT,
            valid_to TEXT,
            state TEXT NOT NULL DEFAULT 'active',
            supersedes_id TEXT REFERENCES assertions(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CHECK((object_kind='literal' AND object_text IS NOT NULL AND object_entity_id IS NULL)
               OR (object_kind='entity' AND object_text IS NULL AND object_entity_id IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS assertion_evidence(
            assertion_id TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
            source_kind TEXT NOT NULL,
            source_id TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            stance TEXT NOT NULL DEFAULT 'supports' CHECK(stance IN ('supports', 'contradicts')),
            PRIMARY KEY(assertion_id, source_kind, source_id)
        );
        CREATE INDEX IF NOT EXISTS assertion_subject ON assertions(subject_id, predicate, state);
        CREATE INDEX IF NOT EXISTS assertion_object_entity ON assertions(object_entity_id, state);
        CREATE INDEX IF NOT EXISTS assertion_literal ON assertions(object_text, state);
        CREATE INDEX IF NOT EXISTS assertion_evidence_source ON assertion_evidence(source_kind, source_id);
        """)
        now = datetime.now(timezone.utc).isoformat()
        with self.db:
            for row in self.db.execute("SELECT * FROM facts ORDER BY id").fetchall():
                self._ensure_entity(row["subject_id"], now)
                created_at = row["valid_from"] or self._episode_time(row["source_id"]) or now
                self.db.execute("""INSERT OR IGNORE INTO assertions(
                    id, subject_id, predicate, object_kind, object_text, object_entity_id, scope,
                    confidence, importance, valid_from, valid_to, state, supersedes_id, created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    row["id"], row["subject_id"], row["predicate"], "literal", row["object_text"], None,
                    "companion", row["confidence"], row["importance"], row["valid_from"], row["valid_to"],
                    row["state"], None, created_at, now,
                ))
                self._backfill_evidence(row["id"], row["source_id"], created_at)
            for row in self.db.execute("SELECT * FROM edges ORDER BY id").fetchall():
                self._ensure_entity(row["from_id"], now)
                self._ensure_entity(row["to_id"], now)
                created_at = row["valid_from"] or self._episode_time(row["source_id"]) or now
                self.db.execute("""INSERT OR IGNORE INTO assertions(
                    id, subject_id, predicate, object_kind, object_text, object_entity_id, scope,
                    confidence, importance, valid_from, valid_to, state, supersedes_id, created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    row["id"], row["from_id"], row["predicate"], "entity", None, row["to_id"],
                    "companion", .7, .5, row["valid_from"], row["valid_to"], row["state"], None, created_at, now,
                ))
                self._backfill_evidence(row["id"], row["source_id"], created_at)
            self.db.execute("PRAGMA user_version=2")

    def _migrate_v3(self) -> None:
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(episodes)").fetchall()}
        additions = {
            "started_at": "TEXT",
            "ended_at": "TEXT",
            "summary": "TEXT",
            "topics_json": "TEXT NOT NULL DEFAULT '[]'",
            "emotion_json": "TEXT NOT NULL DEFAULT '{}'",
            "importance": "REAL NOT NULL DEFAULT 0.5",
            "recall_state": "TEXT NOT NULL DEFAULT 'active'",
            "retention_policy": "TEXT NOT NULL DEFAULT 'standard'",
            "archived_at": "TEXT",
        }
        with self.db:
            for name, definition in additions.items():
                if name not in columns:
                    self.db.execute(f"ALTER TABLE episodes ADD COLUMN {name} {definition}")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS episode_sources(
                    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                    source_kind TEXT NOT NULL CHECK(source_kind IN ('message', 'event')),
                    source_id TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    PRIMARY KEY(episode_id, source_kind, source_id)
                );
                CREATE INDEX IF NOT EXISTS episode_source_lookup
                    ON episode_sources(source_kind, source_id);
                CREATE TABLE IF NOT EXISTS memory_lifecycle(
                    id TEXT PRIMARY KEY,
                    target_kind TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    from_state TEXT,
                    to_state TEXT NOT NULL CHECK(to_state IN ('active', 'faded', 'archived', 'erased')),
                    reason TEXT NOT NULL,
                    effective_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS memory_lifecycle_target
                    ON memory_lifecycle(target_kind, target_id, effective_at DESC);
            """)
            self.db.execute("""UPDATE episodes SET
                started_at=COALESCE(started_at, created_at),
                ended_at=COALESCE(ended_at, created_at),
                summary=COALESCE(NULLIF(summary, ''), content),
                archived_at=COALESCE(archived_at, created_at)
            """)
            # v1/v2 created one transcript-copy episode per turn. Preserve those rows
            # for audit, but keep them out of active retrieval after structured episodes exist.
            self.db.execute("""UPDATE episodes SET recall_state='archived', retention_policy='legacy'
                WHERE source='chat'""")
            has_messages = self.db.execute("""SELECT 1 FROM sqlite_master
                WHERE type='table' AND name='conversation_messages'""").fetchone()
            if has_messages:
                self.db.execute("""INSERT OR IGNORE INTO episode_sources(episode_id, source_kind, source_id, sequence_no)
                    SELECT conversation_id, 'message', id, sequence_no
                    FROM conversation_messages
                    WHERE conversation_id IN (SELECT id FROM episodes)
                """)
            self.db.execute("PRAGMA user_version=3")

    def _ensure_entity(self, ident: str, timestamp: str) -> None:
        self.db.execute("INSERT OR IGNORE INTO entities VALUES(?,?,?,?)", (ident, self._entity_kind(ident), timestamp, timestamp))

    def _episode_time(self, source_id: str | None) -> str | None:
        if not source_id:
            return None
        row = self.db.execute("SELECT created_at FROM episodes WHERE id=?", (source_id,)).fetchone()
        return row["created_at"] if row else None

    def _backfill_evidence(self, assertion_id: str, source_id: str | None, observed_at: str) -> None:
        if source_id:
            self.db.execute("INSERT OR IGNORE INTO assertion_evidence VALUES(?,?,?,?,?)", (assertion_id, "episode", source_id, observed_at, "supports"))

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
        """Compatibility helper for tests and legacy callers; runtime chat no longer uses this path."""
        self._parse_time(self._required_text(created_at, "episode 时间不合法", 64))
        normalized = []
        for sequence_no, item in enumerate(messages[:20]):
            if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
                continue
            content = str(item.get("content", "")).strip()[:4000]
            if not content:
                continue
            normalized.append({
                "id": item.get("id") or f"legacy:{uuid.uuid4().hex}",
                "role": item["role"], "content": content, "createdAt": created_at,
                "sequence": sequence_no,
            })
        if not normalized:
            return False
        self.import_messages(normalized)
        summary = "\n".join(("主人" if item["role"] == "user" else "小未来") + "：" + item["content"] for item in normalized)
        self.create_episode({
            "startedAt": created_at, "endedAt": created_at, "summary": summary,
            "messageIds": [f"message:history:{item['id'][:80]}" for item in normalized],
            "source": "legacy-helper",
        })
        return True

    def create_episode(self, episode: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(episode, dict):
            raise ValueError("Episode 必须是对象")
        started_at = self._required_text(episode.get("startedAt"), "Episode 缺少开始时间", 64)
        ended_at = self._required_text(episode.get("endedAt") or started_at, "Episode 缺少结束时间", 64)
        self._validate_interval(started_at, ended_at)
        summary = self._required_text(episode.get("summary"), "Episode 摘要不能为空", 4000)
        message_ids = list(dict.fromkeys(self._source_ids(episode.get("messageIds", []))))[:100]
        event_ids = list(dict.fromkeys(self._source_ids(episode.get("eventIds", []))))[:100]
        if not message_ids and not event_ids:
            raise ValueError("Episode 至少需要一个消息或事件来源")
        topics = episode.get("topics", [])
        emotion = episode.get("emotion", {})
        if not isinstance(topics, list) or not isinstance(emotion, dict):
            raise ValueError("Episode 主题或情绪格式不正确")
        for message_id in message_ids:
            if not self.db.execute("SELECT 1 FROM conversation_messages WHERE id=?", (message_id,)).fetchone():
                raise ValueError("Episode 引用了不存在的消息")
        for event_id in event_ids:
            if not self.db.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
                raise ValueError("Episode 引用了不存在的事件")
        ident = "episode:" + uuid.uuid4().hex
        archived_at = datetime.now(timezone.utc).isoformat()
        with self.db:
            self.db.execute("""INSERT INTO episodes(
                id, created_at, content, source, started_at, ended_at, summary, topics_json,
                emotion_json, importance, recall_state, retention_policy, archived_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                ident, started_at, summary, str(episode.get("source", "archive"))[:80],
                started_at, ended_at, summary,
                json.dumps([str(item)[:80] for item in topics[:20]], ensure_ascii=False),
                json.dumps(emotion, ensure_ascii=False), self._score(episode.get("importance"), .5),
                "active", str(episode.get("retentionPolicy", "standard"))[:40], archived_at,
            ))
            sequence = 0
            for source_kind, source_ids in (("message", message_ids), ("event", event_ids)):
                for source_id in source_ids:
                    self.db.execute("INSERT INTO episode_sources VALUES(?,?,?,?)", (ident, source_kind, source_id, sequence))
                    sequence += 1
        return self.get_episode(ident) or {}

    def archive_pending_messages(self, current_at: str, force: bool = False) -> list[dict[str, Any]]:
        now = self._parse_time(self._required_text(current_at, "归档时间不合法", 64))
        rows = self.db.execute("""SELECT m.id, m.role, m.content, m.created_at
            FROM conversation_messages m
            WHERE m.source='chat-history'
              AND NOT EXISTS(
                SELECT 1 FROM episode_sources s
                WHERE s.source_kind='message' AND s.source_id=m.id
              )
            ORDER BY m.created_at ASC, m.sequence_no ASC, m.id ASC""").fetchall()
        if not rows:
            return []

        groups: list[tuple[list[sqlite3.Row], bool]] = []
        current: list[sqlite3.Row] = []
        previous_at: datetime | None = None
        for row in rows:
            occurred_at = self._parse_time(row["created_at"])
            gap_closed = previous_at is not None and occurred_at - previous_at >= timedelta(minutes=20)
            if current and (gap_closed or len(current) >= 12):
                groups.append((current, gap_closed))
                current = []
            current.append(row)
            previous_at = occurred_at
        if current:
            idle_closed = now - self._parse_time(current[-1]["created_at"]) >= timedelta(minutes=20)
            groups.append((current, idle_closed))

        archived = []
        for group, closed in groups:
            if len(group) < 6 and not closed and not force:
                continue
            episode = self.create_episode({
                "startedAt": group[0]["created_at"],
                "endedAt": group[-1]["created_at"],
                "summary": self._episode_summary(group),
                "topics": self._episode_topics(group),
                "importance": self._episode_importance(group),
                "messageIds": [row["id"] for row in group],
                "source": "conversation-archive",
            })
            episode["candidateCount"] = len(self.extract_episode_candidates(episode["id"]))
            archived.append(episode)
        return archived

    def extract_episode_candidates(self, episode_id: str) -> list[dict[str, Any]]:
        """Extract only explicit owner statements into reviewable, inactive candidates.

        This deliberately uses a small rule set instead of an LLM. A candidate is
        evidence to review, never an assertion that can enter active retrieval by
        itself.
        """
        ident = self._required_text(episode_id, "Episode id 不合法", 120)
        episode = self.db.execute("SELECT id, started_at, ended_at FROM episodes WHERE id=?", (ident,)).fetchone()
        if not episode:
            raise ValueError("Episode 不存在")
        rows = self.db.execute("""SELECT m.id, m.content, m.created_at
            FROM episode_sources s JOIN conversation_messages m ON m.id=s.source_id
            WHERE s.episode_id=? AND s.source_kind='message' AND m.role='user'
            ORDER BY s.sequence_no ASC""", (ident,)).fetchall()
        extracted: list[dict[str, Any]] = []
        for row in rows:
            for candidate in self._extract_explicit_candidates(row["content"]):
                candidate.update({
                    "sourceEpisodeId": ident,
                    "sourceMessageId": row["id"],
                    "observedAt": row["created_at"],
                })
                extracted.append(self._save_candidate(candidate))
        return extracted

    def list_candidates(self, limit: Any = 30, status: str | None = None) -> list[dict[str, Any]]:
        values: list[Any] = []
        where = ""
        if status:
            normalized = self._required_text(status, "候选状态不合法", 20)
            if normalized not in ("pending", "accepted", "rejected", "stale"):
                raise ValueError("候选状态不合法")
            where = "WHERE status=?"; values.append(normalized)
        rows = self.db.execute(f"SELECT * FROM assertion_candidates {where} ORDER BY observed_at DESC, id ASC LIMIT ?", (*values, self._limit(limit))).fetchall()
        return [self._candidate_row(row) for row in rows]

    def review_candidate(self, candidate_id: str, decision: str, supersedes_id: str | None = None) -> dict[str, Any]:
        ident = self._required_text(candidate_id, "候选 id 不合法", 120)
        choice = self._required_text(decision, "候选审核决定不合法", 20)
        if choice not in ("accepted", "rejected"):
            raise ValueError("候选审核决定不合法")
        row = self.db.execute("SELECT * FROM assertion_candidates WHERE id=?", (ident,)).fetchone()
        if not row:
            raise ValueError("候选不存在")
        if row["status"] != "pending":
            raise ValueError("候选已经审核过")
        conflicts = json.loads(row["conflicts_json"] or "[]")
        if choice == "accepted":
            if conflicts and not self._optional_text(supersedes_id, 120):
                raise ValueError("候选与当前事实冲突，接受时必须指定 supersedesId")
            assertion = self._upsert_assertion(
                ident=None, prefix="fact", subject_id=row["subject_id"], predicate=row["predicate"],
                object_kind=row["object_kind"], object_text=row["object_text"], object_entity_id=row["object_entity_id"],
                confidence=row["confidence"], importance=row["importance"], valid_from=row["valid_from"] or row["observed_at"],
                valid_to=row["valid_to"], state="active", scope=row["scope"], source_id=row["source_episode_id"],
                supersedes_id=self._optional_text(supersedes_id, 120),
            )
        else:
            assertion = None
        now = datetime.now(timezone.utc).isoformat()
        self.db.execute("UPDATE assertion_candidates SET status=?, reviewed_at=? WHERE id=?", (choice, now, ident))
        self.db.commit()
        result = self._candidate_row(self.db.execute("SELECT * FROM assertion_candidates WHERE id=?", (ident,)).fetchone())
        if assertion:
            result["assertion"] = assertion
        return result

    def _save_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
        source_episode_id = self._required_text(candidate.get("sourceEpisodeId"), "候选缺少来源 Episode", 120)
        subject_id = self._required_text(candidate.get("subjectId"), "候选缺少主体", 120)
        predicate = self._required_text(candidate.get("predicate"), "候选缺少关系", 120)
        object_text = self._required_text(candidate.get("objectText"), "候选缺少内容", 2000)
        observed_at = self._required_text(candidate.get("observedAt"), "候选缺少观察时间", 64)
        self._parse_time(observed_at)
        conflicts = self.db.execute("""SELECT id FROM assertions
            WHERE subject_id=? AND predicate=? AND object_kind='literal' AND state='active' AND object_text<>?
            ORDER BY updated_at DESC, id ASC LIMIT 20""", (subject_id, predicate, object_text)).fetchall()
        conflict_ids = [row["id"] for row in conflicts]
        extraction = {
            "method": "explicit-owner-rule-v1", "sourceMessageId": candidate.get("sourceMessageId"),
            "pattern": candidate.get("pattern"), "text": str(candidate.get("evidenceText", ""))[:500],
        }
        now = datetime.now(timezone.utc).isoformat()
        values = (
            "candidate:" + uuid.uuid5(uuid.NAMESPACE_URL, "|".join((source_episode_id, subject_id, predicate, object_text))).hex,
            source_episode_id, subject_id, predicate, "literal", object_text, None, "companion",
            self._score(candidate.get("confidence"), .72), self._score(candidate.get("importance"), .5), observed_at,
            self._optional_time(candidate.get("validFrom")), self._optional_time(candidate.get("validTo")),
            "pending", json.dumps(conflict_ids, ensure_ascii=False), json.dumps(extraction, ensure_ascii=False), now, None,
        )
        self.db.execute("""INSERT INTO assertion_candidates(
            id, source_episode_id, subject_id, predicate, object_kind, object_text, object_entity_id,
            scope, confidence, importance, observed_at, valid_from, valid_to, status, conflicts_json,
            extraction_json, created_at, reviewed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id)
        DO UPDATE SET confidence=MAX(assertion_candidates.confidence, excluded.confidence),
            importance=MAX(assertion_candidates.importance, excluded.importance),
            conflicts_json=excluded.conflicts_json, extraction_json=excluded.extraction_json""", values)
        self.db.commit()
        row = self.db.execute("SELECT * FROM assertion_candidates WHERE id=?", (values[0],)).fetchone()
        return self._candidate_row(row)

    @staticmethod
    def _extract_explicit_candidates(content: str) -> list[dict[str, Any]]:
        text = re.sub(r"\s+", "", str(content or ""))
        patterns = (
            (r"(?:我|主人)(?:最近|现在|一直|特别|很|最)*(喜欢|爱吃|爱)\s*([^，。！？,.!?；;]{1,40})", "likes", .78),
            (r"(?:我|主人)(?:最近|现在|一直|特别|很)*(不喜欢|讨厌)\s*([^，。！？,.!?；;]{1,40})", "dislikes", .82),
            (r"(?:我|主人)(?:的名字)?叫\s*([^，。！？,.!?；;]{1,30})", "name", .9),
        )
        result = []
        for pattern, predicate, confidence in patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                groups = match.groups()
                value = groups[-1].strip(" \u3000\"'“”‘’")
                if len(value) < 1 or value in {"什么", "这个", "那个"}:
                    continue
                result.append({
                    "subjectId": "owner:default", "predicate": predicate, "objectText": value,
                    "confidence": confidence, "importance": .65 if predicate == "name" else .55,
                    "pattern": pattern, "evidenceText": text[max(0, match.start() - 20):match.end() + 20],
                })
        return result

    def _episode_summary(self, rows: list[sqlite3.Row]) -> str:
        user_points = [self._compact_excerpt(row["content"]) for row in rows if row["role"] == "user"]
        assistant_points = [self._compact_excerpt(row["content"]) for row in rows if row["role"] == "assistant"]
        parts = []
        if user_points:
            parts.append("主人谈到" + "、".join(f"“{text}”" for text in user_points[:3]))
        if assistant_points:
            parts.append("小未来回应了" + "、".join(f"“{text}”" for text in assistant_points[:2]))
        parts.append(f"这段相处包含 {len(rows)} 条消息")
        return "；".join(parts) + "。"

    def _episode_topics(self, rows: list[sqlite3.Row]) -> list[str]:
        user_text = " ".join(row["content"] for row in rows if row["role"] == "user")
        terms = self._query_terms(user_text)
        return [term for term in terms if len(term) >= 2][:8]

    @staticmethod
    def _episode_importance(rows: list[sqlite3.Row]) -> float:
        user_text = " ".join(row["content"] for row in rows if row["role"] == "user")
        signals = ("记住", "喜欢", "讨厌", "以后", "不要", "生日", "重要", "承诺", "必须")
        return min(1.0, .45 + .05 * min(4, len(rows) // 2) + (.2 if any(signal in user_text for signal in signals) else 0.0))

    @staticmethod
    def _compact_excerpt(content: str) -> str:
        text = re.sub(r"\s+", " ", str(content)).strip()
        return text[:72] + ("…" if len(text) > 72 else "")

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        terms = [term for term in query.strip().split() if term][:5]
        if not query.strip(): return []
        clause = " AND ".join("COALESCE(NULLIF(summary, ''), content) LIKE ?" for _ in terms) if terms else "COALESCE(NULLIF(summary, ''), content) LIKE ?"
        values = [f"%{term}%" for term in terms] if terms else [f"%{query.strip()}%"]
        rows = self.db.execute(f"""SELECT id, COALESCE(NULLIF(summary, ''), content) AS content, started_at
            FROM episodes WHERE recall_state='active' AND {clause}
            ORDER BY started_at DESC, created_at DESC LIMIT ?""", (*values, limit)).fetchall()
        return [{"id": row["id"], "content": row["content"], "created_at": row["started_at"]} for row in rows]

    def retrieve(self, query: str, limit: Any = 8, current_at: str | None = None) -> dict[str, Any]:
        query = self._required_text(query, "query 必须是非空字符串", 2000)
        capacity = min(12, self._limit(limit))
        now = self._parse_time(current_at) if current_at else datetime.now(timezone.utc)
        terms = self._query_terms(query)
        candidates: dict[str, dict[str, Any]] = {}
        seed_entities: dict[str, float] = {}
        keyword_count = 0
        graph_count = 0

        episodes = self.db.execute("""SELECT id, COALESCE(NULLIF(summary, ''), content) AS content,
            COALESCE(started_at, created_at) AS created_at, importance
            FROM episodes WHERE recall_state='active'
            ORDER BY COALESCE(started_at, created_at) DESC LIMIT 200""").fetchall()
        for row in episodes:
            match = self._match_score(query, terms, row["content"])
            if match <= 0:
                continue
            keyword_count += 1
            score = .68 * match + .2 * self._recency_score(row["created_at"], now) + .12 * float(row["importance"])
            candidates[row["id"]] = {
                "id": row["id"], "kind": "episode", "content": row["content"],
                "createdAt": row["created_at"], "score": round(score, 4),
            }

        assertions = self.db.execute("""SELECT a.*,
            (SELECT source_id FROM assertion_evidence e WHERE e.assertion_id=a.id ORDER BY e.observed_at DESC, e.source_id ASC LIMIT 1) AS source_id,
            (SELECT observed_at FROM assertion_evidence e WHERE e.assertion_id=a.id ORDER BY e.observed_at DESC, e.source_id ASC LIMIT 1) AS observed_at
            FROM assertions a WHERE a.state='active' ORDER BY a.importance DESC, a.updated_at DESC LIMIT 500""").fetchall()
        active_assertions = [row for row in assertions if self._assertion_is_current(row, now)]
        for row in active_assertions:
            if row["object_kind"] == "literal":
                content = f"{row['subject_id']} {row['predicate']} {row['object_text']}"
                match = self._match_score(query, terms, content)
                if match <= 0:
                    continue
                keyword_count += 1
                score = .55 * match + .2 * float(row["importance"]) + .2 * float(row["confidence"]) + .05 * self._recency_score(row["observed_at"] or row["updated_at"], now)
                candidates[row["id"]] = {
                    "id": row["id"], "kind": "fact", "content": content,
                    "subjectId": row["subject_id"], "predicate": row["predicate"], "objectText": row["object_text"],
                    "confidence": row["confidence"], "importance": row["importance"], "validFrom": row["valid_from"],
                    "validTo": row["valid_to"], "sourceId": row["source_id"], "score": round(score, 4),
                }
                seed_entities[row["subject_id"]] = max(seed_entities.get(row["subject_id"], 0.0), score)
                continue

            content = f"{row['subject_id']} {row['predicate']} {row['object_entity_id']}"
            match = self._match_score(query, terms, content)
            if match <= 0:
                continue
            graph_count += 1
            score = .65 * match + .2 * float(row["importance"]) + .15 * float(row["confidence"])
            candidates[row["id"]] = self._graph_candidate(row, content, score, "keyword")
            seed_entities[row["subject_id"]] = max(seed_entities.get(row["subject_id"], 0.0), score)
            seed_entities[row["object_entity_id"]] = max(seed_entities.get(row["object_entity_id"], 0.0), score)

        for row in active_assertions:
            if row["object_kind"] != "entity" or row["id"] in candidates:
                continue
            seed_score = max(seed_entities.get(row["subject_id"], 0.0), seed_entities.get(row["object_entity_id"], 0.0))
            if seed_score <= 0:
                continue
            graph_count += 1
            content = f"{row['subject_id']} {row['predicate']} {row['object_entity_id']}"
            score = .18 + .22 * seed_score + .1 * float(row["importance"]) + .05 * float(row["confidence"])
            candidates[row["id"]] = self._graph_candidate(row, content, score, "one-hop")

        items = sorted(candidates.values(), key=lambda item: (-item["score"], item["kind"], item["id"]))[:capacity]
        return {
            "query": query,
            "capacity": capacity,
            "items": items,
            "channels": {"keyword": keyword_count, "graph": graph_count, "vector": 0},
        }

    def get_episode(self, ident: str) -> dict[str, Any] | None:
        row = self.db.execute("""SELECT e.*,
            (SELECT COUNT(*) FROM episode_sources s WHERE s.episode_id=e.id) AS source_count
            FROM episodes e WHERE e.id=?""", (ident,)).fetchone()
        return self._episode_row(row) if row else None

    def list_episodes(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("""SELECT e.*,
            (SELECT COUNT(*) FROM episode_sources s WHERE s.episode_id=e.id) AS source_count
            FROM episodes e ORDER BY COALESCE(e.started_at, e.created_at) DESC LIMIT ?""", (self._limit(limit),)).fetchall()
        return [self._episode_row(row) for row in rows]

    def upsert_fact(self, fact: dict[str, Any]) -> dict[str, Any]:
        required = ("subjectId", "predicate", "objectText")
        if not isinstance(fact, dict) or any(not isinstance(fact.get(k), str) or not fact[k].strip() for k in required): raise ValueError("事实缺少主体、关系或内容")
        source_id = self._source_id(fact.get("sourceId"))
        ident = fact.get("id") if isinstance(fact.get("id"), str) and fact["id"].strip() else None
        return self._upsert_assertion(
            ident=ident,
            prefix="fact",
            subject_id=fact["subjectId"],
            predicate=fact["predicate"],
            object_kind="literal",
            object_text=fact["objectText"],
            object_entity_id=None,
            confidence=self._score(fact.get("confidence"), .7),
            importance=self._score(fact.get("importance"), .5),
            valid_from=self._optional_time(fact.get("validFrom")),
            valid_to=self._optional_time(fact.get("validTo")),
            state=self._state(fact.get("state")),
            scope=self._optional_text(fact.get("scope"), 80) or "companion",
            source_id=source_id,
            supersedes_id=self._optional_text(fact.get("supersedesId"), 120),
        )

    def find_facts(self, query: str = "", subject_id: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
        limit = self._limit(limit)
        where, values = ["a.state='active'"], []
        if subject_id:
            where.append("a.subject_id=?"); values.append(str(subject_id)[:120])
        if query.strip():
            where.append("(a.subject_id LIKE ? OR a.predicate LIKE ? OR a.object_text LIKE ?)")
            needle = f"%{query.strip()[:500]}%"; values.extend((needle, needle, needle))
        rows = self.db.execute(f"""SELECT a.id, a.subject_id, a.predicate, a.object_text, a.confidence,
            a.importance, a.valid_from, a.valid_to, a.state,
            (SELECT source_id FROM assertion_evidence e WHERE e.assertion_id=a.id ORDER BY e.observed_at DESC, e.source_id ASC LIMIT 1) AS source_id
            FROM assertions a WHERE a.object_kind='literal' AND {' AND '.join(where)}
            ORDER BY a.importance DESC, a.confidence DESC, a.id ASC LIMIT ?""", (*values, limit)).fetchall()
        return [self._fact_row(row) for row in rows]

    def list_facts(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("""SELECT a.id, a.subject_id, a.predicate, a.object_text, a.confidence,
            a.importance, a.valid_from, a.valid_to, a.state,
            (SELECT source_id FROM assertion_evidence e WHERE e.assertion_id=a.id ORDER BY e.observed_at DESC, e.source_id ASC LIMIT 1) AS source_id
            FROM assertions a WHERE a.object_kind='literal'
            ORDER BY CASE a.state WHEN 'active' THEN 0 ELSE 1 END, a.importance DESC, a.confidence DESC, a.id ASC LIMIT ?""", (self._limit(limit),)).fetchall()
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
        ident = edge.get("id") if isinstance(edge.get("id"), str) and edge["id"].strip() else None
        from_id = self._required_text(edge.get("fromId"), "关系边缺少起点", 120)
        predicate = self._required_text(edge.get("predicate"), "关系边缺少关系", 120)
        to_id = self._required_text(edge.get("toId"), "关系边缺少终点", 120)
        return self._upsert_assertion(
            ident=ident,
            prefix="edge",
            subject_id=from_id,
            predicate=predicate,
            object_kind="entity",
            object_text=None,
            object_entity_id=to_id,
            confidence=self._score(edge.get("confidence"), .7),
            importance=self._score(edge.get("importance"), .5),
            valid_from=self._optional_time(edge.get("validFrom")),
            valid_to=self._optional_time(edge.get("validTo")),
            state=self._state(edge.get("state")),
            scope=self._optional_text(edge.get("scope"), 80) or "companion",
            source_id=self._source_id(edge.get("sourceId")),
            supersedes_id=self._optional_text(edge.get("supersedesId"), 120),
        )

    def neighbors(self, entity_id: str, limit: int = 8) -> list[dict[str, Any]]:
        ident = self._required_text(entity_id, "实体 id 不合法", 120)
        rows = self.db.execute("""SELECT a.id, a.subject_id, a.predicate, a.object_entity_id, a.valid_from, a.valid_to, a.state,
            (SELECT source_id FROM assertion_evidence e WHERE e.assertion_id=a.id ORDER BY e.observed_at DESC, e.source_id ASC LIMIT 1) AS source_id
            FROM assertions a WHERE a.object_kind='entity' AND a.state='active' AND (a.subject_id=? OR a.object_entity_id=?) ORDER BY a.id ASC LIMIT ?""", (ident, ident, self._limit(limit))).fetchall()
        return [self._edge_row(row) for row in rows]

    def list_edges(self, limit: Any = 30) -> list[dict[str, Any]]:
        rows = self.db.execute("""SELECT a.id, a.subject_id, a.predicate, a.object_entity_id, a.valid_from, a.valid_to, a.state,
            (SELECT source_id FROM assertion_evidence e WHERE e.assertion_id=a.id ORDER BY e.observed_at DESC, e.source_id ASC LIMIT 1) AS source_id
            FROM assertions a WHERE a.object_kind='entity'
            ORDER BY CASE a.state WHEN 'active' THEN 0 ELSE 1 END, a.id ASC LIMIT ?""", (self._limit(limit),)).fetchall()
        return [self._edge_row(row) for row in rows]

    def graph_snapshot(self, limit: Any = 50) -> dict[str, list[dict[str, Any]]]:
        edges = [edge for edge in self.list_edges(limit) if edge["state"] == "active"]
        nodes: dict[str, dict[str, Any]] = {}
        for edge in edges:
            for ident in (edge["fromId"], edge["toId"]):
                if ident not in nodes:
                    nodes[ident] = {"id": ident, "kind": self._entity_kind(ident), "degree": 0}
                nodes[ident]["degree"] += 1
        return {"nodes": sorted(nodes.values(), key=lambda node: (-node["degree"], node["id"])), "edges": edges}

    def _upsert_assertion(
        self,
        *,
        ident: str | None,
        prefix: str,
        subject_id: str,
        predicate: str,
        object_kind: str,
        object_text: str | None,
        object_entity_id: str | None,
        confidence: float,
        importance: float,
        valid_from: str | None,
        valid_to: str | None,
        state: str,
        scope: str,
        source_id: str | None,
        supersedes_id: str | None,
    ) -> dict[str, Any]:
        subject_id = self._required_text(subject_id, "断言主体不合法", 120)
        predicate = self._required_text(predicate, "断言关系不合法", 120)
        object_text = self._required_text(object_text, "断言内容不合法", 2000) if object_kind == "literal" else None
        object_entity_id = self._required_text(object_entity_id, "断言实体不合法", 120) if object_kind == "entity" else None
        ident = self._optional_text(ident, 120)
        self._validate_interval(valid_from, valid_to)
        now = datetime.now(timezone.utc).isoformat()

        with self.db:
            self._ensure_entity(subject_id, now)
            if object_entity_id:
                self._ensure_entity(object_entity_id, now)

            superseded = None
            if supersedes_id:
                superseded = self.db.execute("SELECT id, subject_id, predicate, object_kind, valid_from, state FROM assertions WHERE id=?", (supersedes_id,)).fetchone()
                if not superseded:
                    raise ValueError("supersedesId 不存在")
                if superseded["state"] != "active":
                    raise ValueError("只能替代 active 断言")
                if state != "active":
                    raise ValueError("替代旧断言的新断言必须是 active")
                if superseded["subject_id"] != subject_id or superseded["predicate"] != predicate or superseded["object_kind"] != object_kind:
                    raise ValueError("不能替代其他主体、关系或类型的断言")
                if ident == supersedes_id:
                    raise ValueError("断言不能替代自身")
                valid_from = valid_from or now
                self._validate_interval(valid_from, valid_to)
                if superseded["valid_from"] and self._parse_time(valid_from) < self._parse_time(superseded["valid_from"]):
                    raise ValueError("新断言 validFrom 不能早于被替代断言")

            current = self.db.execute("SELECT * FROM assertions WHERE id=?", (ident,)).fetchone() if ident else None
            if not ident and not supersedes_id:
                current = self.db.execute("""SELECT * FROM assertions
                    WHERE subject_id=? AND predicate=? AND object_kind=? AND object_text IS ?
                      AND object_entity_id IS ? AND scope=? AND valid_from IS ? AND valid_to IS ? AND state='active'
                    ORDER BY created_at ASC, id ASC LIMIT 1""", (
                    subject_id, predicate, object_kind, object_text, object_entity_id, scope, valid_from, valid_to,
                )).fetchone()
                if current:
                    ident = current["id"]

            ident = ident or f"{prefix}:" + uuid.uuid4().hex
            has_evidence = bool(source_id and self.db.execute(
                "SELECT 1 FROM assertion_evidence WHERE assertion_id=? AND source_kind='episode' AND source_id=?",
                (ident, source_id),
            ).fetchone())
            if current:
                identity = (subject_id, predicate, object_kind, object_text, object_entity_id, scope)
                current_identity = (current["subject_id"], current["predicate"], current["object_kind"], current["object_text"], current["object_entity_id"], current["scope"])
                if identity != current_identity:
                    raise ValueError("断言 id 已属于其他内容")
                merged_confidence = max(float(current["confidence"]), confidence)
                if source_id and not has_evidence:
                    merged_confidence += (1.0 - merged_confidence) * .1
                self.db.execute("""UPDATE assertions SET subject_id=?, predicate=?, object_kind=?, object_text=?,
                    object_entity_id=?, scope=?, confidence=?, importance=?, valid_from=?, valid_to=?, state=?,
                    supersedes_id=?, updated_at=? WHERE id=?""", (
                    subject_id, predicate, object_kind, object_text, object_entity_id, scope,
                    min(1.0, merged_confidence), max(float(current["importance"]), importance), valid_from, valid_to,
                    state, supersedes_id, now, ident,
                ))
            else:
                self.db.execute("""INSERT INTO assertions(
                    id, subject_id, predicate, object_kind, object_text, object_entity_id, scope,
                    confidence, importance, valid_from, valid_to, state, supersedes_id, created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    ident, subject_id, predicate, object_kind, object_text, object_entity_id, scope,
                    confidence, importance, valid_from, valid_to, state, supersedes_id, now, now,
                ))

            if superseded:
                self.db.execute("UPDATE assertions SET state='superseded', valid_to=?, updated_at=? WHERE id=?", (valid_from, now, supersedes_id))
            if source_id:
                observed_at = self._episode_time(source_id) or now
                self.db.execute("INSERT OR IGNORE INTO assertion_evidence VALUES(?,?,?,?,?)", (ident, "episode", source_id, observed_at, "supports"))
        return {"id": ident}

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
        rows = self.db.execute("""SELECT id, chunk_id, model, dimensions, content, source_ids_json,
            created_at, valid_from, valid_to, updated_at, state
            FROM memory_vectors ORDER BY created_at DESC LIMIT ?""", (self._limit(limit),)).fetchall()
        return [self._vector_row(row) for row in rows]

    def list_vector_pending(self, model: Any, limit: Any = 50) -> list[dict[str, Any]]:
        model_name = self._required_text(model, "向量索引缺少 model", 160)
        rows = self.db.execute("""SELECT e.*,
            (SELECT COUNT(*) FROM episode_sources s WHERE s.episode_id=e.id) AS source_count
            FROM episodes e
            WHERE e.recall_state='active'
              AND NOT EXISTS(
                SELECT 1 FROM memory_vectors v
                WHERE v.chunk_id=e.id AND v.model=? AND v.state='active'
              )
            ORDER BY COALESCE(e.started_at, e.created_at) ASC, e.id ASC LIMIT ?""", (
                model_name, self._limit(limit),
            )).fetchall()
        return [self._episode_row(row) for row in rows]

    def upsert_vector(self, item: dict[str, Any]) -> dict[str, Any]:
        """Store a caller-produced embedding without selecting or installing an embedding model."""
        if not isinstance(item, dict):
            raise ValueError("向量记录必须是对象")
        chunk_id = self._required_text(item.get("chunkId"), "向量记录缺少 chunkId", 120)
        model = self._required_text(item.get("model"), "向量记录缺少 model", 160)
        content = self._required_text(item.get("content"), "向量记录内容不能为空", 4000)
        vector = self._vector(item.get("vector"))
        dimensions = item.get("dimensions", len(vector))
        try:
            dimensions = int(dimensions)
        except (TypeError, ValueError) as error:
            raise ValueError("向量维数不合法") from error
        if dimensions != len(vector):
            raise ValueError("向量维数与数据长度不一致")
        source_ids = list(dict.fromkeys(self._source_ids(item.get("sourceIds", []))))
        if not source_ids:
            raise ValueError("向量记录至少需要一个 Episode 来源")
        for source_id in source_ids:
            if not self.db.execute("SELECT 1 FROM episodes WHERE id=?", (source_id,)).fetchone():
                raise ValueError("向量记录引用了不存在的 Episode")
        valid_from = self._optional_time(item.get("validFrom"))
        valid_to = self._optional_time(item.get("validTo"))
        self._validate_interval(valid_from, valid_to)
        state = self._state(item.get("state"))
        now = datetime.now(timezone.utc).isoformat()
        created_at = self._optional_time(item.get("createdAt")) or now
        ident = self._optional_text(item.get("id"), 120) or "vector:" + uuid.uuid5(
            uuid.NAMESPACE_URL, f"{model}|{chunk_id}"
        ).hex
        existing = self.db.execute("SELECT chunk_id, model FROM memory_vectors WHERE id=?", (ident,)).fetchone()
        if existing and (existing["chunk_id"] != chunk_id or existing["model"] != model):
            raise ValueError("向量 id 已属于其他区块或模型")
        self.db.execute("""INSERT INTO memory_vectors(
            id, chunk_id, model, dimensions, content, vector_json, source_ids_json,
            created_at, state, valid_from, valid_to, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET dimensions=excluded.dimensions, content=excluded.content,
            vector_json=excluded.vector_json, source_ids_json=excluded.source_ids_json,
            state=excluded.state, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
            updated_at=excluded.updated_at""", (
                ident, chunk_id, model, dimensions, content,
                json.dumps(vector, separators=(",", ":")), json.dumps(source_ids, ensure_ascii=False),
                created_at, state, valid_from, valid_to, now,
            ))
        self.db.commit()
        row = self.db.execute("""SELECT id, chunk_id, model, dimensions, content, source_ids_json,
            created_at, valid_from, valid_to, updated_at, state FROM memory_vectors WHERE id=?""", (ident,)).fetchone()
        return self._vector_row(row)

    def search_vectors(
        self,
        vector: Any,
        model: Any,
        limit: Any = 8,
        current_at: str | None = None,
    ) -> dict[str, Any]:
        query_vector = self._vector(vector)
        query_model = self._required_text(model, "向量检索缺少 model", 160)
        capacity = min(self.VECTOR_RESULT_LIMIT, self._limit(limit))
        now = self._parse_time(current_at) if current_at else datetime.now(timezone.utc)
        rows = self.db.execute("""SELECT id, chunk_id, model, dimensions, content, vector_json,
            source_ids_json, created_at, valid_from, valid_to, updated_at, state
            FROM memory_vectors
            WHERE model=? AND dimensions=? AND state='active'
            ORDER BY updated_at DESC, created_at DESC LIMIT ?""", (
                query_model, len(query_vector), self.VECTOR_SCAN_LIMIT,
            )).fetchall()
        items = []
        for row in rows:
            if not self._vector_is_current(row, now) or not self._vector_target_is_active(row, now):
                continue
            try:
                stored_vector = self._vector(json.loads(row["vector_json"]))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            score = self._cosine_similarity(query_vector, stored_vector)
            item = self._vector_row(row)
            item["score"] = round(score, 6)
            items.append(item)
        items.sort(key=lambda item: (-item["score"], item["id"]))
        return {
            "model": query_model,
            "dimensions": len(query_vector),
            "capacity": capacity,
            "scanned": len(rows),
            "items": items[:capacity],
        }

    def forget_by_source(self, source_id: str, to_state: str = "faded", reason: str = "user-request") -> int:
        source_id = self._required_text(source_id, "sourceId 不合法", 120)
        target_state = self._required_text(to_state, "遗忘状态不合法", 20)
        if target_state not in ("faded", "archived", "erased"):
            raise ValueError("遗忘状态只能是 faded、archived 或 erased")
        reason = self._required_text(reason, "遗忘原因不能为空", 200)
        if target_state == "erased":
            return self.erase_by_source(source_id)
        now = datetime.now(timezone.utc).isoformat()
        changed = 0
        with self.db:
            episode = self.db.execute("SELECT id, recall_state FROM episodes WHERE id=?", (source_id,)).fetchone()
            if episode and episode["recall_state"] != target_state:
                self.db.execute("UPDATE episodes SET recall_state=?, archived_at=COALESCE(archived_at, ?) WHERE id=?", (target_state, now, source_id))
                self._record_lifecycle("episode", source_id, episode["recall_state"], target_state, reason, now)
                changed += 1
            assertion_ids = [row["assertion_id"] for row in self.db.execute("SELECT assertion_id FROM assertion_evidence WHERE source_kind='episode' AND source_id=?", (source_id,)).fetchall()]
            for assertion_id in assertion_ids:
                assertion = self.db.execute("SELECT state FROM assertions WHERE id=?", (assertion_id,)).fetchone()
                other = self.db.execute("""SELECT 1 FROM assertion_evidence e
                    JOIN episodes ep ON ep.id=e.source_id
                    WHERE e.assertion_id=? AND e.source_kind='episode' AND e.source_id<>? AND ep.recall_state='active' LIMIT 1""", (assertion_id, source_id)).fetchone()
                if assertion and not other and assertion["state"] == "active":
                    self.db.execute("UPDATE assertions SET state='forgotten', updated_at=? WHERE id=?", (now, assertion_id))
                    self._record_lifecycle("assertion", assertion_id, "active", "faded", reason, now)
                    changed += 1
            self.db.execute("UPDATE assertion_candidates SET status='stale', reviewed_at=COALESCE(reviewed_at, ?) WHERE source_episode_id=? AND status='pending'", (now, source_id))
        return changed

    def _record_lifecycle(self, target_kind: str, target_id: str, from_state: str | None, to_state: str, reason: str, effective_at: str) -> None:
        ident = "lifecycle:" + uuid.uuid5(uuid.NAMESPACE_URL, "|".join((target_kind, target_id, to_state, effective_at))).hex
        self.db.execute("INSERT OR IGNORE INTO memory_lifecycle(id, target_kind, target_id, from_state, to_state, reason, effective_at) VALUES(?,?,?,?,?,?,?)", (ident, target_kind, target_id, from_state, to_state, reason, effective_at))

    def erase_by_source(self, source_id: str) -> int:
        with self.db:
            assertion_ids = [row["assertion_id"] for row in self.db.execute("SELECT assertion_id FROM assertion_evidence WHERE source_kind='episode' AND source_id=?", (source_id,)).fetchall()]
            self.db.execute("DELETE FROM assertion_evidence WHERE source_kind='episode' AND source_id=?", (source_id,))
            count = 0
            for assertion_id in assertion_ids:
                if not self.db.execute("SELECT 1 FROM assertion_evidence WHERE assertion_id=? LIMIT 1", (assertion_id,)).fetchone():
                    count += self.db.execute("DELETE FROM assertions WHERE id=?", (assertion_id,)).rowcount

            # Remove compatibility rows and raw conversation messages without double-counting them.
            self.db.execute("DELETE FROM facts WHERE source_id=?", (source_id,))
            self.db.execute("DELETE FROM edges WHERE source_id=?", (source_id,))
            self.db.execute("DELETE FROM conversation_messages WHERE conversation_id=?", (source_id,))
            count += self.db.execute("DELETE FROM episodes WHERE id=?", (source_id,)).rowcount
            count += self.db.execute("DELETE FROM events WHERE id=?", (source_id,)).rowcount
            for table in ("thoughts", "dreams", "reflections", "memory_vectors"):
                self._remove_source_from_json_column(table, "source_ids_json", source_id)
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
        facts = int(self.db.execute("SELECT COUNT(*) FROM assertions WHERE object_kind='literal'").fetchone()[0])
        edges = int(self.db.execute("SELECT COUNT(*) FROM assertions WHERE object_kind='entity'").fetchone()[0])
        return {"episodes": count("episodes"), "messages": count("conversation_messages"), "facts": facts, "profiles": count("profiles"), "edges": edges, "events": count("events"), "vectors": count("memory_vectors"), "thoughts": count("thoughts"), "dreams": count("dreams"), "reflections": count("reflections"), "dailyJournals": count("daily_journals"), "weeklyJournals": count("weekly_journals")}

    def close(self) -> None:
        if self.db is not None:
            self.db.close()
            self.db = None

    def __del__(self) -> None:
        # Short-lived CLI clients and tests may not reach the explicit shutdown RPC.
        self.close()

    def _episodes_for_day(self, day: date, tz: timezone) -> list[dict[str, Any]]:
        rows = self.db.execute("""SELECT id, COALESCE(NULLIF(summary, ''), content) AS content,
            COALESCE(started_at, created_at) AS created_at
            FROM episodes WHERE recall_state != 'erased' ORDER BY COALESCE(started_at, created_at) ASC""").fetchall()
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

    def _remove_source_from_json_column(self, table: str, column: str, source_id: str) -> None:
        for row in self.db.execute(f"SELECT id, {column} FROM {table}").fetchall():
            try:
                sources = json.loads(row[column])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(sources, list) or source_id not in sources:
                continue
            remaining = [item for item in sources if item != source_id]
            if table == "memory_vectors" and not remaining:
                self.db.execute("DELETE FROM memory_vectors WHERE id=?", (row["id"],))
            else:
                self.db.execute(f"UPDATE {table} SET {column}=? WHERE id=?", (json.dumps(remaining, ensure_ascii=False), row["id"]))

    @staticmethod
    def _episode_row(row: sqlite3.Row) -> dict[str, Any]:
        summary = row["summary"] or row["content"]
        return {
            "id": row["id"], "content": summary, "summary": summary,
            "createdAt": row["created_at"], "startedAt": row["started_at"] or row["created_at"],
            "endedAt": row["ended_at"] or row["created_at"], "source": row["source"],
            "topics": json.loads(row["topics_json"] or "[]"), "emotion": json.loads(row["emotion_json"] or "{}"),
            "importance": row["importance"], "recallState": row["recall_state"],
            "retentionPolicy": row["retention_policy"], "sourceCount": row["source_count"],
            "archivedAt": row["archived_at"],
        }

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

    def _optional_time(self, value: Any) -> str | None:
        result = self._optional_text(value, 64)
        if result:
            self._parse_time(result)
        return result

    def _validate_interval(self, valid_from: str | None, valid_to: str | None) -> None:
        if valid_from and valid_to and self._parse_time(valid_to) < self._parse_time(valid_from):
            raise ValueError("validTo 不能早于 validFrom")

    @staticmethod
    def _query_terms(query: str) -> list[str]:
        ignored = {"主人", "小未来", "今天", "现在", "什么", "怎么", "可以", "这个", "那个", "我们", "你们", "还是"}
        terms: list[str] = []
        for token in re.findall(r"[a-z0-9_:-]+|[\u3400-\u9fff]+", query.lower()):
            if re.fullmatch(r"[\u3400-\u9fff]+", token):
                token = token[:40]
                if 2 <= len(token) <= 12 and token not in ignored:
                    terms.append(token)
                for size in range(2, min(4, len(token)) + 1):
                    terms.extend(token[index:index + size] for index in range(len(token) - size + 1))
            elif len(token) >= 2:
                terms.append(token)
        return list(dict.fromkeys(term for term in terms if term not in ignored))[:120]

    @staticmethod
    def _match_score(query: str, terms: list[str], content: str) -> float:
        haystack = re.sub(r"\s+", "", str(content).lower())
        needle = re.sub(r"\s+", "", query.lower())
        if len(needle) >= 2 and (needle in haystack or (len(haystack) >= 4 and haystack in needle)):
            return 1.0
        matches = [term for term in terms if term in haystack]
        if not matches:
            return 0.0
        total = sum(len(term) for term in terms) or 1
        coverage = sum(len(term) for term in matches) / total
        longest = max(len(term) for term in matches) / max(1, max(len(term) for term in terms))
        score = min(1.0, .55 * coverage + .45 * longest)
        return score if score >= .12 else 0.0

    def _assertion_is_current(self, row: sqlite3.Row, now: datetime) -> bool:
        try:
            if row["valid_from"] and self._parse_time(row["valid_from"]) > now:
                return False
            if row["valid_to"] and self._parse_time(row["valid_to"]) <= now:
                return False
        except (TypeError, ValueError):
            return False
        return True

    def _vector_is_current(self, row: sqlite3.Row, now: datetime) -> bool:
        try:
            if row["valid_from"] and self._parse_time(row["valid_from"]) > now:
                return False
            if row["valid_to"] and self._parse_time(row["valid_to"]) <= now:
                return False
        except (TypeError, ValueError):
            return False
        return True

    def _vector_target_is_active(self, row: sqlite3.Row, now: datetime) -> bool:
        assertion = self.db.execute("SELECT state, valid_from, valid_to FROM assertions WHERE id=?", (row["chunk_id"],)).fetchone()
        if assertion:
            return assertion["state"] == "active" and self._assertion_is_current(assertion, now) and self._has_active_vector_source(row)
        episode = self.db.execute("SELECT recall_state FROM episodes WHERE id=?", (row["chunk_id"],)).fetchone()
        if episode:
            return episode["recall_state"] == "active" and self._has_active_vector_source(row)
        return self._has_active_vector_source(row)

    def _has_active_vector_source(self, row: sqlite3.Row) -> bool:
        try:
            source_ids = json.loads(row["source_ids_json"])
        except (TypeError, json.JSONDecodeError):
            return False
        if not isinstance(source_ids, list) or not source_ids:
            return False
        placeholders = ",".join("?" for _ in source_ids)
        return bool(self.db.execute(
            f"SELECT 1 FROM episodes WHERE id IN ({placeholders}) AND recall_state='active' LIMIT 1",
            tuple(source_ids),
        ).fetchone())

    @classmethod
    def _vector(cls, value: Any) -> list[float]:
        if not isinstance(value, list) or not value or len(value) > cls.VECTOR_MAX_DIMENSIONS:
            raise ValueError(f"向量必须是 1 到 {cls.VECTOR_MAX_DIMENSIONS} 维数组")
        result = []
        for component in value:
            if isinstance(component, bool):
                raise ValueError("向量分量必须是有限数字")
            try:
                number = float(component)
            except (TypeError, ValueError) as error:
                raise ValueError("向量分量必须是有限数字") from error
            if not math.isfinite(number):
                raise ValueError("向量分量必须是有限数字")
            result.append(number)
        if max(abs(component) for component in result) <= 0:
            raise ValueError("向量不能是零向量")
        return result

    @staticmethod
    def _cosine_similarity(left: list[float], right: list[float]) -> float:
        if len(left) != len(right):
            return 0.0
        left_scale = max(abs(component) for component in left)
        right_scale = max(abs(component) for component in right)
        if left_scale <= 0 or right_scale <= 0:
            return 0.0
        scaled_left = [component / left_scale for component in left]
        scaled_right = [component / right_scale for component in right]
        left_norm = math.sqrt(math.fsum(component * component for component in scaled_left))
        right_norm = math.sqrt(math.fsum(component * component for component in scaled_right))
        score = math.fsum(a * b for a, b in zip(scaled_left, scaled_right)) / (left_norm * right_norm)
        return max(-1.0, min(1.0, score))

    def _recency_score(self, timestamp: str | None, now: datetime) -> float:
        if not timestamp:
            return 0.0
        try:
            age_days = max(0.0, (now - self._parse_time(timestamp)).total_seconds() / 86400)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, 1.0 - age_days / 365.0)

    @staticmethod
    def _graph_candidate(row: sqlite3.Row, content: str, score: float, match: str) -> dict[str, Any]:
        return {
            "id": row["id"], "kind": "edge", "content": content,
            "fromId": row["subject_id"], "predicate": row["predicate"], "toId": row["object_entity_id"],
            "confidence": row["confidence"], "importance": row["importance"], "validFrom": row["valid_from"],
            "validTo": row["valid_to"], "sourceId": row["source_id"], "match": match, "score": round(score, 4),
        }

    @staticmethod
    def _score(value: Any, default: float) -> float:
        try: return max(0.0, min(1.0, float(default if value is None else value)))
        except (TypeError, ValueError): raise ValueError("置信度和重要性必须是数字")

    @staticmethod
    def _state(value: Any) -> str:
        state = value if isinstance(value, str) else "active"
        if state not in ("active", "archived", "forgotten", "invalidated", "superseded"): raise ValueError("记忆状态不合法")
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

    @staticmethod
    def _vector_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "chunkId": row["chunk_id"], "model": row["model"],
            "dimensions": row["dimensions"], "content": row["content"],
            "sourceIds": json.loads(row["source_ids_json"]), "createdAt": row["created_at"],
            "validFrom": row["valid_from"], "validTo": row["valid_to"],
            "updatedAt": row["updated_at"], "state": row["state"],
        }

    @staticmethod
    def _candidate_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "sourceEpisodeId": row["source_episode_id"], "subjectId": row["subject_id"],
            "predicate": row["predicate"], "objectKind": row["object_kind"], "objectText": row["object_text"],
            "objectEntityId": row["object_entity_id"], "scope": row["scope"], "confidence": row["confidence"],
            "importance": row["importance"], "observedAt": row["observed_at"], "validFrom": row["valid_from"],
            "validTo": row["valid_to"], "status": row["status"], "conflicts": json.loads(row["conflicts_json"] or "[]"),
            "extraction": json.loads(row["extraction_json"] or "{}"), "createdAt": row["created_at"],
            "reviewedAt": row["reviewed_at"],
        }

    @staticmethod
    def _edge_row(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "fromId": row["subject_id"], "predicate": row["predicate"], "toId": row["object_entity_id"], "sourceId": row["source_id"], "validFrom": row["valid_from"], "validTo": row["valid_to"], "state": row["state"]}

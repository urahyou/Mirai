import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import CompanionCore, CoreError
from memory_store import MemoryStore
from server import handle_request


class CompanionCoreTest(unittest.TestCase):
    def test_tick_persists_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore()
            core.bootstrap(directory)
            result = core.ingest({
                "type": "sensing:tick",
                "occurredAt": "2026-08-17T00:00:00.000Z",
                "source": "node.sensing",
                "payload": {"now": 1234},
            })
            self.assertTrue(result["accepted"])
            self.assertEqual(result["state"]["tickCount"], 1)

            restarted = CompanionCore()
            snapshot = restarted.bootstrap(directory)
            self.assertEqual(snapshot["tickCount"], 1)
            self.assertEqual(snapshot["lastTickAt"], 1234)
            self.assertTrue((Path(directory) / "companion-core-state.json").exists())

    def test_invalid_tick_is_rejected_without_writing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore()
            core.bootstrap(directory)
            with self.assertRaisesRegex(CoreError, "payload.now"):
                core.ingest({"type": "sensing:tick", "payload": {"now": "bad"}})
            self.assertEqual(core.snapshot()["tickCount"], 0)

    def test_protocol_returns_structured_errors_and_shutdown(self):
        core = CompanionCore()
        response, should_stop = handle_request(core, {"id": "1", "method": "unknown", "params": {}})
        self.assertFalse(response["ok"])
        self.assertFalse(should_stop)

        response, should_stop = handle_request(core, {"id": "2", "method": "core.shutdown", "params": {}})
        self.assertTrue(response["ok"])
        self.assertTrue(should_stop)

    def test_pet_rules_match_existing_greeting_and_time_decay(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            result = core.pet_apply_event("pet:greeting", 1000)["state"]
            self.assertEqual(result["emotion"]["moodScore"], 66)
            self.assertEqual(result["emotion"]["loneliness"], 17)
            self.assertEqual(result["nurture"]["experience"], 3)
            later = core.pet_get_state(1000 + 12 * 60 * 60 * 1000)
            self.assertLess(later["emotion"]["moodScore"], 66)

    def test_memory_persists_searches_and_forgets_by_source(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            self.assertTrue(core.memory_add_episode([{"role": "user", "content": "我正在开发 Mirai 记忆系统"}], "2026-08-17T00:00:00Z"))
            rows = core.memory_search("Mirai")
            self.assertEqual(len(rows), 1)
            self.assertEqual(core.memory_forget_source(rows[0]["id"]), 1)
            self.assertEqual(core.memory_search("Mirai"), [])

    def test_memory_fact_profile_and_graph_are_source_aware(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([{"role": "user", "content": "主人喜欢像素风界面"}], "2026-08-17T00:00:00Z")
            source_id = core.memory_search("像素风")[0]["id"]
            fact = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "像素风界面",
                "importance": .9, "sourceId": source_id,
            })
            self.assertEqual(core.memory_find_facts("像素风")[0]["id"], fact["id"])
            profile = core.memory_upsert_profile({"id": "character:mirai", "role": "character", "core": {"style": "温柔"}, "learned": {"goal": "学习"}})
            self.assertEqual(profile["core"]["style"], "温柔")
            edge = core.memory_upsert_edge({"fromId": "character:mirai", "predicate": "cares_for", "toId": "owner:default", "sourceId": source_id})
            self.assertEqual(core.memory_neighbors("owner:default")[0]["id"], edge["id"])
            graph = core.memory_graph()
            self.assertEqual(graph["nodes"][0]["id"], "character:mirai")
            self.assertEqual(graph["nodes"][0]["kind"], "character")
            self.assertEqual(graph["edges"][0]["id"], edge["id"])
            self.assertEqual(core.memory_forget_source(source_id), 3)
            self.assertEqual(core.memory_find_facts("像素风"), [])
            self.assertEqual(core.memory_neighbors("owner:default"), [])
            self.assertEqual(core.memory_stats()["episodes"], 1)
            self.assertEqual(core.memory_list("episodes")[0]["recallState"], "faded")

    def test_memory_browser_lists_and_daily_pages_are_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([{"role": "user", "content": "主人喜欢复古少女网页"}], "2026-08-17T08:00:00Z")
            source_id = core.memory_list("episodes")[0]["id"]
            core.memory_upsert_fact({"subjectId": "owner:default", "predicate": "likes", "objectText": "复古少女网页", "sourceId": source_id})
            core.memory_upsert_profile({"id": "character:mirai", "role": "character", "core": {"tone": "少女感"}, "learned": {}})
            core.memory_upsert_edge({"fromId": "character:mirai", "predicate": "cares_for", "toId": "owner:default", "sourceId": source_id})
            core.ingest({"type": "user:opened_panel", "occurredAt": "2026-08-17T09:00:00Z", "source": "test", "payload": {}})
            core.journal_build_daily_material("2026-08-17", 0)
            core.journal_save_daily_prose("2026-08-17", "今天我把喜欢的复古网页悄悄记在了心里。")
            self.assertEqual(len(core.memory_list("episodes")), 1)
            self.assertEqual(core.memory_list("facts")[0]["objectText"], "复古少女网页")
            self.assertEqual(core.memory_list("profiles")[0]["id"], "character:mirai")
            self.assertEqual(core.memory_list("edges")[0]["predicate"], "cares_for")
            self.assertEqual(core.memory_list("events")[0]["type"], "user:opened_panel")
            pages = core.journal_list_daily()
            self.assertEqual(pages[0]["date"], "2026-08-17")
            self.assertTrue(pages[0]["exists"])
            self.assertIn("复古网页", pages[0]["excerpt"])
            with self.assertRaisesRegex(CoreError, "未知记忆类别"):
                core.memory_list("unknown")

    def test_full_messages_and_inner_life_never_become_facts(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([
                {"role": "user", "content": "今天有点累"},
                {"role": "assistant", "content": "那我陪主人安静待一会儿。"},
            ], "2026-08-17T20:00:00Z")
            episode_id = core.memory_list("episodes")[0]["id"]
            messages = core.memory_list("messages")
            self.assertEqual(len(messages), 2)
            self.assertEqual(messages[0]["role"], "assistant")
            thought = core.mind_record_thought({
                "createdAt": "2026-08-17T20:05:00Z", "kind": "worry",
                "content": "主人今天好像有点累，我想安静陪着。", "sourceIds": [episode_id],
                "emotion": {"care": 0.7}, "certainty": 0.4, "expiresAt": "2026-08-18T08:00:00Z",
            })
            dream = core.mind_record_dream({
                "dreamDate": "2026-08-18", "createdAt": "2026-08-18T02:00:00Z",
                "content": "我梦见和主人坐在星光下面。", "sourceIds": [episode_id], "emotion": {"calm": 0.8},
            })
            reflection = core.mind_record_reflection({
                "periodStart": "2026-08-17", "periodEnd": "2026-08-17", "createdAt": "2026-08-17T23:00:00Z",
                "kind": "daily", "content": "今天我学会了少说一点，也能陪在主人身边。", "sourceIds": [episode_id], "confidence": 0.5,
            })
            self.assertEqual(core.mind_list("thoughts")[0]["id"], thought["id"])
            self.assertTrue(core.mind_list("dreams")[0]["isFiction"])
            self.assertEqual(core.mind_list("reflections")[0]["id"], reflection["id"])
            self.assertEqual(core.memory_find_facts("星光"), [])
            stats = core.memory_stats()
            self.assertEqual((stats["messages"], stats["thoughts"], stats["dreams"], stats["reflections"]), (2, 1, 1, 1))

    def test_imported_full_history_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            messages = [
                {"id": "one", "role": "user", "content": "第一句", "createdAt": "2026-08-17T10:00:00Z"},
                {"id": "two", "role": "assistant", "content": "第二句", "createdAt": "2026-08-17T10:00:01Z"},
            ]
            self.assertEqual(core.memory_import_messages(messages), 2)
            self.assertEqual(core.memory_import_messages(messages), 0)
            self.assertEqual(len(core.memory_list("messages")), 2)

    def test_memory_rejects_unproven_source(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            with self.assertRaisesRegex(CoreError, "sourceId 不存在"):
                core.memory_upsert_fact({"subjectId": "owner:default", "predicate": "likes", "objectText": "未验证", "sourceId": "episode:missing"})

    def test_memory_rejects_episode_with_invalid_time(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            with self.assertRaisesRegex(CoreError, "ISO 8601"):
                core.memory_add_episode([{"role": "user", "content": "测试"}], "not-a-time")

    def test_memory_schema_v3_migrates_legacy_facts_and_edges_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "memory.db"
            legacy = sqlite3.connect(database)
            legacy.executescript("""
                PRAGMA foreign_keys=ON;
                CREATE TABLE episodes(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL);
                CREATE TABLE facts(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, predicate TEXT NOT NULL, object_text TEXT NOT NULL, confidence REAL NOT NULL, importance REAL NOT NULL, valid_from TEXT, valid_to TEXT, source_id TEXT REFERENCES episodes(id), state TEXT NOT NULL DEFAULT 'active');
                CREATE TABLE edges(id TEXT PRIMARY KEY, from_id TEXT NOT NULL, predicate TEXT NOT NULL, to_id TEXT NOT NULL, source_id TEXT REFERENCES episodes(id), valid_from TEXT, valid_to TEXT, state TEXT NOT NULL DEFAULT 'active');
                INSERT INTO episodes VALUES('episode:legacy', '2026-08-01T08:00:00Z', '主人喜欢旧网页', 'chat');
                INSERT INTO facts VALUES('fact:legacy', 'owner:default', 'likes', '旧网页', .8, .9, NULL, NULL, 'episode:legacy', 'active');
                INSERT INTO edges VALUES('edge:legacy', 'character:mirai', 'cares_for', 'owner:default', 'episode:legacy', NULL, NULL, 'active');
                PRAGMA user_version=1;
            """)
            legacy.close()

            store = MemoryStore(database)
            self.assertEqual(store.db.execute("PRAGMA user_version").fetchone()[0], 5)
            self.assertEqual(store.list_facts()[0]["id"], "fact:legacy")
            self.assertEqual(store.list_edges()[0]["id"], "edge:legacy")
            self.assertEqual(store.db.execute("SELECT COUNT(*) FROM assertion_evidence").fetchone()[0], 2)
            self.assertEqual(store.db.execute("SELECT kind FROM entities WHERE id='character:mirai'").fetchone()[0], "character")
            vector_columns = {row["name"] for row in store.db.execute("PRAGMA table_info(memory_vectors)").fetchall()}
            self.assertTrue({"valid_from", "valid_to", "updated_at"}.issubset(vector_columns))
            vector_indexes = {row["name"] for row in store.db.execute("PRAGMA index_list(memory_vectors)").fetchall()}
            self.assertIn("vector_search", vector_indexes)
            episode = store.list_episodes()[0]
            self.assertEqual(episode["summary"], "主人喜欢旧网页")
            self.assertEqual(episode["recallState"], "archived")
            self.assertEqual(episode["retentionPolicy"], "legacy")
            store.close()

            reopened = MemoryStore(database)
            self.assertEqual(reopened.db.execute("SELECT COUNT(*) FROM assertions").fetchone()[0], 2)
            self.assertEqual(reopened.db.execute("SELECT COUNT(*) FROM assertion_evidence").fetchone()[0], 2)
            reopened.close()

    def test_episode_facts_are_pending_until_reviewed_and_conflicts_are_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_import_messages([{"id": "pref-one", "role": "user", "content": "我最近很喜欢红茶", "createdAt": "2026-08-17T08:00:00Z"}])
            first_episode = core.memory_create_episode({
                "startedAt": "2026-08-17T08:00:00Z", "endedAt": "2026-08-17T08:00:00Z",
                "summary": "主人提到喜欢红茶", "messageIds": ["message:history:pref-one"],
            })
            candidates = core.memory_extract_candidates(first_episode["id"])
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]["status"], "pending")
            self.assertEqual(candidates[0]["predicate"], "likes")
            self.assertEqual(core.memory_find_facts("红茶"), [])
            accepted = core.memory_review_candidate(candidates[0]["id"], "accepted")
            fact_id = accepted["assertion"]["id"]
            self.assertEqual(core.memory_find_facts("红茶")[0]["id"], fact_id)

            core.memory_import_messages([{"id": "pref-two", "role": "user", "content": "我现在喜欢咖啡", "createdAt": "2026-08-18T08:00:00Z"}])
            second_episode = core.memory_create_episode({
                "startedAt": "2026-08-18T08:00:00Z", "endedAt": "2026-08-18T08:00:00Z",
                "summary": "主人改喜欢咖啡", "messageIds": ["message:history:pref-two"],
            })
            second = core.memory_extract_candidates(second_episode["id"])[0]
            self.assertEqual(second["conflicts"], [fact_id])
            with self.assertRaisesRegex(CoreError, "supersedesId"):
                core.memory_review_candidate(second["id"], "accepted")
            reviewed = core.memory_review_candidate(second["id"], "accepted", fact_id)
            self.assertEqual(reviewed["status"], "accepted")
            self.assertEqual(core.memory_find_facts("咖啡")[0]["objectText"], "咖啡")

    def test_structured_episode_references_canonical_messages_without_copying_transcript(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            messages = [
                {"id": "turn-user", "role": "user", "content": "今天想喝红茶", "createdAt": "2026-08-18T12:00:00Z"},
                {"id": "turn-assistant", "role": "assistant", "content": "我陪主人泡一杯。", "createdAt": "2026-08-18T12:00:01Z"},
            ]
            self.assertEqual(core.memory_import_messages(messages), 2)
            episode = core.memory_create_episode({
                "startedAt": "2026-08-18T12:00:00Z",
                "endedAt": "2026-08-18T12:00:01Z",
                "summary": "午间主人想喝红茶，小未来准备陪伴。",
                "topics": ["红茶", "陪伴"],
                "importance": .7,
                "messageIds": ["message:history:turn-user", "message:history:turn-assistant"],
            })

            self.assertEqual(episode["sourceCount"], 2)
            self.assertEqual(episode["summary"], "午间主人想喝红茶，小未来准备陪伴。")
            self.assertEqual(core.memory_stats()["messages"], 2)
            self.assertEqual(core.memory_stats()["episodes"], 1)
            linked = core.memory.db.execute(
                "SELECT source_id FROM episode_sources WHERE episode_id=? ORDER BY sequence_no", (episode["id"],)
            ).fetchall()
            self.assertEqual([row["source_id"] for row in linked], ["message:history:turn-user", "message:history:turn-assistant"])

    def test_pending_messages_archive_in_bounded_idempotent_episodes(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            messages = []
            for index in range(7):
                messages.append({
                    "id": f"message-{index}",
                    "role": "user" if index % 2 == 0 else "assistant",
                    "content": f"第 {index + 1} 条关于红茶的消息",
                    "createdAt": f"2026-08-18T12:00:0{index}Z",
                })
            self.assertEqual(core.memory_import_messages(messages), 7)
            archived = core.memory_archive_pending("2026-08-18T12:00:10Z")
            self.assertEqual(len(archived), 1)
            self.assertEqual(archived[0]["sourceCount"], 7)
            self.assertIn("这段相处包含 7 条消息", archived[0]["summary"])
            self.assertEqual(core.memory_stats()["messages"], 7)
            self.assertEqual(core.memory_archive_pending("2026-08-18T12:00:11Z"), [])

    def test_idle_or_forced_archive_closes_a_short_episode(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_import_messages([
                {"id": "short-user", "role": "user", "content": "晚点再聊", "createdAt": "2026-08-18T12:00:00Z"},
                {"id": "short-assistant", "role": "assistant", "content": "好，我会等主人。", "createdAt": "2026-08-18T12:00:01Z"},
            ])
            self.assertEqual(core.memory_archive_pending("2026-08-18T12:10:00Z"), [])
            idle = core.memory_archive_pending("2026-08-18T12:20:01Z")
            self.assertEqual(len(idle), 1)

            core.memory_import_messages([
                {"id": "restart-user", "role": "user", "content": "重新打开应用", "createdAt": "2026-08-18T13:00:00Z"},
            ])
            forced = core.memory_archive_pending("2026-08-18T13:00:01Z", True)
            self.assertEqual(len(forced), 1)

    def test_duplicate_fact_collects_evidence_and_forgets_one_source_at_a_time(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([{"role": "user", "content": "我喜欢草莓蛋糕"}], "2026-08-17T08:00:00Z")
            first_source = core.memory_search("草莓蛋糕")[0]["id"]
            first = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "草莓蛋糕",
                "confidence": .6, "sourceId": first_source,
            })
            core.memory_add_episode([{"role": "user", "content": "还是很喜欢草莓蛋糕"}], "2026-08-18T08:00:00Z")
            second_source = core.memory_search("还是很喜欢")[0]["id"]
            second = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "草莓蛋糕",
                "confidence": .6, "sourceId": second_source,
            })

            self.assertEqual(first["id"], second["id"])
            self.assertEqual(core.memory_stats()["facts"], 1)
            self.assertGreater(core.memory_find_facts("草莓蛋糕")[0]["confidence"], .6)
            self.assertEqual(core.memory.db.execute("SELECT COUNT(*) FROM assertion_evidence WHERE assertion_id=?", (first["id"],)).fetchone()[0], 2)
            self.assertEqual(core.memory_forget_source(first_source), 1)
            self.assertEqual(core.memory_find_facts("草莓蛋糕")[0]["id"], first["id"])
            self.assertEqual(core.memory.db.execute("SELECT COUNT(*) FROM assertion_evidence WHERE assertion_id=?", (first["id"],)).fetchone()[0], 2)
            self.assertEqual(core.memory_forget_source(second_source), 2)
            self.assertEqual(core.memory_find_facts("草莓蛋糕"), [])

    def test_temporal_supersession_closes_old_assertion_and_graph_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([{"role": "user", "content": "以前喜欢咖啡"}], "2026-07-01T08:00:00Z")
            old_source = core.memory_search("咖啡")[0]["id"]
            old_fact = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "咖啡",
                "validFrom": "2026-07-01T08:00:00Z", "sourceId": old_source,
            })
            old_edge = core.memory_upsert_edge({
                "fromId": "character:mirai", "predicate": "studies_at", "toId": "place:old-school",
                "validFrom": "2026-07-01T08:00:00Z", "sourceId": old_source,
            })
            core.memory_add_episode([{"role": "user", "content": "现在喜欢红茶"}], "2026-08-01T08:00:00Z")
            new_source = core.memory_search("红茶")[0]["id"]
            new_fact = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "红茶",
                "validFrom": "2026-08-01T08:00:00Z", "sourceId": new_source, "supersedesId": old_fact["id"],
            })
            new_edge = core.memory_upsert_edge({
                "fromId": "character:mirai", "predicate": "studies_at", "toId": "place:new-school",
                "validFrom": "2026-08-01T08:00:00Z", "sourceId": new_source, "supersedesId": old_edge["id"],
            })

            facts = {row["id"]: row for row in core.memory_list("facts")}
            self.assertEqual(facts[old_fact["id"]]["state"], "superseded")
            self.assertEqual(facts[old_fact["id"]]["validTo"], "2026-08-01T08:00:00Z")
            self.assertEqual(core.memory_find_facts("红茶")[0]["id"], new_fact["id"])
            graph = core.memory_graph()
            self.assertEqual([edge["id"] for edge in graph["edges"]], [new_edge["id"]])
            self.assertNotIn("place:old-school", [node["id"] for node in graph["nodes"]])
            self.assertEqual(core.memory_forget_source(old_source), 1)
            self.assertEqual(core.memory_find_facts("红茶")[0]["id"], new_fact["id"])
            self.assertEqual(core.memory.db.execute("SELECT supersedes_id FROM assertions WHERE id=?", (new_fact["id"],)).fetchone()[0], old_fact["id"])

            with self.assertRaisesRegex(CoreError, "其他主体"):
                core.memory_upsert_fact({
                    "subjectId": "character:mirai", "predicate": "likes", "objectText": "红茶",
                    "supersedesId": new_fact["id"],
                })
            with self.assertRaisesRegex(CoreError, "ISO 8601"):
                core.memory_upsert_fact({"subjectId": "owner:default", "predicate": "likes", "objectText": "测试", "validFrom": "tomorrow"})
            with self.assertRaisesRegex(CoreError, "validTo"):
                core.memory_upsert_fact({
                    "subjectId": "owner:default", "predicate": "likes", "objectText": "测试",
                    "validFrom": "2026-08-02T00:00:00Z", "validTo": "2026-08-01T00:00:00Z",
                })
            with self.assertRaisesRegex(CoreError, "其他内容"):
                core.memory_upsert_fact({
                    "id": new_fact["id"], "subjectId": "owner:default", "predicate": "likes", "objectText": "被悄悄改写",
                })

    def test_bounded_memory_frame_blends_current_facts_episodes_and_one_hop_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([{"role": "user", "content": "主人最近很喜欢草莓蛋糕"}], "2026-08-17T08:00:00Z")
            source_id = core.memory_search("草莓蛋糕")[0]["id"]
            fact = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "草莓蛋糕",
                "importance": .9, "confidence": .85, "validFrom": "2026-08-01T00:00:00Z", "sourceId": source_id,
            })
            edge = core.memory_upsert_edge({
                "fromId": "owner:default", "predicate": "visits", "toId": "place:bakery",
                "importance": .7, "sourceId": source_id,
            })
            expired = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "planned", "objectText": "过期的草莓蛋糕聚会",
                "validFrom": "2026-07-01T00:00:00Z", "validTo": "2026-08-01T00:00:00Z", "sourceId": source_id,
            })
            future = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "planned", "objectText": "未来的草莓蛋糕课程",
                "validFrom": "2026-09-01T00:00:00Z", "sourceId": source_id,
            })

            frame = core.memory_retrieve("草莓蛋糕", 8, "2026-08-18T12:00:00Z")
            item_ids = [item["id"] for item in frame["items"]]
            self.assertEqual(frame["capacity"], 8)
            self.assertLessEqual(len(frame["items"]), 8)
            self.assertIn(fact["id"], item_ids)
            self.assertIn(source_id, item_ids)
            self.assertIn(edge["id"], item_ids)
            self.assertNotIn(expired["id"], item_ids)
            self.assertNotIn(future["id"], item_ids)
            self.assertEqual(frame["channels"]["vector"], 0)
            self.assertGreaterEqual(frame["channels"]["graph"], 1)
            self.assertEqual(core.memory_retrieve("草莓蛋糕", 1, "2026-08-18T12:00:00Z")["capacity"], 1)
            response, should_stop = handle_request(core, {
                "id": "retrieve:1", "method": "memory.retrieve",
                "params": {"query": "草莓蛋糕", "limit": 2, "currentAt": "2026-08-18T12:00:00Z"},
            })
            self.assertTrue(response["ok"])
            self.assertFalse(should_stop)
            self.assertEqual(response["result"]["capacity"], 2)
            with self.assertRaisesRegex(CoreError, "非空"):
                core.memory_retrieve("   ")

    def test_pluggable_vectors_are_bounded_and_lifecycle_aware(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.memory_add_episode([{"role": "user", "content": "主人喜欢草莓蛋糕"}], "2026-08-17T08:00:00Z")
            source_id = core.memory_search("草莓蛋糕")[0]["id"]
            first = core.memory_vector_upsert({
                "chunkId": source_id, "model": "test-embedding-v1", "content": "草莓蛋糕相处片段",
                "vector": [1, 0, 0], "sourceIds": [source_id],
                "validFrom": "2026-08-01T00:00:00Z", "validTo": "2026-09-01T00:00:00Z",
            })
            second = core.memory_vector_upsert({
                "chunkId": "chunk:dessert", "model": "test-embedding-v1", "content": "一起吃甜点",
                "vector": [0.8, 0.2, 0], "sourceIds": [source_id],
            })
            archived = core.memory_vector_upsert({
                "chunkId": "chunk:archived", "model": "test-embedding-v1", "content": "已归档向量",
                "vector": [1, 0, 0], "sourceIds": [source_id], "state": "archived",
            })
            future = core.memory_vector_upsert({
                "chunkId": "chunk:future", "model": "test-embedding-v1", "content": "未来向量",
                "vector": [1, 0, 0], "sourceIds": [source_id], "validFrom": "2026-09-01T00:00:00Z",
            })
            expired = core.memory_vector_upsert({
                "chunkId": "chunk:expired", "model": "test-embedding-v1", "content": "过期向量",
                "vector": [1, 0, 0], "sourceIds": [source_id], "validTo": "2026-08-01T00:00:00Z",
            })
            old_fact = core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "草莓蛋糕",
                "validFrom": "2026-08-01T00:00:00Z", "sourceId": source_id,
            })
            old_fact_vector = core.memory_vector_upsert({
                "chunkId": old_fact["id"], "model": "test-embedding-v1", "content": "主人喜欢草莓蛋糕",
                "vector": [1, 0, 0], "sourceIds": [source_id],
            })
            core.memory_upsert_fact({
                "subjectId": "owner:default", "predicate": "likes", "objectText": "红茶",
                "validFrom": "2026-08-10T00:00:00Z", "sourceId": source_id, "supersedesId": old_fact["id"],
            })

            frame = core.memory_vector_search([1, 0, 0], "test-embedding-v1", 99, "2026-08-18T00:00:00Z")
            item_ids = [item["id"] for item in frame["items"]]
            self.assertEqual(frame["capacity"], 12)
            self.assertEqual(item_ids, [first["id"], second["id"]])
            self.assertNotIn(archived["id"], item_ids)
            self.assertNotIn(future["id"], item_ids)
            self.assertNotIn(expired["id"], item_ids)
            self.assertNotIn(old_fact_vector["id"], item_ids)
            self.assertGreater(frame["items"][0]["score"], frame["items"][1]["score"])
            self.assertAlmostEqual(core.memory._cosine_similarity([1e308, 1e308], [1e308, 1e308]), 1.0)
            self.assertEqual(core.memory_vector_search([1, 0], "test-embedding-v1")["items"], [])
            self.assertEqual(core.memory_vector_search([1, 0, 0], "other-model")["items"], [])
            self.assertNotIn("vector_json", core.memory_list("vectors")[0].keys())

            response, should_stop = handle_request(core, {
                "id": "vector:search", "method": "memory.vector_search",
                "params": {"vector": [1, 0, 0], "model": "test-embedding-v1", "limit": 1, "currentAt": "2026-08-18T00:00:00Z"},
            })
            self.assertTrue(response["ok"])
            self.assertFalse(should_stop)
            self.assertEqual(response["result"]["capacity"], 1)
            self.assertEqual(core.memory_forget_source(source_id), 2)
            self.assertEqual(core.memory_vector_search([1, 0, 0], "test-embedding-v1", 8, "2026-08-18T00:00:00Z")["items"], [])

            with self.assertRaisesRegex(CoreError, "零向量"):
                core.memory_vector_search([0, 0, 0], "test-embedding-v1")
            with self.assertRaisesRegex(CoreError, "不存在"):
                core.memory_vector_upsert({
                    "chunkId": "missing", "model": "test", "content": "无来源",
                    "vector": [1], "sourceIds": ["episode:missing"],
                })

    def test_life_state_advances_offline_and_performs_virtual_activity(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            initial = core.life_get_state(1_000_000)
            later = core.life_advance(1_000_000 + 6 * 60 * 60 * 1000)
            self.assertGreater(later["hunger"], initial["hunger"])
            self.assertLess(later["energy"], initial["energy"])
            played = core.life_perform_activity("play", 1_000_000 + 6 * 60 * 60 * 1000)
            self.assertLess(played["boredom"], later["boredom"])
            self.assertEqual(played["recentActivities"][-1]["activityId"], "play")

    def test_life_shopping_is_virtual_and_has_no_external_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            state = core.life_perform_activity("shopping", 2_000_000)
            self.assertIn("item:小礼物", state["inventory"])
            self.assertEqual(state["money"], 1100)

    def test_life_meal_and_school_stay_inside_virtual_state(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            core.state["lifeState"]["hunger"] = 80
            fed = core.life_perform_activity("meal", 3_000_000)
            self.assertLess(fed["hunger"], 40)
            self.assertEqual(fed["location"], "home")
            school = core.life_perform_activity("school", fed["updatedAt"])
            self.assertEqual(school["currentActivityId"], "school")
            self.assertEqual(school["location"], "school")
            self.assertIn("上学", school["recentActivities"][-1]["tags"])

    def test_multidimensional_emotion_changes_with_events_and_decays(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            base = core.emotion_get_state(1_000_000)
            core.pet_apply_event("pet:praise", 1_000_000)
            praised = core.emotion_get_state(1_000_000)
            self.assertGreater(praised["valence"], base["valence"])
            self.assertGreater(praised["security"], base["security"])
            after_study = core.life_perform_activity("study", 1_100_000)
            self.assertEqual(after_study["currentActivityId"], "study")
            emotional = core.emotion_get_state(1_100_000)
            self.assertGreater(emotional["focus"], praised["focus"])
            decayed = core.emotion_get_state(1_100_000 + 24 * 60 * 60 * 1000)
            self.assertLess(decayed["focus"], emotional["focus"])

    def test_daily_and_weekly_journal_material_only_references_saved_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            core = CompanionCore(); core.bootstrap(directory)
            timestamp = 1_786_968_800_000  # 2026-08-17T12:00:00Z
            core.memory_add_episode([
                {"role": "user", "content": "今天我们一起整理了记忆系统"},
                {"role": "assistant", "content": "我会先写事实素材。"},
            ], "2026-08-17T12:00:00Z")
            core.pet_apply_event("pet:greeting", timestamp)
            life = core.life_perform_activity("study", timestamp)

            daily = core.journal_build_daily_material("2026-08-17", 0)
            self.assertEqual(daily["facts"]["chatCount"], 1)
            self.assertEqual(daily["facts"]["eventTypes"]["pet:greeting"], 1)
            self.assertEqual(daily["facts"]["activityTypes"]["study"], 1)
            self.assertEqual(daily["sources"]["activities"][0]["sourceId"], life["recentActivities"][-1]["id"])
            self.assertIn("不是小未来自动生成的日记正文", daily["constraints"][1])
            saved = core.journal_get_daily_material("2026-08-17")
            self.assertEqual(saved["material"]["date"], "2026-08-17")

            with self.assertRaisesRegex(CoreError, "不能为空"):
                core.journal_save_daily_prose("2026-08-17", "")
            written = core.journal_save_daily_prose("2026-08-17", "今天和主人一起整理了好多东西，心里暖暖的。")
            self.assertEqual(written["prose"], "今天和主人一起整理了好多东西，心里暖暖的。")
            self.assertEqual(written["sourceIds"], saved["sourceIds"])
            self.assertEqual(core.journal_get_daily_material("2026-08-17")["prose"], written["prose"])

            weekly = core.journal_build_weekly_material("2026-08-17", 0)
            self.assertEqual(weekly["weekStart"], "2026-08-17")
            self.assertEqual(weekly["facts"]["chatCount"], 1)
            self.assertIsNotNone(core.journal_get_weekly_material("2026-08-17"))


if __name__ == "__main__":
    unittest.main()

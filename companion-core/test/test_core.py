import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import CompanionCore, CoreError
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
            self.assertEqual(core.memory_forget_source(source_id), 3)
            self.assertEqual(core.memory_find_facts("像素风"), [])
            self.assertEqual(core.memory_neighbors("owner:default"), [])
            self.assertEqual(core.memory_stats()["episodes"], 0)

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

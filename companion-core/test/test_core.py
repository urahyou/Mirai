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


if __name__ == "__main__":
    unittest.main()

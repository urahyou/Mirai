"""
回归测试：EdgeDuplicate.duplicate_facts 接受 UUID（原缺陷导致间歇丢写）。

缺陷现场（graphiti-sidecar.log）：
    EdgeDuplicate.duplicate_facts.0
      Input should be a valid integer, unable to parse string as an integer [input_value='<UUID>']

根因：related_edges_context 的 'id' 字段是 edge 的 UUID（字符串），LLM 回填 UUID，
但 EdgeDuplicate.duplicate_facts 原声明为 list[int]（索引），pydantic 校验失败 → 整次 episode 丢弃。

修复：duplicate_facts 声明放宽为 list[str | int]，下游按 uuid 匹配（兼容整数索引）。

运行：graphiti-sidecar/.venv/bin/python3 graphiti-sidecar/test_edge_duplicate.py
"""
import asyncio
import sys
from datetime import datetime, timezone

from graphiti_core.edges import EntityEdge
from graphiti_core.llm_client.config import ModelSize
from graphiti_core.prompts.dedupe_edges import EdgeDuplicate
from graphiti_core.utils.maintenance.edge_operations import resolve_extracted_edge


def make_edge(uuid: str, fact: str) -> EntityEdge:
    return EntityEdge(
        uuid=uuid,
        group_id="g",
        source_node_uuid="s1",
        target_node_uuid="t1",
        created_at=datetime.now(timezone.utc),
        name="RELATES_TO",
        fact=fact,
    )


class MockLLM:
    """generate_response 固定返回 duplicate_facts=[UUID]，模拟触发缺陷的 LLM 响应。"""

    def __init__(self, dup):
        self.dup = dup

    async def generate_response(self, *args, **kwargs):
        return {
            "duplicate_facts": self.dup,
            "contradicted_facts": [],
            "fact_type": "DEFAULT",
        }


async def run_case(dup_values, label, expect_uuid):
    # related_edges 里给 3 条，uuid 用真实形态（这里用可读假 UUID，缺缺陷现场为 UUID 字符串）
    related = [
        make_edge("00000000-0000-0000-0000-00000000000a", "主人喜欢美式咖啡"),
        make_edge("00000000-0000-0000-0000-00000000000b", "主人爱喝拉面汤"),
        make_edge("00000000-0000-0000-0000-00000000000c", "宠物叫小未来"),
    ]
    extracted = make_edge("ffffffff-ffff-ffff-ffff-ffffffffffff", "主人喜欢美式咖啡")
    llm = MockLLM(dup_values)
    try:
        resolved, _, _ = await resolve_extracted_edge(
            llm, extracted, related, related, None, None, ensure_ascii=False
        )
    except Exception as e:
        print(f"✗ [{label}] 抛异常: {type(e).__name__}: {e}")
        return False
    ok_uuid = resolved.uuid == expect_uuid
    print(f"{'✓' if ok_uuid else '✗'} [{label}] 解析到 uuid={resolved.uuid[:8]}… fact={resolved.fact!r} (期望 {expect_uuid[:8]}…)")
    return ok_uuid


async def main():
    # 1) 修复核心：pydantic 能接受 UUID 字符串
    try:
        EdgeDuplicate(**{"duplicate_facts": ["00000000-0000-0000-0000-00000000000a"], "contradicted_facts": [], "fact_type": "DEFAULT"})
        print("✓ pydantic 接受 UUID duplicate_facts（原缺陷点已消除）")
    except Exception as e:
        print(f"✗ pydantic 仍拒绝 UUID: {e}")

    r1 = await run_case(["00000000-0000-0000-0000-00000000000a"], "UUID 命中", "00000000-0000-0000-0000-00000000000a")
    r2 = await run_case([1], "整数索引命中（不回归）", "00000000-0000-0000-0000-00000000000b")
    r3 = await run_case(["not-a-uuid-999"], "未知 UUID → 不崩、回落 extracted", "ffffffff-ffff-ffff-ffff-ffffffffffff")
    print("\n结果:", "全部通过" if (r1 and r2 and r3) else "存在失败")
    return 0 if (r1 and r2 and r3) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

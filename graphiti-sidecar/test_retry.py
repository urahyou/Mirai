#!/usr/bin/env python3
"""Graphiti sidecar 的 episode 写入重试逻辑回归测试。

不依赖 graphiti_core / neo4j：仅 import server.py（其顶层只引 stdlib），
monkeypatch get_graphiti/env/parse_time 来验证：
  1) 偶发的抽取 LLM 校验失败（entity id=null）会被自动重试并恢复；
  2) 连续多次失败时会正确抛异常（让主进程优雅降级），且重试次数符合配置。
运行：python3 graphiti-sidecar/test_retry.py
"""
import asyncio
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("sidecar_server", Path(__file__).parent / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeGraph:
    def __init__(self, fail_first):
        self.fail_first = fail_first
        self.calls = 0

    async def add_episode(self, **kwargs):
        self.calls += 1
        if self.calls <= self.fail_first:
            raise ValueError("edges.2.target_entity_id: Input should be a valid integer (None)")
        return None


def make_server(graph, retries="3"):
    async def _get():
        return graph
    server.get_graphiti = _get
    server.env = lambda n, d="": {
        "GRAPHITI_EPISODE_RETRIES": retries,
        "GRAPHITI_EPISODE_TIMEOUT": "30",
    }.get(n, d)
    server.parse_time = lambda v: None


def main():
    # 1) 先失败 2 次、第 3 次成功 → 应恢复并最终 ok
    graph = FakeGraph(fail_first=2)
    make_server(graph)
    res = asyncio.run(server.add_episode({"messages": [{"role": "user", "content": "hi"}]}))
    assert graph.calls == 3, f"期望重试到第3次成功，实际调用 {graph.calls}"
    assert res["ok"] is True, f"期望 ok=True，实际 {res}"
    print(f"✓ 偶发失败自动重试恢复（调用 {graph.calls} 次 → 成功）")

    # 2) 一直失败 → 重试满仍抛异常（主进程据此降级），次数=配置
    graph = FakeGraph(fail_first=999)
    make_server(graph, retries="3")
    try:
        asyncio.run(server.add_episode({"messages": [{"role": "user", "content": "x"}]}))
        raise AssertionError("应抛出异常却未抛")
    except ValueError as exc:
        assert graph.calls == 3, f"期望重试3次，实际 {graph.calls}"
        assert "target_entity_id" in str(exc), f"异常信息不符: {exc}"
        print(f"✓ 连续失败重试满 3 次后正确抛出并降级")

    print("graphiti retry 测试全部通过 ✅")


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# 重打 EdgeDuplicate 缺陷修复到 graphiti-sidecar/.venv 的 graphiti_core。
#
# 背景：graphiti-sidecar/.venv 被 .gitignore，一旦重装 venv，本修复会丢失。
# 运行本脚本即可把两处补丁重新打上（幂等：已打过会跳过并提示）。
#
# 缺陷：EdgeDuplicate.duplicate_facts 原声明 list[int]，但 related_edges 的 'id' 是
# UUID 字符串，LLM 回填 UUID 时 pydantic 校验失败，导致该次 episode 整条被丢弃（间歇丢写）。
#
# 用法：bash graphiti-sidecar/apply-edge-duplicate-fix.sh [venv路径]
set -euo pipefail

VENV="${1:-graphiti-sidecar/.venv}"
PY="$VENV/bin/python"
GP="$VENV/lib/python3.13/site-packages/graphiti_core"
DEDUPE="$GP/prompts/dedupe_edges.py"
EDGE_OPS="$GP/utils/maintenance/edge_operations.py"

if [ ! -f "$DEDUPE" ] || [ ! -f "$EDGE_OPS" ]; then
  echo "✗ 找不到 graphiti_core（$GP），请确认 venv 路径。"
  exit 1
fi

# 幂等：已存在修复标记则跳过
if grep -q "resolved_duplicates" "$EDGE_OPS"; then
  echo "✓ 修复已存在（edge_operations.py 含 resolved_duplicates），跳过。"
  exit 0
fi

"$PY" - "$DEDUPE" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
old = """class EdgeDuplicate(BaseModel):
    duplicate_facts: list[int] = Field(
        ...,
        description='List of ids of any duplicate facts. If no duplicate facts are found, default to empty list.',
    )"""
new = """class EdgeDuplicate(BaseModel):
    # duplicate_facts 语义上指向 related_edges 的 'id'（见 related_edges_context，那里 id=uuid），
    # LLM 常直接回填可见的 UUID 字符串而非整数索引；同时兼容部分模型回填整数索引，故放宽为 str|int。
    duplicate_facts: list[str | int] = Field(
        ...,
        description='List of ids of any duplicate facts. If no duplicate facts are found, default to empty list.',
    )"""
assert old in src, "dedupe_edges.py 未匹配到旧片段（可能已改版），请手工合并"
open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
print("✓ 已修补 dedupe_edges.py")
PYEOF

"$PY" - "$EDGE_OPS" <<'PYEOF'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
old1 = """    response_object = EdgeDuplicate(**llm_response)
    duplicate_facts = response_object.duplicate_facts

    duplicate_fact_ids: list[int] = [i for i in duplicate_facts if 0 <= i < len(related_edges)]

    resolved_edge = extracted_edge
    for duplicate_fact_id in duplicate_fact_ids:
        resolved_edge = related_edges[duplicate_fact_id]
        break

    if duplicate_fact_ids and episode is not None:
        resolved_edge.episodes.append(episode.uuid)"""
new1 = """    response_object = EdgeDuplicate(**llm_response)
    duplicate_facts = response_object.duplicate_facts

    # 修复：duplicate_facts 可能返回 related_edges 的 UUID（其 'id' 字段为 uuid 字符串）或整数索引。
    # 之前声明为 list[int]，LLM 回填 UUID 时 pydantic 校验失败（EdgeDuplicate 间歇丢写）。
    # 这里按 uuid 匹配，兼容整数索引。
    uuid_to_edge = {str(e.uuid): e for e in related_edges}
    resolved_duplicates: list[EntityEdge] = []
    for i in duplicate_facts:
        if isinstance(i, int) and 0 <= i < len(related_edges):
            resolved_duplicates.append(related_edges[i])
        elif isinstance(i, str):
            if i in uuid_to_edge:
                resolved_duplicates.append(uuid_to_edge[i])
            else:
                try:
                    idx = int(i)
                    if 0 <= idx < len(related_edges):
                        resolved_duplicates.append(related_edges[idx])
                except ValueError:
                    pass

    resolved_edge = extracted_edge
    if resolved_duplicates:
        resolved_edge = resolved_duplicates[0]

    if resolved_duplicates and episode is not None:
        resolved_edge.episodes.append(episode.uuid)"""
assert old1 in src, "edge_operations.py 未匹配到旧片段①，请手工合并"
src = src.replace(old1, new1, 1)

old2 = "    duplicate_edges: list[EntityEdge] = [related_edges[idx] for idx in duplicate_fact_ids]"
new2 = "    duplicate_edges: list[EntityEdge] = resolved_duplicates"
assert old2 in src, "edge_operations.py 未匹配到旧片段②，请手工合并"
src = src.replace(old2, new2, 1)
open(path, 'w', encoding='utf-8').write(src)
print("✓ 已修补 edge_operations.py")
PYEOF

"$PY" -m py_compile "$DEDUPE" "$EDGE_OPS"
echo "✓ 补丁全部应用，编译通过。"

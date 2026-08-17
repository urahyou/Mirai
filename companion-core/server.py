#!/usr/bin/env python3
"""Python Companion Core 的 stdin/stdout JSON-RPC 入口。

stdout 只输出单行 JSON 响应，诊断信息应输出到 stderr，确保 Electron 可安全解析协议。
"""

from __future__ import annotations

import json
import sys
from typing import Any

from core import CompanionCore, CoreError


def error_response(request_id: Any, message: str) -> dict[str, Any]:
    return {"id": request_id if isinstance(request_id, str) else "", "ok": False, "error": {"message": message}}


def handle_request(core: CompanionCore, request: Any) -> tuple[dict[str, Any], bool]:
    if not isinstance(request, dict):
        return error_response("", "请求必须是对象"), False
    request_id = request.get("id")
    method = request.get("method")
    params = request.get("params", {})
    if not isinstance(request_id, str) or not request_id:
        return error_response("", "请求缺少 id"), False
    if not isinstance(method, str) or not method:
        return error_response(request_id, "请求缺少 method"), False
    if not isinstance(params, dict):
        return error_response(request_id, "params 必须是对象"), False
    try:
        if method == "core.bootstrap":
            result = core.bootstrap(params.get("dataDir", ""))
        elif method == "core.health":
            result = {"ready": core.data_dir is not None, "protocolVersion": 1}
        elif method == "core.snapshot":
            result = core.snapshot()
        elif method == "pet.get_state":
            result = core.pet_get_state(params.get("now"))
        elif method == "pet.apply_event":
            result = core.pet_apply_event(params.get("eventType"), params.get("now"))
        elif method == "event.ingest":
            result = core.ingest(params.get("event"))
        elif method == "core.shutdown":
            result = {"stopped": True}
            return {"id": request_id, "ok": True, "result": result}, True
        else:
            return error_response(request_id, f"未知 method：{method}"), False
    except CoreError as error:
        return error_response(request_id, str(error)), False
    except Exception as error:  # 不把 Python 堆栈或环境细节暴露给 Node 侧。
        print(f"[companion-core] internal error: {error}", file=sys.stderr, flush=True)
        return error_response(request_id, "Core 内部错误"), False
    return {"id": request_id, "ok": True, "result": result}, False


def main() -> int:
    core = CompanionCore()
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError:
            response, should_stop = error_response("", "请求不是合法 JSON"), False
        else:
            response, should_stop = handle_request(core, request)
        print(json.dumps(response, ensure_ascii=False), flush=True)
        if should_stop:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

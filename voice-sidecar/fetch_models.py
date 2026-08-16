#!/usr/bin/env python3
"""把 SenseVoice ASR 模型装到 voice-sidecar/models/（支持从 warashi 一次性拷贝，或从官方下载）。

只依赖 Python 标准库（urllib / tarfile / shutil），无需第三方包：
  1) 若 voice-sidecar/models 下模型已就绪 -> 直接返回；
  2) 否则若本机 warashi 已有模型 -> 拷过来（免重下，一次性迁移，之后彻底断根）；
  3) 都没有 -> 从 sherpa-onnx 官方 release 下载 tar.bz2 并解压（约 1GB）。
"""
import os
import shutil
import sys
import tarfile
import urllib.request

MODEL_DIRNAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
)
LEGACY_HINTS = [
    os.path.expanduser("~/Desktop/warashi"),  # 常见位置
    os.environ.get("LEGACY_WARASHI_ROOT", ""),
]


def _ready(dirpath: str) -> bool:
    return os.path.isfile(os.path.join(dirpath, "model.int8.onnx")) and os.path.isfile(
        os.path.join(dirpath, "tokens.txt")
    )


def main() -> int:
    sidecar = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(sidecar, "models")
    os.makedirs(out, exist_ok=True)
    target = os.path.join(out, MODEL_DIRNAME)

    if _ready(target):
        print(f"[fetch] ready: {target}")
        return 0

    # 1) 从 warashi 一次性拷贝（优先，避免重下 1GB）
    for root in LEGACY_HINTS:
        if not root:
            continue
        legacy = os.path.join(root, "models", MODEL_DIRNAME)
        if _ready(legacy):
            print(f"[fetch] copying model from warashi: {legacy} -> {target}")
            shutil.copytree(legacy, target, dirs_exist_ok=True)
            print("[fetch] copied (模型已迁移，之后不再需要 warashi)")
            return 0

    # 2) 官方下载
    print(f"[fetch] downloading {MODEL_URL} (约 1GB，请耐心等待)...")
    tmp = os.path.join(out, MODEL_DIRNAME + ".tar.bz2")
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=120) as resp, open(tmp, "wb") as f:
            shutil.copyfileobj(resp, f)
        print("[fetch] downloaded, extracting...")
        with tarfile.open(tmp, "r:bz2") as t:
            t.extractall(out)
        os.remove(tmp)
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch] ❌ 下载失败: {exc}")
        if os.path.exists(tmp):
            os.remove(tmp)
        return 1

    if _ready(target):
        print(f"[fetch] ready: {target}")
        return 0
    print("[fetch] ❌ 解压后模型不完整，请检查。")
    return 1


if __name__ == "__main__":
    sys.exit(main())

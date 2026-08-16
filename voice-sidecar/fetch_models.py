#!/usr/bin/env python3
"""把 SenseVoice ASR 模型从官方 release 下载并解压到 voice-sidecar/models/。

只依赖 Python 标准库（urllib / tarfile / shutil），无需第三方包：
  1) 若 voice-sidecar/models 下模型已就绪 -> 直接返回；
  2) 否则从 sherpa-onnx 官方 GitHub release 下载 tar.bz2 并解压（约 1GB）。

这是全新环境一键配置的一部分：不依赖任何本机已有项目/外部路径。
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

"""Mirai 语音侧车 —— 本地 VAD/ASR 最小实现。

从 warashi (Open-LLM-VTuber) 抽取的独立子模块，去掉了对 warashi 项目的依赖。
 - vad.py:   Silero 语音活动检测（VADEngine）
 - asr.py:   Sherpa-ONNX + SenseVoice 语音识别（SenseVoiceRecognizer）

部署：本目录自带 requirements.txt，用独立 venv 安装（voice-sidecar/.venv），
不再复用 warashi 的虚拟环境。模型由 scripts/setup-voice.js 安装到 voice-sidecar/models/。
"""

from .asr import SenseVoiceConfig, SenseVoiceRecognizer
from .vad import SileroVADConfig, VADEngine

__all__ = [
    "SileroVADConfig",
    "VADEngine",
    "SenseVoiceConfig",
    "SenseVoiceRecognizer",
]

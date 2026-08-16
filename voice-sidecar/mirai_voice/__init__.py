"""Mirai 语音侧车 —— 本地 VAD/ASR 最小实现（独立包，不依赖任何外部项目）。

 - vad.py:   Silero 语音活动检测（VADEngine）
 - asr.py:   Sherpa-ONNX + SenseVoice 语音识别（SenseVoiceRecognizer）

部署：本目录自带 requirements.txt，用独立 venv 安装（voice-sidecar/.venv），
全新环境一次配置：模型由 scripts/setup-voice.js 从官方下载安装到 voice-sidecar/models/。
"""

from .asr import SenseVoiceConfig, SenseVoiceRecognizer
from .vad import SileroVADConfig, VADEngine

__all__ = [
    "SileroVADConfig",
    "VADEngine",
    "SenseVoiceConfig",
    "SenseVoiceRecognizer",
]

"""Mirai 语音侧车 —— ASR（语音识别），基于 Sherpa-ONNX + SenseVoice。

本包为 Mirai 独立实现（按 Open-LLM-VTuber 的 ASR/Sherpa-ONNX 设计思路精简重写），不依赖任何外部项目/
本机已有环境。
 - 只保留 `sense_voice` 模型分支；
 - 不做简繁转换（Mirai 要简体，直接返回原文）；
 - 不内置模型下载逻辑（模型由 `npm run setup:voice` 统一安装到
   `voice-sidecar/models/`，见 scripts/setup-voice.js）。

第三方依赖：numpy、sherpa-onnx、onnxruntime、loguru。
"""

import os
from dataclasses import dataclass, field

import sherpa_onnx
from loguru import logger
from onnxruntime import get_available_providers

# SenseVoice 解码语言提示：只支持 auto|zh|en|ja|ko|yue，其余降级 auto。
_SUPPORTED_LANGS = {"auto", "zh", "en", "ja", "ko", "yue"}


def _clamp_language(language: str) -> str:
    """把语言标签/代码映射到 SenseVoice 支持的解码提示 {auto,zh,en,ja,ko,yue}。

    zh-* 特意映射为 'zh'（而非 'auto'）——SenseVoice 的自动检测在短中文片段上
    会误触发（例如中文 -> "Sainging the."），显式 'zh' 锁定对中文更稳健。
    """
    if not language:
        return "auto"
    code = str(language).strip().lower()
    if code in _SUPPORTED_LANGS:
        return code
    if code in ("zh-hk",) or code.startswith("yue"):
        return "yue"
    if code.startswith("zh"):
        return "zh"
    if code.startswith("en"):
        return "en"
    if code.startswith("ja"):
        return "ja"
    if code.startswith("ko"):
        return "ko"
    return "auto"


@dataclass
class SenseVoiceConfig:
    model: str = ""  # SenseVoice 的 model.onnx 路径
    tokens: str = ""  # tokens.txt 路径
    num_threads: int = 4
    use_itn: bool = True  # 使用 ITN（数字/标点规整）
    language: str = "zh"
    provider: str = "cpu"
    sample_rate: int = 16000


class SenseVoiceRecognizer:
    """SenseVoice 离线识别器封装：负责建 recognizer + 提供同步解码。

    sidecar 里共享单例，并加锁串行化 decode（解码无状态）。
    """

    def __init__(self, config: SenseVoiceConfig):
        for attr in ("model", "tokens"):
            if not os.path.isfile(getattr(config, attr)):
                raise FileNotFoundError(
                    f"ASR {attr} 不存在: {getattr(config, attr)}（请先 npm run setup:voice 安装模型）"
                )
        provider = config.provider
        if provider == "cuda" and "CUDAExecutionProvider" not in get_available_providers():
            logger.warning("CUDA provider 不可用，回退 CPU。")
            provider = "cpu"
        self.config = config
        self.provider = provider
        self.language = _clamp_language(config.language)
        self.sample_rate = config.sample_rate
        logger.info(f"Sherpa-Onnx-ASR: Loading SenseVoice ({provider}) from {config.model}")
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=config.model,
            tokens=config.tokens,
            num_threads=config.num_threads,
            use_itn=config.use_itn,
            language=self.language,
            debug=False,
            provider=provider,
        )

    def transcribe(self, int16_pcm: bytes) -> str:
        """把一段 int16 PCM 识别成文本（简体，原样返回）。"""
        import numpy as np

        audio = np.frombuffer(int16_pcm, dtype=np.int16).astype(np.float32)
        stream = self.recognizer.create_stream()
        stream.accept_waveform(self.sample_rate, audio)
        self.recognizer.decode_streams([stream])
        return stream.result.text

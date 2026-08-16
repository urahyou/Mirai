"""Mirai 语音侧车 —— VAD（语音活动检测），基于 Silero。

从 warashi (Open-LLM-VTuber) 的 `open_llm_vtuber/vad/silero.py` 抽取并精简：
 - 去掉 VADInterface 抽象基类、vad_factory、vad_main/__main__、tqdm 进度展示等
   sidecar 用不到的代码；
 - 保留 VADEngine + StateMachine 的核心状态机逻辑，行为与原实现一致。

第三方依赖：numpy、torch、loguru、pydantic、silero-vad（VAD 模型由该包内置，
无需额外下载模型文件）。
"""

from collections import deque
from enum import Enum

import numpy as np
import torch
from loguru import logger
from pydantic import BaseModel
from silero_vad import load_silero_vad


class SileroVADConfig(BaseModel):
    orig_sr: int = 16000
    target_sr: int = 16000
    prob_threshold: float = 0.4
    db_threshold: int = 60
    required_hits: int = 3  # 3 * (0.032) = 0.1s 的语音
    required_misses: int = 24  # 24 * (0.032) = 0.8s 的静音
    smoothing_window: int = 5


class VADEngine:
    """Silero 语音活动检测引擎。每个连接应持有一个独立实例（自带状态机）。"""

    def __init__(
        self,
        orig_sr: int = 16000,
        target_sr: int = 16000,
        prob_threshold: float = 0.4,
        db_threshold: int = 60,
        required_hits: int = 3,
        required_misses: int = 24,
        smoothing_window: int = 5,
    ):
        self.config = SileroVADConfig(
            orig_sr=orig_sr,
            target_sr=target_sr,
            prob_threshold=prob_threshold,
            db_threshold=db_threshold,
            required_hits=required_hits,
            required_misses=required_misses,
            smoothing_window=smoothing_window,
        )
        self.model = self.load_vad_model()
        self.state = StateMachine(self.config)
        self.window_size_samples = 512 if self.config.target_sr == 16000 else 256
        # 512 / 16000 = 0.032 秒

    def load_vad_model(self):
        logger.info("Loading Silero-VAD model...")
        return load_silero_vad()

    def detect_speech(self, audio_data: list[float]):
        """喂入 [-1,1] 的 float PCM（整块），按 512 样本窗口逐步检测。

        迭代产出：
          - b"<|PAUSE|>"   检测到说话开始
          - b"<|RESUME|>"  一句话结束（静音段过完）
          - 原始 int16 字节：整句的 PCM（在 RESUME 之后单独 yield），供最终识别
        """
        audio_np = np.array(audio_data, dtype=np.float32)
        for i in range(0, len(audio_np), self.window_size_samples):
            chunk_np = audio_np[i : i + self.window_size_samples]
            if len(chunk_np) < self.window_size_samples:
                break
            chunk = torch.Tensor(chunk_np)

            with torch.no_grad():
                speech_prob = self.model(chunk, self.config.target_sr).item()

            if speech_prob:
                for probs, dbs, chunk in self.state.get_result(speech_prob, chunk_np):
                    audio_chunk = bytes(chunk)
                    yield audio_chunk

        del audio_np


# 定义状态枚举
class State(Enum):
    IDLE = 1  # 空闲状态，等待语音
    ACTIVE = 2  # 检测到语音状态
    INACTIVE = 3  # 语音结束状态（静音状态）


class StateMachine:
    def __init__(self, config: SileroVADConfig):
        self.state = State.IDLE
        self.prob_threshold = config.prob_threshold
        self.db_threshold = config.db_threshold
        self.required_hits = config.required_hits
        self.required_misses = config.required_misses
        self.smoothing_window = config.smoothing_window

        self.probs = []
        self.dbs = []
        self.bytes = bytearray()
        self.miss_count = 0
        self.hit_count = 0

        self.prob_window = deque(maxlen=self.smoothing_window)
        self.db_window = deque(maxlen=self.smoothing_window)

        self.pre_buffer = deque(maxlen=20)

    @classmethod
    def calculate_db(cls, audio_data: np.ndarray) -> float:
        rms = np.sqrt(np.mean(np.square(audio_data)))
        return 20 * np.log10(rms + 1e-7) if rms > 0 else -np.inf

    def update(self, chunk_bytes, prob, db):
        self.probs.append(prob)
        self.dbs.append(db)
        self.bytes.extend(chunk_bytes)

    def reset_buffers(self):
        self.probs.clear()
        self.dbs.clear()
        self.bytes.clear()

    def get_smoothed_values(self, prob, db):
        self.prob_window.append(prob)
        self.db_window.append(db)
        smoothed_prob = np.mean(self.prob_window)
        smoothed_db = np.mean(self.db_window)
        return smoothed_prob, smoothed_db

    def process(self, prob, float_chunk_np: np.ndarray):
        int_chunk_np = float_chunk_np * 32767
        chunk_bytes = int_chunk_np.astype(np.int16).tobytes()
        db = self.calculate_db(int_chunk_np)

        # 获取平滑后的 prob 和 db
        smoothed_prob, smoothed_db = self.get_smoothed_values(prob, db)

        if self.state == State.IDLE:
            self.pre_buffer.append(chunk_bytes)
            if (
                smoothed_prob >= self.prob_threshold
                and smoothed_db >= self.db_threshold
            ):
                self.hit_count += 1
                if self.hit_count >= self.required_hits:
                    self.state = State.ACTIVE
                    self.update(chunk_bytes, smoothed_prob, smoothed_db)
                    self.hit_count = 0
                    yield [], [], b"<|PAUSE|>"
            else:
                self.hit_count = 0

        elif self.state == State.ACTIVE:
            self.update(chunk_bytes, smoothed_prob, smoothed_db)
            if (
                smoothed_prob >= self.prob_threshold
                and smoothed_db >= self.db_threshold
            ):
                self.miss_count = 0
            else:
                self.miss_count += 1
                if self.miss_count >= self.required_misses:
                    self.state = State.INACTIVE
                    self.miss_count = 0

        elif self.state == State.INACTIVE:
            self.update(chunk_bytes, smoothed_prob, smoothed_db)
            if (
                smoothed_prob >= self.prob_threshold
                and smoothed_db >= self.db_threshold
            ):
                self.hit_count += 1
                if self.hit_count >= self.required_hits:
                    self.state = State.ACTIVE
                    self.hit_count = 0
                    self.miss_count = 0
            else:
                self.hit_count = 0
                self.miss_count += 1
                if self.miss_count >= self.required_misses:
                    self.state = State.IDLE
                    self.miss_count = 0
                    yield [], [], b"<|RESUME|>"
                    if len(self.probs) > 30:
                        pre_bytes = b"".join(self.pre_buffer)
                        yield self.probs, self.dbs, pre_bytes + self.bytes
                        self.reset_buffers()
                    self.pre_buffer.clear()

    def get_result(self, input_num, chunk_np):
        yield from self.process(input_num, chunk_np)

#!/usr/bin/env python3
"""
Mirai 语音侧车 —— 语音输入半程：
  微信同级进程边界之外，把"麦克风→VAD→ASR"做成一个本地 WebSocket 服务，
  VAD/ASR 内核用本地独立包 mirai_voice（从 warashi 抽取的最小实现，不再依赖 warashi）。

协议（与 warashi 前端一致的方向，但做了简化）：
  客户端 → 本服务（二进制）：int16 PCM，单声道，16kHz，小端，原始字节块
  客户端 → 本服务（JSON）：
    {"type":"speak","text":"<要朗读的文字>","id":<可选>}   语音输出：合成语音
  本服务 → 客户端（JSON 文本）：
    {"type":"ready"}                        连接建立、模型加载完成
    {"type":"vad","state":"speech_start"}   检测到说话开始（可用来打断 TTS）
    {"type":"vad","state":"speech_end"}     一句话结束
    {"type":"asr","text":"<识别的文字>"}      一句话的最终识别结果
    {"type":"audio","id":<对应speak的id>,"format":"mp3","data":"<base64>"}
                                                对 speak 的响应：合成好的 MP3（base64）

环境变量：
  SIDECAR_HOST      默认 127.0.0.1
  SIDECAR_PORT      默认 8765
  SIDECAR_MODEL_DIR / SIDECAR_ASR_MODEL / SIDECAR_TOKENS   ASR 模型路径
  SIDECAR_ASR_LANGUAGE   默认 zh（简体中文）
  TTS 引擎（SIDECAR_TTS_ENGINE）：
    edge        默认。edge_tts 云端合成（需联网），音色由 SIDECAR_TTS_VOICE 指定。
    gpt-sovits  本地音色克隆。请求本机 GPT-SoVITS API（默认 http://127.0.0.1:9880/），
                用参考音频克隆角色音色，完全离线（输出 wav）。
  SIDECAR_TTS_VOICE        edge 用：edge_tts 音色，默认 zh-CN-XiaoxiaoNeural（中文女声小雪）
  SIDECAR_TTS_URL          gpt-sovits 用：GPT-SoVITS API 地址，默认 http://127.0.0.1:9880/
  SIDECAR_TTS_REF_WAV      gpt-sovits 用：参考音频绝对路径（服务所在机上的路径）
  SIDECAR_TTS_PROMPT_TEXT  gpt-sovits 用：参考音频对应的台词（日文参考通常必填）
  SIDECAR_TTS_PROMPT_LANG  gpt-sovits 用：参考台词语言，默认 zh（可选 ja/en/…）
  SIDECAR_TTS_TEXT_LANGUAGE gpt-sovits 用：合成语言，默认 zh（可选 ja/en/auto…）
  SIDECAR_TTS_TEMPERATURE  gpt-sovits 用：默认 0.9
  SIDECAR_TTS_SPEED_FACTOR gpt-sovits 用：语速 0.75–1.25，默认 1.0（省略不传）
"""

import asyncio
import base64
import json
import os
import threading

import numpy as np

from mirai_voice.vad import VADEngine
from mirai_voice.asr import SenseVoiceConfig, SenseVoiceRecognizer

SAMPLE_RATE = 16000

# 本文件所在目录（voice-sidecar/）——包、models、venv 都以它为基准
_SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))

HOST = os.environ.get("SIDECAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIDECAR_PORT", "8765"))

# ASR 模型路径（默认指向本仓库 voice-sidecar/models/ 下的 SenseVoice 模型）
_model_dir = os.environ.get(
    "SIDECAR_MODEL_DIR",
    os.path.join(
        _SIDECAR_DIR,
        "models",
        "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    ),
)
ASR_MODEL = os.environ.get("SIDECAR_ASR_MODEL", os.path.join(_model_dir, "model.int8.onnx"))
ASR_TOKENS = os.environ.get("SIDECAR_TOKENS", os.path.join(_model_dir, "tokens.txt"))
ASR_LANGUAGE = os.environ.get("SIDECAR_ASR_LANGUAGE", "zh")
ASR_NUM_THREADS = int(os.environ.get("SIDECAR_ASR_THREADS", "4"))
# TTS 音色（edge_tts），默认中文女声小雪
TTS_VOICE = os.environ.get("SIDECAR_TTS_VOICE", "zh-CN-XiaoxiaoNeural")

# TTS 引擎开关：edge（默认，edge_tts 云合成）| gpt-sovits（本地音色克隆，GPT-SoVITS API）
TTS_ENGINE = os.environ.get("SIDECAR_TTS_ENGINE", "edge").strip().lower()
# GPT-SoVITS 参数（仅 TTS_ENGINE=gpt-sovits 时使用）
TTS_URL = os.environ.get("SIDECAR_TTS_URL", "http://127.0.0.1:9880/").strip()
TTS_REF_WAV = os.environ.get("SIDECAR_TTS_REF_WAV", "").strip()
TTS_PROMPT_TEXT = os.environ.get("SIDECAR_TTS_PROMPT_TEXT", "").strip()
TTS_PROMPT_LANG = os.environ.get("SIDECAR_TTS_PROMPT_LANG", "zh").strip()
TTS_TEXT_LANGUAGE = os.environ.get("SIDECAR_TTS_TEXT_LANGUAGE", "zh").strip()
TTS_TEMPERATURE = float(os.environ.get("SIDECAR_TTS_TEMPERATURE", "0.9"))
TTS_SPEED_FACTOR = os.environ.get("SIDECAR_TTS_SPEED_FACTOR", "").strip()

_log = lambda *a: print("[sidecar]", *a, flush=True)  # noqa: E731


def _build_asr():
    """直接建 SenseVoice recognizer，返回简体识别结果（Mirai 要简体）。"""
    config = SenseVoiceConfig(
        model=ASR_MODEL,
        tokens=ASR_TOKENS,
        num_threads=ASR_NUM_THREADS,
        use_itn=True,
        language=ASR_LANGUAGE,
        provider="cpu",
    )
    return SenseVoiceRecognizer(config)


# 全局共享的 ASR（解码无状态；用锁防止并发 decode_streams 竞争）
_asr = None
_asr_lock = threading.Lock()


def asr_decode(raw_int16: bytes) -> str:
    """把一段 int16 PCM 识别成简体文字。"""
    global _asr
    if _asr is None:
        # 正常在启动时已预建；此处兜底（加锁防并发重复构建）
        with _asr_lock:
            if _asr is None:
                _asr = _build_asr()
    audio = np.frombuffer(raw_int16, dtype=np.int16).astype(np.float32)
    with _asr_lock:
        stream = _asr.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        _asr.recognizer.decode_streams([stream])
        return stream.result.text

async def handle_connection(websocket):
    vad = VADEngine()  # 每个连接独立的状态机
    _log("client connected, models ready")
    await websocket.send(json.dumps({"type": "ready"}))
    loop = asyncio.get_running_loop()

    # 音频接收循环只负责快速喂 VAD；所有 ASR 解码放到后台任务，绝不阻塞音频流入。
    in_speech = False            # VAD 是否正处于说话段
    active = bytearray()         # 当前说话段的原始 PCM 字节（供飘字部分识别）
    gen = 0                      # 代次：每一轮说话结束时 +1，防止旧飘字覆盖最终结果
    bg = set()                   # 后台解码任务引用
    send_lock = asyncio.Lock()   # 串行化并发 websocket.send

    def spawn(coro):
        """fire-and-forget 任务，防止事件循环被解码阻塞。"""
        task = asyncio.ensure_future(coro)
        bg.add(task)
        task.add_done_callback(bg.discard)

    async def send_json(payload):
        try:
            async with send_lock:
                await websocket.send(json.dumps(payload))
        except Exception:  # noqa: BLE001
            pass

    async def decode_final(raw, my_gen):
        if my_gen != gen:
            return
        text = await loop.run_in_executor(None, asr_decode, raw)
        if text and text.strip():
            await send_json({"type": "asr", "partial": False, "text": text})

    async def decode_partial(raw, my_gen):
        if my_gen != gen:
            return
        try:
            text = await loop.run_in_executor(None, asr_decode, raw)
        except Exception:  # noqa: BLE001
            return
        if my_gen != gen or not (text and text.strip()):
            return
        await send_json({"type": "asr", "partial": True, "text": text})

    async def partial_loop():
        """说话期间每 ~0.7s 解码一次当前累积音频，产生飘字。"""
        while True:
            await asyncio.sleep(0.7)
            if in_speech and len(active) > 2048:
                snapshot = bytes(active)
                spawn(decode_partial(snapshot, gen))

    def _synth_edge(text) -> bytes:
        """edge_tts 云端合成 → MP3。"""
        import edge_tts

        buf = bytearray()

        async def _run():
            com = edge_tts.Communicate(text, TTS_VOICE)
            async for chunk in com.stream():
                if chunk["type"] == "audio":
                    buf.extend(chunk["data"])

        asyncio.run(_run())
        return bytes(buf)

    def _synth_gpt_sovits(text) -> bytes:
        """GPT-SoVITS 本地音色克隆 → WAV。请求 JSON 到根路径，非流式取回单个 wav。"""
        import urllib.request

        if not TTS_REF_WAV:
            _log("gpt-sovits: SIDECAR_TTS_REF_WAV 未设置，无法合成")
            return b""
        payload = {
            "ref_audio_path": TTS_REF_WAV,   # api_v2 字段（旧 api.py 用 refer_wav_path）
            "text": text,
            "text_lang": TTS_TEXT_LANGUAGE,
            "prompt_lang": TTS_PROMPT_LANG,
            "media_type": "wav",
            "streaming_mode": False,
            "temperature": TTS_TEMPERATURE,
            "top_k": 15,
            "top_p": 1,
            "text_split_method": "cut5",
            "batch_size": 1,
        }
        if TTS_PROMPT_TEXT:
            payload["prompt_text"] = TTS_PROMPT_TEXT
        if TTS_SPEED_FACTOR:
            try:
                payload["speed_factor"] = max(0.75, min(1.25, float(TTS_SPEED_FACTOR)))
            except ValueError:
                pass
        req = urllib.request.Request(
            TTS_URL.rstrip("/") + "/tts",  # api_v2 端点是 /tts（非根路径）
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()

    async def handle_speak(text, req_id):
        """收到 {type:'speak'} → 按 TTS_ENGINE 合成语音，回传 base64 audio。"""
        text = (text or "").strip()
        if not text:
            return

        synth = _synth_gpt_sovits if TTS_ENGINE == "gpt-sovits" else _synth_edge
        fmt = "wav" if TTS_ENGINE == "gpt-sovits" else "mp3"

        try:
            audio = await loop.run_in_executor(None, synth, text)
        except Exception as exc:  # noqa: BLE001
            _log("tts failed:", repr(exc))
            return
        if not audio:
            _log("tts produced empty audio")
            return
        await send_json(
            {
                "type": "audio",
                "id": req_id,
                "format": fmt,
                "data": base64.b64encode(audio).decode("ascii"),
            }
        )

    spawn(partial_loop())

    try:
        async for message in websocket:
            # 二进制 = int16 PCM 原始块
            if isinstance(message, (bytes, bytearray)):
                data = bytes(message)
                if not data or len(data) % 2 != 0:
                    continue
                pcm_i16 = np.frombuffer(data, dtype=np.int16)
                chunk_f = pcm_i16.astype(np.float32) / 32768.0
                for out in vad.detect_speech(chunk_f.tolist()):
                    if out == b"<|PAUSE|>":
                        in_speech = True
                        active = bytearray()
                        await send_json({"type": "vad", "state": "speech_start"})
                    elif out == b"<|RESUME|>":
                        in_speech = False
                        gen += 1
                        await send_json({"type": "vad", "state": "speech_end"})
                    elif len(out) > 1024:
                        # VAD 在句末吐出整句字节（在 RESUME 之后单独 yield），供最终识别
                        gen += 1
                        spawn(decode_final(out, gen))
                if in_speech:
                    active.extend(data)
            # 文本 = 控制信息
            else:
                try:
                    payload = json.loads(message)
                    if payload.get("type") == "ping":
                        await send_json({"type": "pong"})
                    elif payload.get("type") == "reset":
                        in_speech = False
                        active = bytearray()
                        gen += 1
                    elif payload.get("type") == "speak":
                        spawn(handle_speak(payload.get("text", ""), payload.get("id", 0)))
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        _log("connection ended:", repr(exc))
    finally:
        for task in list(bg):
            task.cancel()
        _log("client disconnected")


async def main():
    import websockets

    # 启动时预加载 ASR 模型（避免首句识别时阻塞事件循环）
    global _asr
    _log("preloading ASR model...")
    _asr = _build_asr()

    _log(f"listening on ws://{HOST}:{PORT}  (voice-sidecar)")
    async with websockets.serve(handle_connection, HOST, PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

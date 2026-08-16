#!/usr/bin/env python3
"""MPS 上验证 Qwen3TTS-1.7B 能否合成中文（音色克隆）。"""
import os, sys, time
Q = '/Users/urahyou/Desktop/Mirai/vendor/qwen3tts/Qwen3TTS-0.6b-API'
sys.path.insert(0, Q)
sys.path.insert(0, os.path.join(Q, 'qwen_tts'))

import torch, numpy as np
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
DTYPE_NAME = os.environ.get('DTYPE', 'bfloat16')
DTYPE = getattr(torch, DTYPE_NAME)
DEVICE = os.environ.get('DEVICE', 'mps')
MODEL = '/Users/urahyou/Desktop/Mirai/vendor/qwen3tts/Qwen3TTS-0.6b-API/Qwen3-TTS-12Hz-0.6B-Base'
REF = '/Users/urahyou/Desktop/bandori-pet-rev/audio_reference/anon.mp3'
OUT = f'/tmp/qwen_tts_{DEVICE}_{DTYPE_NAME}.wav'

print(f'[1] 加载模型 device={DEVICE} dtype={DTYPE_NAME} ...', flush=True)
t0 = time.time()
from qwen_tts import Qwen3TTSModel
tts = Qwen3TTSModel.from_pretrained(
    MODEL,
    device_map=DEVICE,
    dtype=DTYPE,
    attn_implementation='sdpa',
)
print(f'[1] 模型加载完成 {time.time()-t0:.1f}s', flush=True)

print('[2] 读参考音频 ...', flush=True)
try:
    import soundfile as sf
    audio, sr = sf.read(REF, dtype='float32', always_2d=False)
    print(f'    sf.read: sr={sr} len={len(audio)}', flush=True)
except Exception as e:
    print('    sf.read 失败，改 librosa:', repr(e), flush=True)
    import librosa
    audio, sr = librosa.load(REF, sr=None, mono=True)
    print(f'    librosa: sr={sr} len={len(audio)}', flush=True)

print('[3] 合成中文（x_vector_only 音色克隆）...', flush=True)
t1 = time.time()
wavs, sr_out = tts.generate_voice_clone(
    text='你好，我是小未来，很高兴认识你。',
    language='Chinese',
    ref_audio=(audio, sr),
    x_vector_only_mode=True,
    do_sample=True,
    top_k=50, top_p=1.0, temperature=0.9,
)
dt = time.time() - t1
print(f'[3] 合成完成 device={DEVICE} dtype={DTYPE_NAME} 耗时={dt:.1f}s 输出sr={sr_out} len={len(wavs[0])} 音频{len(wavs[0])/sr_out:.1f}s RTF={dt/(len(wavs[0])/sr_out):.1f}x', flush=True)

import soundfile as sf
sf.write(OUT, wavs[0], sr_out)
print(f'[4] 已写 {OUT} 大小={os.path.getsize(OUT)}B', flush=True)
print('DONE', flush=True)

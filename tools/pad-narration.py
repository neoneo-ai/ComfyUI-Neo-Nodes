"""按实测节拍时间把旁白段对齐到录制时间轴，补静音，写 narration_sync.wav。

用法: python tools/pad-narration.py <scenario> <beat-timings.json> [总时长秒] [片头秒]
beat-timings.json 由 tools/capture-video.mjs 在录制结束时写出：
[{index, start, dur}]，start 是该拍在录制时间轴上的实测起点（秒）。
总秒数取录制（webm）长度，保证音轨铺满整条视频。
片头秒是第一拍之前的白屏加载时长，成片用 -ss 切掉，旁白起点同步前移。
"""
import json
import os
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_wav(path):
    with wave.open(path, 'rb') as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        return data, w.getframerate()


def main():
    scenario, timings_path = sys.argv[1], sys.argv[2]
    nar_dir = os.path.join(ROOT, 'tmp', 'narration', scenario)
    segs = json.load(open(os.path.join(nar_dir, 'segments.json'), encoding='utf-8'))
    timings = json.load(open(timings_path, encoding='utf-8'))
    sr = segs['sample_rate']
    lead = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
    total = max(t['start'] + t['dur'] for t in timings) + 0.6 - lead
    if len(sys.argv) > 3:
        total = max(total, float(sys.argv[3]) - lead)
    out = np.zeros(int(total * sr), dtype=np.int32)
    for t in timings:
        seg = segs['segments'][t['index']]
        data, rate = read_wav(os.path.join(nar_dir, seg['path']))
        if rate != sr:
            raise SystemExit(f"{seg['path']} 采样率 {rate} != {sr}")
        pos = int((t['start'] - lead) * sr)
        if pos < 0:
            data = data[-pos:]
            pos = 0
        end = min(pos + len(data), len(out))
        out[pos:end] += data[:end - pos]
    out = np.clip(out, -32768, 32767).astype(np.int16)
    path = os.path.join(nar_dir, 'narration_sync.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(out.tobytes())
    print(f'narration_sync.wav {total:.2f} s -> {path}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python
"""
make_synth_video.py — a synthetic side-view clip to test truth_cam.py without a webcam.

A grey "phone" with a red sticker moves like a 50 mm, 110/min compression at
0.5 mm per pixel for 15 s.  Then:

    python tools/make_synth_video.py                # writes tools/_synth_side.mp4
    python tools/truth_cam.py --video tools/_synth_side.mp4 --headless --mm-per-px 0.5 --marker-hsv 0,255,255
    -> 27 compressions tracked, depth mean 50.0 mm, sd 0.4 mm
"""
import math
import os

import cv2
import numpy as np

W, H, FPS = 640, 480, 30
MM_PER_PX = 0.5
RATE, DEPTH_MM, SECONDS = 110, 50, 15


def main():
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_synth_side.mp4")
    out = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    T = 60 / RATE
    for i in range(FPS * SECONDS):
        t = i / FPS
        phase = (t / T) % 1
        x = -DEPTH_MM * 0.5 * (1 - math.cos(2 * math.pi * phase))       # 0 .. -DEPTH (pressed)
        y = 240 - x / MM_PER_PX                                          # pressed = larger y
        f = np.full((H, W, 3), (40, 40, 40), np.uint8)
        cv2.rectangle(f, (200, int(y)), (440, int(y) + 140), (90, 90, 90), -1)       # phone body
        cv2.circle(f, (320, int(y) + 10), 12, (0, 0, 255), -1)                       # red sticker
        cv2.line(f, (500, 100), (500, 100 + int(146 / MM_PER_PX)), (255, 255, 255), 2)  # 146 mm ruler
        out.write(f)
    out.release()
    print("wrote", out_path)


if __name__ == "__main__":
    main()

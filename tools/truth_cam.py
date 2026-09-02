#!/usr/bin/env python
"""
truth_cam.py — webcam ground truth for the depth estimate.

Film the phone from the SIDE while you compress. A bright sticker (or the
phone's edge) is tracked frame by frame; its vertical travel in millimetres is
the *true* compression depth, independent of the accelerometer.

    python tools/truth_cam.py                     # live webcam, click the marker colour
    python tools/truth_cam.py --video clip.mp4    # a recorded side-view clip
    python tools/truth_cam.py --video clip.mp4 --scale-mm 146 --out truth.csv

Calibration: either give --mm-per-px, or --scale-mm <known length> and click
two points that far apart (e.g. the phone's long edge, 146 mm for many phones).

Output CSV: t_s,x_px,y_px,y_mm  plus per-compression rows (cycle_end_s,depth_mm).
Compare with the app's CSV export using tools/compare_truth.py.

Requires: pip install numpy opencv-python   (the project .venv has them)
"""
import argparse
import csv
import sys
import time

import cv2
import numpy as np


def hsv_range(h, s, v, dh=10, ds=80, dv=80):
    lo = np.array([max(0, h - dh), max(0, s - ds), max(0, v - dv)])
    hi = np.array([min(179, h + dh), 255, 255])
    return lo, hi


class Tracker:
    """HSV colour-blob tracker. Click on the marker to pick its colour."""

    def __init__(self):
        self.lo = self.hi = None
        self.calib_pts = []
        self.mm_per_px = None

    def pick(self, frame, x, y):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        patch = hsv[max(0, y - 3):y + 4, max(0, x - 3):x + 4].reshape(-1, 3)
        h, s, v = np.median(patch, axis=0)
        self.lo, self.hi = hsv_range(int(h), int(s), int(v))

    def find(self, frame):
        if self.lo is None:
            return None
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, self.lo, self.hi)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            return None
        c = max(cnts, key=cv2.contourArea)
        if cv2.contourArea(c) < 30:
            return None
        m = cv2.moments(c)
        return (m["m10"] / m["m00"], m["m01"] / m["m00"], cv2.contourArea(c))


def cycles_from_track(ts, ys_mm, min_depth_mm=8.0):
    """Split a vertical track into compressions: local maxima of downward travel."""
    ys = np.asarray(ys_mm)
    if len(ys) < 5:
        return []
    # no smoothing (it shaves the peaks); the min_depth hysteresis rejects jitter
    sm = ys
    out = []
    last_peak = sm[0]
    state = "up"
    valley_val, valley_i = None, None
    for i in range(1, len(sm)):
        if state == "up":
            if sm[i] < last_peak - min_depth_mm:
                state = "down"; valley_val, valley_i = sm[i], i
            else:
                last_peak = max(last_peak, sm[i])
        else:
            if sm[i] < valley_val:
                valley_val, valley_i = sm[i], i
            elif sm[i] > valley_val + min_depth_mm * 0.6:
                out.append((ts[valley_i], last_peak - valley_val))
                state = "up"; last_peak = sm[i]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", help="video file instead of the webcam")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--mm-per-px", type=float)
    ap.add_argument("--scale-mm", type=float, default=146.0, help="known length for the 2-click calibration")
    ap.add_argument("--out", default="truth.csv")
    ap.add_argument("--headless", action="store_true", help="no window: needs --video, --mm-per-px and --marker-hsv")
    ap.add_argument("--marker-hsv", help="h,s,v of the marker colour (headless)")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video if args.video else args.camera)
    if not cap.isOpened():
        sys.exit("cannot open camera/video")
    fps_file = cap.get(cv2.CAP_PROP_FPS) or 30.0

    tr = Tracker()
    if args.mm_per_px:
        tr.mm_per_px = args.mm_per_px
    if args.marker_hsv:
        h, s, v = [int(x) for x in args.marker_hsv.split(",")]
        tr.lo, tr.hi = hsv_range(h, s, v)
    if args.headless and (tr.mm_per_px is None or tr.lo is None):
        sys.exit("--headless needs --mm-per-px and --marker-hsv")

    state = {"frame": None}

    def on_mouse(ev, x, y, flags, param):
        if ev != cv2.EVENT_LBUTTONDOWN or state["frame"] is None:
            return
        if tr.mm_per_px is None:
            tr.calib_pts.append((x, y))
            if len(tr.calib_pts) == 2:
                (x1, y1), (x2, y2) = tr.calib_pts
                px = float(np.hypot(x2 - x1, y2 - y1))
                tr.mm_per_px = args.scale_mm / px
                print(f"calibrated: {tr.mm_per_px:.4f} mm/px ({px:.1f} px = {args.scale_mm} mm)")
        elif tr.lo is None:
            tr.pick(state["frame"], x, y)
            print(f"marker colour picked: HSV lo={tr.lo.tolist()} hi={tr.hi.tolist()}")

    if not args.headless:
        cv2.namedWindow("truth_cam")
        cv2.setMouseCallback("truth_cam", on_mouse)

    rows, ts, ys = [], [], []
    t_start = time.time()
    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        state["frame"] = frame
        t = n / fps_file if args.video else time.time() - t_start
        n += 1
        hit = tr.find(frame)
        if hit and tr.mm_per_px:
            y_mm = hit[1] * tr.mm_per_px
            rows.append((t, hit[0], hit[1], y_mm))
            ts.append(t); ys.append(-y_mm)     # up = positive so a compression is a valley
        if not args.headless:
            disp = frame.copy()
            msg = ("click 2 points %d mm apart" % args.scale_mm) if tr.mm_per_px is None else ("click the marker" if tr.lo is None else f"tracking  n={len(rows)}  q=quit")
            cv2.putText(disp, msg, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
            for p in tr.calib_pts:
                cv2.circle(disp, p, 5, (0, 255, 255), -1)
            if hit:
                cv2.circle(disp, (int(hit[0]), int(hit[1])), 8, (0, 0, 255), 2)
            cv2.imshow("truth_cam", disp)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    cap.release()
    if not args.headless:
        cv2.destroyAllWindows()

    cyc = cycles_from_track(ts, ys)
    with open(args.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["t_s", "x_px", "y_px", "y_mm"])
        w.writerows([(f"{r[0]:.3f}", f"{r[1]:.1f}", f"{r[2]:.1f}", f"{r[3]:.2f}") for r in rows])
        w.writerow([])
        w.writerow(["cycle_end_s", "depth_mm"])
        w.writerows([(f"{t:.3f}", f"{d:.1f}") for t, d in cyc])
    if cyc:
        d = np.array([c[1] for c in cyc])
        print(f"{len(cyc)} compressions tracked, depth mean {d.mean():.1f} mm, sd {d.std():.1f} mm -> {args.out}")
    else:
        print(f"no compressions detected ({len(rows)} tracked frames) -> {args.out}")


if __name__ == "__main__":
    main()

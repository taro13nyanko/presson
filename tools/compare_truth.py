#!/usr/bin/env python
"""
compare_truth.py — align the app's per-compression depths with the webcam
ground truth and print the agreement.

    python tools/compare_truth.py presson-compressions.csv truth.csv [--offset SECONDS]

The two clocks are different (phone vs laptop), so the script finds the time
offset that best matches the compression sequences (or use --offset), then
pairs compressions by nearest time and reports mean error, SD and the limits
of agreement, plus a small SVG plot (compare.svg) you can drop into a README.
"""
import argparse
import csv
import sys

import numpy as np


def read_app(path):
    t, d = [], []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            t.append(float(r["t_s"])); d.append(float(r["depth_cm"]) * 10.0)
    return np.array(t), np.array(d)


def read_truth(path):
    t, d = [], []
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    i = next((k for k, r in enumerate(rows) if r and r[0] == "cycle_end_s"), None)
    if i is None:
        sys.exit("truth.csv has no cycle table (run truth_cam.py first)")
    for r in rows[i + 1:]:
        if len(r) >= 2 and r[0]:
            t.append(float(r[0])); d.append(float(r[1]))
    return np.array(t), np.array(d)


def best_offset(ta, tb, lo=-60, hi=60, step=0.05):
    best, bo = -1, 0.0
    for off in np.arange(lo, hi, step):
        tb2 = tb + off
        # score = number of app compressions with a truth compression within 0.15 s
        idx = np.searchsorted(tb2, ta)
        near = 0
        for k, t in enumerate(ta):
            for j in (idx[k] - 1, idx[k]):
                if 0 <= j < len(tb2) and abs(tb2[j] - t) < 0.15:
                    near += 1; break
        if near > best:
            best, bo = near, off
    return bo, best


def svg(pairs, path):
    W, H, L, B = 520, 300, 50, 40
    a = np.array([p[0] for p in pairs]); b = np.array([p[1] for p in pairs])
    mx = max(80, a.max() * 1.1, b.max() * 1.1)
    def X(v): return L + v / mx * (W - L - 20)
    def Y(v): return H - B - v / mx * (H - B - 20)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="sans-serif" font-size="12">',
           f'<rect width="{W}" height="{H}" fill="#fff"/>',
           f'<line x1="{X(0)}" y1="{Y(0)}" x2="{X(mx)}" y2="{Y(mx)}" stroke="#bbb" stroke-dasharray="4 4"/>']
    for v in (20, 40, 50, 60, 80):
        if v < mx:
            out.append(f'<text x="{X(v)}" y="{H-B+16}" text-anchor="middle">{v}</text><text x="{L-8}" y="{Y(v)+4}" text-anchor="end">{v}</text>')
    for x, y in zip(a, b):
        out.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="3" fill="#3ea6ff" fill-opacity="0.7"/>')
    out.append(f'<text x="{W/2}" y="{H-8}" text-anchor="middle">webcam depth (mm)</text>')
    out.append(f'<text transform="translate(14,{H/2}) rotate(-90)" text-anchor="middle">PressOn depth (mm)</text>')
    out.append('</svg>')
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("app_csv"); ap.add_argument("truth_csv")
    ap.add_argument("--offset", type=float, help="truth time + offset = app time (auto if omitted)")
    ap.add_argument("--svg", default="compare.svg")
    args = ap.parse_args()
    ta, da = read_app(args.app_csv)
    tb, db = read_truth(args.truth_csv)
    if not len(ta) or not len(tb):
        sys.exit("empty input")
    off, matched = (args.offset, None) if args.offset is not None else best_offset(ta, tb)
    tb = tb + off
    pairs = []
    for t, d in zip(ta, da):
        j = int(np.argmin(np.abs(tb - t)))
        if abs(tb[j] - t) < 0.15:
            pairs.append((db[j], d))
    if len(pairs) < 3:
        sys.exit(f"only {len(pairs)} matched compressions (offset {off:+.2f} s) — check the offset or the tracking")
    x = np.array([p[0] for p in pairs]); y = np.array([p[1] for p in pairs])
    err = y - x
    print(f"offset {off:+.2f} s, {len(pairs)} of {len(ta)} app compressions matched to webcam cycles")
    print(f"webcam mean depth {x.mean():.1f} mm, PressOn mean depth {y.mean():.1f} mm")
    print(f"error: mean {err.mean():+.1f} mm, SD {err.std():.1f} mm, limits of agreement {err.mean()-1.96*err.std():+.1f} .. {err.mean()+1.96*err.std():+.1f} mm")
    print(f"mean absolute error {np.abs(err).mean():.1f} mm ({np.abs(err).mean()/x.mean()*100:.1f} % of mean depth)")
    svg(pairs, args.svg)
    print(f"plot -> {args.svg}")


if __name__ == "__main__":
    main()

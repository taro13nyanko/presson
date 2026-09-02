#!/usr/bin/env python
"""
serial_bridge.py — show a real PressOn trainer (ESP32) on the instructor screen.

Reads the JSON lines the firmware prints on USB serial and forwards them to
tools/serve.py's /api/report, so the puck appears next to the phones.

    pip install pyserial
    python tools/serial_bridge.py COM5 --server https://192.168.1.42:8443 --name "Puck A"
"""
import argparse
import json
import ssl
import sys
import time
import urllib.request


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", help="serial port, e.g. COM5 or /dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--server", default="http://localhost:8443")
    ap.add_argument("--name", default="ESP32 trainer")
    args = ap.parse_args()
    try:
        import serial  # pyserial
    except ImportError:
        sys.exit("pip install pyserial")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE          # self-signed local certificate
    ser = serial.Serial(args.port, args.baud, timeout=1)
    state = {"id": "esp32-" + args.port.replace("/", "_"), "name": args.name, "mode": "trainer", "ended": False,
             "t": 0, "count": 0, "rate": 0, "depthCm": 0.0, "paused": False, "handsOff": 0, "ccf": 100, "status": "none", "stats": None}
    t0 = time.time()
    print("bridging", args.port, "->", args.server)
    while True:
        line = ser.readline().decode("utf-8", "replace").strip()
        if not line:
            continue
        print(line)
        if not line.startswith("{"):
            continue
        try:
            j = json.loads(line)
        except ValueError:
            continue
        kind = j.get("type")
        if kind == "start":
            t0 = time.time(); state.update(ended=False, count=0, rate=0, depthCm=0.0, status="none", stats=None)
        elif kind == "comp":
            st = j.get("status", "")
            state.update(t=int(time.time() - t0), count=j.get("count", 0), rate=int(round(j.get("rate", 0))),
                         depthCm=float(j.get("depth_cm", 0)), paused=False,
                         status={"GOOD": "good", "PUSH HARDER": "harder", "A LITTLE LESS": "softer", "FASTER": "faster", "SLOWER": "slower", "RESUME!": "paused"}.get(st, "none"))
        elif kind == "cue" and j.get("cue") in ("resume", "handsoff"):
            state.update(paused=True, status="paused")
        elif kind == "end":
            state.update(ended=True, stats={"inTargetPct": j.get("in_target_pct", 0)}, handsOff=int(j.get("hands_off_s", 0)), ccf=j.get("ccf_pct", 0))
        else:
            continue
        req = urllib.request.Request(args.server.rstrip("/") + "/api/report", data=json.dumps(state).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=2, context=ctx).read()
        except Exception as e:  # noqa: BLE001
            print("  (relay failed:", e, ")")


if __name__ == "__main__":
    main()

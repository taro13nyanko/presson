# PressOn — the estimator, in detail

The estimator turns a 3-axis accelerometer stream (phone or MPU6050) into per-compression **depth**, **rate** and **interruption** metrics. It is deliberately simple: every stage is first-order, every constant is listed here, and the same code exists in JavaScript (`app/estimator.js`) and C++ (`firmware/presson-trainer/estimator.h`), validated with identical vectors.

## 1. Inputs

| symbol | source | unit |
|---|---|---|
| **a** | `DeviceMotionEvent.acceleration` (gravity removed by the OS) — may be `null` on some Android builds | m/s² |
| **g** | `accelerationIncludingGravity`; on the MPU6050 this is the only reading | m/s² |
| **t** | event timestamp (ms → s); on the ESP32, `micros()` since session start | s |

Samples arrive at 50–100 Hz with jitter. `dt` is taken from the timestamps; a gap over 250 ms resets the stroke state (sensor stalled, tab hidden).

## 2. Vertical axis

The phone lies on the sternum in an unknown orientation. The compression direction is the gravity direction, so:

1. Gravity vector estimate: `G ← G + (g − G)·(1 − e^{−2π·0.25·dt})` (first-order low-pass, 0.25 Hz).
2. Unit axis `u = G/|G|` (fallback `(0,0,1)` if |G| < 2 m/s², i.e. free fall or a broken sensor).
3. Linear acceleration `l = a` if available, else `l = g − G` (the *fallback path*; it adds one more high-pass, accounted for in §5).
4. Scalar `a_v = l · u`.

Sign conventions differ between Android and iOS (and the phone may be screen-down); only |Δx| is used, so the sign never matters.

## 3. Filters

| stage | type | cutoff | purpose |
|---|---|---|---|
| HP₁ | 1st-order high-pass | 0.3 Hz | sensor bias, slow drift |
| LP₁, LP₂ | two 1st-order low-passes | 10 Hz | tremor, hand noise, 50/60 Hz pickup |
| leaky integrator | `v ← v·e^{−2π·0.3·dt} + a_f·dt` | 0.3 Hz leak | velocity without random-walk drift (equivalent to an integrator followed by a 0.3 Hz high-pass) |

All filters are recomputed per sample from the actual `dt`, so irregular sampling is fine.

## 4. Strokes and compressions (zero-velocity reset)

A compression is a down-stroke followed by an up-stroke. Velocity is zero at the top and at the bottom, so:

* Every zero-crossing of `v` closes a **stroke**. Its displacement is `Δx = ∫ v dt` since the previous crossing (trapezoid rule, crossing time interpolated). Integrating only between crossings is the *zero-velocity reset* (Aase & Myklebust 2002): drift cannot accumulate beyond one stroke.
* Strokes shorter than **8 mm** are tremor or repositioning and are merged forward into the next stroke; consecutive strokes in the same direction are merged too (a wiggle in the middle of a stroke splits it in three).
* Two consecutive opposite strokes form one **compression**, `depth = (|Δx₁| + |Δx₂|)/2`, with the cycle duration `dur` from the start of the first to the end of the second. Compressions with `dur` outside **0.30–1.50 s** (200–40 /min) or depth over **12 cm** are rejected (jolts, dropping the phone).

## 5. Gain compensation

Every stage above attenuates a sinusoid at angular frequency ω by a known factor:

```
G(ω) = HP(0.3) · LP(10)² · HP(0.3, the leak) [· HP(0.25) on the fallback path]
HP(fc) = x/√(1+x²),  LP(fc) = 1/√(1+x²),  x = ω / 2π·fc
```

`ω = 2π/dur` is known for every compression, so `depth ← depth / G(ω)`. Before this step the estimator under-read by about 6 % (clean) to 10 % (fallback path at 80 /min); after it the synthetic error is under 2 % for smooth strokes and under 6 % for very asymmetric strokes (where harmonics above the fundamental are attenuated slightly differently).

## 6. Spectral cross-check

For a pure sinusoid of peak-to-peak displacement D, the peak-to-peak acceleration is `a_pp = D·ω²`. The estimator records `depthSpec = a_pp / ω² / G(ω)` per compression. In the synthetic sweep it agrees with the integrated depth within about 2 % for smooth compressions and over-reads by roughly 10 % (a short hold at the top), 17 % (45 % duty) to 56 % (40 % duty: fast down, slow up). It is exported in the CSV as a *smoothness* indicator and a sanity check; the integrated depth is what the rescuer sees.

## 7. Rate, interruptions, compression fraction

* **Rate** = 60 / median of the last 5 inter-compression intervals (intervals over 1.5 s are pauses, not rate). Until two compressions exist, no rate is shown.
* **Hands-off**: no compression for **2 s** starts a pause at `lastCompression + 0.6 s`; the pause ends at the start of the next detected cycle. Pause time and count are accumulated.
* **Compression fraction (CCF)** = (time since first compression − hands-off) / time since first compression.

## 8. The coach

`app/coach.js` (ported to the firmware): thresholds with hysteresis — a problem is *entered* at the tolerance value (depth < 4.5 cm, > 6.5 cm; rate < 98, > 122) and *left* only when the value is back inside the target band (5–6 cm, 100–120 /min). Depth problems outrank rate problems. Rules:

* nothing before 3 compressions; any two cues ≥ 1.5 s apart; repeated corrections ≥ 2.5 s apart and the same correction ≥ 4 s apart, rotating through all current problems;
* "good" once on entering the target band, then "good, keep going" every 30 s;
* "resume" 2 s into a pause, again every 5 s, becoming "hands off for N seconds" after 10 s;
* "switch rescuer" every 120 s (guidelines: swap every 2 minutes to prevent fatigue).

Trade-off to be aware of: a compression of 4.5–5.0 cm, just below the guideline minimum, draws no correction; the 0.5 cm tolerance is set at roughly the estimator's own error so the coach does not flip-flop.

## 9. Known limits

* **Leaning / incomplete recoil** is a constant offset, invisible to an accelerometer in steady state. Real feedback pucks use a force sensor for this. Not claimed.
* **Soft surfaces**: on a mattress the accelerometer measures sternum *plus* mattress travel and over-estimates depth (AHA 2025 discusses CPR on soft surfaces). A second sensor under the back (the ESP32 puck) can subtract it — planned.
* **Accuracy claims**: synthetic error < 6 %; manikin studies of the same family of algorithms report about 1.5–4 mm (Aase 2002, Song 2015, Ruiz de Gauna 2016). We have checked the webcam tracker only on a synthetic clip (`tools/make_synth_video.py`: 50.0 mm true → 50.0 ± 0.4 mm); no real cushion session has been compared with the camera yet, and nothing has been tested on a manikin. Treat the number as a coaching signal, not a measurement.
* **Sampling**: iOS Safari delivers ~60 Hz, Android 50–100 Hz; the design is insensitive to this (§3, §5), verified at 50 and 100 Hz with jitter.

## 10. Constants (defaults)

```
gravityCutoffHz 0.25   hpCutoffHz 0.3   lpCutoffHz 10   leakHz 0.3
minStrokeM 0.008   minCycleS 0.30   maxCycleS 1.50   maxDepthM 0.12   pauseAfterS 2.0
rateWindow 5   depthWindow 5
```

## References

* Aase SO, Myklebust H. Compression depth estimation for CPR quality assessment using DSP on accelerometer signals. *IEEE Trans Biomed Eng* 2002;49(3):263-8.
* Song Y, Oh J, Chee Y. A new chest compression depth feedback algorithm for high-quality CPR based on smartphone. *Telemed J E Health* 2015;21(1):36-41.
* Ruiz de Gauna S, et al. A feasibility study for measuring accurate chest compression depth and rate on soft surfaces using two accelerometers and spectral analysis. *BioMed Res Int* 2016.
* American Heart Association. 2025 Guidelines for CPR and ECC, Part 7: Adult Basic Life Support. *Circulation* 2025.
* 日本蘇生協議会. JRC 蘇生ガイドライン 2025, 一次救命処置 (BLS).

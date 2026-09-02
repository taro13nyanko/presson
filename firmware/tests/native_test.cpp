// Native test of the C++ estimator (firmware/presson-trainer/estimator.h) with the
// same synthetic sweep as tests/estimator.test.js.  Build & run (any C++ compiler):
//   zig c++ -O2 -o native_test firmware/tests/native_test.cpp && ./native_test
//   g++ -O2 -o native_test firmware/tests/native_test.cpp && ./native_test
#include <stdio.h>
#include <stdlib.h>
#include <vector>
#include "../presson-trainer/estimator.h"

struct Sample { float t, ax, ay, az, gx, gy, gz, xTrue; };

struct Cond { const char *name; float fs, noise, drift, tilt, duty, hold, jitter; bool screenDown, nullLinear; };

static std::vector<Sample> synth(float rate, float depth, float seconds, const Cond &c, unsigned seed) {
  PressOnSynth rng(seed);
  const float g = 9.80665f;
  float th = c.tilt * PRESSON_PI / 180.0f;
  float gv[3] = { g * sinf(th), 0.0f, g * cosf(th) * (c.screenDown ? -1.0f : 1.0f) };
  float u[3] = { gv[0] / g, gv[1] / g, gv[2] / g };
  std::vector<float> xs, ts;
  float t = 0, phase = 0, T = 60.0f / rate, dtNom = 1.0f / c.fs;
  while (t < seconds) {
    float dt = dtNom + (c.jitter ? (rng.rnd() * 2 - 1) * c.jitter : 0);
    xs.push_back(PressOnSynth::cycleShape(phase, depth, c.duty, c.hold));
    ts.push_back(t);
    phase += dt / T; if (phase >= 1) phase -= 1;
    t += dt;
  }
  std::vector<Sample> out;
  for (size_t i = 0; i < xs.size(); i++) {
    float a = 0;
    if (i > 0 && i + 1 < xs.size()) {
      float d1 = ts[i] - ts[i - 1], d2 = ts[i + 1] - ts[i];
      float v1 = (xs[i] - xs[i - 1]) / d1, v2 = (xs[i + 1] - xs[i]) / d2;
      a = (v2 - v1) / (0.5f * (d1 + d2));
    }
    float n = c.noise ? rng.gauss() * c.noise : 0;
    float dr = c.drift ? c.drift * sinf(2 * PRESSON_PI * 0.05f * ts[i]) : 0;
    float lin = a + n + dr;
    Sample s;
    s.t = ts[i];
    s.ax = lin * u[0] + (c.noise ? rng.gauss() * c.noise * 0.5f : 0);
    s.ay = lin * u[1] + (c.noise ? rng.gauss() * c.noise * 0.5f : 0);
    s.az = lin * u[2];
    s.gx = s.ax + gv[0]; s.gy = s.ay + gv[1]; s.gz = s.az + gv[2];
    s.xTrue = xs[i];
    out.push_back(s);
  }
  return out;
}

int main() {
  const float rates[] = { 80, 100, 110, 120, 140 };
  const float depths[] = { 0.03f, 0.04f, 0.05f, 0.06f, 0.07f };
  Cond conds[] = {
    { "clean 60 Hz, flat",             60,  0.0f,  0.0f,  0,  0.5f,  0.0f,  0.0f,   false, false },
    { "noisy 60 Hz, tilted 20 deg",    60,  0.15f, 0.05f, 20, 0.5f,  0.0f,  0.0f,   false, false },
    { "noisy, fast down-stroke 40%",   60,  0.15f, 0.05f, 10, 0.4f,  0.1f,  0.0f,   false, false },
    { "noisy, screen down, 50 Hz",     50,  0.15f, 0.05f, 15, 0.45f, 0.05f, 0.0f,   true,  false },
    { "noisy 100 Hz, jitter 3 ms",     100, 0.15f, 0.05f, 5,  0.5f,  0.05f, 0.003f, false, false },
    { "no linear accel (MPU6050 path)", 60, 0.15f, 0.05f, 20, 0.5f,  0.0f,  0.0f,   false, true },
  };
  int failures = 0;
  printf("| condition | max depth err | mean depth err | max rate err |\n|---|---|---|---|\n");
  for (const Cond &c : conds) {
    float maxD = 0, sumD = 0, maxR = 0; int n = 0;
    for (float rate : rates) for (float depth : depths) {
      // same seed as the JS: rate*1000 + depth*1e5 (rounded, so 0.03 -> 3000 and not 2999)
      std::vector<Sample> s = synth(rate, depth, 20.0f, c, (unsigned)(lroundf(rate * 1000) + lroundf(depth * 1e5f)));
      PressOnEstimator est;
      double sum = 0; int cnt = 0;
      for (const Sample &x : s) {
        bool comp = est.push(x.ax, x.ay, x.az, !c.nullLinear, x.gx, x.gy, x.gz, x.t);
        if (comp && est.last.t > 3.0f) { sum += est.last.depth; cnt++; }
      }
      float d = cnt ? (float)(sum / cnt) : 0;
      float de = fabsf((d - depth) / depth), re = fabsf(est.rate() - rate);
      if (de > maxD) maxD = de; sumD += de; n++; if (re > maxR) maxR = re;
      if (de >= 0.10f || re >= 3.0f) { failures++; printf("  FAIL %s rate=%g depth=%g: depth err %.1f%% rate err %.1f\n", c.name, rate, depth, de * 100, re); }
    }
    printf("| %s | %.1f %% | %.1f %% | %.1f /min |\n", c.name, maxD * 100, sumD / n * 100, maxR);
  }
  // interruption test
  {
    Cond c = { "", 60, 0.1f, 0, 0, 0.5f, 0, 0, false, true };
    std::vector<Sample> a = synth(110, 0.05f, 10, c, 7), b = synth(110, 0.05f, 10, c, 8);
    PressOnEstimator est;
    float t = 0;
    for (const Sample &x : a) { est.push(0, 0, 0, false, x.gx, x.gy, x.gz, x.t); t = x.t; }
    float pauseEnd = t + 6.0f;
    for (float tp = t + 1.0f / 60; tp < pauseEnd; tp += 1.0f / 60) est.push(0, 0, 0, false, 0, 0, 9.80665f, tp);
    for (const Sample &x : b) { est.push(0, 0, 0, false, x.gx, x.gy, x.gz, pauseEnd + x.t); t = pauseEnd + x.t; }
    printf("\nInterruption: handsOff=%.1f s (true ~6), pauses=%d, CCF=%.0f %%\n", est.handsOff(t), est.pauseCount, est.ccf(t) * 100);
    if (!(est.handsOff(t) > 4.5f && est.handsOff(t) < 7.5f && est.pauseCount == 1)) { failures++; printf("  FAIL interruption\n"); }
  }
  printf(failures ? "\n%d FAILED\n" : "\nAll native checks passed\n", failures);
  return failures ? 1 : 0;
}

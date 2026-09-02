/*
 * PressOn — chest-compression estimator, C++ port of app/estimator.js.
 * Header-only, no dynamic memory, no Arduino dependency: compiles for
 * ESP32 / AVR (Arduino) and natively (firmware/tests/native_test.cpp).
 *
 * Pipeline (identical to the JavaScript):
 *   gravity LP 0.25 Hz -> project linear accel on gravity axis ->
 *   HP 0.3 Hz -> 2x LP 10 Hz -> leaky integration (0.3 Hz) = velocity ->
 *   zero-velocity strokes (∫v dt between crossings, tiny strokes merged) ->
 *   two opposite strokes = one compression, depth = mean stroke length,
 *   divided by the filter chain gain at the cycle frequency.
 */
#pragma once
#include <math.h>

#ifndef PRESSON_PI
#define PRESSON_PI 3.14159265358979f
#endif

struct PressOnStroke {
  float t0, t1, dx, amax, amin;
  bool valid;
};

struct PressOnCompression {
  float t, depth, depthSpec, dur, rate;
};

class PressOnEstimator {
 public:
  // parameters (same defaults as the JS)
  float gravityCutoffHz = 0.25f;
  float hpCutoffHz = 0.3f;
  float lpCutoffHz = 10.0f;
  float leakHz = 0.3f;
  float minStrokeM = 0.008f;
  float minCycleS = 0.30f;
  float maxCycleS = 1.50f;
  float maxDepthM = 0.12f;
  float pauseAfterS = 2.0f;
  static const int WINDOW = 5;

  PressOnCompression last;
  int count = 0;
  int pauseCount = 0;

  PressOnEstimator() { reset(); }

  void reset() {
    n_ = 0; tPrev_ = -1.0f; haveG_ = false;
    hpX_ = hpY_ = lp1_ = lp2_ = 0.0f;
    v_ = vPrev_ = 0.0f;
    strokeDx_ = 0.0f; strokeT0_ = 0.0f; strokeAmax_ = -1e9f; strokeAmin_ = 1e9f;
    carry_.valid = false; pending_.valid = false;
    count = 0; pauseCount = 0;
    nIntervals_ = 0; nDepths_ = 0; ivHead_ = 0; dHead_ = 0;
    lastT_ = -1.0f; startT_ = -1.0f; firstCompT_ = -1.0f; firstDur_ = 0.0f;
    handsOff_ = 0.0f; pauseStart_ = -1.0f;
    fallback_ = false; aV_ = 0.0f; aF_ = 0.0f;
    last.t = last.depth = last.depthSpec = last.dur = last.rate = 0.0f;
  }

  // Feed one sample. hasLinear=false means ax..az are ignored and the linear
  // acceleration is derived from the gravity-including reading gx..gz.
  // Returns true when this sample completed a compression (see `last`).
  bool push(float ax, float ay, float az, bool hasLinear, float gx, float gy, float gz, float t) {
    if (startT_ < 0) startT_ = t;
    if (tPrev_ < 0) {
      tPrev_ = t; g_[0] = gx; g_[1] = gy; g_[2] = gz; haveG_ = true; strokeT0_ = t; n_++;
      return false;
    }
    float dt = t - tPrev_;
    if (dt <= 0) return false;
    if (dt > 0.25f) { tPrev_ = t; resetStroke(t); return false; }
    if (dt < 0.001f) dt = 0.001f;
    tPrev_ = t; n_++;

    float kg = 1.0f - expf(-dt * 2 * PRESSON_PI * gravityCutoffHz);
    g_[0] += (gx - g_[0]) * kg; g_[1] += (gy - g_[1]) * kg; g_[2] += (gz - g_[2]) * kg;
    float gm = sqrtf(g_[0] * g_[0] + g_[1] * g_[1] + g_[2] * g_[2]);
    float ux, uy, uz;
    if (gm > 2.0f) { ux = g_[0] / gm; uy = g_[1] / gm; uz = g_[2] / gm; } else { ux = 0; uy = 0; uz = 1; }

    float lx, ly, lz;
    if (!hasLinear) { fallback_ = true; lx = gx - g_[0]; ly = gy - g_[1]; lz = gz - g_[2]; }
    else { fallback_ = false; lx = ax; ly = ay; lz = az; }
    float aV = lx * ux + ly * uy + lz * uz;
    aV_ = aV;

    float tauH = 1.0f / (2 * PRESSON_PI * hpCutoffHz);
    float aH = tauH / (tauH + dt);
    float hp = aH * (hpY_ + aV - hpX_);
    hpX_ = aV; hpY_ = hp;
    float kl = 1.0f - expf(-dt * 2 * PRESSON_PI * lpCutoffHz);
    lp1_ += (hp - lp1_) * kl;
    lp2_ += (lp1_ - lp2_) * kl;
    float aF = lp2_;
    aF_ = aF;

    float leak = expf(-dt * 2 * PRESSON_PI * leakHz);
    vPrev_ = v_;
    v_ = v_ * leak + aF * dt;

    if (aF > strokeAmax_) strokeAmax_ = aF;
    if (aF < strokeAmin_) strokeAmin_ = aF;
    bool completed = false;
    bool crossed = (vPrev_ > 0 && v_ <= 0) || (vPrev_ < 0 && v_ >= 0);
    if (crossed) {
      float frac = vPrev_ / (vPrev_ - v_);
      if (!(frac >= 0 && frac <= 1)) frac = 1;
      float tc = t - dt + frac * dt;
      strokeDx_ += 0.5f * vPrev_ * frac * dt;
      completed = closeStroke(tc);
      strokeDx_ += 0.5f * v_ * (1 - frac) * dt;
    } else {
      strokeDx_ += 0.5f * (vPrev_ + v_) * dt;
    }

    if (lastT_ >= 0 && t - lastT_ > pauseAfterS && pauseStart_ < 0) pauseStart_ = lastT_ + 0.6f;
    return completed;
  }

  float rate() const {
    if (nIntervals_ == 0) return count ? 60.0f / last.dur : 0.0f;
    float tmp[WINDOW]; int n = nIntervals_ < WINDOW ? nIntervals_ : WINDOW;
    for (int i = 0; i < n; i++) tmp[i] = intervals_[i];
    // insertion sort (n <= 5)
    for (int i = 1; i < n; i++) { float x = tmp[i]; int j = i - 1; while (j >= 0 && tmp[j] > x) { tmp[j + 1] = tmp[j]; j--; } tmp[j + 1] = x; }
    float med = (n % 2) ? tmp[n / 2] : 0.5f * (tmp[n / 2 - 1] + tmp[n / 2]);
    return 60.0f / med;
  }
  bool rateValid() const { return nIntervals_ >= 2 || count >= 2; }

  float depth() const {
    int n = nDepths_ < WINDOW ? nDepths_ : WINDOW;
    if (!n) return 0.0f;
    float s = 0; for (int i = 0; i < n; i++) s += depths_[i];
    return s / n;
  }

  float sinceLast(float now) const { return lastT_ < 0 ? (startT_ < 0 ? 0.0f : now - startT_) : now - lastT_; }
  bool paused(float now) const { return lastT_ >= 0 && now - lastT_ > pauseAfterS; }
  float handsOff(float now) const {
    float h = handsOff_;
    if (paused(now)) { float p0 = pauseStart_ >= 0 ? pauseStart_ : lastT_ + 0.6f; float d = now - p0; if (d > 0) h += d; }
    return h;
  }
  float ccf(float now) const {
    if (!count) return 0.0f;
    float active = now - firstCompT_ + firstDur_;
    if (active <= 0) return 0.0f;
    float c = (active - handsOff(now)) / active;
    return c < 0 ? 0 : (c > 1 ? 1 : c);
  }
  float gainAt(float omega) const {
    float g = hpGain(omega, hpCutoffHz) * lpGain(omega, lpCutoffHz) * lpGain(omega, lpCutoffHz) * hpGain(omega, leakHz);
    if (fallback_) g *= hpGain(omega, gravityCutoffHz);
    return g;
  }
  float aV() const { return aV_; }
  float aF() const { return aF_; }
  float velocity() const { return v_; }

 private:
  static float hpGain(float omega, float fc) { float x = omega / (2 * PRESSON_PI * fc); return x / sqrtf(1 + x * x); }
  static float lpGain(float omega, float fc) { float x = omega / (2 * PRESSON_PI * fc); return 1.0f / sqrtf(1 + x * x); }
  static float fabsf_(float x) { return x < 0 ? -x : x; }
  static float maxf_(float a, float b) { return a > b ? a : b; }
  static float minf_(float a, float b) { return a < b ? a : b; }

  void resetStroke(float t) {
    v_ = vPrev_ = 0; strokeDx_ = 0; strokeT0_ = t; strokeAmax_ = -1e9f; strokeAmin_ = 1e9f;
    carry_.valid = false; pending_.valid = false;
  }

  bool closeStroke(float tc) {
    PressOnStroke s; s.t0 = strokeT0_; s.t1 = tc; s.dx = strokeDx_; s.amax = strokeAmax_; s.amin = strokeAmin_; s.valid = true;
    strokeDx_ = 0; strokeT0_ = tc; strokeAmax_ = -1e9f; strokeAmin_ = 1e9f;

    if (fabsf_(s.dx) < minStrokeM) {
      if (carry_.valid) { carry_.dx += s.dx; carry_.t1 = s.t1; carry_.amax = maxf_(carry_.amax, s.amax); carry_.amin = minf_(carry_.amin, s.amin); }
      else carry_ = s;
      if (carry_.t1 - carry_.t0 > maxCycleS) { carry_.valid = false; pending_.valid = false; }
      return false;
    }
    if (carry_.valid) {
      s.dx += carry_.dx; s.t0 = carry_.t0; s.amax = maxf_(s.amax, carry_.amax); s.amin = minf_(s.amin, carry_.amin);
      carry_.valid = false;
      if (fabsf_(s.dx) < minStrokeM) return false;
    }
    if (pending_.valid && ((pending_.dx > 0) == (s.dx > 0))) {
      pending_.dx += s.dx; pending_.t1 = s.t1; pending_.amax = maxf_(pending_.amax, s.amax); pending_.amin = minf_(pending_.amin, s.amin);
      if (pending_.t1 - pending_.t0 > maxCycleS) pending_.valid = false;
      return false;
    }
    if (!pending_.valid || s.t0 - pending_.t1 > 0.05f) { pending_ = s; return false; }

    PressOnStroke p = pending_; pending_.valid = false;
    float dur = s.t1 - p.t0;
    float depth = 0.5f * (fabsf_(p.dx) + fabsf_(s.dx));
    if (dur < minCycleS || dur > maxCycleS || depth > maxDepthM) return false;
    float app = maxf_(p.amax, s.amax) - minf_(p.amin, s.amin);
    float omega = 2 * PRESSON_PI / dur;
    float gain = gainAt(omega);
    depth /= gain;
    float depthSpec = app / (omega * omega) / gain;

    if (lastT_ >= 0) {
      float iv = s.t1 - lastT_;
      if (iv <= maxCycleS) {
        intervals_[ivHead_] = iv; ivHead_ = (ivHead_ + 1) % WINDOW; if (nIntervals_ < WINDOW) nIntervals_++;
      } else {
        float p0 = pauseStart_ >= 0 ? pauseStart_ : lastT_ + 0.6f;
        float d = (s.t1 - dur) - p0; if (d > 0) handsOff_ += d;
        pauseCount++;
        nIntervals_ = 0; ivHead_ = 0;
      }
    }
    pauseStart_ = -1.0f;
    lastT_ = s.t1;
    if (firstCompT_ < 0) { firstCompT_ = s.t1; firstDur_ = dur; }
    depths_[dHead_] = depth; dHead_ = (dHead_ + 1) % WINDOW; if (nDepths_ < WINDOW) nDepths_++;
    count++;
    last.t = s.t1; last.depth = depth; last.depthSpec = depthSpec; last.dur = dur;
    last.rate = rate();
    return true;
  }

  int n_;
  float tPrev_;
  float g_[3]; bool haveG_;
  float hpX_, hpY_, lp1_, lp2_;
  float v_, vPrev_;
  float strokeDx_, strokeT0_, strokeAmax_, strokeAmin_;
  PressOnStroke carry_, pending_;
  float intervals_[WINDOW]; int nIntervals_, ivHead_;
  float depths_[WINDOW]; int nDepths_, dHead_;
  float lastT_, startT_, firstCompT_, firstDur_;
  float handsOff_, pauseStart_;
  bool fallback_;
  float aV_, aF_;
};

/* Synthetic compressions (same shape as the JS `synth`) for self-tests. */
class PressOnSynth {
 public:
  // displacement of one cycle (m, negative = pressed) at phase u in [0,1)
  static float cycleShape(float u, float depth, float duty, float hold) {
    float active = 1.0f - hold;
    if (u >= active) return 0.0f;
    float w = u / active;
    if (w < duty) { float p = w / duty; return -depth * 0.5f * (1.0f - cosf(PRESSON_PI * p)); }
    float q = (w - duty) / (1.0f - duty);
    return -depth * 0.5f * (1.0f + cosf(PRESSON_PI * q));
  }
  // mulberry32, same as the JS
  explicit PressOnSynth(unsigned seed) : a_(seed) {}
  float rnd() {
    a_ += 0x6D2B79F5u;
    unsigned t = a_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + ((t ^ (t >> 7)) * (t | 61u));
    return (float)((t ^ (t >> 14)) / 4294967296.0);
  }
  float gauss() {
    float u = 0, v = 0;
    while (u == 0) u = rnd();
    while (v == 0) v = rnd();
    return sqrtf(-2.0f * logf(u)) * cosf(2 * PRESSON_PI * v);
  }
 private:
  unsigned a_;
};

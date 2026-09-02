/*
 * PressOn — chest-compression estimator (rate / depth / interruptions)
 * from a 3-axis accelerometer. Pure math, no DOM. Runs in the browser,
 * in Node (tests) and is ported 1:1 to firmware/presson-trainer/estimator.h.
 *
 * Input per sample:
 *   ax, ay, az  linear acceleration (gravity removed) in m/s^2, or null
 *   gx, gy, gz  acceleration INCLUDING gravity in m/s^2 (used for the
 *               vertical axis and as fallback when linear accel is null)
 *   t           timestamp in seconds (monotonic)
 *
 * Pipeline:
 *   1. gravity vector  = low-pass(accelerationIncludingGravity, 0.25 Hz)
 *   2. a_v = linear accel projected on the gravity axis  (phone may be tilted,
 *      screen up or screen down — only the magnitude matters)
 *   3. high-pass 0.3 Hz (drift)  ->  2 x low-pass 10 Hz (hand tremor, noise)
 *   4. leaky integration -> velocity  (the leak is a 0.3 Hz high-pass)
 *   5. every zero-crossing of velocity closes a "stroke"; the displacement
 *      of a stroke is  ∫ v dt  between two crossings (zero-velocity reset).
 *      Tiny strokes (< 8 mm) are merged into their neighbour.
 *   6. two consecutive opposite strokes = one compression
 *        depth  = mean(|stroke1|, |stroke2|)
 *        spectral cross-check: depthSpec = a_pp / omega^2   (exact for a sine)
 *   7. rate = 60 / median(last 5 intervals);  gaps > 2 s = hands-off time
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PressOn = Object.assign(root.PressOn || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TWO_PI = Math.PI * 2;

  var DEFAULTS = {
    gravityCutoffHz: 0.25,  // LP for the gravity vector
    hpCutoffHz: 0.3,        // HP on acceleration (drift)
    lpCutoffHz: 10,         // LP on acceleration (two 1st-order stages)
    leakHz: 0.3,            // leak of the velocity integrator
    minStrokeM: 0.008,      // strokes shorter than 8 mm are merged
    minCycleS: 0.30,        // 200 /min
    maxCycleS: 1.50,        // 40 /min
    maxDepthM: 0.12,        // anything deeper is a jolt, not CPR
    pauseAfterS: 2.0,       // no compression for 2 s = interruption
    rateWindow: 5,          // median over the last N intervals
    depthWindow: 5          // mean over the last N compressions
  };

  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }
  function mean(arr) {
    if (!arr.length) return 0;
    var t = 0; for (var i = 0; i < arr.length; i++) t += arr[i];
    return t / arr.length;
  }

  function Estimator(opts) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.reset();
  }

  Estimator.prototype.reset = function () {
    this.n = 0;
    this.tPrev = null;
    this.g = null;                 // gravity vector estimate [x,y,z]
    this.hpX = 0; this.hpY = 0;    // HP state (prev input / prev output)
    this.lp1 = 0; this.lp2 = 0;    // LP stages
    this.v = 0; this.vPrev = 0;    // velocity
    this.strokeDx = 0;             // ∫ v dt since last zero crossing
    this.strokeT0 = null;
    this.strokeAmax = -Infinity; this.strokeAmin = Infinity;
    this.carry = null;             // tiny stroke waiting to be merged
    this.pending = null;           // first stroke of a compression
    this.compressions = [];        // {t, depth, depthSpec, dur}
    this.intervals = [];           // seconds between compressions
    this.lastT = null;             // time of last compression
    this.startT = null;            // time of first sample
    this.handsOffS = 0;            // accumulated pause time
    this.pauseStart = null;        // when the current pause began (t)
    this.pauses = [];              // {t0, t1}
    this.aV = 0; this.aF = 0;      // for debugging / plots
    this.fallback = false;         // true when linear acceleration is unavailable
    this.events = [];              // queue consumed by the caller
  };

  // Returns an array of events that happened during this sample
  // (usually empty). Event: {type:'compression', t, depth, depthSpec, dur, rate}
  Estimator.prototype.push = function (ax, ay, az, gx, gy, gz, t) {
    var o = this.o;
    this.events.length = 0;
    if (this.startT === null) this.startT = t;
    if (this.tPrev === null) {
      this.tPrev = t;
      this.g = [gx, gy, gz];
      this.strokeT0 = t;
      this.n++;
      return this.events;
    }
    var dt = t - this.tPrev;
    if (dt <= 0) return this.events;                // duplicate / out of order
    if (dt > 0.25) {                                // long gap: sensor stalled
      this.tPrev = t; this._resetStroke(t);
      return this.events;
    }
    if (dt < 0.001) dt = 0.001;
    this.tPrev = t;
    this.n++;

    // 1. gravity vector (LP)
    var kg = 1 - Math.exp(-dt * TWO_PI * o.gravityCutoffHz);
    this.g[0] += (gx - this.g[0]) * kg;
    this.g[1] += (gy - this.g[1]) * kg;
    this.g[2] += (gz - this.g[2]) * kg;
    var gm = Math.sqrt(this.g[0] * this.g[0] + this.g[1] * this.g[1] + this.g[2] * this.g[2]);
    var ux, uy, uz;
    if (gm > 2) { ux = this.g[0] / gm; uy = this.g[1] / gm; uz = this.g[2] / gm; }
    else { ux = 0; uy = 0; uz = 1; }

    // 2. linear acceleration along the vertical axis
    var lx, ly, lz;
    if (ax === null || ax === undefined || isNaN(ax)) {
      this.fallback = true;
      lx = gx - this.g[0]; ly = gy - this.g[1]; lz = gz - this.g[2];
    } else { this.fallback = false; lx = ax; ly = ay; lz = az; }
    var aV = lx * ux + ly * uy + lz * uz;
    this.aV = aV;

    // 3. HP (1st order) then LP (2 x 1st order)
    var tauH = 1 / (TWO_PI * o.hpCutoffHz);
    var aH = tauH / (tauH + dt);
    var hp = aH * (this.hpY + aV - this.hpX);
    this.hpX = aV; this.hpY = hp;
    var kl = 1 - Math.exp(-dt * TWO_PI * o.lpCutoffHz);
    this.lp1 += (hp - this.lp1) * kl;
    this.lp2 += (this.lp1 - this.lp2) * kl;
    var aF = this.lp2;
    this.aF = aF;

    // 4. leaky integration -> velocity
    var leak = Math.exp(-dt * TWO_PI * o.leakHz);
    this.vPrev = this.v;
    this.v = this.v * leak + aF * dt;

    // 5. stroke accumulation and zero-crossing detection
    if (aF > this.strokeAmax) this.strokeAmax = aF;
    if (aF < this.strokeAmin) this.strokeAmin = aF;
    var crossed = (this.vPrev > 0 && this.v <= 0) || (this.vPrev < 0 && this.v >= 0);
    if (crossed) {
      // interpolate the crossing time
      var frac = this.vPrev / (this.vPrev - this.v);
      if (!(frac >= 0 && frac <= 1)) frac = 1;
      var tc = t - dt + frac * dt;
      // displacement up to the crossing (trapezoid to zero)
      this.strokeDx += 0.5 * this.vPrev * frac * dt;
      this._closeStroke(tc);
      // remainder of this sample belongs to the new stroke
      this.strokeDx += 0.5 * this.v * (1 - frac) * dt;
    } else {
      this.strokeDx += 0.5 * (this.vPrev + this.v) * dt;
    }

    // 7. interruption bookkeeping
    if (this.lastT !== null) {
      var gap = t - this.lastT;
      if (gap > o.pauseAfterS) {
        if (this.pauseStart === null) this.pauseStart = this.lastT + 0.6;
      }
    }
    return this.events;
  };

  Estimator.prototype._resetStroke = function (t) {
    this.v = 0; this.vPrev = 0; this.strokeDx = 0; this.strokeT0 = t;
    this.strokeAmax = -Infinity; this.strokeAmin = Infinity;
    this.carry = null; this.pending = null;
  };

  Estimator.prototype._closeStroke = function (tc) {
    var o = this.o;
    var s = { t0: this.strokeT0, t1: tc, dx: this.strokeDx,
              amax: this.strokeAmax, amin: this.strokeAmin };
    this.strokeDx = 0; this.strokeT0 = tc;
    this.strokeAmax = -Infinity; this.strokeAmin = Infinity;

    if (Math.abs(s.dx) < o.minStrokeM) {          // tiny wiggle: merge forward
      if (this.carry) {
        this.carry.dx += s.dx; this.carry.t1 = s.t1;
        this.carry.amax = Math.max(this.carry.amax, s.amax);
        this.carry.amin = Math.min(this.carry.amin, s.amin);
      } else this.carry = s;
      // a long run of wiggles is a pause, not a stroke
      if (this.carry.t1 - this.carry.t0 > o.maxCycleS) { this.carry = null; this.pending = null; }
      return;
    }
    if (this.carry) {
      s.dx += this.carry.dx; s.t0 = this.carry.t0;
      s.amax = Math.max(s.amax, this.carry.amax); s.amin = Math.min(s.amin, this.carry.amin);
      this.carry = null;
      if (Math.abs(s.dx) < o.minStrokeM) return;
    }
    var p = this.pending;
    if (p && (p.dx > 0) === (s.dx > 0)) {         // same direction: merge
      p.dx += s.dx; p.t1 = s.t1;
      p.amax = Math.max(p.amax, s.amax); p.amin = Math.min(p.amin, s.amin);
      if (p.t1 - p.t0 > o.maxCycleS) this.pending = null;
      return;
    }
    if (!p || s.t0 - p.t1 > 0.05) {               // no partner (or stale): start a new pair
      this.pending = s;
      return;
    }
    // 6. opposite strokes -> one compression
    var dur = s.t1 - p.t0;
    var depth = 0.5 * (Math.abs(p.dx) + Math.abs(s.dx));
    this.pending = null;
    if (dur < o.minCycleS || dur > o.maxCycleS || depth > o.maxDepthM) return;
    var app = Math.max(p.amax, s.amax) - Math.min(p.amin, s.amin);
    var omega = TWO_PI / dur;
    // compensate the known attenuation of the filter chain at this cycle's frequency
    var gain = this.gainAt(omega);
    depth /= gain;
    var depthSpec = app / (omega * omega) / gain;
    var c = { t: s.t1, depth: depth, depthSpec: depthSpec, dur: dur, gain: gain };
    if (this.lastT !== null) {
      var iv = c.t - this.lastT;
      if (iv <= o.maxCycleS) {
        this.intervals.push(iv);
        if (this.intervals.length > o.rateWindow) this.intervals.shift();
      } else {
        // interruption ended
        var p0 = this.pauseStart !== null ? this.pauseStart : this.lastT + 0.6;
        this.handsOffS += Math.max(0, c.t - dur - p0);
        this.pauses.push({ t0: p0, t1: c.t - dur });
        this.intervals.length = 0;
      }
    }
    this.pauseStart = null;
    this.lastT = c.t;
    this.compressions.push(c);
    c.rate = this.rate();
    this.events.push(Object.assign({ type: 'compression' }, c));
  };

  // Magnitude response of HP -> LP -> LP -> leaky integrator (relative to an
  // ideal integrator) at angular frequency omega.  All stages are 1st order.
  Estimator.prototype.gainAt = function (omega) {
    var o = this.o;
    function hp(fc) { var x = omega / (TWO_PI * fc); return x / Math.sqrt(1 + x * x); }
    function lp(fc) { var x = omega / (TWO_PI * fc); return 1 / Math.sqrt(1 + x * x); }
    var g = hp(o.hpCutoffHz) * lp(o.lpCutoffHz) * lp(o.lpCutoffHz) * hp(o.leakHz);
    if (this.fallback) g *= hp(o.gravityCutoffHz);   // (aig - LP(aig)) is one more HP
    return g;
  };

  Estimator.prototype.rate = function () {
    if (this.intervals.length === 0) {
      var last = this.compressions[this.compressions.length - 1];
      return last ? 60 / last.dur : 0;
    }
    return 60 / median(this.intervals);
  };

  Estimator.prototype.depth = function () {
    var n = this.compressions.length, w = this.o.depthWindow;
    if (!n) return 0;
    var arr = [];
    for (var i = Math.max(0, n - w); i < n; i++) arr.push(this.compressions[i].depth);
    return mean(arr);
  };

  Estimator.prototype.depthSpec = function () {
    var n = this.compressions.length, w = this.o.depthWindow;
    if (!n) return 0;
    var arr = [];
    for (var i = Math.max(0, n - w); i < n; i++) arr.push(this.compressions[i].depthSpec);
    return mean(arr);
  };

  // Snapshot of everything the UI needs. `now` = current time (s).
  Estimator.prototype.metrics = function (now) {
    var o = this.o;
    var sinceLast = this.lastT === null ? (this.startT === null ? 0 : now - this.startT) : now - this.lastT;
    var paused = this.lastT !== null && sinceLast > o.pauseAfterS;
    var handsOff = this.handsOffS;
    if (paused) handsOff += Math.max(0, now - (this.pauseStart !== null ? this.pauseStart : this.lastT + 0.6));
    var elapsed = this.startT === null ? 0 : now - this.startT;
    var active = this.compressions.length ? now - this.compressions[0].t + this.compressions[0].dur : 0;
    var ccf = active > 0 ? Math.max(0, Math.min(1, (active - handsOff) / active)) : 0;
    return {
      count: this.compressions.length,
      rate: this.intervals.length >= 2 || this.compressions.length >= 2 ? this.rate() : 0,
      depth: this.depth(),
      depthSpec: this.depthSpec(),
      sinceLast: sinceLast,
      paused: paused,
      handsOff: handsOff,
      ccf: ccf,
      elapsed: elapsed,
      aV: this.aV,
      aF: this.aF,
      v: this.v
    };
  };

  /* ------------------------------------------------------------------ */
  /* Synthetic compressions — used by the self-test, the desktop demo   */
  /* and the firmware self-test (same shape).                           */
  /* ------------------------------------------------------------------ */

  // Displacement (m, negative = pressed) of one cycle at phase u in [0,1).
  // duty = fraction of the cycle spent going down, hold = fraction resting at top.
  function cycleShape(u, depth, duty, hold) {
    var active = 1 - hold;
    if (u >= active) return 0;                    // resting at the top
    var w = u / active;                           // 0..1 over the moving part
    if (w < duty) {                                // down-stroke, raised cosine
      var p = w / duty;
      return -depth * 0.5 * (1 - Math.cos(Math.PI * p));
    }
    var q = (w - duty) / (1 - duty);              // up-stroke
    return -depth * 0.5 * (1 + Math.cos(Math.PI * q));
  }

  // Generates samples for a scripted session.
  // segments: [{rate, depth, seconds, duty, hold, pause:boolean}]
  // returns [{t, ax, ay, az, gx, gy, gz, xTrue}]
  function synth(segments, opts) {
    opts = opts || {};
    var fs = opts.fs || 60;
    var jitter = opts.jitterS || 0;
    var noise = opts.noise || 0;
    var drift = opts.drift || 0;
    var tilt = opts.tiltDeg || 0;
    var screenDown = !!opts.screenDown;
    var rnd = opts.random || Math.random;
    var g = 9.80665;
    var th = tilt * Math.PI / 180;
    // gravity as measured by the phone (Android convention: +g when flat, screen up)
    var gv = [g * Math.sin(th), 0, g * Math.cos(th) * (screenDown ? -1 : 1)];
    var u = [gv[0] / g, gv[1] / g, gv[2] / g];    // compression axis = gravity axis
    var out = [];
    var t = 0, phase = 0;
    var dtNom = 1 / fs;
    // numeric 2nd derivative of the displacement track
    var xs = [], ts = [];
    var segIdx = 0, segT = 0;
    while (segIdx < segments.length) {
      var seg = segments[segIdx];
      var T = 60 / (seg.rate || 110);
      var dt = dtNom + (jitter ? (rnd() * 2 - 1) * jitter : 0);
      var x = 0;
      if (!seg.pause) {
        x = cycleShape(phase, seg.depth, seg.duty || 0.5, seg.hold || 0);
        phase += dt / T; if (phase >= 1) phase -= 1;
      } else phase = 0;
      xs.push(x); ts.push(t);
      t += dt; segT += dt;
      if (segT >= seg.seconds) { segIdx++; segT = 0; }
    }
    // acceleration by central differences (m/s^2)
    for (var i = 0; i < xs.length; i++) {
      var a = 0;
      if (i > 0 && i < xs.length - 1) {
        var d1 = ts[i] - ts[i - 1], d2 = ts[i + 1] - ts[i];
        var v1 = (xs[i] - xs[i - 1]) / d1, v2 = (xs[i + 1] - xs[i]) / d2;
        a = (v2 - v1) / (0.5 * (d1 + d2));
      }
      var n = noise ? gauss(rnd) * noise : 0;
      var dr = drift ? drift * Math.sin(TWO_PI * 0.05 * ts[i]) : 0;
      var lin = a + n + dr;
      var s = {
        t: ts[i],
        ax: lin * u[0] + (noise ? gauss(rnd) * noise * 0.5 : 0),
        ay: lin * u[1] + (noise ? gauss(rnd) * noise * 0.5 : 0),
        az: lin * u[2],
        xTrue: xs[i]
      };
      s.gx = s.ax + gv[0]; s.gy = s.ay + gv[1]; s.gz = s.az + gv[2];
      out.push(s);
    }
    return out;
  }

  function gauss(rnd) {
    var u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
  }

  // Deterministic PRNG for reproducible tests (mulberry32)
  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return { Estimator: Estimator, synth: synth, cycleShape: cycleShape, seeded: seeded, DEFAULTS: DEFAULTS, median: median };
});

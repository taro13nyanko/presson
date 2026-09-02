// Synthetic-signal validation of app/estimator.js.  Run:  node tests/estimator.test.js
// Exit code 1 if any check fails.  Prints a markdown table for the README.
'use strict';
const P = require('../app/estimator.js');

let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log('  FAIL: ' + msg); } }

function run(samples, opts) {
  const est = new P.Estimator(opts);
  const comps = [];
  for (const s of samples) {
    const ev = est.push(s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.t);
    for (const e of ev) comps.push(e);
  }
  return { est, comps, metrics: est.metrics(samples[samples.length - 1].t) };
}

// True per-cycle depth from the xTrue track: count minima below -5 mm
function trueCycles(samples) {
  let n = 0, inPress = false;
  for (const s of samples) {
    if (!inPress && s.xTrue < -0.005) { inPress = true; n++; }
    else if (inPress && s.xTrue > -0.002) inPress = false;
  }
  return n;
}

console.log('# PressOn estimator — synthetic validation\n');

// ---------- 1. accuracy sweep ------------------------------------------------
const rates = [80, 100, 110, 120, 140];
const depths = [0.03, 0.04, 0.05, 0.06, 0.07];
const conditions = [
  { name: 'clean 60 Hz, flat',            fs: 60,  noise: 0,    drift: 0,    tiltDeg: 0,  duty: 0.5,  hold: 0 },
  { name: 'noisy 60 Hz, tilted 20°',      fs: 60,  noise: 0.15, drift: 0.05, tiltDeg: 20, duty: 0.5,  hold: 0 },
  { name: 'noisy, fast down-stroke 40%',  fs: 60,  noise: 0.15, drift: 0.05, tiltDeg: 10, duty: 0.4,  hold: 0.1 },
  { name: 'noisy, screen down, 50 Hz',    fs: 50,  noise: 0.15, drift: 0.05, tiltDeg: 15, duty: 0.45, hold: 0.05, screenDown: true },
  { name: 'noisy 100 Hz, jitter ±3 ms',   fs: 100, noise: 0.15, drift: 0.05, tiltDeg: 5,  duty: 0.5,  hold: 0.05, jitterS: 0.003 },
  { name: 'no linear-accel API (fallback)', fs: 60, noise: 0.15, drift: 0.05, tiltDeg: 20, duty: 0.5, hold: 0, nullLinear: true },
];

console.log('| condition | max |depth err| | mean |depth err| | max |rate err| | spectral cross-check mean err |');
console.log('|---|---|---|---|---|');
for (const c of conditions) {
  let maxDepthErr = 0, sumDepthErr = 0, n = 0, maxRateErr = 0, sumSpecErr = 0;
  for (const rate of rates) for (const depth of depths) {
    const rnd = P.seeded(rate * 1000 + depth * 1e5);
    const samples = P.synth(
      [{ rate, depth, seconds: 20, duty: c.duty, hold: c.hold }],
      { fs: c.fs, noise: c.noise, drift: c.drift, tiltDeg: c.tiltDeg, jitterS: c.jitterS, screenDown: c.screenDown, random: rnd });
    if (c.nullLinear) for (const s of samples) { s.ax = null; s.ay = null; s.az = null; }
    const { comps, metrics } = run(samples);
    // ignore the first 3 s (filters settling)
    const steady = comps.filter(e => e.t > 3);
    const d = steady.reduce((a, e) => a + e.depth, 0) / steady.length;
    const ds = steady.reduce((a, e) => a + e.depthSpec, 0) / steady.length;
    const depthErr = (d - depth) / depth;
    const rateErr = metrics.rate - rate;
    const nTrue = trueCycles(samples.filter(s => s.t > 3));
    maxDepthErr = Math.max(maxDepthErr, Math.abs(depthErr));
    sumDepthErr += Math.abs(depthErr); n++;
    maxRateErr = Math.max(maxRateErr, Math.abs(rateErr));
    sumSpecErr += Math.abs((ds - depth) / depth);
    check(Math.abs(depthErr) < 0.10, `${c.name} rate=${rate} depth=${depth}: depth err ${(depthErr * 100).toFixed(1)}%`);
    check(Math.abs(rateErr) < 3, `${c.name} rate=${rate} depth=${depth}: rate err ${rateErr.toFixed(1)}`);
    check(Math.abs(steady.length - nTrue) <= 2, `${c.name} rate=${rate} depth=${depth}: counted ${steady.length} vs true ${nTrue}`);
  }
  console.log(`| ${c.name} | ${(maxDepthErr * 100).toFixed(1)} % | ${(sumDepthErr / n * 100).toFixed(1)} % | ${maxRateErr.toFixed(1)} /min | ${(sumSpecErr / n * 100).toFixed(1)} % |`);
}

// ---------- 2. interruptions / hands-off ------------------------------------
{
  const rnd = P.seeded(7);
  const samples = P.synth([
    { rate: 110, depth: 0.05, seconds: 10 },
    { pause: true, seconds: 6 },
    { rate: 110, depth: 0.05, seconds: 10 },
  ], { fs: 60, noise: 0.1, random: rnd });
  const { metrics, est } = run(samples);
  console.log(`\nInterruption test: handsOff=${metrics.handsOff.toFixed(1)} s (true ≈ 6), pauses=${est.pauses.length}, CCF=${(metrics.ccf * 100).toFixed(0)} %`);
  check(metrics.handsOff > 4.5 && metrics.handsOff < 7.5, 'hands-off time within 4.5–7.5 s');
  check(est.pauses.length === 1, 'exactly one pause detected');
  check(metrics.ccf > 0.65 && metrics.ccf < 0.85, 'CCF around 75 %');
}

// ---------- 3. no compressions -> (almost) no detections --------------------
{
  const rnd = P.seeded(11);
  const samples = P.synth([{ pause: true, seconds: 30 }], { fs: 60, noise: 0.3, drift: 0.2, random: rnd });
  const { metrics } = run(samples);
  console.log(`Noise-only test: ${metrics.count} compressions from 30 s of noise (want 0)`);
  check(metrics.count === 0, 'noise produces no compressions');
}

// ---------- 4. a single jolt (picking the phone up) -------------------------
{
  const samples = [];
  const g = 9.80665;
  for (let i = 0; i < 300; i++) {
    const t = i / 60;
    let a = 0;
    if (t > 2 && t < 2.3) a = 8 * Math.sin(Math.PI * (t - 2) / 0.3);   // one shove
    samples.push({ t, ax: 0, ay: 0, az: a, gx: 0, gy: 0, gz: a + g });
  }
  const { metrics } = run(samples);
  console.log(`Single-jolt test: ${metrics.count} compressions (want ≤ 1), rate=${metrics.rate.toFixed(0)}`);
  check(metrics.count <= 1, 'a single jolt is at most one false compression');
  check(metrics.rate === 0 || metrics.count >= 2, 'no rate reported from a single event');
}

// ---------- 5. rate changes are tracked -------------------------------------
{
  const rnd = P.seeded(3);
  const samples = P.synth([
    { rate: 90, depth: 0.05, seconds: 12 },
    { rate: 120, depth: 0.05, seconds: 12 },
  ], { fs: 60, noise: 0.1, random: rnd });
  const est = new P.Estimator();
  let rAt10 = 0, rAt23 = 0;
  for (const s of samples) {
    est.push(s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.t);
    if (Math.abs(s.t - 10) < 0.01) rAt10 = est.metrics(s.t).rate;
    if (Math.abs(s.t - 23) < 0.01) rAt23 = est.metrics(s.t).rate;
  }
  console.log(`Rate tracking: ${rAt10.toFixed(0)} at 10 s (true 90), ${rAt23.toFixed(0)} at 23 s (true 120)`);
  check(Math.abs(rAt10 - 90) < 3 && Math.abs(rAt23 - 120) < 3, 'rate follows the change within 3 /min');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

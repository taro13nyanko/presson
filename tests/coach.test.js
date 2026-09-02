// Behavioural tests for app/coach.js.  Run:  node tests/coach.test.js
'use strict';
const { Coach } = require('../app/coach.js');
let failures = 0;
function check(c, msg) { if (!c) { failures++; console.log('  FAIL: ' + msg); } }

function drive(script) {
  // script: [{until, rate, depth, paused}] ; simulate a compression every 60/rate s
  const coach = new Coach();
  const cues = [];
  let t = 0, count = 0, lastComp = 0;
  for (const seg of script) {
    while (t < seg.until) {
      const paused = !!seg.paused;
      if (!paused && t - lastComp >= 60 / seg.rate) { lastComp = t; count++; }
      // like the estimator: rate/depth hold their last value during a pause
      const m = { count, rate: seg.rate, depth: seg.depth, paused: paused && t - lastComp > 2, sinceLast: t - lastComp };
      const cue = coach.update(m, t);
      if (cue) cues.push({ t: +t.toFixed(2), cue });
      t += 0.25;
    }
  }
  return cues;
}

// 1. slow & shallow -> corrected -> good: cues should be few and in the right order
{
  const cues = drive([
    { until: 10, rate: 85, depth: 0.035 },
    { until: 20, rate: 110, depth: 0.053 },
    { until: 60, rate: 110, depth: 0.053 },
  ]);
  const ids = cues.map(c => c.cue);
  console.log('scenario 1:', cues.map(c => `${c.t}s ${c.cue}`).join(', '));
  check(ids[0] === 'harder', 'first cue is "harder" (depth has priority over rate)');
  check(ids.includes('good'), 'says "good" once corrected');
  check(ids.filter(x => x === 'harder').length <= 3, 'does not nag: "harder" at most 3 times in 10 s');
  check(ids.filter(x => x === 'keep').length === 1, 'one "keep going" in 40 s of good CPR');
  const gaps = cues.slice(1).map((c, i) => c.t - cues[i].t);
  check(gaps.every(g => g >= 1.5), 'cues at least 1.5 s apart');
}

// 2. pause handling
{
  const cues = drive([
    { until: 8, rate: 110, depth: 0.053 },
    { until: 20, rate: 110, depth: 0.053, paused: true },
    { until: 26, rate: 110, depth: 0.053 },
  ]);
  const ids = cues.map(c => c.cue);
  console.log('scenario 2:', cues.map(c => `${c.t}s ${c.cue}`).join(', '));
  check(ids.includes('resume'), 'asks to resume during a pause');
  check(ids.includes('handsoff'), 'escalates to "hands-off" after 10 s');
  const firstResume = cues.find(c => c.cue === 'resume');
  check(firstResume && firstResume.t >= 9.5 && firstResume.t <= 11, 'first "resume" about 2 s after the last compression');
  check(ids[ids.length - 1] === 'good', 'says "good" when compressions restart correctly');
}

// 3. hysteresis: rate hovering around the threshold must not flip-flop
{
  const cues = drive([
    { until: 6, rate: 97, depth: 0.053 },
    { until: 12, rate: 99, depth: 0.053 },
    { until: 18, rate: 101, depth: 0.053 },
    { until: 24, rate: 99, depth: 0.053 },
  ]);
  const ids = cues.map(c => c.cue);
  console.log('scenario 3:', cues.map(c => `${c.t}s ${c.cue}`).join(', '));
  check(ids.filter(x => x === 'good').length <= 1, 'rate wobbling 99–101 does not produce repeated "good"');
}

// 4. rescuer switch reminder every 2 minutes
{
  const cues = drive([{ until: 250, rate: 110, depth: 0.053 }]);
  const sw = cues.filter(c => c.cue === 'switch');
  console.log('scenario 4: switch cues at', sw.map(c => c.t).join(', '));
  check(sw.length === 2 && sw[0].t >= 120 && sw[0].t < 122, 'switch reminders at ~120 s and ~240 s');
}

// 5. too deep / too fast
{
  const cues = drive([{ until: 10, rate: 130, depth: 0.07 }]);
  const ids = cues.map(c => c.cue);
  console.log('scenario 5:', ids.join(', '));
  check(ids[0] === 'softer', 'too deep is called first');
  check(ids.includes('slower'), 'too fast is called eventually');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll coach checks passed');
process.exit(failures ? 1 : 0);

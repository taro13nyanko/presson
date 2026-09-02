/*
 * PressOn — coaching state machine.  Pure logic, no DOM, testable in Node.
 * Turns estimator metrics into a small number of well-timed cues instead of
 * nagging on every compression.
 *
 * Cue ids (the UI maps them to text/voice in both languages):
 *   harder  softer  faster  slower  good  keep  resume  handsoff  switch
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PressOn = Object.assign(root.PressOn || {}, factory());
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    rateMin: 100, rateMax: 120,          // JRC / AHA 2025: 100–120 /min
    depthMin: 0.05, depthMax: 0.06,      // about 5 cm, not more than 6 cm
    depthLow: 0.045, depthHigh: 0.065,   // cue thresholds with tolerance
    rateLow: 98, rateHigh: 122,
    minCompressions: 3,                  // no judgement before 3 compressions
    repeatS: 4,                          // same cue at most every 4 s
    globalGapS: 1.5,                     // any two cues at least 1.5 s apart
    correctiveGapS: 2.5,                 // repeated corrections at least 2.5 s apart
    keepGoingS: 30,                      // "good, keep going" every 30 s
    pauseCueS: 2,                        // first "resume" after 2 s pause
    pauseRepeatS: 5,                     // then every 5 s
    switchEveryS: 120                    // rescuer switch reminder
  };

  function Coach(opts) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.reset();
  }

  Coach.prototype.reset = function () {
    this.lastCue = null;
    this.lastCueT = -1e9;
    this.lastByCue = {};
    this.state = 'none';       // none | harder | softer | faster | slower | good | paused
    this.problems = [];
    this.lastKeepT = -1e9;
    this.lastPauseCueT = -1e9;
    this.startT = null;
    this.lastSwitchT = null;
    this.history = [];         // [{t, cue, state}]
  };

  // Problems in priority order given the metrics (with hysteresis against
  // the current state: a problem is *entered* at the tolerance threshold and
  // *left* only when the value is back inside the target band).
  Coach.prototype.problemsOf = function (m) {
    var o = this.o, s = this.state, p = [];
    if (m.depth < (s === 'harder' ? o.depthMin : o.depthLow)) p.push('harder');
    else if (m.depth > (s === 'softer' ? o.depthMax : o.depthHigh)) p.push('softer');
    if (m.rate < (s === 'faster' ? o.rateMin : o.rateLow)) p.push('faster');
    else if (m.rate > (s === 'slower' ? o.rateMax : o.rateHigh)) p.push('slower');
    return p;
  };

  Coach.prototype._emit = function (cue, now, state) {
    this.lastCue = cue; this.lastCueT = now; this.lastByCue[cue] = now;
    this.state = state;
    this.history.push({ t: now, cue: cue, state: state });
    return cue;
  };

  // Call often (every compression and on a ~250 ms timer).  Returns a cue id or null.
  Coach.prototype.update = function (m, now) {
    var o = this.o;
    if (this.startT === null) { this.startT = now; this.lastSwitchT = now; }
    var gapOk = now - this.lastCueT >= o.globalGapS;
    var prev = this.state;

    if (m.count < o.minCompressions) { this.state = 'none'; return null; }

    if (m.paused) {
      if (prev !== 'paused') { this.lastPauseCueT = -1e9; this.state = 'paused'; }
      var since = m.sinceLast;
      if (since >= o.pauseCueS && now - this.lastPauseCueT >= o.pauseRepeatS && gapOk) {
        this.lastPauseCueT = now;
        return this._emit(since >= 10 ? 'handsoff' : 'resume', now, 'paused');
      }
      return null;
    }

    // rescuer switch reminder (guidelines: swap every ~2 minutes to avoid fatigue)
    if (now - this.lastSwitchT >= o.switchEveryS && gapOk) {
      this.lastSwitchT = now;
      return this._emit('switch', now, prev === 'paused' ? 'good' : prev);
    }

    var problems = this.problemsOf(m);
    this.problems = problems;
    var next = problems.length ? problems[0] : 'good';

    if (next === 'good') {
      if (prev !== 'good') {
        if (!gapOk) return null;           // keep prev state, retry next tick
        this.lastKeepT = now;
        return this._emit('good', now, 'good');
      }
      if (now - this.lastKeepT >= o.keepGoingS && gapOk) {
        this.lastKeepT = now;
        return this._emit('keep', now, 'good');
      }
      return null;
    }

    // corrective: on a state change say the top problem; when repeating,
    // rotate through all current problems, oldest-said first
    if (prev !== next) {
      if (!gapOk) return null;
      return this._emit(next, now, next);
    }
    if (now - this.lastCueT < o.correctiveGapS) return null;
    var best = null, bestT = Infinity;
    for (var i = 0; i < problems.length; i++) {
      var t = this.lastByCue[problems[i]] || -1e9;
      if (t < bestT) { bestT = t; best = problems[i]; }
    }
    if (best && now - bestT >= o.repeatS) return this._emit(best, now, next);
    return null;
  };

  return { Coach: Coach, COACH_DEFAULTS: DEFAULTS };
});

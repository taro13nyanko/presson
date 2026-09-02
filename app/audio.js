/* PressOn — metronome (WebAudio), voice (speechSynthesis), haptics (Android). */
(function (root) {
  'use strict';

  function Audio() {
    this.ctx = null;
    this.metroOn = false;
    this.metroTimer = null;
    this.bpm = 110;
    this.voiceOn = true;
    this.lang = 'en';
    this.speaking = false;
    this.lastSpoken = { text: '', t: 0 };
    this.onSpeakStart = null;
    this.onSpeakEnd = null;
  }

  // Must be called from a user gesture (Start button) to unlock audio on iOS.
  Audio.prototype.unlock = function () {
    try {
      if (!this.ctx) this.ctx = new (root.AudioContext || root.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      // silent buffer to unlock
      var b = this.ctx.createBuffer(1, 1, 22050);
      var s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch (e) { /* no audio */ }
    try {
      if (root.speechSynthesis) {
        var u = new SpeechSynthesisUtterance(' ');
        u.volume = 0; root.speechSynthesis.speak(u);
      }
    } catch (e) { /* no speech */ }
  };

  // iOS suspends the context on screen lock / calls; call on visibilitychange and before clicks
  Audio.prototype.resume = function () {
    try { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); } catch (e) { /* ignore */ }
  };

  Audio.prototype.click = function (accent) {
    if (!this.ctx) return;
    try {
      if (this.ctx.state !== 'running') { this.ctx.resume(); return; }
      var t = this.ctx.currentTime;
      var o = this.ctx.createOscillator();
      var g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = accent ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t); o.stop(t + 0.07);
    } catch (e) { /* ignore */ }
  };

  Audio.prototype.startMetronome = function (bpm) {
    this.bpm = bpm || this.bpm;
    this.stopMetronome();
    this.metroOn = true;
    var self = this, beat = 0;
    this.metroTimer = setInterval(function () {
      self.click(beat % 30 === 0);   // accent every 30 (count blocks)
      beat++;
    }, 60000 / this.bpm);
  };

  Audio.prototype.stopMetronome = function () {
    if (this.metroTimer) clearInterval(this.metroTimer);
    this.metroTimer = null;
    this.metroOn = false;
  };

  Audio.prototype.pickVoice = function () {
    if (!root.speechSynthesis) return null;
    var voices = root.speechSynthesis.getVoices() || [];
    var want = this.lang === 'ja' ? 'ja' : 'en';
    var best = null;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if ((v.lang || '').toLowerCase().indexOf(want) === 0) {
        // prefer local, "natural"/"Google"/"Kyoko"/"Samantha" voices
        var score = (v.localService ? 2 : 0) + (/natural|google|kyoko|samantha|o-ren|siri/i.test(v.name) ? 1 : 0);
        if (!best || score > best.score) best = { v: v, score: score };
      }
    }
    return best ? best.v : null;
  };

  // Speak a line.  `important` lines interrupt whatever is being said.
  Audio.prototype.say = function (text, important) {
    if (!this.voiceOn || !root.speechSynthesis || !text) return;
    var now = Date.now();
    if (this.lastSpoken.text === text && now - this.lastSpoken.t < 1200) return;   // debounce
    this.lastSpoken = { text: text, t: now };
    try {
      if (important) root.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang === 'ja' ? 'ja-JP' : 'en-US';
      var v = this.pickVoice(); if (v) u.voice = v;
      u.rate = this.lang === 'ja' ? 1.1 : 1.05;
      u.pitch = 1.0; u.volume = 1.0;
      var self = this;
      u.onstart = function () { self.speaking = true; if (self.onSpeakStart) self.onSpeakStart(); };
      u.onend = u.onerror = function () { self.speaking = false; if (self.onSpeakEnd) self.onSpeakEnd(); };
      root.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  };

  Audio.prototype.stopSpeaking = function () {
    try { root.speechSynthesis && root.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  };

  Audio.prototype.buzz = function (pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern || 40); } catch (e) { /* iOS has no vibration API */ }
  };

  root.PressOn = Object.assign(root.PressOn || {}, { Audio: Audio });
})(typeof self !== 'undefined' ? self : this);

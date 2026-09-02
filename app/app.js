/* PressOn — app controller: sensors, guided flow, live coaching, summary, export. */
(function () {
  'use strict';
  var P = window.PressOn;
  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------------ */
  /* settings & language                                                */
  /* ------------------------------------------------------------------ */
  var settings = loadSettings();
  var lang = settings.lang || P.detectLang();
  var qs = new URLSearchParams(location.search);
  if (qs.get('lang') && P.STR[qs.get('lang')]) lang = qs.get('lang');

  function loadSettings() {
    var d = { voice: true, metro: true, handsFree: false, share: true, name: '', llmUrl: '', llmKey: '', llmModel: '' };
    try { return Object.assign(d, JSON.parse(localStorage.getItem('presson.settings') || '{}')); } catch (e) { return d; }
  }
  function saveSettings() {
    try { localStorage.setItem('presson.settings', JSON.stringify(settings)); localStorage.setItem('presson.lang', lang); } catch (e) { /* ignore */ }
  }
  function T(key) { var s = P.STR[lang]; return key.split('.').reduce(function (o, k) { return o && o[k]; }, s) || key; }
  function V(key, vars) { return P.fmt(P.VOICE[lang][key] || '', vars); }

  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = T(el.getAttribute('data-i18n'));
      if (typeof v === 'string') el.textContent = v;
    });
    $('langBtn').textContent = lang === 'en' ? 'EN / 日本語' : '日本語 / EN';
    $('setLang').value = lang;
    audio.lang = lang;
    renderStep();
  }

  /* ------------------------------------------------------------------ */
  /* objects                                                            */
  /* ------------------------------------------------------------------ */
  var audio = new P.Audio();
  var est = new P.Estimator();
  var coach = new P.Coach();
  var serverMode = false;
  var session = null;       // current session record
  var mode = null;          // 'rescue' | 'training' | 'demo'
  var stepIdx = 0;
  var motionSeen = false;
  var motionBound = false;
  var tickTimer = null, demoTimer = null, shareTimer = null;
  var wakeLock = null;
  var recognizer = null;
  var clientId = 'p' + Math.random().toString(36).slice(2, 8);

  function nowS() { return performance.now() / 1000; }

  /* ------------------------------------------------------------------ */
  /* screens                                                            */
  /* ------------------------------------------------------------------ */
  var screens = ['home', 'steps', 'session', 'summary'];
  function show(id) { screens.forEach(function (s) { $(s).hidden = s !== id; }); window.scrollTo(0, 0); }

  /* ------------------------------------------------------------------ */
  /* sensors                                                            */
  /* ------------------------------------------------------------------ */
  function onMotion(e) {
    motionSeen = true;
    // only while compressions are actually being coached — never during the
    // guided steps or the countdown (walking, kneeling and placing the phone
    // would otherwise be counted as compressions and a false pause)
    if (!session || !session.running || session.ended || session.demo) return;
    var t = (e.timeStamp && e.timeStamp > 0 ? e.timeStamp : performance.now()) / 1000;
    var a = e.acceleration, g = e.accelerationIncludingGravity;
    if (!g || g.x === null) return;
    var ax = a && a.x !== null && a.x !== undefined ? a.x : null;
    var ay = ax === null ? null : a.y, az = ax === null ? null : a.z;
    feed(ax, ay, az, g.x, g.y, g.z, t);
  }

  function feed(ax, ay, az, gx, gy, gz, t) {
    if (session.t0 === null) session.t0 = t;
    var ev = est.push(ax, ay, az, gx, gy, gz, t);
    if (session.samples.length < 60 * 60 * 30) {          // cap at 30 min of raw data
      session.samples.push([r3(t - session.t0), r3(ax), r3(ay), r3(az), r3(gx), r3(gy), r3(gz)]);
    }
    for (var i = 0; i < ev.length; i++) onCompression(ev[i], t);
  }
  function r3(x) { return x === null || x === undefined ? null : Math.round(x * 1000) / 1000; }

  // Request permission (iOS) and bind the listener.  Must run inside a tap.
  function enableMotion() {
    if (!window.isSecureContext) { note(T('needHttps')); return Promise.resolve(false); }
    if (!window.DeviceMotionEvent) { note(T('noSensor')); return Promise.resolve(false); }
    var p = Promise.resolve('granted');
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      p = DeviceMotionEvent.requestPermission().catch(function () { return 'denied'; });
    }
    return p.then(function (state) {
      if (state !== 'granted') { note(T('permDenied')); return false; }
      if (!motionBound) { window.addEventListener('devicemotion', onMotion, { passive: true }); motionBound = true; }
      // detect "no sensor" (desktop) after a short wait
      setTimeout(function () { if (!motionSeen && mode !== 'demo') note(T('noSensor')); }, 2000);
      return true;
    });
  }

  function note(msg) { var n = $('sensorNote'); n.textContent = msg; n.hidden = !msg; }

  /* ------------------------------------------------------------------ */
  /* guided steps                                                       */
  /* ------------------------------------------------------------------ */
  var STEPS = [
    { title: 'step1Title', body: 'step1Body', btn: 'step1Btn', voice: 'step1', fig: figResponse },
    { title: 'step2Title', body: 'step2Body', btn: 'step2Btn', voice: 'step2', fig: figCall },
    { title: 'step3Title', body: 'step3Body', btn: 'step3Btn', voice: 'step3', fig: figPlace }
  ];
  function renderStep() {
    if ($('steps').hidden) return;
    var s = STEPS[stepIdx];
    $('stepNum').textContent = (stepIdx + 1) + ' / 3';
    $('stepTitle').textContent = T(s.title);
    $('stepBody').textContent = T(s.body);
    $('stepBtn').textContent = T(s.btn);
    $('stepFigure').innerHTML = s.fig();
    $('skipBtn').hidden = stepIdx === 2;
  }
  function gotoStep(i) {
    stepIdx = i; show('steps'); renderStep();
    audio.say(V(STEPS[i].voice), true);
  }
  function figResponse() {
    return '<rect x="40" y="120" width="280" height="40" rx="12" fill="#22303c"/>' +
      '<circle cx="80" cy="140" r="22" fill="#98a2ad"/>' +
      '<rect x="110" y="122" width="170" height="36" rx="14" fill="#98a2ad"/>' +
      '<path d="M120 60 l0 40 M100 80 l40 0" stroke="#ff3b3b" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M150 70 c20 -10 30 10 20 30" stroke="#ffb020" stroke-width="6" fill="none" stroke-linecap="round"/>';
  }
  function figCall() {
    return '<rect x="130" y="20" width="100" height="160" rx="18" fill="#22303c" stroke="#98a2ad" stroke-width="4"/>' +
      '<text x="180" y="112" text-anchor="middle" font-size="44" font-weight="900" fill="#22d36b" font-family="sans-serif">119</text>' +
      '<path d="M250 60 q30 40 0 80 M270 40 q50 60 0 120" stroke="#3ea6ff" stroke-width="6" fill="none" stroke-linecap="round"/>' +
      '<text x="70" y="110" text-anchor="middle" font-size="28" font-weight="900" fill="#ffb020" font-family="sans-serif">AED</text>';
  }
  function figPlace() {
    return '<rect x="40" y="90" width="280" height="90" rx="30" fill="#22303c"/>' +
      '<rect x="150" y="100" width="60" height="70" rx="8" fill="#0b0f14" stroke="#3ea6ff" stroke-width="3"/>' +
      '<ellipse cx="180" cy="120" rx="46" ry="20" fill="#98a2ad" opacity="0.95"/>' +
      '<ellipse cx="180" cy="100" rx="42" ry="18" fill="#c5ccd3"/>' +
      '<path d="M180 20 v60" stroke="#ff3b3b" stroke-width="8" stroke-linecap="round"/>' +
      '<path d="M165 40 l15 -20 l15 20" stroke="#ff3b3b" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  /* ------------------------------------------------------------------ */
  /* session                                                            */
  /* ------------------------------------------------------------------ */
  function newSession(m) {
    est.reset(); coach.reset();
    session = { mode: m, demo: m === 'demo', startedAt: new Date(), t0: null, startT: null, running: false, samples: [], compressions: [], cues: [], events: [], ended: false, aedAt: null };
    mode = m;
  }

  function beginFlow(m) {
    audio.unlock();
    audio.voiceOn = settings.voice;
    newSession(m);
    if (m === 'demo') { startCompressions(); return; }
    enableMotion().then(function (ok) {
      if (!ok) return;
      if (m === 'rescue') gotoStep(0); else startCompressions();
    });
  }

  function startCompressions() {
    show('session');
    $('modeLbl').textContent = mode === 'demo' ? 'DEMO' : mode === 'training' ? T('training') : '';
    $('btnAed').classList.remove('done');
    $('btnAed').querySelector('span').textContent = T('aed');
    $('cueText').textContent = '';
    setStatus('none');
    requestWakeLock();
    // countdown 3-2-1 in training/demo; immediate in rescue
    if (mode === 'rescue') { runSession(); return; }
    var cd = $('countdown'), n = 3; cd.hidden = false; $('countNum').textContent = n;
    audio.say(V('countdown'), true);
    var iv = setInterval(function () {
      n--; if (n <= 0) { clearInterval(iv); cd.hidden = true; runSession(); } else $('countNum').textContent = n;
    }, 1000);
  }

  function runSession() {
    est.reset(); coach.reset();
    session.samples.length = 0; session.compressions.length = 0; session.t0 = null;
    session.startedAt = new Date();
    session.startT = nowS(); session.running = true;
    lastStatus = 'none';
    audio.say(V('go'), true);
    if (settings.metro) audio.startMetronome(110);
    if (session.demo) startDemoFeed();
    tickTimer = setInterval(tick, 100);
    if (serverMode && settings.share) shareTimer = setInterval(shareReport, 500);
    startRecognizer();
  }

  function onCompression(c, t) {
    session.compressions.push({ t: r3(t - session.t0), depth: r3(c.depth), depthSpec: r3(c.depthSpec), dur: r3(c.dur), rate: Math.round(c.rate) });
    var dot = $('pulseDot'); dot.classList.add('hit'); setTimeout(function () { dot.classList.remove('hit'); }, 90);
    audio.buzz(15);
  }

  var lastStatus = 'none';
  function setStatus(s) {
    var el = $('statusWord');
    el.textContent = T('status.' + s);
    el.className = 'status ' + (s === 'good' ? 'good' : s === 'none' ? 'none' : s === 'softer' ? 'warn' : 'bad');
    lastStatus = s;
  }

  function tick() {
    if (!session || session.ended) return;
    $('elapsed').textContent = fmtTime(nowS() - session.startT);
    // ---- no sensor data at all (desktop, or permission silently refused)
    if (!session.demo && !motionSeen && nowS() - session.startT > 2.5 && !$('cueText').textContent) $('cueText').textContent = T('noSensor');
    // wait for the first sample so the coach clock runs in the sensor's time base
    if (!session.demo && est.tPrev === null) return;
    var now = session.demo ? demoNow() : est.tPrev + (nowS() - lastSampleWall);
    var m = est.metrics(now);
    // ---- gauges
    $('count').textContent = m.count;
    var rateEl = $('rateNum'), depthEl = $('depthNum');
    if (m.count >= 2 && !m.paused) {
      rateEl.textContent = Math.round(m.rate);
      rateEl.className = 'num ' + (m.rate >= 100 && m.rate <= 120 ? 'good' : 'bad');
      $('rateFill').style.left = Math.max(0, Math.min(100, (m.rate - 60) / 100 * 100)) + '%';
    } else { rateEl.textContent = '--'; rateEl.className = 'num'; }
    if (m.count >= 1) {
      var cm = m.depth * 100;
      depthEl.textContent = cm.toFixed(1);
      depthEl.className = 'num ' + (cm >= 5 && cm <= 6 ? 'good' : cm > 6 ? 'warn' : 'bad');
      $('depthFill').style.width = Math.max(0, Math.min(100, cm / 8 * 100)) + '%';
    }
    $('handsOff').textContent = Math.round(m.handsOff) + ' s';
    $('handsOff').className = m.paused ? 'bad' : '';
    $('ccf').textContent = m.count ? Math.round(m.ccf * 100) + '%' : '--';
    // ---- coaching
    var cue = coach.update(m, now);
    var st = coach.state === 'none' || coach.state === 'paused' ? coach.state : (coach.problems.length ? coach.problems[0] : 'good');
    if (m.count < 3) st = 'none';
    if (st !== lastStatus) setStatus(st);
    if (cue) {
      var line = V(cue, { n: Math.round(m.sinceLast) });
      $('cueText').textContent = line;
      audio.say(line, cue === 'resume' || cue === 'handsoff');
      session.cues.push({ t: r3(now - (session.t0 === null ? now : session.t0)), cue: cue, rate: Math.round(m.rate), depth: r3(m.depth) });
      if (cue !== 'good' && cue !== 'keep') audio.buzz([60, 40, 60]);
    }
  }
  var lastSampleWall = 0;
  window.addEventListener('devicemotion', function () { lastSampleWall = nowS(); }, { passive: true });

  function fmtTime(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

  function endSession() {
    if (!session || session.ended) return;
    session.ended = true;
    session.endT = nowS();
    clearInterval(tickTimer); clearInterval(demoTimer); clearInterval(shareTimer);
    audio.stopMetronome(); audio.say(V('stopped'), true);
    stopRecognizer(); releaseWakeLock();
    var stats = computeStats();
    session.stats = stats;
    renderSummary(stats);
    if (serverMode && settings.share) shareReport(true);
    show('summary');
  }

  function aedArrived() {
    if (!session || !session.running || session.ended) return;
    if (session.aedAt !== null) { hint(T('aedLogged') + ' ' + fmtTime(session.aedAt)); return; }
    session.aedAt = nowS() - session.startT;
    session.events.push({ t: r3(session.aedAt), type: 'aed' });
    $('btnAed').classList.add('done');
    $('btnAed').querySelector('span').textContent = T('aedDone') + ' ' + fmtTime(session.aedAt);
    $('cueText').textContent = V('aed');
    audio.say(V('aed'), true);
    audio.buzz([80, 60, 80]);
  }

  /* ------------------------------------------------------------------ */
  /* desktop demo: scripted synthetic session fed in real time          */
  /* ------------------------------------------------------------------ */
  var demoSamples = [], demoIdx = 0, demoStartWall = 0;
  function demoNow() { return nowS() - demoStartWall; }
  function startDemoFeed() {
    var rnd = P.seeded(42);
    demoSamples = P.synth([
      { rate: 84, depth: 0.034, seconds: 12, duty: 0.45 },      // slow and shallow -> "push harder", "faster"
      { rate: 108, depth: 0.052, seconds: 16, duty: 0.45 },     // corrected -> "good"
      { pause: true, seconds: 7 },                              // hands off -> "resume"
      { rate: 128, depth: 0.066, seconds: 12, duty: 0.45 },     // too fast, too deep
      { rate: 112, depth: 0.055, seconds: 40, duty: 0.45 }      // good until the end
    ], { fs: 60, noise: 0.12, drift: 0.05, tiltDeg: 8, jitterS: 0.002, random: rnd });
    demoIdx = 0; demoStartWall = nowS();
    demoTimer = setInterval(function () {
      var t = demoNow();
      while (demoIdx < demoSamples.length && demoSamples[demoIdx].t <= t) {
        var s = demoSamples[demoIdx++];
        feed(s.ax, s.ay, s.az, s.gx, s.gy, s.gz, s.t);
      }
      if (demoIdx >= demoSamples.length) endSession();
    }, 33);
  }

  /* ------------------------------------------------------------------ */
  /* summary, debrief, export                                           */
  /* ------------------------------------------------------------------ */
  function computeStats() {
    var cs = session.compressions, n = cs.length;
    var rates = [], depths = [], inTarget = 0;
    for (var i = 0; i < n; i++) {
      depths.push(cs[i].depth);
      var r = i > 0 ? 60 / (cs[i].t - cs[i - 1].t) : null;
      if (r !== null && r >= 40 && r <= 200) rates.push(r);
      var okD = cs[i].depth >= 0.05 && cs[i].depth <= 0.06;
      var okR = r === null ? true : (r >= 100 && r <= 120);
      if (okD && okR) inTarget++;
    }
    var m = est.metrics(est.tPrev !== null ? est.tPrev : 0);
    var dur = n ? cs[n - 1].t - cs[0].t + cs[n - 1].dur : 0;
    return {
      count: n,
      durationS: dur,
      sessionS: session.endT - session.startT,
      meanRate: rates.length ? P.median(rates) : 0,
      meanDepthCm: depths.length ? depths.reduce(function (a, b) { return a + b; }, 0) / depths.length * 100 : 0,
      inTargetPct: n ? Math.round(inTarget / n * 100) : 0,
      handsOffS: m.handsOff,
      ccfPct: Math.round(m.ccf * 100),
      pauses: est.pauses.length,
      aedAt: session.aedAt,
      startedAt: session.startedAt.toISOString(),
      mode: session.mode
    };
  }

  function renderSummary(s) {
    $('sDuration').textContent = fmtTime(s.durationS);
    $('sCount').textContent = s.count;
    $('sRate').textContent = s.count >= 2 ? Math.round(s.meanRate) + ' /min' : '--';
    $('sRate').className = 'v ' + (s.meanRate >= 100 && s.meanRate <= 120 ? 'good' : 'bad');
    $('sDepth').textContent = s.count ? s.meanDepthCm.toFixed(1) + ' cm' : '--';
    $('sDepth').className = 'v ' + (s.meanDepthCm >= 5 && s.meanDepthCm <= 6 ? 'good' : 'bad');
    $('sInTarget').textContent = s.inTargetPct + '%';
    $('sCcf').textContent = s.count ? s.ccfPct + '%' : '--';
    $('sCcf').className = 'v ' + (s.ccfPct >= 80 ? 'good' : 'bad');
    $('sHandsOff').textContent = Math.round(s.handsOffS) + ' s';
    $('sPauses').textContent = s.pauses;
    drawChart();
    $('debriefRule').textContent = ruleDebrief(s);
    $('debriefAi').hidden = true; $('debriefAi').textContent = '';
  }

  function drawChart() {
    var cs = session.compressions, svg = $('chart');
    var W = 600, H = 220, L = 44, R = 44, Tp = 14, B = 26;
    if (cs.length < 2) { svg.innerHTML = ''; return; }
    var tEnd = cs[cs.length - 1].t, t0 = cs[0].t;
    function X(t) { return L + (t - t0) / Math.max(1, tEnd - t0) * (W - L - R); }
    function Yr(r) { return Tp + (1 - (Math.min(160, Math.max(60, r)) - 60) / 100) * (H - Tp - B); }
    function Yd(d) { return Tp + (1 - Math.min(8, Math.max(0, d)) / 8) * (H - Tp - B); }
    var out = [];
    out.push('<rect x="' + L + '" y="' + Yr(120) + '" width="' + (W - L - R) + '" height="' + (Yr(100) - Yr(120)) + '" fill="rgba(34,211,107,0.12)"/>');
    out.push('<rect x="' + L + '" y="' + Yd(6) + '" width="' + (W - L - R) + '" height="' + (Yd(5) - Yd(6)) + '" fill="rgba(62,166,255,0.12)"/>');
    est.pauses.forEach(function (p) {
      var a = p.t0 - session.t0, b = p.t1 - session.t0;
      out.push('<rect x="' + X(a) + '" y="' + Tp + '" width="' + Math.max(2, X(b) - X(a)) + '" height="' + (H - Tp - B) + '" fill="rgba(255,59,59,0.18)"/>');
    });
    var pr = [], pd = [];
    for (var i = 1; i < cs.length; i++) {
      var r = 60 / (cs[i].t - cs[i - 1].t);
      if (r >= 40 && r <= 200) pr.push(X(cs[i].t).toFixed(1) + ',' + Yr(r).toFixed(1));
      pd.push(X(cs[i].t).toFixed(1) + ',' + Yd(cs[i].depth * 100).toFixed(1));
    }
    out.push('<polyline points="' + pr.join(' ') + '" fill="none" stroke="#22d36b" stroke-width="2"/>');
    out.push('<polyline points="' + pd.join(' ') + '" fill="none" stroke="#3ea6ff" stroke-width="2"/>');
    [60, 100, 120, 160].forEach(function (r) { out.push('<text x="' + (L - 6) + '" y="' + (Yr(r) + 4) + '" text-anchor="end" font-size="11" fill="#22d36b">' + r + '</text>'); });
    [0, 5, 6, 8].forEach(function (d) { out.push('<text x="' + (W - R + 6) + '" y="' + (Yd(d) + 4) + '" font-size="11" fill="#3ea6ff">' + d + ' cm</text>'); });
    out.push('<text x="' + L + '" y="' + (H - 8) + '" font-size="11" fill="#98a2ad">0:00</text>');
    out.push('<text x="' + (W - R) + '" y="' + (H - 8) + '" text-anchor="end" font-size="11" fill="#98a2ad">' + fmtTime(tEnd - t0) + '</text>');
    out.push('<text x="' + (W / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#98a2ad">rate /min (green) · depth cm (blue) · red = interruption</text>');
    svg.innerHTML = out.join('');
  }

  function ruleDebrief(s) {
    var d = P.STR[lang].ruleDebrief, out = [];
    var vars = { rate: Math.round(s.meanRate), depth: s.meanDepthCm.toFixed(1), handsOff: Math.round(s.handsOffS), ccf: s.ccfPct, inTarget: s.inTargetPct };
    if (s.count < 2) return d.outro;
    out.push(P.fmt(s.meanRate < 100 ? d.rateLow : s.meanRate > 120 ? d.rateHigh : d.rateOk, vars));
    out.push(P.fmt(s.meanDepthCm < 5 ? d.depthLow : s.meanDepthCm > 6 ? d.depthHigh : d.depthOk, vars));
    out.push(P.fmt(s.ccfPct < 80 ? d.ccfLow : d.ccfOk, vars));
    out.push(P.fmt(d.consistency, vars));
    out.push(d.outro);
    return out.join('\n');
  }

  function handoverText(s) {
    return P.fmt(T('handoverText'), {
      start: session.startedAt.toLocaleTimeString(), dur: fmtTime(s.durationS), count: s.count,
      rate: Math.round(s.meanRate), depth: s.meanDepthCm.toFixed(1), inTarget: s.inTargetPct,
      handsOff: Math.round(s.handsOffS), ccf: s.ccfPct,
      aed: s.aedAt === null ? '—' : fmtTime(s.aedAt) + ' after start'
    });
  }

  function copyText(txt) {
    var done = function () { toast(T('copied')); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { legacyCopy(txt); done(); });
    else { legacyCopy(txt); done(); }
  }
  function legacyCopy(txt) {
    var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ } document.body.removeChild(ta);
  }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1500);
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/octet-stream' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function exportJson() {
    var payload = {
      app: 'PressOn', version: '1.0', mode: session.mode, startedAt: session.startedAt.toISOString(),
      stats: session.stats, compressions: session.compressions, cues: session.cues, events: session.events,
      pauses: est.pauses.map(function (p) { return { t0: r3(p.t0 - session.t0), t1: r3(p.t1 - session.t0) }; }),
      sampleColumns: ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'], samples: session.samples,
      device: navigator.userAgent, estimator: est.o
    };
    download('presson-' + session.startedAt.toISOString().replace(/[:.]/g, '-') + '.json', JSON.stringify(payload), 'application/json');
  }
  function exportCsv() {
    var rows = ['t_s,depth_cm,depth_spectral_cm,cycle_s,rate_per_min'];
    session.compressions.forEach(function (c) { rows.push([c.t, (c.depth * 100).toFixed(2), (c.depthSpec * 100).toFixed(2), c.dur, c.rate].join(',')); });
    download('presson-compressions.csv', rows.join('\n'), 'text/csv');
  }

  /* ------------------------------------------------------------------ */
  /* AI debrief (any OpenAI-compatible endpoint, e.g. Featherless.ai)   */
  /* ------------------------------------------------------------------ */
  function aiDebrief() {
    var s = session.stats, box = $('debriefAi');
    if (!settings.llmKey || !settings.llmUrl) { $('settings').showModal(); return; }
    box.hidden = false; box.textContent = T('debriefBusy');
    var sys = lang === 'ja'
      ? 'あなたは救急救命の指導者です。以下の胸骨圧迫データ（スマホ加速度計の推定値、医療機器ではない）をもとに、練習者に向けて、良かった点1つ、直すべき点2つ、次回の練習方法1つを、合計200字以内の日本語で、励ます口調で書いてください。目標: 100〜120回/分、深さ5〜6cm、圧迫時間の割合80%以上。'
      : 'You are a CPR instructor. From the chest-compression data below (estimated by a phone accelerometer, not a medical device) write, for the trainee, one thing done well, two things to fix, and one drill for next time. Under 120 words, encouraging, concrete numbers. Targets: 100–120/min, 5–6 cm, compression fraction over 80%.';
    var body = {
      model: settings.llmModel || 'Qwen/Qwen2.5-7B-Instruct',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ stats: s, cues: session.cues.slice(0, 40) }) }],
      max_tokens: 400, temperature: 0.4
    };
    var url = settings.llmUrl.replace(/\/+$/, '') + '/chat/completions';
    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + settings.llmKey }, body: JSON.stringify(body) };
    fetch(url, opts).then(function (r) { return r.json(); })
      .catch(function () {
        // browsers may block cross-origin calls: fall back to the local server's proxy
        if (!serverMode) throw new Error('network');
        return fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url, key: settings.llmKey, body: body }) }).then(function (r) { return r.json(); });
      })
      .then(function (j) {
        var txt = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : (j && j.error ? String(j.error.message || j.error) : 'No answer');
        box.textContent = txt.trim();
      })
      .catch(function (e) { box.textContent = 'AI debrief failed (' + e.message + '). The rule-based debrief above still applies.'; });
  }

  /* ------------------------------------------------------------------ */
  /* instructor screen relay (only when served by tools/serve.py)       */
  /* ------------------------------------------------------------------ */
  function detectServer() {
    fetch('api/ping', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.presson) { serverMode = true; $('instructorLink').hidden = false; } })
      .catch(function () { serverMode = false; });
  }
  function shareReport(final) {
    if (!session) return;
    var m = est.metrics(session.demo ? demoNow() : (est.tPrev !== null ? est.tPrev : 0));
    var payload = { id: clientId, name: settings.name || clientId, mode: session.mode, ended: !!final,
      t: Math.round(nowS() - session.startT), count: m.count, rate: Math.round(m.rate), depthCm: +(m.depth * 100).toFixed(1),
      paused: m.paused, handsOff: Math.round(m.handsOff), ccf: Math.round(m.ccf * 100), status: lastStatus, stats: final ? session.stats : null };
    fetch('api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }).catch(function () { /* ignore */ });
  }

  /* ------------------------------------------------------------------ */
  /* voice commands (optional)                                          */
  /* ------------------------------------------------------------------ */
  function startRecognizer() {
    if (!settings.handsFree) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try {
      recognizer = new SR();
      recognizer.lang = lang === 'ja' ? 'ja-JP' : 'en-US';
      recognizer.continuous = true; recognizer.interimResults = false;
      recognizer.onresult = function (e) {
        var txt = '';
        for (var i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript + ' ';
        txt = txt.toLowerCase();
        if (/\b(stop|finish)\b|ストップ|停止|終了/.test(txt)) endSession();
        else if (/\ba ?e ?d\b|エーイーディー|ＡＥＤ|aed/.test(txt)) aedArrived();
      };
      recognizer.onend = function () { if (session && !session.ended && settings.handsFree && !audio.speaking) { try { recognizer.start(); } catch (e) { /* ignore */ } } };
      audio.onSpeakStart = function () { try { recognizer.stop(); } catch (e) { /* ignore */ } };
      audio.onSpeakEnd = function () { if (session && !session.ended) { try { recognizer.start(); } catch (e) { /* ignore */ } } };
      recognizer.start();
    } catch (e) { recognizer = null; }
  }
  function stopRecognizer() {
    audio.onSpeakStart = audio.onSpeakEnd = null;
    if (recognizer) { try { recognizer.onend = null; recognizer.stop(); } catch (e) { /* ignore */ } recognizer = null; }
  }

  /* ------------------------------------------------------------------ */
  /* wake lock                                                          */
  /* ------------------------------------------------------------------ */
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () { /* ignore */ });
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(function () { /* ignore */ }); wakeLock = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && session && !session.ended) { requestWakeLock(); audio.resume(); }
  });
  // leaving the page mid-session (edge-swipe "back" on Android) loses the log
  window.addEventListener('beforeunload', function (e) { if (session && !session.ended && session.running) { e.preventDefault(); e.returnValue = ''; } });

  /* ------------------------------------------------------------------ */
  /* hold-to-press buttons (palms on the screen must not trigger them)  */
  /* ------------------------------------------------------------------ */
  // A hold only counts for a single finger-sized contact; a second contact
  // anywhere (palm, heel of the hand) cancels it.
  var touches = 0;
  document.addEventListener('pointerdown', function (e) { if (e.isPrimary) touches = 0; touches++; }, true);   // isPrimary = no other contact active
  ['pointerup', 'pointercancel'].forEach(function (ev) { document.addEventListener(ev, function () { touches = Math.max(0, touches - 1); }, true); });
  document.addEventListener('visibilitychange', function () { touches = 0; });
  function holdButton(el, ms, cb, barEl) {
    var timer = null, start = 0, raf = null, pid = null, done = false;
    function anim() { if (barEl) barEl.style.width = Math.min(100, (performance.now() - start) / ms * 100) + '%'; raf = requestAnimationFrame(anim); }
    function down(e) {
      e.preventDefault();
      if (timer !== null) { cancel(); return; }                                  // second contact on the button = palm
      if (touches > 1) return;                                                   // other fingers already on the screen
      done = false; pid = e.pointerId; start = performance.now(); anim();
      timer = setTimeout(function () { done = true; cancel(); cb(); }, ms);
    }
    function cancel() { clearTimeout(timer); timer = null; pid = null; cancelAnimationFrame(raf); if (barEl) barEl.style.width = '0'; }
    function up() {
      var wasHolding = timer !== null;
      cancel();
      if (wasHolding && !done) hint(T('holdHint'));                             // released too early: tell the user
    }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    ['pointercancel', 'pointerleave'].forEach(function (ev) { el.addEventListener(ev, cancel); });
    document.addEventListener('pointerdown', function (e) { if (timer !== null && e.pointerId !== pid) cancel(); }, true);
  }
  var hintTimer = null;
  function hint(msg) {
    var el = $('cueText'); el.textContent = msg;
    clearTimeout(hintTimer); hintTimer = setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 1500);
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */
  $('btnRescue').addEventListener('click', function () { beginFlow('rescue'); });
  $('btnTraining').addEventListener('click', function () { beginFlow('training'); });
  $('btnDemo').addEventListener('click', function () { beginFlow('demo'); });
  $('stepBtn').addEventListener('click', function () { if (stepIdx < 2) gotoStep(stepIdx + 1); else startCompressions(); });
  $('skipBtn').addEventListener('click', function () { startCompressions(); });
  holdButton($('btnStop'), 1000, endSession, $('stopHold'));
  holdButton($('btnAed'), 500, aedArrived, $('aedHold'));
  $('btnNew').addEventListener('click', function () { show('home'); });
  $('btnHandover').addEventListener('click', function () { copyText(handoverText(session.stats)); });
  $('btnJson').addEventListener('click', exportJson);
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnDebrief').addEventListener('click', aiDebrief);
  $('langBtn').addEventListener('click', function () { lang = lang === 'en' ? 'ja' : 'en'; saveSettings(); applyLang(); });

  // settings dialog
  var dlg = $('settings');
  $('btnSettings').addEventListener('click', function () {
    $('setVoice').checked = settings.voice; $('setMetro').checked = settings.metro; $('setHandsFree').checked = settings.handsFree;
    $('setShare').checked = settings.share; $('setName').value = settings.name;
    $('setLlmUrl').value = settings.llmUrl; $('setLlmKey').value = settings.llmKey; $('setLlmModel').value = settings.llmModel;
    $('shareRow').hidden = !serverMode;
    dlg.showModal();
  });
  $('setSave').addEventListener('click', function () {
    settings.voice = $('setVoice').checked; settings.metro = $('setMetro').checked; settings.handsFree = $('setHandsFree').checked;
    settings.share = $('setShare').checked; settings.name = $('setName').value.trim();
    settings.llmUrl = $('setLlmUrl').value.trim() || ($('setLlmKey').value.trim() ? 'https://api.featherless.ai/v1' : '');
    settings.llmKey = $('setLlmKey').value.trim(); settings.llmModel = $('setLlmModel').value.trim();
    lang = $('setLang').value; audio.voiceOn = settings.voice;
    saveSettings(); applyLang(); dlg.close();
    if (session && session.ended && settings.llmKey) aiDebrief();
  });
  $('setClose').addEventListener('click', function () { dlg.close(); });

  // block accidental scrolling/zooming during a session
  document.addEventListener('touchmove', function (e) { if (!$('session').hidden) e.preventDefault(); }, { passive: false });

  // service worker (offline)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
  }

  // on GitHub Pages the repository link can be derived from the address
  (function () {
    var m = location.hostname.match(/^([^.]+)\.github\.io$/), seg = location.pathname.split('/').filter(Boolean);
    if (m && seg.length) $('repoLink').href = 'https://github.com/' + m[1] + '/' + seg[0];
  })();
  applyLang();
  detectServer();
  if (!window.isSecureContext) note(T('needHttps'));
  else if (!window.DeviceMotionEvent) note(T('noSensor'));
  if (qs.get('demo') === '1') {
    // auto-started without a tap, so audio is locked until the first touch/click
    beginFlow('demo');
    var unlockOnce = function () { audio.unlock(); document.removeEventListener('pointerdown', unlockOnce); };
    document.addEventListener('pointerdown', unlockOnce);
    toast(lang === 'ja' ? '音を出すには画面をタップ' : 'Tap anywhere for sound');
  }
  if (qs.get('step')) { newSession('training'); stepIdx = Math.max(0, Math.min(2, parseInt(qs.get('step'), 10) - 1)); show('steps'); renderStep(); }
})();

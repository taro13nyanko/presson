/*
 * PressOn trainer — ESP32 + MPU6050 + OLED + buzzer + 2 LEDs + 2 buttons.
 * The same compression estimator as the phone app (estimator.h), running as a
 * cheap clip-on feedback puck for CPR drills / AED cabinets.
 *
 * Runs unmodified in the Wokwi simulator (diagram.json next to this file):
 *   START button (green) : start / stop a session
 *   DEMO button  (blue)  : feed synthetic compressions (no need to shake the IMU)
 *   Serial 115200        : boot self-test, then one JSON line per compression
 *
 * Wiring (ESP32 DevKit C V4): SDA=21 SCL=22 (MPU6050 0x68 + SSD1306 0x3C),
 *   buzzer=25, green LED=26, red LED=27, START=32, DEMO=33 (buttons to GND).
 */
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "estimator.h"
#include "trainer_types.h"

#define PIN_SDA 21
#define PIN_SCL 22
#define PIN_BUZZER 25
#define PIN_LED_GREEN 26
#define PIN_LED_RED 27
#define PIN_BTN_START 32
#define PIN_BTN_DEMO 33
#define MPU_ADDR 0x68
#define SAMPLE_HZ 100
#define G 9.80665f

Adafruit_SSD1306 display(128, 64, &Wire, -1, 400000UL, 400000UL);
PressOnEstimator est;

/* ---------------- coach (port of app/coach.js, same thresholds) ------------- */
enum Cue { CUE_NONE, CUE_HARDER, CUE_SOFTER, CUE_FASTER, CUE_SLOWER, CUE_GOOD, CUE_KEEP, CUE_RESUME, CUE_HANDSOFF, CUE_SWITCH };
enum State { ST_NONE, ST_HARDER, ST_SOFTER, ST_FASTER, ST_SLOWER, ST_GOOD, ST_PAUSED };
const char *STATE_TXT[] = { "PUSH HARD&FAST", "PUSH HARDER", "A LITTLE LESS", "FASTER", "SLOWER", "GOOD", "RESUME!" };
const char *CUE_NAMES[] = { "", "harder", "softer", "faster", "slower", "good", "keep", "resume", "handsoff", "switch" };

struct Coach {
  State state = ST_NONE;
  float lastCueT = -1e9f, lastByCue[10], lastKeepT = -1e9f, lastPauseCueT = -1e9f, startT = -1, lastSwitchT = -1;
  void reset() { state = ST_NONE; lastCueT = lastKeepT = lastPauseCueT = -1e9f; startT = lastSwitchT = -1; for (int i = 0; i < 10; i++) lastByCue[i] = -1e9f; }
  Cue emit(Cue c, float now, State s) { lastCueT = now; lastByCue[c] = now; state = s; return c; }
  static Cue cueFor(State s) { switch (s) { case ST_HARDER: return CUE_HARDER; case ST_SOFTER: return CUE_SOFTER; case ST_FASTER: return CUE_FASTER; case ST_SLOWER: return CUE_SLOWER; default: return CUE_NONE; } }
  // problems in priority order, with hysteresis against the current state
  int problems(float rate, float depth, State *out) {
    int n = 0;
    if (depth < (state == ST_HARDER ? 0.05f : 0.045f)) out[n++] = ST_HARDER;
    else if (depth > (state == ST_SOFTER ? 0.06f : 0.065f)) out[n++] = ST_SOFTER;
    if (rate < (state == ST_FASTER ? 100.f : 98.f)) out[n++] = ST_FASTER;
    else if (rate > (state == ST_SLOWER ? 120.f : 122.f)) out[n++] = ST_SLOWER;
    return n;
  }
  Cue update(int count, float rate, float depth, bool paused, float sinceLast, float now) {
    if (startT < 0) { startT = now; lastSwitchT = now; }
    bool gapOk = now - lastCueT >= 1.5f;
    State prev = state;
    if (count < 3) { state = ST_NONE; return CUE_NONE; }
    if (paused) {
      if (prev != ST_PAUSED) { lastPauseCueT = -1e9f; state = ST_PAUSED; }
      if (sinceLast >= 2.0f && now - lastPauseCueT >= 5.0f && gapOk) { lastPauseCueT = now; return emit(sinceLast >= 10 ? CUE_HANDSOFF : CUE_RESUME, now, ST_PAUSED); }
      return CUE_NONE;
    }
    if (now - lastSwitchT >= 120.f && gapOk) { lastSwitchT = now; return emit(CUE_SWITCH, now, prev == ST_PAUSED ? ST_GOOD : prev); }
    State pr[2]; int n = problems(rate, depth, pr);
    State next = n ? pr[0] : ST_GOOD;
    if (next == ST_GOOD) {
      if (prev != ST_GOOD) { if (!gapOk) return CUE_NONE; lastKeepT = now; return emit(CUE_GOOD, now, ST_GOOD); }
      if (now - lastKeepT >= 30.f && gapOk) { lastKeepT = now; return emit(CUE_KEEP, now, ST_GOOD); }
      return CUE_NONE;
    }
    if (prev != next) { if (!gapOk) return CUE_NONE; return emit(cueFor(next), now, next); }
    if (now - lastCueT < 2.5f) return CUE_NONE;
    State best = ST_NONE; float bestT = 1e30f;
    for (int i = 0; i < n; i++) { float t = lastByCue[cueFor(pr[i])]; if (t < bestT) { bestT = t; best = pr[i]; } }
    if (best != ST_NONE && now - bestT >= 4.0f) return emit(cueFor(best), now, next);
    return CUE_NONE;
  }
} coach;

/* ---------------- session state ---------------------------------------------- */
bool running = false, demo = false, summaryShown = false;
unsigned long t0us = 0, lastSampleUs = 0, lastDrawMs = 0, lastMetroMs = 0, lastBeepMs = 0;
float sumDepth = 0; int nDepth = 0, inTarget = 0; float sumIv = 0; int nIv = 0; float lastCompT = -1;
float sessionEnd = 0;
int demoScriptIdx = 0;
float demoPhase = 0, demoSegStart = 0;
bool imuOk = false;
float imuG = 0;

/* ---------------- MPU6050 (raw I2C, no library) ------------------------------ */
bool mpuInit() {
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x6B); Wire.write(0x00);          // wake up
  if (Wire.endTransmission() != 0) return false;
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1C); Wire.write(0x08); Wire.endTransmission();   // accel +-4 g -> 8192 LSB/g
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x1A); Wire.write(0x03); Wire.endTransmission();   // DLPF 44 Hz
  return true;
}
bool mpuRead(float &gx, float &gy, float &gz) {
  Wire.beginTransmission(MPU_ADDR); Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6) != 6) return false;
  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = (uint8_t)Wire.read();                     // read in order (big-endian XH XL YH YL ZH ZL)
  int16_t rx = (int16_t)((b[0] << 8) | b[1]);
  int16_t ry = (int16_t)((b[2] << 8) | b[3]);
  int16_t rz = (int16_t)((b[4] << 8) | b[5]);
  const float lsbPerG = 8192.0f;
  gx = rx / lsbPerG * G; gy = ry / lsbPerG * G; gz = rz / lsbPerG * G;
  return true;
}

/* ---------------- sounds (non-blocking sequencer) & lights ------------------- */
Note seq[6]; int seqN = 0, seqI = 0; unsigned long seqNextMs = 0;
void playSeq(const Note *n, int count) { if (count > 6) count = 6; for (int i = 0; i < count; i++) seq[i] = n[i]; seqN = count; seqI = 0; seqNextMs = millis(); }
void seqService() {
  if (seqI >= seqN) return;
  unsigned long ms = millis();
  if ((long)(ms - seqNextMs) < 0) return;
  if (seq[seqI].f) { tone(PIN_BUZZER, seq[seqI].f, seq[seqI].ms); lastBeepMs = ms; }   // tone() is non-blocking on ESP32
  seqNextMs = ms + seq[seqI].ms + 20;
  seqI++;
}
void cueSound(Cue c) {
  static const Note HARDER[] = { { 440, 120 }, { 0, 10 }, { 440, 120 } };           // low double
  static const Note SOFTER[] = { { 660, 200 } };
  static const Note FASTER[] = { { 660, 70 }, { 990, 70 }, { 1320, 70 } };          // rising
  static const Note SLOWER[] = { { 1320, 70 }, { 990, 70 }, { 660, 70 } };          // falling
  static const Note GOOD[]   = { { 1760, 60 }, { 0, 10 }, { 1760, 60 } };           // high double
  static const Note RESUME[] = { { 330, 300 } };
  static const Note SWITCH[] = { { 880, 80 }, { 880, 80 }, { 880, 80 } };
  switch (c) {
    case CUE_HARDER: playSeq(HARDER, 3); break;
    case CUE_SOFTER: playSeq(SOFTER, 1); break;
    case CUE_FASTER: playSeq(FASTER, 3); break;
    case CUE_SLOWER: playSeq(SLOWER, 3); break;
    case CUE_GOOD: case CUE_KEEP: playSeq(GOOD, 3); break;
    case CUE_RESUME: case CUE_HANDSOFF: playSeq(RESUME, 1); break;
    case CUE_SWITCH: playSeq(SWITCH, 3); break;
    default: break;
  }
}
void leds(State s, bool blink) {
  bool good = s == ST_GOOD;
  bool bad = s == ST_HARDER || s == ST_FASTER || s == ST_SLOWER || s == ST_SOFTER;
  digitalWrite(PIN_LED_GREEN, good ? HIGH : LOW);
  digitalWrite(PIN_LED_RED, bad ? HIGH : (s == ST_PAUSED ? (blink ? HIGH : LOW) : LOW));
}

/* ---------------- display ---------------------------------------------------- */
void drawIdle() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2); display.setCursor(10, 4); display.print("PressOn");
  display.setTextSize(1);
  display.setCursor(0, 26); display.print(imuOk ? "IMU ok |g|=" : "IMU? |g|="); display.print(imuG, 1);
  display.setCursor(0, 40); display.print("START: session");
  display.setCursor(0, 50); display.print("DEMO : synthetic CPR");
  display.display();
}
void drawLive(float now) {
  bool paused = est.paused(now);
  float rate = est.rate(), depthCm = est.depth() * 100.0f;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0); display.print("#"); display.print(est.count);
  display.setCursor(48, 0); int s = (int)now; display.print(s / 60); display.print(":"); if (s % 60 < 10) display.print("0"); display.print(s % 60);
  display.setCursor(92, 0); display.print(demo ? "DEMO" : "LIVE");
  // rate big
  display.setTextSize(3); display.setCursor(0, 12);
  if (est.rateValid() && !paused) display.print((int)(rate + 0.5f)); else display.print("--");
  display.setTextSize(1); display.setCursor(58, 26); display.print("/min");
  // depth
  display.setTextSize(2); display.setCursor(84, 12);
  if (est.count) { if (depthCm >= 10) display.print((int)(depthCm + 0.5f)); else display.print(depthCm, 1); } else display.print("-.-");
  display.setTextSize(1); display.setCursor(96, 30); display.print("cm");
  // depth bar 0..8 cm, then the 5..6 cm band inverted on top so the bar stays visible inside it
  display.drawRect(0, 40, 128, 8, SSD1306_WHITE);
  int w = (int)(depthCm / 8.0f * 126.0f); if (w < 0) w = 0; if (w > 126) w = 126;
  display.fillRect(1, 42, w, 4, SSD1306_WHITE);
  display.fillRect(80, 41, 16, 6, SSD1306_INVERSE);
  // status
  display.setTextSize(1); display.setCursor(0, 54); display.print(STATE_TXT[coach.state]);
  display.setCursor(98, 54); display.print("off"); display.print((int)est.handsOff(now));
  display.display();
}
void drawSummary() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0); display.print("SESSION  "); display.print(est.count); display.print(" comp");
  display.setCursor(0, 14); display.print("rate  "); display.print(nIv ? (int)(60.0f * nIv / sumIv + 0.5f) : 0); display.print(" /min");
  display.setCursor(0, 26); display.print("depth "); display.print(nDepth ? sumDepth / nDepth * 100 : 0, 1); display.print(" cm");
  display.setCursor(0, 38); display.print("target "); display.print(nDepth ? inTarget * 100 / nDepth : 0); display.print("%  CCF "); display.print((int)(est.ccf(sessionEnd) * 100)); display.print("%");
  display.setCursor(0, 50); display.print("hands-off "); display.print((int)est.handsOff(sessionEnd)); display.print(" s");
  display.display();
}

/* ---------------- demo script (synthetic compressions) ----------------------- */
const DemoSeg DEMO_SCRIPT[] = {
  { 84, 0.034f, 12, false },    // slow & shallow  -> PUSH HARDER / FASTER
  { 108, 0.052f, 16, false },   // corrected       -> GOOD
  { 0, 0, 6, true },            // hands off       -> RESUME
  { 128, 0.066f, 12, false },   // too fast/deep   -> SLOWER / A LITTLE LESS
  { 112, 0.055f, 14, false }    // good to the end (60 s total)
};
const int DEMO_N = sizeof(DEMO_SCRIPT) / sizeof(DEMO_SCRIPT[0]);
PressOnSynth demoRng(42);

// analytic second derivative of PressOnSynth::cycleShape (m/s^2) at phase u, period T
float cycleAccel(float u, float depth, float duty, float hold, float T) {
  float active = 1.0f - hold;
  if (u >= active) return 0.0f;
  float w = u / active;
  if (w < duty) { float k = PRESSON_PI / (active * duty); return -depth * 0.5f * k * k * cosf(k * u) / (T * T); }
  float k2 = PRESSON_PI / (active * (1.0f - duty));
  return depth * 0.5f * k2 * k2 * cosf(k2 * (u - duty * active)) / (T * T);
}

// gravity-including vertical acceleration for the scripted demo; segments switch
// only when a cycle completes, so the track stays continuous
bool demoSample(float t, float dt, float &gz) {
  if (demoScriptIdx >= DEMO_N) return false;
  const DemoSeg *seg = &DEMO_SCRIPT[demoScriptIdx];
  float a = 0;
  if (seg->pause) {
    if (t - demoSegStart >= seg->seconds) { demoScriptIdx++; demoSegStart = t; demoPhase = 0; }
  } else {
    float T = 60.0f / seg->rate;
    a = cycleAccel(demoPhase, seg->depth, 0.45f, 0.0f, T);
    demoPhase += dt / T;
    if (demoPhase >= 1) {
      demoPhase -= 1;
      if (t - demoSegStart >= seg->seconds) { demoScriptIdx++; demoSegStart = t; demoPhase = 0; }
    }
  }
  if (demoScriptIdx >= DEMO_N) return false;
  gz = G + a + demoRng.gauss() * 0.12f;
  return true;
}

/* ---------------- session control -------------------------------------------- */
void startSession(bool isDemo) {
  est.reset(); coach.reset();
  running = true; demo = isDemo; summaryShown = false;
  t0us = micros(); lastSampleUs = t0us;
  sumDepth = 0; nDepth = 0; inTarget = 0; sumIv = 0; nIv = 0; lastCompT = -1;
  demoScriptIdx = 0; demoSegStart = 0; demoPhase = 0;
  Serial.print("{\"type\":\"start\",\"demo\":"); Serial.print(isDemo ? "true" : "false"); Serial.println("}");
  static const Note START[] = { { 1320, 80 }, { 1760, 120 } };
  playSeq(START, 2);
}
void stopSession() {
  running = false;
  sessionEnd = (micros() - t0us) / 1e6f;
  seqN = 0; noTone(PIN_BUZZER);
  digitalWrite(PIN_LED_GREEN, LOW); digitalWrite(PIN_LED_RED, LOW);
  Serial.print("{\"type\":\"end\",\"count\":"); Serial.print(est.count);
  Serial.print(",\"rate\":"); Serial.print(nIv ? 60.0f * nIv / sumIv : 0, 1);
  Serial.print(",\"depth_cm\":"); Serial.print(nDepth ? sumDepth / nDepth * 100 : 0, 2);
  Serial.print(",\"in_target_pct\":"); Serial.print(nDepth ? inTarget * 100 / nDepth : 0);
  Serial.print(",\"hands_off_s\":"); Serial.print(est.handsOff(sessionEnd), 1);
  Serial.print(",\"ccf_pct\":"); Serial.print((int)(est.ccf(sessionEnd) * 100));
  Serial.println("}");
  drawSummary(); summaryShown = true;
}

/* ---------------- boot self-test --------------------------------------------- */
bool selfTest() {
  const float cases[3][2] = { { 100, 0.05f }, { 120, 0.04f }, { 80, 0.06f } };
  bool ok = true;
  for (int c = 0; c < 3; c++) {
    PressOnEstimator e; PressOnSynth rng(7 + c);
    float rate = cases[c][0], depth = cases[c][1], T = 60.0f / rate, dt = 1.0f / SAMPLE_HZ;
    float phase = 0; double sum = 0; int n = 0;
    for (int i = 0; i < 12 * SAMPLE_HZ; i++) {
      float t = i * dt;
      float a = cycleAccel(phase, depth, 0.5f, 0.0f, T);
      phase += dt / T; if (phase >= 1) phase -= 1;
      float gz = G + a + rng.gauss() * 0.1f;
      if (e.push(0, 0, 0, false, 0, 0, gz, t) && t > 3) { sum += e.last.depth; n++; }
    }
    float d = n ? (float)(sum / n) : 0, r = e.rate();
    bool pass = fabsf(d - depth) / depth < 0.10f && fabsf(r - rate) < 3;
    ok = ok && pass;
    Serial.print("SELFTEST "); Serial.print((int)rate); Serial.print("/min "); Serial.print(depth * 100, 1); Serial.print("cm -> ");
    Serial.print(r, 1); Serial.print("/min "); Serial.print(d * 100, 2); Serial.print("cm "); Serial.println(pass ? "PASS" : "FAIL");
  }
  Serial.println(ok ? "SELFTEST PASS" : "SELFTEST FAIL");
  return ok;
}

/* ---------------- Arduino ----------------------------------------------------- */
bool btnStartPrev = true, btnDemoPrev = true;
unsigned long btnMs = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT); pinMode(PIN_LED_GREEN, OUTPUT); pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BTN_START, INPUT_PULLUP); pinMode(PIN_BTN_DEMO, INPUT_PULLUP);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C, true, false);
  imuOk = mpuInit();
  delay(20);
  { float gx, gy, gz; if (imuOk && mpuRead(gx, gy, gz)) imuG = sqrtf(gx * gx + gy * gy + gz * gz); }
  Serial.println("PressOn trainer v1.0");
  Serial.print("IMU |g| = "); Serial.println(imuG, 2);          // expect about 9.81 at rest
  selfTest();
  drawIdle();
}

void loop() {
  unsigned long ms = millis();
  seqService();
  // ---- buttons: any edge (press or release bounce) restarts a 200 ms quiet time
  bool bs = digitalRead(PIN_BTN_START), bd = digitalRead(PIN_BTN_DEMO);
  if (bs != btnStartPrev || bd != btnDemoPrev) {
    if (ms - btnMs > 200) {
      if (!bs && btnStartPrev) { if (running) stopSession(); else startSession(false); }
      if (!bd && btnDemoPrev) { if (running) stopSession(); else startSession(true); }
    }
    btnMs = ms;
  }
  btnStartPrev = bs; btnDemoPrev = bd;
  if (Serial.available()) { char c = Serial.read(); if (c == 'd' && !running) startSession(true); else if (c == 's') { if (running) stopSession(); else startSession(false); } }

  if (!running) { if (!summaryShown) drawIdle(); delay(20); return; }

  // ---- sample at SAMPLE_HZ
  unsigned long us = micros();
  if (us - lastSampleUs < 1000000UL / SAMPLE_HZ) return;
  float dt = (us - lastSampleUs) / 1e6f;
  lastSampleUs = us;
  float now = (us - t0us) / 1e6f;
  float gx = 0, gy = 0, gz = G;
  if (demo) { if (!demoSample(now, dt, gz)) { stopSession(); return; } }
  else if (!mpuRead(gx, gy, gz)) { gx = 0; gy = 0; gz = G; }

  bool comp = est.push(0, 0, 0, false, gx, gy, gz, now);
  if (comp) {
    sumDepth += est.last.depth; nDepth++;
    bool okD = est.last.depth >= 0.05f && est.last.depth <= 0.06f, okR = true;
    if (lastCompT >= 0) { float iv = est.last.t - lastCompT; if (iv <= 1.5f) { sumIv += iv; nIv++; float r = 60.0f / iv; okR = r >= 100 && r <= 120; } }
    if (okD && okR) inTarget++;
    lastCompT = est.last.t;
    Serial.print("{\"type\":\"comp\",\"t\":"); Serial.print(est.last.t, 2);
    Serial.print(",\"count\":"); Serial.print(est.count);
    Serial.print(",\"rate\":"); Serial.print(est.rate(), 1);
    Serial.print(",\"depth_cm\":"); Serial.print(est.last.depth * 100, 2);
    Serial.print(",\"status\":\""); Serial.print(STATE_TXT[coach.state]); Serial.println("\"}");
  }

  // ---- coaching
  bool paused = est.paused(now);
  Cue cue = coach.update(est.count, est.rate(), est.depth(), paused, est.sinceLast(now), now);
  if (cue != CUE_NONE) {
    Serial.print("{\"type\":\"cue\",\"t\":"); Serial.print(now, 1); Serial.print(",\"cue\":\""); Serial.print(CUE_NAMES[cue]); Serial.println("\"}");
    cueSound(cue);
  }
  // ---- metronome 110 /min (skipped while a cue sound is playing)
  if (ms - lastMetroMs >= 545) { lastMetroMs = ms; if (seqI >= seqN && ms - lastBeepMs > 300) { tone(PIN_BUZZER, 880, 30); lastBeepMs = ms; } }
  leds(coach.state, (ms / 250) % 2 == 0);
  if (ms - lastDrawMs >= 100) { lastDrawMs = ms; drawLive(now); }
}

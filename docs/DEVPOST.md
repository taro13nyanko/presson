# Devpost submission text — copy each block into the matching field

Deadline: **Sep 5, 2026, 5:00 PM EDT = Sep 6, 06:00 JST**. Submit by the evening of Sep 5 JST to be safe. Replace every `YOUR-GITHUB-NAME` (also in README.md) before submitting.

---

## Project name
PressOn

## Elevator pitch (≤ 200 characters)
Any phone becomes a CPR coach: put it on the chest, hands on top, push — it tells you out loud if you're pushing hard and fast enough. Offline, no install. Same algorithm on a $5 ESP32 puck.

## Track
Smart Health Technology (also fits AI + Hardware Integration and Robotics & Embedded Systems)

## Problem statement (VoltHacks field)
Every year 28,354 cardiac arrests of cardiac origin in Japan are witnessed by a bystander, yet bystander first aid (CPR, with or without an AED) is given in only 60 % of them, and one-month survival roughly doubles when it is (14.8 % vs 7.3 %, FDMA 2024). Survival depends on quality — 100–120 compressions a minute, about 5 cm deep (not over 6 cm), no long pauses (JRC/AHA 2025) — and untrained rescuers cannot feel 5 cm. The devices that measure this cost $200–500 and sit in ambulances and AED cabinets, not in the pocket of the person kneeling next to the patient. Everyone has a phone with the same kind of accelerometer inside.

## Inspiration
In a CPR course the feedback manikin tells you your compressions were 3.8 cm deep — you would never have known by feel. The manikin costs more than a laptop; the sensor that measures depth inside it is the same kind of accelerometer that is in every phone. VoltHacks asked for systems that touch the physical world through sensors — a chest compression is about as physical as it gets.

## What it does
* **Guided start** — check response → call 119/911 on speaker, send for an AED → place the phone flat on the sternum, hands on top. Every step is spoken.
* **Live coaching** from the accelerometer: rate and depth per compression, huge numbers readable from a metre away, and a voice that says *push harder / faster / slower / good / resume*. A 110/min metronome. Cues are rate-limited and rotate so it coaches instead of nagging.
* **Interruptions**: hands off the chest for 2 s starts a timer and a "resume" prompt; compression fraction is tracked (target > 80 %). Rescuer-switch reminder every 2 minutes. AED-arrived button. Hold-to-stop so palms on the screen cannot end a session.
* **Handover**: one-paragraph log for the paramedics (start time, duration, count, mean rate/depth, % in target, hands-off, AED time) to the clipboard; JSON/CSV export with raw sensor data.
* **Debrief**: rule-based always; optional AI debrief through any OpenAI-compatible endpoint (built for Featherless.ai).
* **Instructor screen**: in a class every phone reports to a laptop over Wi-Fi; the instructor sees all trainees live. An ESP32 puck joins over serial.
* **PressOn trainer**: the same estimator and coach as ESP32 firmware (MPU6050 + OLED + buzzer + LEDs), about $7–10 in parts, compiled with arduino-cli and runnable in Wokwi in the browser (not yet flashed to physical hardware).
* Works offline (PWA), English / 日本語, screen-up or screen-down, tilted or flat, Android and iOS.

## How we built it
* **Estimator** (JavaScript + C++ port): gravity vector by low-pass → linear acceleration projected on the gravity axis (orientation-free) → 0.3 Hz high-pass, 2 × 10 Hz low-pass → leaky integration to velocity → every zero-crossing of velocity closes a stroke, displacement = ∫v dt between crossings (zero-velocity reset, so drift cannot accumulate) → two opposite strokes = one compression → depth divided by the exact filter-chain gain at that cycle's frequency. A spectral estimate (a_pp/ω²) is logged as a cross-check.
* **Coach**: state machine with hysteresis (enter a problem at the tolerance, leave it only inside the target band), depth over rate priority, minimum gaps, rotation through problems, pause escalation, switch reminders. Behavioural tests.
* **App**: plain HTML/JS PWA, DeviceMotion (iOS permission flow), WebAudio metronome, speechSynthesis in two languages, Wake Lock, hold-to-press buttons, SVG session chart, service worker for offline.
* **Validation**: synthetic compressions of known depth/rate with noise, drift, tilt, jitter, 50–100 Hz, screen-down and the no-linear-acceleration fallback — 150 cases through both the JS and the C++ code; a webcam ground-truth tool (OpenCV sticker tracking, calibrated in mm) with a comparison script; the tracker verified on a generated clip (50.0 mm true → 50.0 ± 0.4 mm).
* **Firmware**: ESP32 + MPU6050 (raw I²C), SSD1306, piezo, LEDs, buttons; boot self-test; scripted demo mode; Wokwi diagram + CI scenario; compiled with arduino-cli.
* **Tools**: Python HTTPS server with self-signed cert (phones need HTTPS for motion sensors) + Server-Sent-Events relay for the instructor screen; serial bridge for the puck.

## Challenges we ran into
* **Depth from an accelerometer drifts.** Plain double integration wanders off within seconds. Integrating only between zero-velocity crossings fixed it, and merging sub-8 mm strokes killed the false compressions from hand tremor.
* **Every filter steals amplitude.** The first version under-read depth by 6–10 % depending on rate and code path. Because every stage is first-order with a closed-form response, dividing by the product of the responses at the measured cycle frequency brought the synthetic error under 2 % for smooth strokes and under 6 % for a jerky 40 %-duty stroke — no tuning tables.
* **Phones disagree.** iOS needs a permission call inside a tap and reports gravity with the opposite sign to Android; some Android browsers return `null` linear acceleration. Using the gravity direction as the compression axis made orientation and sign irrelevant, and the fallback path is validated separately.
* **A coach that talks too much is ignored.** The first state machine spoke on every compression. Hysteresis, minimum gaps and cue rotation came from watching it nag.
* **Palms on the screen.** During compressions the rescuer's hands are on the phone: every control became hold-to-press and touch scrolling is blocked.
* **Windows path limits** broke the ESP32 toolchain (MAX_PATH) — the kind of bug that eats an evening of a solo build.

## Accomplishments that we're proud of
* Sub-6 % depth error and under 1.5 /min rate error on 150 synthetic cases, in the JavaScript and in its C++ port, with the maths written down.
* A rescue flow that a panicking stranger can follow with the hands busy: one big red button, spoken steps, huge numbers, hold-to-stop.
* The same algorithm on a $7–10 puck that judges can run in their browser, including a boot self-test that prints its own accuracy.
* Honest status of evidence in the README: what is synthetic, what is simulated, what has been run on real hardware.
* An instructor screen that turns any classroom of phones into a feedback-manikin lab.
* Honest labelling: what the sensor can and cannot measure (leaning, soft surfaces) is stated in the app and the docs.

## What we learned
* Signal processing beats machine learning when the physics is known: a 2 Hz sinusoid does not need a neural network, it needs a correct gain formula.
* Real-world impact is decided by the UI under stress, not by the algorithm — the number of cues per minute mattered more than the last percent of accuracy.
* Testing on a cushion is not testing on a chest; say so.

## What's next
* Manikin validation with a certified feedback manikin at a university course (Bland–Altman against the manikin's sensor).
* Two-sensor mode: ESP32 puck under the back + phone on the chest to cancel mattress movement; a ¥300 force sensor on the puck for leaning detection.
* QR stickers for AED cabinets that open PressOn instantly; dispatcher-assisted mode where the 119 operator hears the metrics.
* Formal safety review before any real-world deployment; ventilation prompts for trained rescuers; child/infant settings.

## Built with
javascript · html5 · css3 · pwa · devicemotion-api · web-audio · web-speech-api · service-worker · c++ · arduino · esp32 · mpu6050 · ssd1306 · wokwi · python · opencv · numpy · server-sent-events · featherless.ai · github-pages

## Technologies / components (VoltHacks list)
Smartphone 3-axis accelerometer (DeviceMotion API); ESP32 DevKit C; MPU6050 IMU; SSD1306 OLED; piezo buzzer; LEDs; push buttons; Wokwi simulator; arduino-cli; JavaScript PWA; Python 3 (http.server, ssl, OpenCV, NumPy); Featherless.ai (OpenAI-compatible LLM API) for the optional debrief.

## Try it out (links)
* Live app: `https://YOUR-GITHUB-NAME.github.io/presson/`
* Repository: `https://github.com/YOUR-GITHUB-NAME/presson`
* Wokwi project: `https://wokwi.com/projects/<id>` (create it from firmware/presson-trainer, see firmware/README.md)
* Desktop demo (no sensor): `https://YOUR-GITHUB-NAME.github.io/presson/app/?demo=1`
* Self-test: `https://YOUR-GITHUB-NAME.github.io/presson/app/selftest.html`
* Instructor screen (simulated trainees): `https://YOUR-GITHUB-NAME.github.io/presson/app/instructor.html#demo`

## Team
Yusuke Ota — first-year undergraduate, College of Arts and Sciences (Natural Sciences I), The University of Tokyo. Solo.

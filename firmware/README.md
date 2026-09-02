# PressOn trainer — ESP32 firmware

The phone app's estimator and coach, running on a ¥1,000–1,500 / $7–10 puck. Same `estimator.h` (C++ port of `app/estimator.js`), validated with the same synthetic vectors (`tests/native_test.cpp`). Compiled with arduino-cli (esp32 core 3.3, 332 KB flash); not yet flashed to physical hardware — Wokwi is the reference environment.

## Parts

| part | role | pin |
|---|---|---|
| ESP32 DevKit C V4 | MCU (ESP32 only as written; `estimator.h` itself has no Arduino dependency and compiles anywhere) | — |
| MPU6050 | accelerometer (raw I²C, no library, ±4 g, DLPF 44 Hz, 100 Hz) | SDA 21 · SCL 22 |
| SSD1306 128×64 OLED | rate, depth bar, status, hands-off, session summary | SDA 21 · SCL 22 (0x3C) |
| piezo buzzer | 110/min metronome, cue sounds (low double = harder, rising = faster, falling = slower, high double = good, long low = resume) | 25 |
| green LED / red LED | in target / needs correction (blinking = paused) | 26 / 27 |
| START button / DEMO button | session start-stop / scripted synthetic session | 32 / 33 (to GND, internal pull-ups) |

## Run it in the browser (Wokwi)

1. Open https://wokwi.com → *New project* → ESP32.
2. Replace `sketch.ino` with `presson-trainer.ino`, add the files `estimator.h` and `trainer_types.h`, replace `diagram.json`, add `libraries.txt` (Adafruit SSD1306, GFX, BusIO).
3. Start the simulation. Serial shows `SELFTEST … PASS` three times, then the OLED shows the idle screen.
4. Press **DEMO** (blue, or key `d`): a scripted 60 s session runs — slow & shallow (*PUSH HARDER*, *FASTER*), corrected (*GOOD*), a 6 s pause (*RESUME!*), too fast/deep (*SLOWER*), good until the end; the summary appears on the OLED and as JSON on serial.
5. **START** runs a live session from the MPU6050 (real hardware: put the puck on a cushion and push). In the simulator you can click the MPU6050 and move *accel Z*, but a hand-dragged slider rarely produces clean 0.3–1.5 s cycles — use DEMO to see the coach work.

`selftest.scenario.yaml` automates step 4: `wokwi-cli firmware/presson-trainer --scenario selftest.scenario.yaml --timeout 90000` (the default 30 s timeout is shorter than the demo). `wokwi.toml` points the VS Code extension at the binaries built by:

```
arduino-cli core install esp32:esp32
arduino-cli lib install "Adafruit SSD1306" "Adafruit GFX Library" "Adafruit BusIO"
arduino-cli compile --fqbn esp32:esp32:esp32 --export-binaries firmware/presson-trainer
```

## Serial protocol (115200)

```
{"type":"start","demo":true}
{"type":"comp","t":3.21,"count":6,"rate":84.2,"depth_cm":3.41,"status":"PUSH HARDER"}
{"type":"cue","t":3.4,"cue":"harder"}
{"type":"end","count":102,"rate":109.8,"depth_cm":5.21,"in_target_pct":64,"hands_off_s":5.9,"ccf_pct":90}   (values illustrative)
```

`tools/serial_bridge.py COM5 --server https://<laptop>:8443` forwards these to the instructor screen next to the phones. Send `d` on serial to start a demo session, `s` to start/stop a live one.

## Why a puck at all

* AED cabinets: a puck on the cabinet door is cheaper than the cabinet's sticker and gives feedback to whoever grabs the AED.
* School and office drills without a manikin: puck on a cushion, buzzer as the metronome, OLED as the score.
* Two-sensor mode (planned): puck under the patient's back + phone on the chest → subtract mattress movement (the soft-surface problem) and add a ¥300 force sensor for leaning detection.

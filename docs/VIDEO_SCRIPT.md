# Demo video — 100 seconds, shot list and narration

Judges watch dozens of videos; the first 8 seconds decide whether they keep watching. Show the physical action early, keep the phone screen large, and put the numbers on screen as captions (your `video-subtitles/jimaku` tool can burn the captions in).

**Gear:** phone (PressOn open in Chrome/Safari from the GitHub Pages link), laptop with `python tools/serve.py` running and `instructor.html` open, a firm cushion or folded futon on the floor, a second camera (laptop webcam or a friend's phone) filming from the side. Record the phone screen with the OS screen recorder at the same time; you will use both.

**Setting:** floor, good light, camera at knee height looking slightly down so the cushion, the phone and your hands are all in frame. Wear a plain T-shirt. Speak slowly; you can also let the app's voice do most of the talking and add captions.

| time | picture | sound / caption |
|---|---|---|
| 0–8 s | black, white text, one line at a time | Caption: **"28,354 cardiac arrests a year in Japan are witnessed by someone. Fewer than 15 % survive."** then **"Bystander CPR roughly doubles survival (14.8 % vs 7.3 %). Nobody can feel 5 cm."** |
| 8–14 s | you, kneeling next to the cushion, phone in hand, look at camera | You: "This is PressOn. Any phone becomes a CPR coach. No app store, no signal needed." |
| 14–24 s | phone screen (screen recording, full frame): tap START, step 1, step 2, step 3 | App voice: *Tap the shoulders and shout… Call 119 on speaker… Put the phone flat on the centre of the chest.* Caption: **"Guided in 3 taps — in English or Japanese."** |
| 24–48 s | side camera: phone on the cushion, your hands on it, you compress **deliberately slow and shallow**; picture-in-picture of the phone screen (or the laptop instructor screen) | App voice: *Push harder.* … *Faster.* — you correct — *Good. Keep going.* Caption: **"Rate 84 → 108 /min · depth 3.4 → 5.2 cm"**. Let the metronome be audible. |
| 48–58 s | you lift your hands and hold them up for 5 s | App voice: *Resume compressions.* Caption: **"Hands-off timer · compression fraction"**. Put hands back: *Good.* |
| 58–66 s | laptop screen: instructor.html with your phone's card live (and a second phone if you have one) | You: "In a class, every phone reports to the instructor's laptop." |
| 66–80 s | laptop screen: Wokwi tab, press DEMO, OLED shows PUSH HARDER → GOOD, buzzer clicks; zoom on the serial `SELFTEST … PASS` lines | You: "The same algorithm runs on a five-dollar ESP32 puck — here in a simulator you can run yourself. It prints its own accuracy test on boot." Caption: **"ESP32 + MPU6050 · open firmware · runs in Wokwi"** |
| 80–90 s | phone screen: hold to stop → summary screen, then tap *Copy handover text* and show the pasted paragraph in a note | You: "When the ambulance arrives, the paramedic gets this." Caption: **"146 compressions · 112 /min · 5.4 cm · CCF 93 %"** |
| 90–100 s | end card | Caption: **"PressOn — open source, offline, any phone. Training aid, not a medical device."** GitHub link. |

## Recording tips

* Do a full run once before recording so the voice, metronome and wake lock are all unlocked; the first tap after a page load is what enables audio on iPhone.
* Set the phone to **Training mode** for the video (it adds a 3-2-1 countdown, which reads well on camera). Rescue mode skips the countdown.
* If the room is noisy, turn the metronome off in Settings and let the captions carry the numbers.
* Side camera: keep the phone's edge visible; if you want the ground-truth overlay, stick a bright sticker on the phone edge and run `tools/truth_cam.py` on the clip afterwards (`--scale-mm 146`, click the phone's long edge). Put the resulting mean error and SD in the README whatever they are — a mediocre number with an explanation is worth more to a judge than no number.
* Export at 1080p, under 3 minutes (Devpost embeds YouTube/Vimeo; upload as *unlisted*).
* Captions: `video-subtitles/jimaku.cmd` can generate them from your narration; for the numbers use manual captions so they are exact.

## One-sentence answers judges may ask (put them in the Devpost text too)

* *How do you know it's 5.4 cm?* — Integration between zero-velocity crossings with an exact filter-gain correction; synthetic error under 6 %; a webcam tool measures true travel in mm for anyone who wants to check; manikin validation is the next step and is stated as such.
* *Isn't this PocketCPR?* — Same sensor idea (2010); the differences are no install, offline, orientation-free, interruption metrics, a paramedic handover log, an instructor screen, an open ESP32 port and published validation tools.
* *Why not ML?* — The physics of a 2 Hz stroke is known; a correct filter beats a black box, and it runs on an ESP32.
* *Is it safe?* — Training aid, disclaimer on screen, compressions-first in the flow, no screen that could be read as "the patient is fine".

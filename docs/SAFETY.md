# Safety, scope and honest limits

**PressOn is a training and feedback aid. It is not a medical device, it is not certified, and it does not replace a dispatcher's instructions, an AED's voice prompts or a certified CPR course.** The rescue-style flow (check → call 119 → place the phone) is included so that trainees practise the real sequence and so the design can be evaluated; it has not been assessed for use on a real patient and PressOn is not intended for that use.

## What we tell the user, on screen

* The home screen carries the disclaimer in both languages.
* The first step is *check response*, the second is *call 119 / 911 / 112 on speaker and send someone for an AED* — before the phone is placed. In a real emergency, **compressions first**; add the phone when a second person can hold it, or skip it.
* The app never tells the rescuer to stop compressions; it says *push harder / faster / slower / resume*. The only "stop" is the hold-to-stop button and the "Session stopped" confirmation after it. There is no screen that could be read as "the patient is fine".
* The AED button only logs the time and tells the rescuer to follow the AED's own voice.

## Physical risks of a phone under the hands

* A phone can slide on a sweaty chest and the rescuer may reposition it instead of compressing — the app tolerates ±20° tilt and screen-down placement so repositioning is not needed.
* A cracked screen: place the phone screen-down or in a case if in doubt; the algorithm does not care.
* The phone adds a few centimetres of stack height; keep the arms straight and the shoulders above the hands as usual.

## Measurement limits (also in docs/ALGORITHM.md)

* Depth is an estimate from acceleration. Synthetic error < 6 %; comparable published algorithms reach 2–5 mm on manikins. We could not test on a manikin.
* On a mattress the estimate is too high (the body moves with the surface). Compress on a firm surface, as guidelines say.
* Leaning on the chest between compressions cannot be detected by an accelerometer. Let the chest come back up fully.

## Data

Everything stays on the phone. The instructor relay only exists when you run `tools/serve.py` on your own laptop, on your own Wi-Fi. The AI debrief sends the session statistics and the list of coaching cues (timestamps and cue ids — no audio, no raw sensor samples) to the endpoint the user configured, when the user taps the button or saves an API key on the summary screen.

## Regulatory note

Software that provides CPR feedback for lay rescuers has been cleared as a medical device in some jurisdictions when built into AEDs. PressOn makes no such claim; it is published as open source for education, drills and research. Anyone deploying it in a clinical or public-access context must do their own assessment.

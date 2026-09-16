# BioSpine Posture Companion

<<<<<<< HEAD
A mobile-first Progressive Web App (PWA) for the ESP32 + MPU6050 posture-correcting wearable
("BioSpine"), paired with the ESP32 over its own Wi-Fi access point and a WebSocket.

## What is included
- Live, instantaneous posture status (a safe zone/hysteresis keeps it from being jumpy right at
  the threshold — see below — but there's no added reaction delay)
- Live deviation, average, median and maximum deviation
- Correct/incorrect time, posture score, slouch alert count, best streak
- Live angle chart, 7-day saved-session chart, event timeline
- Session history stored in browser localStorage
- Calibration that can be re-run at any time, right from the website
- Adjustable warning angle, safe zone, and buzz duration
- A single buzz per slouch onset (not a repeating alarm) that stops on its own
- Manual buzzer (vibration motor) on/off, independent of browser notifications
- WebSocket/Wi-Fi connection (the app's code also supports Web Bluetooth for other boards,
  but the supplied ESP32 firmware only implements Wi-Fi/WebSocket)
- PWA install support

## Wi-Fi / WebSocket contract
The ESP32 starts its own access point (`BioSpine-ESP32` / `biospine123`) and runs a
WebSocket server on port 81 (`ws://192.168.4.1:81`).

Telemetry JSON (sent every ~200ms):
```
{"dev":4.2,"pitch":4.2,"roll":0,"slouch":false,"vibrating":false,"battery":100,
 "rssi":-52,"calibrated":true,"mpu":"ok","transport":"WIFI","wifi":true}
```
- `dev` / `pitch`: the filtered deviation from the calibrated baseline, in degrees. The current
  sensor code only measures forward/back tilt (pitch) from the accelerometer — `roll` is always
  reported as `0` (no side-to-side detection yet; would need the gyro axes wired in).
- `slouch`: whether the current reading is past the warning angle, **with the safe-zone hysteresis
  applied** (see below). This is instantaneous — it flips the instant the hysteresis band is
  crossed, with no added waiting period, and the app mirrors it 1:1 for the on-screen status.
- `vibrating`: true only while the motor is mid-pulse.
- `battery`/`rssi`/`calibrated`/`mpu`: diagnostic fields (battery is currently hardcoded to 100).

Commands (plain-text substring matches, not strict JSON parsing — sent as one object from the app):
```
{"cmd":"calibrate"}
{"cmd":"buzz"}
{"cmd":"settings","angle":15,"buzzDuration":5,"safeZone":4,"buzzerEnabled":true}
```
- `calibrate`: averages ~20 pitch samples to re-zero the baseline. Can be sent at any time,
  including mid-session — the website's "Recalibrate" button does exactly this.
- `buzz`: fires one manual vibration pulse to test the motor/transistor wiring, independent of
  posture detection.
- `angle`: the warning threshold in degrees.
- `safeZone`: a `+/-` degree tolerance band around `angle`. While posture is OK, deviation must
  exceed `angle + safeZone` to be flagged; while already slouching, it must drop back below
  `angle - safeZone` to clear. Small natural sway inside that band never flips the state — this
  is the literal "safe zone." There is no time-based delay on top of this: crossing the band flips
  the state immediately.
- `buzzDuration`: seconds the vibration motor pulses for when a slouch is first detected. It fires
  **once** per slouch onset and stops on its own — it will not buzz again while you stay slouched;
  it only re-arms after posture returns to OK and then slouches again.
- `buzzerEnabled`: hard manual on/off for the vibration motor only. Detection, events, history and
  browser notifications all keep working when this is off — only the physical pulse is skipped.

## Firmware
`BioSpine_ESP32.ino` is your original raw-I2C ESP32 + MPU6050 + Wi-Fi/WebSocket sketch, with the
safe-zone hysteresis, the `buzzerEnabled` on/off, and a fix for a real bug where the plain
substring check for `"buzz"` also matched inside `"buzzerEnabled"` (so every settings update was
also firing a test pulse) — it now matches the exact quoted `"buzz"` command value only.

Posture detection is instantaneous (safe-zone hysteresis only, no added holding delay), and the
buzzer fires exactly one `buzzDuration`-long pulse per slouch onset instead of repeating. This also
fixes a bug where the post-buzz "ignore readings" quiet window was forcing the posture state to
"OK" instead of holding the prior state — that briefly-false reading was cutting pulses short and
letting the buzzer immediately re-arm and re-fire, which is what made it seem like it never stopped.

## Run it
Put the phone on the ESP32's Wi-Fi access point (or the same network, if you change the firmware
to join an existing one), open the app, go to Device, and connect with the WebSocket URL
`ws://192.168.4.1:81`.

## Convert to an app
Install the PWA from the browser's "Install app" / "Add to Home screen" option. For a
store-distributed Android/iOS app, wrap this PWA with a native shell such as Capacitor.

## Safety / project scope
This is a prototype wellness/engineering dashboard, not a medical diagnostic system. The posture
threshold, safe zone and delay are all configurable and should be tuned for the actual sensor
placement and wearer.
=======
This is a mobile-first Progressive Web App (PWA) designed for the ESP32 + MPU6050 posture-correcting wearable.

## Features
* Live posture status monitoring.
* Real-time tracking of live deviation, average, median, and maximum deviation.
* Correct and incorrect posture duration tracking.
* Dynamic posture scoring and slouch alert counting.
* Continuous good-posture streak counters.
* Live angle charts and 7-day saved-session performance charts.
* Local session history securely stored in browser localStorage.
* Interactive event timeline and remote 3-second calibration command.
* Customizable warning angle and delay settings.
* Optional browser notifications and sound alerts.
* Flexible connectivity options supporting Bluetooth Low Energy (BLE) and Wi-Fi WebSockets.
* Full Progressive Web App (PWA) installation support.

## Tech Stack
* **Frontend:** HTML5, CSS3, JavaScript (Vanilla PWA)
* **Hardware & Firmware:** ESP32-WROOM-32, MPU6050 IMU, ERM Vibration Motor, Arduino C++
* **Communication:** Web Bluetooth API & WebSockets Server
>>>>>>> 1b974401b48b23feffb8b52f12149335a1af65ba

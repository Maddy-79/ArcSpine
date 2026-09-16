#include <Wire.h>

#include <WiFi.h>
#include <WebSocketsServer.h>

// ==========================================================
// PIN DEFINITIONS
// ==========================================================

#define SDA_PIN 21
#define SCL_PIN 22
#define MOTOR_PIN 4


// ==========================================================
// WIFI SETTINGS
// ==========================================================

const char* WIFI_SSID = "Arc-Spine-ESP32";
const char* WIFI_PASSWORD = "Arc-Spine123";


// ==========================================================
// GLOBALS
// ==========================================================

// ==========================================================
// MPU6050 — RAW I2C REGISTER ACCESS
// (bypasses Adafruit library's strict WHO_AM_I check, which
//  rejects many clone MPU6050 boards even though they work fine)
// ==========================================================

#define MPU_ADDR              0x68   // change to 0x69 if AD0 is tied to 3.3V
#define MPU_REG_PWR_MGMT      0x6B
#define MPU_REG_ACCEL_XOUT_H  0x3B

bool mpuReady = false;
int mpuFailCount = 0;
float smoothedPitch = 0;
bool smoothedInit = false;


// ---------------- WIFI ----------------

WebSocketsServer ws(81);

bool wifiStarted = false;
bool wsc = false;


// ---------------- GENERAL ----------------

bool slouch = false;
bool vib = false;

float base = 0;
float angle = 15.0;   // slouch threshold in degrees
float safeZone = 4.0; // +/- degrees hysteresis band around `angle` (a "safe zone")
bool buzzerEnabled = true; // manual on/off for the vibration motor, independent of detection

unsigned long vibDurationMs = 5000;        // buzz lasts this long, then stops on its own (default 5s)
unsigned long lastSend = 0;
unsigned long vibUntil = 0;
unsigned long ignoreReadingsUntil = 0;    // quiet window after a motor pulse (avoids motor-noise feedback)
unsigned long connectMuteUntil = 0;       // no buzzing for 3s after a client connects
const unsigned long CONNECT_MUTE_MS = 3000;   // 3s of silence right after connecting


// ==========================================================
// MOTOR FUNCTIONS
// ==========================================================

void motorOff() {

    digitalWrite(MOTOR_PIN, LOW);

    vib = false;
}


void pulse() {

    digitalWrite(MOTOR_PIN, HIGH);

    vib = true;

    vibUntil = millis() + vibDurationMs;

    // Skip slouch evaluation while buzzing and briefly after — this is
    // exactly when motor electrical noise is most likely to corrupt the
    // next few I2C reads and cause a false re-trigger.
    ignoreReadingsUntil = millis() + vibDurationMs + 500;
}


// ==========================================================
// MPU6050 — RAW REGISTER I/O
// ==========================================================

void mpuWriteRegister(uint8_t reg, uint8_t value) {

    Wire.beginTransmission(MPU_ADDR);
    Wire.write(reg);
    Wire.write(value);
    Wire.endTransmission();
}

bool mpuInit() {

    // Confirm something answers at the address first.
    Wire.beginTransmission(MPU_ADDR);

    if (Wire.endTransmission() != 0) {
        return false;
    }

    // Wake the sensor up (it boots in sleep mode).
    mpuWriteRegister(MPU_REG_PWR_MGMT, 0x00);

    delay(50);

    mpuFailCount = 0;

    return true;
}

bool mpuReadAccel(int16_t &ax, int16_t &ay, int16_t &az) {

    Wire.beginTransmission(MPU_ADDR);
    Wire.write(MPU_REG_ACCEL_XOUT_H);

    if (Wire.endTransmission(false) != 0) {
        return false;
    }

    Wire.requestFrom((int)MPU_ADDR, 6, (int)true);

    if (Wire.available() < 6) {
        return false;
    }

    ax = (Wire.read() << 8) | Wire.read();
    ay = (Wire.read() << 8) | Wire.read();
    az = (Wire.read() << 8) | Wire.read();

    return true;
}

// Raw, unfiltered pitch reading in degrees.
// Formula matches the hackathon guide exactly:
//   Pitch = atan2(Ay, sqrt(Ax^2 + Az^2)) * 180/pi
// (Y-axis forward/back tilt, per the guide's mounting orientation:
//  Y-axis aligned with the vertical spine.)
float rawPitch() {

    int16_t axRaw, ayRaw, azRaw;

    if (!mpuReadAccel(axRaw, ayRaw, azRaw)) {

        mpuFailCount++;

        // Too many consecutive I2C failures — try to recover the sensor
        // instead of silently reporting stale/zero data forever.
        if (mpuFailCount > 20) {

            Serial.println("MPU6050 read failures — attempting re-init...");

            mpuReady = mpuInit();
            mpuFailCount = 0;
        }

        return smoothedPitch;   // hold last known-good value instead of snapping to 0
    }

    mpuFailCount = 0;

    // Default sensitivity for +-2g range: 16384 LSB/g.
    float axg = axRaw / 16384.0;
    float ayg = ayRaw / 16384.0;
    float azg = azRaw / 16384.0;

    float pitchDeg =
        atan2(
            ayg,
            sqrt(axg * axg + azg * azg)
        ) * 180.0 / PI;

    return pitchDeg;
}

// ==========================================================
// OUTLIER REJECTION
// Without a hardware decoupling capacitor, motor noise can
// corrupt more than one consecutive I2C frame at a time, so
// we use two layers: a hard jump-clamp (rejects any single
// reading that changes implausibly fast) plus a median-of-5
// filter (rejects short noise bursts of up to 2 bad samples).
// ==========================================================

float lastAcceptedRaw = 0;
bool lastAcceptedInit = false;

const float MAX_JUMP_PER_SAMPLE = 12.0;   // degrees; tune if real posture changes get clipped

float medHistory[5] = {0, 0, 0, 0, 0};
int medIndex = 0;
int medCount = 0;

float medianOf5(float v[5]) {

    float s[5];
    for (int i = 0; i < 5; i++) s[i] = v[i];

    // small insertion sort — fine for 5 elements
    for (int i = 1; i < 5; i++) {
        float key = s[i];
        int j = i - 1;
        while (j >= 0 && s[j] > key) { s[j + 1] = s[j]; j--; }
        s[j + 1] = key;
    }

    return s[2];
}

float filteredRawPitch() {

    float sample = rawPitch();

    // Layer 1: clamp implausible single-sample jumps (likely a glitch).
    if (lastAcceptedInit) {

        float jump = sample - lastAcceptedRaw;

        if (jump > MAX_JUMP_PER_SAMPLE) {
            sample = lastAcceptedRaw + MAX_JUMP_PER_SAMPLE;
        } else if (jump < -MAX_JUMP_PER_SAMPLE) {
            sample = lastAcceptedRaw - MAX_JUMP_PER_SAMPLE;
        }
    }

    lastAcceptedRaw = sample;
    lastAcceptedInit = true;

    // Layer 2: median-of-5 to reject short noise bursts.
    medHistory[medIndex] = sample;
    medIndex = (medIndex + 1) % 5;
    if (medCount < 5) medCount++;

    if (medCount < 5) {
        return sample;   // not enough history yet, pass through
    }

    return medianOf5(medHistory);
}

// Smoothed pitch — low-pass filtered to remove sensor jitter/noise,
// per the guide's recommendation to filter out transient movements.
float pitch() {

    if (!mpuReady) {
        return 0;
    }

    float raw = filteredRawPitch();

    const float alpha = 0.1;   // smoothing factor: lower = smoother, slower to react (was 0.2)

    if (!smoothedInit) {
        smoothedPitch = raw;
        smoothedInit = true;
    } else {
        smoothedPitch = alpha * raw + (1 - alpha) * smoothedPitch;
    }

    return smoothedPitch;
}


void calibrate() {

    motorOff();

    if (mpuReady) {
        // Average a few readings for a stable baseline.
        float sum = 0;
        const int samples = 20;

        for (int i = 0; i < samples; i++) {
            sum += pitch();
            delay(20);
        }

        base = sum / samples;
    } else {
        base = 0;
    }

    // Re-zero the confirmed state too — otherwise, right after recalibrating,
    // the hysteresis in loop() could briefly keep evaluating against the OLD
    // "already slouching" edge of the safe zone for one iteration.
    slouch = false;

    Serial.print("Calibrated. Base pitch: ");
    Serial.println(base);
}


// ==========================================================
// SEND DATA (Wi-Fi only)
// ==========================================================

void sendData(String s) {

    if (wsc) {
        ws.broadcastTXT(s);
    }
}


// ==========================================================
// COMMAND HANDLER
// ==========================================================

void command(String s) {

    Serial.print("Command received: ");
    Serial.println(s);

    // ------------------------------------------------------
    // CALIBRATION
    // ------------------------------------------------------

    if (s.indexOf("calibrate") >= 0) {

        calibrate();
    }

    // ------------------------------------------------------
    // MANUAL BUZZER TEST
    // Lets you verify the motor/transistor circuit works,
    // independent of posture detection. Send {"cmd":"buzz"}.
    // NOTE: matches the quoted value "buzz" exactly (not just the
    // substring "buzz"), because "buzz" is also the first 4 letters
    // of "buzzerEnabled" below — a plain substring check here would
    // fire a test pulse every single time a settings update included
    // buzzerEnabled, which is not what "manual test" is supposed to mean.
    // ------------------------------------------------------

    if (s.indexOf("\"buzz\"") >= 0) {

        Serial.println("Manual buzzer test triggered.");
        pulse();
    }

    // ------------------------------------------------------
    // BUZZER ENABLE / DISABLE
    // Persistent manual on/off for the vibration motor, separate
    // from the one-shot test above. When disabled, posture detection,
    // events and telemetry keep working as normal — only the motor
    // pulse itself is skipped, so a notification-only mode is possible.
    // ------------------------------------------------------

    int p = s.indexOf("buzzerEnabled");

    if (p >= 0) {

        int colon = s.indexOf(':', p);

        if (colon >= 0) {

            buzzerEnabled = s.substring(colon + 1).indexOf("true") >= 0;

            Serial.print("Buzzer enabled: ");
            Serial.println(buzzerEnabled ? "true" : "false");
        }
    }

    // ------------------------------------------------------
    // SAFE ZONE
    // +/- degree tolerance band around `angle`. See the hysteresis
    // comment in loop() for how this is applied.
    // ------------------------------------------------------

    p = s.indexOf("safeZone");

    if (p >= 0) {

        int colon = s.indexOf(':', p);

        if (colon >= 0) {

            safeZone =
                s.substring(
                    colon + 1
                ).toFloat();

            Serial.print("Safe zone set to: +/-");
            Serial.println(safeZone);
        }
    }

    // ------------------------------------------------------
    // ANGLE (slouch threshold)
    // ------------------------------------------------------

    p = s.indexOf("angle");

    if (p >= 0) {

        int colon = s.indexOf(':', p);

        if (colon >= 0) {

            angle =
                s.substring(
                    colon + 1
                ).toFloat();

            Serial.print("Angle set to: ");
            Serial.println(angle);
        }
    }

    // ------------------------------------------------------
    // BUZZ DURATION
    // How long (in seconds) the motor pulses for, once, when a
    // slouch is detected. Sent as "buzzDuration" from the app.
    // ------------------------------------------------------

    p = s.indexOf("buzzDuration");

    if (p >= 0) {

        int colon = s.indexOf(':', p);

        if (colon >= 0) {

            vibDurationMs =
                (unsigned long)(
                    s.substring(
                        colon + 1
                    ).toFloat() * 1000
                );

            Serial.print("Buzz duration set to: ");
            Serial.println(vibDurationMs);
        }
    }
}


// ==========================================================
// WIFI WEBSOCKET EVENT
// ==========================================================

void webSocketEvent(
    uint8_t clientNum,
    WStype_t type,
    uint8_t *payload,
    size_t length
) {

    if (type == WStype_CONNECTED) {

        Serial.println();
        Serial.println("Wi-Fi WebSocket client connected!");

        wsc = true;

        // Mute the buzzer for 3 seconds after connecting — avoids an
        // immediate false alert before a real baseline/posture has settled.
        connectMuteUntil = millis() + CONNECT_MUTE_MS;

        Serial.print("WebSocket client ID: ");
        Serial.println(clientNum);

        String status =
            String("{\"event\":\"CONNECTED\",") +
            "\"device\":\"Arc-Spine-ESP32\"," +
            "\"transport\":\"WIFI\"," +
            "\"mpu\":\"" + (mpuReady ? "OK" : "NOT_FOUND") + "\"," +
            "\"wifi\":true}";

        ws.sendTXT(clientNum, status);
    }

    if (type == WStype_DISCONNECTED) {

        Serial.println("Wi-Fi WebSocket client disconnected.");

        wsc = false;
    }

    if (type == WStype_TEXT) {

        Serial.print("Wi-Fi command: ");
        Serial.println((char*)payload);

        command(String((char*)payload));
    }
}


// ==========================================================
// START WIFI
// ==========================================================

void startWiFi() {

    Serial.println();
    Serial.println("Starting Wi-Fi Access Point...");

    WiFi.mode(WIFI_AP);

    wifiStarted =
        WiFi.softAP(
            WIFI_SSID,
            WIFI_PASSWORD
        );

    if (wifiStarted) {

        Serial.println("Wi-Fi Access Point started!");

        IPAddress IP = WiFi.softAPIP();

        Serial.print("Wi-Fi Network: ");
        Serial.println(WIFI_SSID);

        Serial.print("Wi-Fi Password: ");
        Serial.println(WIFI_PASSWORD);

        Serial.print("ESP32 IP Address: ");
        Serial.println(IP);

        Serial.println("WebSocket address:");
        Serial.println("ws://192.168.4.1:81");

    } else {

        Serial.println("Wi-Fi failed to start.");
    }

    ws.begin();
    ws.onEvent(webSocketEvent);

    Serial.println("WebSocket server started.");
}


// ==========================================================
// SETUP
// ==========================================================

void setup() {

    Serial.begin(115200);
    delay(1000);

    Serial.println();
    Serial.println("================================");
    Serial.println("      Arc-Spine ESP32 START");
    Serial.println("================================");

    // ------------------------------------------------------
    // MOTOR
    // ------------------------------------------------------

    pinMode(MOTOR_PIN, OUTPUT);
    motorOff();

    // ------------------------------------------------------
    // I2C
    // ------------------------------------------------------

    Wire.begin(SDA_PIN, SCL_PIN);

    // ------------------------------------------------------
    // I2C BUS SCAN — diagnostic
    // ------------------------------------------------------

    Serial.println();
    Serial.println("Scanning I2C bus...");

    {
        int found = 0;

        for (uint8_t addr = 1; addr < 127; addr++) {

            Wire.beginTransmission(addr);

            if (Wire.endTransmission() == 0) {

                Serial.print("  I2C device found at 0x");
                Serial.println(addr, HEX);

                found++;
            }
        }

        if (found == 0) {

            Serial.println("  NO I2C DEVICES FOUND.");
            Serial.println("  Check: VCC->3.3V, GND->GND, SCL->GPIO22, SDA->GPIO21.");

        } else {

            Serial.print("  Total devices found: ");
            Serial.println(found);
        }
    }

    // ------------------------------------------------------
    // MPU6050 — RAW I2C INIT
    // ------------------------------------------------------

    Serial.println();
    Serial.println("Initializing MPU6050...");

    if (mpuInit()) {

        mpuReady = true;

        Serial.println("MPU6050 found and initialized (raw I2C mode).");

    } else {

        mpuReady = false;

        Serial.println("MPU6050 NOT FOUND.");
        Serial.println("Check wiring on SDA/SCL (pins 21/22) and power.");
        Serial.println("Posture angle will report 0 until this is fixed.");
    }

    // ------------------------------------------------------
    // AUTO-CALIBRATION AT BOOT
    // Without this, 'base' stays at 0 until the user manually
    // presses Calibrate, so ANY resting tilt of the sensor
    // reads as a permanent slouch and the motor fires
    // repeatedly right from power-on.
    // ------------------------------------------------------

    if (mpuReady) {

        Serial.println();
        Serial.println("Auto-calibrating baseline...");
        Serial.println("Hold the wearable in a comfortable upright position.");

        delay(2000);   // give the wearer a moment to settle into position

        calibrate();
    }

    // ------------------------------------------------------
    // START WIFI
    // ------------------------------------------------------

    Serial.println();
    Serial.println("Starting Wi-Fi...");

    startWiFi();

    // ======================================================
    // READY
    // ======================================================

    Serial.println();
    Serial.println("================================");
    Serial.println("       Arc-Spine READY");
    Serial.println("================================");

    Serial.println();
    Serial.println("Wi-Fi:");
    Serial.println("  Arc-Spine-ESP32");
    Serial.println("  ws://192.168.4.1:81");

    Serial.println();
    Serial.println("Waiting for connection...");
    Serial.println("================================");
}


// ==========================================================
// MAIN LOOP
// ==========================================================

void loop() {

    ws.loop();

    // ======================================================
    // MOTOR TIMER
    // ======================================================

    if (vib && millis() >= vibUntil) {
        motorOff();
    }

    // ======================================================
    // MPU6050 READ
    // ======================================================

    float p = pitch();

    // dSigned keeps the direction (forward tilt vs. backward tilt) relative to the calibrated
    // baseline, for display. d is the magnitude used everywhere posture is judged — slouching
    // forward and slouching backward should trigger identically, so the threshold logic stays
    // sign-agnostic.
    float dSigned = p - base;
    float d = fabs(dSigned);

    // ======================================================
    // POSTURE DETECTION
    // ======================================================
    //
    // SAFE ZONE (hysteresis): `slouch` here still holds the CONFIRMED
    // state from the end of the previous loop iteration, so it's exactly
    // what we need to pick which edge of the band applies:
    //   - currently OK        -> must exceed angle + safeZone to flip bad
    //   - currently slouching -> must drop below angle - safeZone to clear
    // Small, natural sway that stays inside that +/- band never flips
    // anything — that's the "safe zone" the wearer can move around in.

    float safeLo = max(0.0f, angle - safeZone);
    float safeHi = angle + safeZone;
    bool overThreshold = slouch ? (d > safeLo) : (d > safeHi);

    // While in the brief noise-quiet window right after a buzz, HOLD the
    // previous confirmed state instead of forcing it to "OK". Forcing it
    // to false here was the actual bug: it made the posture look instantly
    // corrected mid-buzz, which cut the pulse short and then immediately
    // let a fresh onset re-arm and re-fire a moment later — which is what
    // read as the buzzer "never stopping".
    bool bad = mpuReady && (millis() < ignoreReadingsUntil ? slouch : overThreshold);

    // ======================================================
    // SLOUCH LOGIC — instantaneous, single buzz
    // - The state flips the instant the (safe-zoned) threshold is
    //   crossed — no waiting period before it's considered bad.
    // - Exactly one buzz of vibDurationMs fires per slouch onset.
    //   It is NOT repeated while posture stays bad; the wearer has
    //   to return to OK and slouch again before it will buzz again.
    // - No buzzing during the first 3s after connecting.
    // - buzzerEnabled only gates the physical pulse — state and
    //   telemetry keep updating normally either way.
    // - If posture is corrected mid-buzz, the pulse is left to
    //   finish its full vibDurationMs rather than being cut short.
    // ======================================================

    if (bad && !slouch) {

        slouch = true;

        if (buzzerEnabled && !vib && millis() >= connectMuteUntil) {
            pulse();
        }
    }

    else if (!bad && slouch) {

        slouch = false;
        sendData("{\"event\":\"POSTURE_OK\"}");
    }

    // ======================================================
    // TELEMETRY EVERY 200ms
    // ======================================================

    if (millis() - lastSend >= 200) {

        lastSend = millis();

        String data =
            String("{\"dev\":") + String(d, 2) +
            ",\"signedDev\":" + String(dSigned, 2) +

            ",\"pitch\":" + String(p, 2) +
            ",\"roll\":0" +

            ",\"slouch\":" + (bad ? "true" : "false") +
            ",\"vibrating\":" + (vib ? "true" : "false") +
            ",\"battery\":100" +
            ",\"rssi\":" + String(WiFi.RSSI()) +

            ",\"calibrated\":" + (base != 0 ? "true" : "false") +
            ",\"mpu\":\"" + (mpuReady ? "ok" : "not_found") + "\"" +

            ",\"transport\":\"WIFI\"" +
            ",\"wifi\":true" +

            "}";

        sendData(data);
    }

    delay(10);
}
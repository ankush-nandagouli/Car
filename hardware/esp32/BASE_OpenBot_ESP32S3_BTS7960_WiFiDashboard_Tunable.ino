/*
  OpenBot-compatible ESP32-S3 motor firmware
  Hardware:
    - ESP32-S3-WROOM-1
    - 2 x BTS7960 / IBT-2 drivers
    - Left BTS7960 drives the two left motors in parallel
    - Right BTS7960 drives the two right motors in parallel

  OpenBot serial protocol:
    c<left>,<right>\n   motor commands, each -255..255
    f\n                 feature discovery; replies fDIY_ESP32:\n
    h<ms>\n             heartbeat timeout configuration
    v<ms>\n             voltage reporting interval request; reports voltage limits only
    i<left>,<right>\n   ignored because indicator LEDs are not installed/configured

  Arduino-ESP32 core 3.x is assumed (LEDC pin-based API).
  Tools -> USB CDC On Boot: Enabled
  Use the ESP32-S3 native USB port.

  IMPORTANT:
    - Do not power motors from the ESP32.
    - BTS7960 motor power comes from the motor battery.
    - ESP32 GND, both BTS7960 logic GNDs and battery negative must be common.
    - Use a physical emergency stop that interrupts motor power.
    - Start with wheels raised and the speed cap low.
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// -------------------- Pin configuration --------------------
// Left BTS7960
static constexpr uint8_t LEFT_RPWM = 4;
static constexpr uint8_t LEFT_LPWM = 5;
static constexpr uint8_t LEFT_REN  = 6;
static constexpr uint8_t LEFT_LEN  = 7;

// Right BTS7960
static constexpr uint8_t RIGHT_RPWM = 8;
static constexpr uint8_t RIGHT_LPWM = 9;
static constexpr uint8_t RIGHT_REN  = 10;
static constexpr uint8_t RIGHT_LEN  = 11;

// -------------------- Motor settings --------------------
static uint32_t pwmFrequencyHz = 20000;
static constexpr uint8_t PWM_RESOLUTION = 8;  // duty range 0..255

// Runtime-adjustable from the Wi-Fi dashboard. Start conservatively.
static int maxMotorPwm = 180;       // 0..255 final PWM ceiling
static int minStartPwm = 0;         // optional minimum PWM for moving motors
static int throttleSensitivity = 100; // 50..200%; affects how quickly max is reached
static uint32_t controlTimeoutMs = 10000; // configurable command-loss safety timeout
static bool heartbeatStopEnabled = false; // avoid stale/one-shot h config stopping active driving

// Set true if that whole side runs backwards for a positive OpenBot command.
// If only one motor on a side spins the wrong way, swap that motor's two wires.
static constexpr bool INVERT_LEFT_SIDE = false;
static constexpr bool INVERT_RIGHT_SIDE = false;

// Safety timeout is configurable from the dashboard. If the app sends only
// change-based commands, this must exceed the time between nonzero and release.

// -------------------- Protocol state --------------------
static char rxLine[64];
static size_t rxLength = 0;
static bool rxOverflow = false;

static int requestedLeft = 0;
static int requestedRight = 0;
static uint32_t lastControlMs = 0;
static bool receivedControl = false;

static uint32_t heartbeatIntervalMs = 0;
static uint32_t lastHeartbeatMs = 0;
static bool heartbeatConfigured = false;

// -------------------- Wi-Fi debug dashboard --------------------
static const char *AP_SSID = "OpenBot-S3-Debug";
static const char *AP_PASSWORD = "openbot123"; // Change before deployment
WebServer dashboard(80);
static char lastRxLine[64] = "(none)";
static char lastRxHeader = '-';
static uint32_t totalCommands = 0, controlCommands = 0, featureRequests = 0, heartbeatMessages = 0;
static uint32_t lastRxMs = 0;
static bool dashboardStarted = false;

// Forward declarations used by the dashboard handlers.
static int clampCommand(int value);
static void handleSettings();
static void applyRequestedMotors();

static String jsonEscape(const char *s) {
  String out;
  while (*s) {
    char c = *s++;
    if (c == '"' || c == '\\') out += '\\';
    if ((uint8_t)c >= 0x20) out += c;
  }
  return out;
}

static void handleStatusJson() {
  uint32_t now = millis();
  bool controlFresh = receivedControl && (uint32_t)(now - lastControlMs) <= controlTimeoutMs;
  String json = "{";
  json += "\"uptime_ms\":" + String(now) + ",";
  json += "\"wifi_ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"last_rx\":\"" + jsonEscape(lastRxLine) + "\",";
  json += "\"last_header\":\"" + String(lastRxHeader) + "\",";
  json += "\"total_commands\":" + String(totalCommands) + ",";
  json += "\"control_commands\":" + String(controlCommands) + ",";
  json += "\"feature_requests\":" + String(featureRequests) + ",";
  json += "\"heartbeat_messages\":" + String(heartbeatMessages) + ",";
  json += "\"last_rx_age_ms\":" + String(lastRxMs ? (uint32_t)(now-lastRxMs) : 0xFFFFFFFFUL) + ",";
  json += "\"requested_left\":" + String(requestedLeft) + ",";
  json += "\"requested_right\":" + String(requestedRight) + ",";
  json += "\"left_pwm\":" + String(clampCommand(requestedLeft)) + ",";
  json += "\"right_pwm\":" + String(clampCommand(requestedRight)) + ",";
  json += "\"control_fresh\":" + String(controlFresh ? "true" : "false") + ",";
  json += "\"heartbeat_configured\":" + String(heartbeatConfigured ? "true" : "false") + ",";
  json += "\"heartbeat_interval_ms\":" + String(heartbeatIntervalMs) + ",";
  json += "\"heartbeat_age_ms\":" + String(heartbeatConfigured ? (uint32_t)(now-lastHeartbeatMs) : 0) + ",";
  json += "\"clients\":" + String(WiFi.softAPgetStationNum()) + ",";
  json += "\"max_pwm\":" + String(maxMotorPwm) + ",";
  json += "\"min_start_pwm\":" + String(minStartPwm) + ",";
  json += "\"sensitivity\":" + String(throttleSensitivity) + ",";
  json += "\"control_timeout_ms\":" + String(controlTimeoutMs) + ",";
  json += "\"heartbeat_stop_enabled\":" + String(heartbeatStopEnabled ? "true" : "false") + ",";
  json += "\"pwm_frequency_hz\":" + String(pwmFrequencyHz);
  json += "}";
  dashboard.send(200, "application/json", json);
}

static void handleDashboardRoot() {
  static const char PAGE[] PROGMEM = R"HTML(
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenBot S3 Debug</title><style>
body{font:16px system-ui;background:#10151d;color:#e9eef6;margin:0;padding:18px}
h1{font-size:22px;margin:0 0 6px}small{color:#aab7c8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-top:16px}
.card{background:#1b2532;border:1px solid #344256;border-radius:12px;padding:14px;overflow-wrap:anywhere}
.label{color:#aab7c8;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.value{font-size:23px;font-weight:700;margin-top:5px}
.good{color:#57e39b}.bad{color:#ff7a7a}.mono{font:14px ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}
</style></head><body><h1>OpenBot ESP32-S3 Debug</h1><small>Live serial monitor · refreshes every 400 ms</small>
<div class="card" style="margin-top:16px"><h2 style="font-size:18px;margin-top:0">Motor tuning</h2>
<div class="label">Maximum PWM / speed cap: <b id="maxLabel">180</b> / 255</div><input id="maxPwm" type="range" min="50" max="255" value="180" oninput="maxLabel.textContent=this.value" style="width:100%">
<div class="label" style="margin-top:12px">Minimum start PWM: <b id="minLabel">0</b></div><input id="minPwm" type="range" min="0" max="100" value="0" oninput="minLabel.textContent=this.value" style="width:100%">
<div class="label" style="margin-top:12px">Throttle sensitivity: <b id="sensLabel">100</b>%</div><input id="sensitivity" type="range" min="50" max="200" value="100" oninput="sensLabel.textContent=this.value" style="width:100%">
<div class="label" style="margin-top:12px">Command-loss timeout</div><select id="timeout"><option value="1000">1 second (fast stop)</option><option value="2000">2 seconds</option><option value="3000">3 seconds</option><option value="5000">5 seconds</option><option value="7000">7 seconds</option><option value="10000" selected>10 seconds</option></select>
<div class="label" style="margin-top:12px">PWM frequency</div><select id="frequency"><option value="1000">1 kHz</option><option value="5000">5 kHz</option><option value="10000">10 kHz</option><option value="20000" selected>20 kHz (quiet)</option><option value="25000">25 kHz</option></select>
<label style="display:block;margin-top:14px"><input id="hbStop" type="checkbox"> Stop motors if OpenBot heartbeat expires (only enable if heartbeat repeats)</label>
<button onclick="applySettings()" style="margin-top:14px;padding:10px 16px;border:0;border-radius:8px;font-weight:700">Apply settings</button> <span id="saveMsg"></span>
<p><small>Settings apply immediately and reset after ESP32 reboot. The 10-second timeout is a fallback if commands stop; a zero command from the app stops the motors immediately. Raise speed gradually with wheels lifted.</small></p></div>
<div class="grid">
<div class="card"><div class="label">Control stream</div><div id="fresh" class="value">Waiting…</div></div>
<div class="card"><div class="label">Last received line</div><div id="last" class="value mono">—</div></div>
<div class="card"><div class="label">Left command / PWM</div><div id="left" class="value">0</div></div>
<div class="card"><div class="label">Right command / PWM</div><div id="right" class="value">0</div></div>
<div class="card"><div class="label">All messages</div><div id="total" class="value">0</div></div>
<div class="card"><div class="label">Drive commands</div><div id="controls" class="value">0</div></div>
<div class="card"><div class="label">Feature requests</div><div id="features" class="value">0</div></div>
<div class="card"><div class="label">Heartbeat messages</div><div id="heartbeats" class="value">0</div></div>
<div class="card"><div class="label">Last message age</div><div id="age" class="value">—</div></div>
<div class="card"><div class="label">Heartbeat age / interval</div><div id="hb" class="value">—</div></div>
<div class="card"><div class="label">Wi-Fi clients</div><div id="clients" class="value">0</div></div>
<div class="card"><div class="label">Uptime</div><div id="uptime" class="value">0s</div></div></div>
<p class="card">Connect a second device to <b>OpenBot-S3-Debug</b>, password <b>openbot123</b>, then open <b>http://192.168.4.1</b>. Keep the mounted phone connected to ESP32 over USB.</p>
<script>
let settingsLoaded=false;
async function applySettings(){try{let q=new URLSearchParams({max_pwm:maxPwm.value,min_pwm:minPwm.value,sensitivity:sensitivity.value,timeout:timeout.value,frequency:frequency.value,hb_stop:hbStop.checked?'1':'0'});let r=await fetch('/api/settings?'+q.toString(),{cache:'no-store'});let d=await r.json();saveMsg.textContent=d.ok?'Applied':'Failed';setTimeout(()=>saveMsg.textContent='',2500);}catch(e){saveMsg.textContent='Could not apply';}}
async function tick(){try{let r=await fetch('/api/status',{cache:'no-store'}),d=await r.json();
if(!settingsLoaded){maxPwm.value=d.max_pwm;maxLabel.textContent=d.max_pwm;minPwm.value=d.min_start_pwm;minLabel.textContent=d.min_start_pwm;sensitivity.value=d.sensitivity;sensLabel.textContent=d.sensitivity;timeout.value=String(d.control_timeout_ms);frequency.value=String(d.pwm_frequency_hz);hbStop.checked=d.heartbeat_stop_enabled;settingsLoaded=true;}
let f=document.getElementById('fresh');f.textContent=d.control_fresh?'Drive command stream active':'No fresh drive command';f.className='value '+(d.control_fresh?'good':'bad');
document.getElementById('last').textContent=d.last_rx;
document.getElementById('left').textContent=d.requested_left+' / '+d.left_pwm;
document.getElementById('right').textContent=d.requested_right+' / '+d.right_pwm;
document.getElementById('total').textContent=d.total_commands;document.getElementById('controls').textContent=d.control_commands;
document.getElementById('features').textContent=d.feature_requests;document.getElementById('heartbeats').textContent=d.heartbeat_messages;
document.getElementById('age').textContent=d.last_rx_age_ms>100000000?'Never':d.last_rx_age_ms+' ms';
document.getElementById('hb').textContent=d.heartbeat_configured?d.heartbeat_age_ms+' / '+d.heartbeat_interval_ms+' ms':'Not configured';
document.getElementById('clients').textContent=d.clients;document.getElementById('uptime').textContent=Math.floor(d.uptime_ms/1000)+'s';
}catch(e){document.getElementById('fresh').textContent='Dashboard reconnecting';}}
tick();setInterval(tick,400);
</script></body></html>)HTML";
  dashboard.send_P(200, "text/html", PAGE);
}

static void startDashboard() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  dashboard.on("/", HTTP_GET, handleDashboardRoot);
  dashboard.on("/api/status", HTTP_GET, handleStatusJson);
  dashboard.on("/api/settings", HTTP_GET, handleSettings);
  dashboard.begin();
  dashboardStarted = true;
}

// -------------------- Motor helpers --------------------
static int clampCommand(int value) {
  if (value > 255) value = 255;
  if (value < -255) value = -255;
  if (value == 0) return 0;
  int sign = value < 0 ? -1 : 1;
  int input = abs(value);
  input = (input * throttleSensitivity) / 100;
  if (input > 255) input = 255;
  if (input < 1) input = 1;
  int low = minStartPwm;
  if (low >= maxMotorPwm) low = maxMotorPwm - 1;
  int output = low + ((input - 1) * (maxMotorPwm - low)) / 254;
  if (output < 1) output = 1;
  if (output > maxMotorPwm) output = maxMotorPwm;
  return sign * output;
}

static void handleSettings() {
  if (dashboard.hasArg("max_pwm")) maxMotorPwm = constrain(dashboard.arg("max_pwm").toInt(), 50, 255);
  if (dashboard.hasArg("min_pwm")) minStartPwm = constrain(dashboard.arg("min_pwm").toInt(), 0, 100);
  if (minStartPwm >= maxMotorPwm) minStartPwm = maxMotorPwm - 1;
  if (dashboard.hasArg("sensitivity")) throttleSensitivity = constrain(dashboard.arg("sensitivity").toInt(), 50, 200);
  if (dashboard.hasArg("timeout")) controlTimeoutMs = (uint32_t)constrain(dashboard.arg("timeout").toInt(), 1000, 10000);
  if (dashboard.hasArg("hb_stop")) heartbeatStopEnabled = dashboard.arg("hb_stop") == "1";
  if (dashboard.hasArg("frequency")) {
    long requested = dashboard.arg("frequency").toInt();
    if (requested == 1000 || requested == 5000 || requested == 10000 || requested == 20000 || requested == 25000) {
      pwmFrequencyHz = (uint32_t)requested;
      ledcChangeFrequency(LEFT_RPWM, pwmFrequencyHz, PWM_RESOLUTION);
      ledcChangeFrequency(LEFT_LPWM, pwmFrequencyHz, PWM_RESOLUTION);
      ledcChangeFrequency(RIGHT_RPWM, pwmFrequencyHz, PWM_RESOLUTION);
      ledcChangeFrequency(RIGHT_LPWM, pwmFrequencyHz, PWM_RESOLUTION);
    }
  }
  applyRequestedMotors(); // Apply the new PWM cap/response immediately.
  dashboard.send(200, "application/json", "{\"ok\":true}");
}

static void disableLeft() {
  ledcWrite(LEFT_RPWM, 0);
  ledcWrite(LEFT_LPWM, 0);
  digitalWrite(LEFT_REN, LOW);
  digitalWrite(LEFT_LEN, LOW);
}

static void disableRight() {
  ledcWrite(RIGHT_RPWM, 0);
  ledcWrite(RIGHT_LPWM, 0);
  digitalWrite(RIGHT_REN, LOW);
  digitalWrite(RIGHT_LEN, LOW);
}

static void stopMotors() {
  requestedLeft = 0;
  requestedRight = 0;
  disableLeft();
  disableRight();
}

// BTS7960 direction convention:
// positive command -> RPWM active, LPWM zero
// negative command -> LPWM active, RPWM zero
static void driveLeft(int command) {
  if (INVERT_LEFT_SIDE) command = -command;
  command = clampCommand(command);

  if (command == 0) {
    disableLeft();
    return;
  }

  // Break-before-make: clear both PWM inputs before changing direction.
  ledcWrite(LEFT_RPWM, 0);
  ledcWrite(LEFT_LPWM, 0);
  digitalWrite(LEFT_REN, HIGH);
  digitalWrite(LEFT_LEN, HIGH);

  if (command > 0) {
    ledcWrite(LEFT_LPWM, 0);
    ledcWrite(LEFT_RPWM, command);
  } else {
    ledcWrite(LEFT_RPWM, 0);
    ledcWrite(LEFT_LPWM, -command);
  }
}

static void driveRight(int command) {
  if (INVERT_RIGHT_SIDE) command = -command;
  command = clampCommand(command);

  if (command == 0) {
    disableRight();
    return;
  }

  ledcWrite(RIGHT_RPWM, 0);
  ledcWrite(RIGHT_LPWM, 0);
  digitalWrite(RIGHT_REN, HIGH);
  digitalWrite(RIGHT_LEN, HIGH);

  if (command > 0) {
    ledcWrite(RIGHT_LPWM, 0);
    ledcWrite(RIGHT_RPWM, command);
  } else {
    ledcWrite(RIGHT_RPWM, 0);
    ledcWrite(RIGHT_LPWM, -command);
  }
}

static void applyRequestedMotors() {
  driveLeft(requestedLeft);
  driveRight(requestedRight);
}

// -------------------- OpenBot protocol --------------------
static void sendLine(const char *line) {
  Serial.print(line);
  Serial.write('\n');
}

static void processLine(char *line) {
  if (line == nullptr || line[0] == '\0') return;

  strncpy(lastRxLine, line, sizeof(lastRxLine) - 1);
  lastRxLine[sizeof(lastRxLine) - 1] = '\0';
  lastRxHeader = line[0];
  lastRxMs = millis();
  totalCommands++;

  const char header = line[0];
  char *body = line + 1;

  switch (header) {
    case 'c': {
      controlCommands++;
      // Official format: c<left>,<right>; values are -255..255.
      char *comma = strchr(body, ',');
      if (comma == nullptr) return;
      *comma = '\0';

      char *leftEnd = nullptr;
      char *rightEnd = nullptr;
      long leftValue = strtol(body, &leftEnd, 10);
      long rightValue = strtol(comma + 1, &rightEnd, 10);

      // Reject malformed input rather than accidentally driving.
      if (leftEnd == body || rightEnd == comma + 1) return;

      if (leftValue > 255) leftValue = 255;
      if (leftValue < -255) leftValue = -255;
      if (rightValue > 255) rightValue = 255;
      if (rightValue < -255) rightValue = -255;

      requestedLeft = (int)leftValue;
      requestedRight = (int)rightValue;
      lastControlMs = millis();
      receivedControl = true;
      applyRequestedMotors();
      break;
    }

    case 'f':
      featureRequests++;
      // Only advertise features physically implemented in this build.
      // No voltage divider, indicators, sonar or wheel encoders are configured.
      sendLine("fDIY_ESP32:");
      break;

    case 'h': {
      heartbeatMessages++;
      // Match official OpenBot firmware semantics: h sets the interval and
      // refreshes the heartbeat timestamp. App should refresh it periodically.
      long interval = strtol(body, nullptr, 10);
      if (interval < 0) interval = 0;
      heartbeatIntervalMs = (uint32_t)interval;
      lastHeartbeatMs = millis();
      heartbeatConfigured = true;
      break;
    }

    case 'v':
      // No battery voltage divider is installed. Send the official-style
      // thresholds only; do not report fabricated live voltage readings.
      sendLine("vmin:6.00");
      sendLine("vlow:9.00");
      sendLine("vmax:12.60");
      break;

    // No indicator LEDs, sonar, wheel encoders, bumper or status LEDs are
    // wired in the currently described hardware, so their messages are ignored.
    case 'i':
    case 's':
    case 'w':
    case 'b':
    case 'l':
    case 'n':
    default:
      break;
  }
}

static void readSerialProtocol() {
  while (Serial.available() > 0) {
    const char ch = (char)Serial.read();

    if (ch == '\r') continue;

    if (ch == '\n') {
      if (!rxOverflow) {
        rxLine[rxLength] = '\0';
        processLine(rxLine);
      }
      rxLength = 0;
      rxOverflow = false;
      continue;
    }

    if (rxLength < sizeof(rxLine) - 1) {
      rxLine[rxLength++] = ch;
    } else {
      // Drop the entire overlong line.
      rxOverflow = true;
    }
  }
}

static void enforceSafetyTimeouts() {
  const uint32_t now = millis();

  if (receivedControl && (uint32_t)(now - lastControlMs) > controlTimeoutMs) {
    stopMotors();
    receivedControl = false;
  }

  // Follow the heartbeat interval requested by the OpenBot app.
  // Heartbeat stopping is optional because some app/controller builds send h<ms>
  // as configuration and may not repeat it. Command timeout remains the primary
  // watchdog; enable this option only after verifying repeated heartbeat traffic.
  if (heartbeatStopEnabled && heartbeatConfigured && heartbeatIntervalMs > 0 &&
      (uint32_t)(now - lastHeartbeatMs) >= heartbeatIntervalMs) {
    stopMotors();
    receivedControl = false;
  }
}

void setup() {
  // Set enables low as early as possible so the drivers start disabled.
  pinMode(LEFT_REN, OUTPUT);
  pinMode(LEFT_LEN, OUTPUT);
  pinMode(RIGHT_REN, OUTPUT);
  pinMode(RIGHT_LEN, OUTPUT);
  digitalWrite(LEFT_REN, LOW);
  digitalWrite(LEFT_LEN, LOW);
  digitalWrite(RIGHT_REN, LOW);
  digitalWrite(RIGHT_LEN, LOW);

  pinMode(LEFT_RPWM, OUTPUT);
  pinMode(LEFT_LPWM, OUTPUT);
  pinMode(RIGHT_RPWM, OUTPUT);
  pinMode(RIGHT_LPWM, OUTPUT);

  // Arduino-ESP32 core 3.x LEDC API attaches PWM directly to GPIO pins.
  ledcAttach(LEFT_RPWM, pwmFrequencyHz, PWM_RESOLUTION);
  ledcAttach(LEFT_LPWM, pwmFrequencyHz, PWM_RESOLUTION);
  ledcAttach(RIGHT_RPWM, pwmFrequencyHz, PWM_RESOLUTION);
  ledcAttach(RIGHT_LPWM, pwmFrequencyHz, PWM_RESOLUTION);

  stopMotors();

  Serial.begin(115200);
  startDashboard();
  // OpenBot's firmware sends the ready marker 'r' at startup.
  sendLine("r");
}

void loop() {
  readSerialProtocol();
  enforceSafetyTimeouts();
  if (dashboardStarted) dashboard.handleClient();
  delay(1);
}

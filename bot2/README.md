# OpenBot Secure AI + MG995 + Gemini Live + Intercom

This is a security-conscious prototype scaffold for the OpenBot-style ESP32-S3 robot described in the project notes. It includes the browser controller, robot-phone PWA, authenticated WSS signaling/API service, ESP32-S3 firmware, MG995 servo control, local browser object detection, Gemini/Groq assistant proxy, Gemini Live real-time voice, separate two-way audio intercom, and selectable button-pad/virtual-joystick drive controls.

> This source has been syntax-checked, but has not been physically tested with the exact ESP32-S3 board, BTS7960 wiring, MG995, phone browsers, or provider accounts. Configure and test it before using motors.

## Architecture

- The robot phone runs `/robot.html`, connects to the mobile hotspot, starts its camera and microphone once, and keeps the page visible. The ESP32-S3 joins the phone hotspot as a Wi-Fi station and opens an authenticated TLS WebSocket to the signaling service.
- Robot-phone video uses its own WebRTC peer connection to the controller.
- Intercom audio uses a separate WebRTC peer connection. After the robot phone user grants camera/microphone permissions, its microphone is sent continuously while the page is active. On the controller, **Enable intercom / microphone** requests mic permission once; holding **Hold to talk** enables the controller mic, and releasing it mutes that track. The robot phone does not need to tap a separate intercom button.
- Gemini Live is a separate controller-side real-time voice session. The signaling backend provisions a short-lived Gemini ephemeral token; the controller streams 16 kHz PCM and plays Gemini's 24 kHz PCM response. A Live session is not the same as the phone-to-controller intercom.
- Manual drive supports either a button pad or virtual joystick. MG995 servo angle/presets/sweep are relayed to the ESP32-S3.
- Text/vision chat, Groq transcription, and Groq speech use authenticated backend endpoints. Provider keys may be entered in the controller page for the current session or configured as Render environment secrets.
- COCO-SSD object detection runs locally in the controller browser. The camera image is uploaded to a provider only when the user asks a visual question and camera snapshots are enabled.

## Files

- `pwa/index.html`, `robot.html`, `controller.html`, `style.css`, `manifest.webmanifest`, `sw.js`
- `pwa/js/robot.js`, `pwa/js/controller.js`
- `signaling/server.js`, `signaling/package.json`, `signaling/.env.example`
- `firmware/OpenBotSecure/OpenBotSecure.ino`
- `README.md`, `DEPLOY.md`

## Deploy the signaling service

Deploy `signaling/` as a Node Web Service on Render:

- Runtime: Node 20+
- Build command: `npm install`
- Start command: `npm start`
- Required environment variables:
  - `ROBOT_TOKEN`, `CONTROLLER_TOKEN`, `ESP32_TOKEN`: three different random secrets, each at least 32 characters
  - `ROOM_ID`: random value at least 16 characters
  - `ALLOWED_ORIGINS`: exact HTTPS origin of the PWA, without a trailing slash
- Optional provider secrets:
  - `GEMINI_API_KEY`: server-side Gemini key
  - `GROQ_API_KEY`: server-side Groq key
- Optional model variables:
  - `GEMINI_MODEL=gemini-3.8-flash`
  - `GEMINI_LIVE_MODEL=gemini-3.8-live`
  - `GROQ_MODEL=qwen/qwen3.8-27b`
  - `GROQ_STT_MODEL=whisper-large-v3-turbo`
  - `GROQ_TTS_MODEL=canopylabs/orpheus-v1-english`

API keys are optional as server environment variables if you enter them in the controller UI. Controller-entered keys are held in page memory (not local storage) and sent over HTTPS to the authenticated signaling API; the service does not intentionally persist or log them. For a public/shared deployment, configuring them as Render environment secrets is preferable. Do not commit keys to GitHub or put them in the ESP32 firmware. Provider free quotas and model availability can change; verify usage and pricing in the provider console.

## Deploy the PWA

Deploy `pwa/` as a Static Site:

- Publish/root directory: `pwa`
- Build command: blank
- Publish directory: `.`
- HTTPS required for camera, microphone, and WebRTC APIs
- Add the exact PWA HTTPS origin to the signaling service's `ALLOWED_ORIGINS`, then redeploy the service

## Configure and connect devices

1. Enable mobile data and mobile hotspot on the robot phone.
2. Open `/robot.html` on the robot phone. Enter the WSS URL, room ID, and robot token; connect; tap **Start camera + keep awake** and grant camera + microphone permission. Keep the page visible. This single start action is needed because browsers require user permission and may restrict background capture/audio playback.
3. Open `/controller.html` on the second device. Enter the same WSS URL and room ID plus the controller token; connect.
4. For provider access, either paste Gemini/Groq API keys into the controller's **API keys & Gemini Live voice** panel or configure them as Render environment secrets. The default Live model is `gemini-3.8-live`.
5. To use two-way intercom, press **Enable intercom / microphone** once on the controller and grant permission. Hold **Hold to talk** to speak from the controller to the robot phone. The robot phone microphone streams back automatically after its camera/mic permission has been granted. Use headphones where possible to avoid feedback.
6. Choose **Button pad** or **Joystick** in Manual Drive. Releasing a button or joystick stops the motors. Test the STOP button first with motor power disconnected.
7. Test servo controls with motors disconnected. Test motors with wheels lifted and low speed before floor testing.

## Gemini Live voice and AI keys

- The controller UI supports Gemini and Groq API key inputs. Keys typed into the UI are not stored in local storage and are sent only to the authenticated backend over HTTPS.
- The backend `/api/live-token` endpoint requests a short-lived, single-use Gemini ephemeral token. The long-lived Gemini key is not put into the Gemini Live WebSocket URL. The browser uses the constrained Live WebSocket endpoint.
- Gemini Live handles speech input and generated audio output in one session. It does not require Groq STT/TTS for that Live voice feature.
- The normal chat/vision feature uses Gemini primary then Groq fallback in Auto mode. Groq STT/TTS remain optional for the non-Live speech modes.
- Current model defaults are documented at the time of this package build. If a provider reports an unknown/unavailable model, update the matching environment variable or the model field using the provider's current model list.

## MG995 wiring

- MG995 red: external regulated 5–6 V supply positive.
- MG995 brown/black: supply ground.
- MG995 orange/yellow: signal to the configured ESP32-S3 GPIO.
- Join the servo supply ground to ESP32 GND.
- Do not power the MG995 from the ESP32 3.3 V pin. Use a supply sized for servo stall current and avoid feeding the ESP32 from the servo rail.
- `SERVO_PIN=8` is a placeholder. Verify the exact pin against your board. Install ESP32Servo, WebSockets by Markus Sattler (Links2004), and ArduinoJson.
- Servo UI is limited to 10–170 degrees; physical endpoints vary. Check movement before attaching linkages.

## Firmware setup

Edit `firmware/OpenBotSecure/OpenBotSecure.ino` with your hotspot SSID/password, signaling hostname, room ID, ESP32 token, trusted root CA certificate, and verified motor/servo GPIOs. Never use `setInsecure()`. The firmware intentionally fails closed if the root CA placeholder remains. Motor GPIOs are placeholders too; verify pin availability and BTS7960 enable logic on the actual board.

## Patrol safety

Patrol is only a bounded demonstration: up to 30 seconds, low speed (25–70/255), alternating short movement pulses and stops, and a browser-side object-detection gate. It stops when an object is detected, video/detection becomes stale, the page is hidden or blurred, the connection is lost, or the timer expires.

**COCO-SSD is not safety-rated and does not measure distance.** A blank detection list does not prove a path is clear; it can miss walls, glass, wires, low/small objects, stairs, and objects outside the camera view. Do not leave the robot unattended or use this around people, pets, stairs, or fragile items. For meaningful autonomous navigation, add front-facing ultrasonic/ToF sensors and local ESP32 obstacle-stop logic, plus a physical motor-power cutoff. AI does not directly control the motors.

## Troubleshooting

- **AI providers unavailable:** check API key field or Render environment secret, model availability, provider quotas, and service logs.
- **Gemini Live token error:** verify Gemini key and Live API access; try the current Live model listed in Google's model documentation.
- **Intercom no audio:** allow mic permissions on both devices; start camera on robot phone; use HTTPS; tap the robot page once if autoplay is blocked; test with headphones; configure TURN if STUN-only connectivity cannot cross the networks.
- **No video:** allow camera permission, keep robot page visible, and configure TURN if necessary.
- **Servo does not move:** verify external 5–6 V power, shared ground, signal GPIO, library installation, and physical angle limits.
- **Motors do not stop on release:** disconnect motor power immediately and verify firmware command timeout, wiring, and STOP behavior before testing again.

## Official documentation used

- Gemini Live WebSocket: https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
- Gemini ephemeral tokens: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
- Gemini model list: https://ai.google.dev/gemini-api/docs/models
- Groq vision: https://console.groq.com/docs/vision
- Groq speech-to-text: https://console.groq.com/docs/speech-to-text
- Groq text-to-speech: https://console.groq.com/docs/text-to-speech
- ESP32Servo: https://github.com/madhephaestus/ESP32Servo
- WebRTC signaling concepts: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling


## Robot-side Gemini Live conversation (new)

1. Deploy the signaling service with the same secure environment variables described above.
2. Open `robot.html` on the robot phone, connect/authenticate, then tap **Start camera + keep awake** once and grant camera/microphone permission. Keep the page open.
3. On `controller.html`, enter the Gemini API key (or configure `GEMINI_API_KEY` on the signaling server), connect, then press **Start AI on robot phone**. The server mints a short-lived, single-use Gemini Live token and relays only that token to the authenticated robot phone. The long-lived key is not relayed.
4. The robot phone streams microphone PCM to Gemini Live and plays generated PCM audio through its own speaker. Stop it with **Stop robot AI** on the controller or **Stop robot AI voice** on the robot page.
5. **Two-way intercom** remains a separate WebRTC audio connection. It can run alongside the robot AI, but simultaneous loudspeaker/microphone use can cause acoustic feedback; headphones or lower speaker volume are recommended.

Gemini Live audio input is sent as 16-bit PCM at 16 kHz and output is played as 24 kHz PCM. See Google's current Live API documentation: https://ai.google.dev/gemini-api/docs/live-api/capabilities and https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens.

**Browser limitation:** This is active-page/background-best-effort web audio, not a guaranteed always-on Android service. Keep the robot page visible and screen awake. For reliable locked-screen listening, implement a native Android foreground service and follow Android microphone foreground-service requirements.

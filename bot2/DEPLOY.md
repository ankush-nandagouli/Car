# Render deployment checklist

## 1. Signaling/API service
- Root directory: `signaling`
- Runtime: Node 20+
- Build command: `npm install`
- Start command: `npm start`
- Required secrets: `ROBOT_TOKEN`, `CONTROLLER_TOKEN`, `ESP32_TOKEN` (different random values, at least 32 characters), `ROOM_ID` (at least 16 characters), `ALLOWED_ORIGINS` (exact PWA HTTPS origin, no trailing slash).
- Optional provider secrets: `GEMINI_API_KEY`, `GROQ_API_KEY`.
- Model defaults: `GEMINI_MODEL=gemini-3.8-flash`, `GEMINI_LIVE_MODEL=gemini-3.8-live`, `GROQ_MODEL=qwen/qwen3.8-27b`, `GROQ_STT_MODEL=whisper-large-v3-turbo`, `GROQ_TTS_MODEL=canopylabs/orpheus-v1-english`.
- If you do not set provider keys in Render, paste them into the controller UI. Controller-entered keys are held in page memory and sent to the authenticated HTTPS backend; they are not stored in local storage. Server environment secrets are preferable for a shared/public deployment.

## 2. PWA static site
- Root directory: `pwa`
- Build command: blank
- Publish directory: `.`
- Deploy with HTTPS.
- Put the exact static-site origin in `ALLOWED_ORIGINS` and redeploy the signaling service.

## 3. Robot phone
- Enable mobile hotspot + mobile data.
- Open `/robot.html`, enter WSS URL, room ID and robot token; connect.
- Tap **Start camera + keep awake** and grant camera and microphone permissions. Keep the page visible for reliable capture/audio.
- The video stream and intercom audio use separate WebRTC peer connections. The robot phone does not need a second intercom button after its initial permission/start step.

## 4. Controller device
- Open `/controller.html`; enter WSS URL, room ID and controller token; connect.
- In **API keys & Gemini Live voice**, paste Gemini and/or Groq API keys if they are not configured as server secrets. Start Gemini Live for combined real-time speech input/output.
- For two-way intercom, click **Enable intercom / microphone** once. Hold **Hold to talk** to send controller speech; release to mute. The robot microphone returns continuously.
- Select Button pad or Joystick under Manual Drive.

## 5. Firmware and hardware
- Install ESP32Servo, WebSockets by Markus Sattler (Links2004), and ArduinoJson.
- Configure hotspot credentials, signaling hostname, room ID, ESP32 token, trusted root CA, and all GPIO assignments in `firmware/OpenBotSecure/OpenBotSecure.ino`.
- `SERVO_PIN=8` and the motor GPIOs are placeholders. Verify against your exact ESP32-S3 board.
- MG995 requires a regulated external 5–6 V supply with shared ground to ESP32 GND. Never power it from 3.3 V.
- Never disable TLS certificate validation. Firmware intentionally fails closed until the root CA placeholder is replaced.
- Test servo with motors disconnected; test motors with wheels lifted, low speed, and a physical power cutoff.

## Costs and safety
- Free tiers and model quotas/prices change. Review Gemini/Groq current usage and billing controls.
- Gemini Live uses a short-lived ephemeral token provisioned by the authenticated backend.
- Patrol is not safety-rated obstacle avoidance. Add local distance sensors and motor-stop logic before autonomous movement near people, pets, stairs, or fragile objects.


## Robot phone AI voice setup

- In the robot phone browser, authenticate and tap **Start camera + keep awake** once. This grants microphone/camera permission and unlocks browser audio.
- On the controller, enter Gemini key in the API keys section (or set `GEMINI_API_KEY` in Render). Keep the controller connected and the robot online.
- Press **Start AI on robot phone**. The server creates a single-use short-lived Live API token and sends that token (not the long-lived API key) over the authenticated room channel.
- Use **Stop robot AI** on controller to stop the session. The robot page also has a local stop button.
- Intercom and AI are independent. Running both may cause acoustic feedback unless speaker volume is low or headphones are used.
- Browser pages are not a guaranteed always-on service when backgrounded or locked. For dependable locked-screen operation, a native Android foreground service is required.

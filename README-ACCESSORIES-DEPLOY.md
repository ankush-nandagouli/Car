# OpenBot Web Controller + Accessories — Self-hosted Login

This repository contains the OpenBot source with the web controller and Robot-app add-on for an ESP32-S3 vehicle. The remote web-controller login and signaling no longer require Firebase Authentication, Supabase, or another third-party authentication provider.

## Remote authentication design

- The Node.js signaling server exposes `POST /api/login` over HTTPS.
- A single username/password is stored privately as Render environment variables, not in JavaScript or a public repository.
- Successful login returns a short-lived, signed JWT (12-hour lifetime).
- The browser uses the JWT to join the WebSocket room. The Android Robot app logs in using the username/password entered in its own Settings screen, then joins with its own JWT.
- The server only relays messages between the authenticated browser and Robot clients in the configured room. Login attempts are rate-limited and tokens expire.
- The room ID is a routing identifier, not a password. Use a strong unique password and a random 32+ character session secret.

**Why credentials are not hardcoded in client source:** credentials compiled into a browser bundle or APK can be extracted by anyone who receives it. Keep the server's canonical password in Render's private environment and enter it in the Robot app's Settings. The Android app stores the entered value in its app preferences; protect physical access to the robot phone and do not distribute the APK with a prefilled password.

## Updated files

### Web controller (`controller/web-server/`)
- `client/index.html` and `client/style.css`: username/password sign-in dialog and controller UI.
- `client/index.js`: self-hosted login, session token, and accessory controls; no Firebase browser-auth imports.
- `client/websocket/connection.js`: same-origin `/ws` signaling connection.
- `server/server.js`: static hosting, `/healthz`, `/api/login`, JWT verification, login rate limiting, authenticated WebSocket room pairing, peer relay, and disconnect notifications.
- `server/package.json`: `jsonwebtoken` and `dotenv`; no Firebase Admin SDK required for remote signaling.
- `server/.env.example`: local-only environment template. Do not commit a real `.env` file.

### Android Robot app
The accessory command integration is in:
- `android/robot/src/main/java/org/openbot/app/robot/vehicle/Vehicle.java`
- `android/robot/src/main/java/org/openbot/app/robot/common/ControlsFragment.java`
- `android/robot/src/main/java/org/openbot/app/robot/env/PhoneController.java`
- `android/robot/src/main/java/org/openbot/app/robot/env/ControllerConfig.java`
- `android/robot/src/main/res/xml/root_preferences.xml`
- `android/robot/src/main/res/values/strings.xml`

In Robot app Settings, set **Web Signaling Server**, **Remote Controller Username**, and **Remote Controller Password**. Use the exact username/password configured on Render. The Robot app gets its JWT from the same-origin `/api/login` endpoint and uses it for the WebSocket join.

Note: upstream OpenBot still contains Firebase SDK integrations for unrelated existing features (such as cloud/profile functionality). The remote web-controller login and signaling flow no longer depends on Firebase, and no Firebase service-account JSON is needed for this deployment. Removing Firebase from every unrelated upstream app feature would be a separate change and could disable those features.

## Render deployment

Create a Render Blueprint from `render.yaml`, or create a Node Web Service with:
- Root directory: `controller/web-server`
- Build command: `npm install && npm install --prefix server && npm run build`
- Start command: `npm run start:prod`
- Health check path: `/healthz`

Set these private environment variables in the Render service:

- `OPENBOT_USERNAME`: your chosen username.
- `OPENBOT_PASSWORD`: a long, unique password (do not use an example password).
- `OPENBOT_SESSION_SECRET`: a random secret of at least 32 characters. The Blueprint can generate this value; if creating the service manually, generate a random value and store it privately.
- `OPENBOT_ROOM_ID`: use `main` unless you intentionally configure a different room.
- `NODE_ENV=production`.

Render's public service URL should use HTTPS. The browser connects to `https://YOUR-SERVICE.onrender.com`; the Robot app's Web Signaling Server setting must be `wss://YOUR-SERVICE.onrender.com/ws`. The server login API is `https://YOUR-SERVICE.onrender.com/api/login`.

For local development, copy `controller/web-server/server/.env.example` to `.env`, choose your own credentials, and run from `controller/web-server`. Never commit `.env`.

## GitHub Actions: APK download + Render deploy

Workflow: `.github/workflows/build-deploy.yml`.

1. Push the repository to GitHub.
2. Add repository secret `RENDER_DEPLOY_HOOK_URL` from the Render service's Settings → Deploy Hook. The hook URL is a secret.
3. Push to `main`/`master`, or run the workflow manually. GitHub Actions builds the web bundle and Android debug APK, uploads both as artifacts, and triggers Render on successful main/master pushes if the deploy-hook secret exists.
4. Download the APK from the workflow run's **Artifacts** section. For a persistent release URL, push a version tag such as `v1.0.0`; the workflow attaches `robot-debug.apk` to a GitHub Release. The URL pattern is `https://github.com/OWNER/REPO/releases/latest/download/robot-debug.apk` after a release exists.

The workflow produces a debug APK for testing, not a production-signed release APK. No credentials are required to build the APK because the robot user enters the remote credentials in app Settings.

## WebRTC / Internet notes

The WebSocket server exchanges signaling messages; it does not carry the video itself. WebRTC may need a TURN relay on restrictive mobile networks. No TURN server credentials are included. Configure a TURN service if camera video does not connect reliably over cellular networks.

## ESP32 accessory protocol and safety

The add-on serial commands are newline-terminated: `c<left>,<right>`, `h<ms>`, `p<angle>`, `l<front>,<rear>`, `i<left>,<right>`, `m<maxPWM>,<minStartPWM>,<sensitivity>,<timeoutMs>`, and `q`.

- Verify ESP32-S3 pins against your exact board. Firmware default mapping: left BTS7960 RPWM/LPWM/EN = GPIO 4/5/6/7; right = GPIO 8/9/10/11; MG995 signal GPIO 12; front/rear MOSFET controls GPIO 13/14; hazard outputs GPIO 15/16.
- Power the MG995/MG996R from a separate regulated 5–6 V supply sized for stall current; share ground with the ESP32. Never power it from an ESP32 GPIO/3.3 V rail.
- Use MOSFET/transistor drivers for lamps, a suitable fuse/wiring, and a physical motor-power emergency cutoff.
- Test with wheels raised, low PWM, and the emergency cutoff within reach. Software stop is not a safety-rated emergency stop.

## Validation status

The source changes are included, but a full Android Gradle build and live Render deployment have not been verified in this environment. GitHub Actions is configured to build and upload the APK and web bundle after you push the repository. Test the built APK and the live connection before enabling motor power.

# Internet remote-control deployment

## Topology

- Mounted Android phone: modified OpenBot Robot app, connected to ESP32-S3 by USB OTG and connected to the Internet via Wi-Fi/mobile data.
- Browser/controller device: opens the modified Web Controller from any Internet connection.
- Hosted signaling service: HTTPS website + WSS signaling endpoint pairs browser and Robot by Firebase-authenticated account and relays WebRTC signaling + commands.
- ESP32-S3: remains behind the phone's USB serial link; its Wi-Fi debug AP is local diagnostics only and must not be port-forwarded to the Internet.

## Secure signaling server

The upstream demo signaling relay matches rooms by email but does not verify Firebase tokens server-side. For a public Internet-controlled robot, use the included `web-controller/server/server.js` overlay instead of the demo relay.

1. In your OpenBot working copy, replace `controller/web-server/server/server.js` with this package's server overlay.
2. From `controller/web-server`, run `npm install firebase-admin --save`. `ws` is already in the upstream package dependencies.
3. Create a Firebase service account from the **same Firebase project** used by the web controller and Robot app. Store its full JSON only as the deployment environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`. Never commit it, embed it in frontend files or share it publicly.
4. Deploy Node server behind TLS/WSS on a platform such as Render. Its process reads `PORT` from the hosting environment and listens on that port. Configure the hosting platform's WebSocket support and TLS.
5. In `controller/web-server/client/index.html`, set `<meta name="openbot-signaling-url" content="wss://YOUR-SIGNALING-HOST/ws">` to the public WSS endpoint. If the host serves the Node service at the root without `/ws`, use that root URL instead. The included server has no path-based routing; reverse-proxy `/ws` to the port if you use that path.
6. In the mounted Robot app open Settings → Web Signaling Server and enter the **same WSS URL**. Ensure Firebase sign-in is successful on the Robot phone and browser.
7. Deploy the web client over HTTPS. For WebRTC media behind strict NAT/carrier-grade NAT, add TURN servers with authenticated, short-lived credentials in the Android/WebRTC configuration. This package does not create a TURN service or set up your hosting account automatically.

The supplied signaling overlay verifies Firebase ID tokens and checks that the token email matches the requested room. Both the browser patch and Android Robot patch are needed for this server: the stock Android app does not send the `authToken` join field and therefore cannot join this server until rebuilt with the provided patch.

## Before remote driving

- Use unique account access and don't expose service-account credentials.
- Verify command-loss timeout and zero-on-release behavior at low speed.
- Test browser disconnect, Robot phone disconnect, WebSocket server restart and mobile-network loss. Motors must stop on lost control commands.
- Have a physical emergency motor-power cutoff in reach; software stop is not a safety-rated e-stop.
- Test with wheels raised before driving on a clear area. Internet latency can make steering hazardous.

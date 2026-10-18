# OpenBot PWA prototype

A mobile-first PWA concept for using the phone as the vision/AI computer and an ESP32-S3 as the motor controller over USB-C.

## Included
- Responsive dashboard, camera preview and COCO-SSD object detection in-browser (TensorFlow.js).
- Manual joystick, directional controls, speed limit, emergency stop.
- USB serial connection attempt using `navigator.serial` at 115200 baud.
- Offline shell caching via service worker; ML libraries/model may still need internet on first load.
- Firmware integration protocol notes in `firmware/README.md`.

## Run locally
Serve this directory over HTTPS or `localhost` (camera and USB APIs require a secure context):

```bash
python -m http.server 8000
```

Open `http://localhost:8000` on a development computer. For a phone, deploy to HTTPS hosting such as GitHub Pages or Render static site, then open the URL in Chrome. PWA installability requires HTTPS except localhost.

## USB-C and Android
The app picks a transport automatically (`js/transport.js`):

1. **Web Serial** (`navigator.serial`) if the browser has it.
2. **WebUSB** (`navigator.usb`) fallback, which Chrome for Android supports. Handles:
   - ESP32-S3/C3 native USB (VID `0x303A`, CDC-ACM) - plug the board's **USB** port, not the UART port
   - CP210x (CP2102) and CH340/CH341/CH9102 USB-UART bridges
   - FTDI is not supported over WebUSB here.

Requirements: HTTPS (or localhost), Chrome on Android, a data-capable USB-C cable/OTG, and a user tap on **Connect USB-C** (the browser chooser only appears from a tap). Close any other app using the port. If the chooser shows no device, try the other USB port on the board, or unplug/replug while the phone is unlocked.

Note: the ESP32-S3 re-enumerates when it resets, which drops the USB link; just tap Connect again.

## Safety limitations
- Generic COCO-SSD detection is not a depth sensor and does not reliably determine free space or collision distance.
- Object tracking currently selects/displays a visual target; it does not automatically steer the robot.
- Free roam is intentionally observation-only; autonomous motor output is not enabled. A safe planner needs validated obstacle sensing/depth, calibrated control, and a firmware watchdog.
- Use a physical motor power switch, test with wheels raised, and keep firmware-side timeout/limits. Do not run the motors on the ground until the parser and wiring have been verified.

## Privacy
Camera frames are processed in the browser; this code does not upload video to a server. Third-party TensorFlow.js/model assets are loaded from jsDelivr when online.

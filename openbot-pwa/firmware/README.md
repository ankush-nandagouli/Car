# ESP32-S3 firmware integration notes

The PWA sends newline-terminated ASCII at 115200 baud:

- `c<left>,<right>`: signed wheel speeds in the range -255..255 (example `c120,120`)
- `h`: halt immediately
- `f`: status ping/request (firmware should reply with a line such as `L=0 R=0`)

**Important:** match the parser to your existing OpenBot firmware if its exact protocol semantics differ. Keep a hardware-level motor timeout in firmware (suggested 300–500 ms without a fresh valid drive command), clamp PWM, reject malformed packets, and stop on USB disconnect/reset. Do not rely on the browser to be the only safety layer.

This folder intentionally does not invent your BTS7960 GPIO wiring. Add the parser to your known-good ESP32-S3 motor firmware and retain your actual pin mapping, PWM setup, direction logic, and safety interlocks. Verify the exact official OpenBot command format before connecting wheels to the floor.

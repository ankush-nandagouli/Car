# Android Robot app patching

Run `python /path/to/OpenBot_Servo_Lights_Internet_Addon/android-patches/apply_android_patch.py` with the current working directory set to the root of your `ob-f/OpenBot` clone. The script edits:

- `android/robot/src/main/java/org/openbot/app/robot/vehicle/Vehicle.java`: adds `p<angle>` servo output and front/rear `l<front>,<rear>`/hazard serial helpers.
- `android/robot/src/main/java/org/openbot/app/robot/common/ControlsFragment.java`: handles `SERVO_ANGLE`, `LIGHTS`, `HAZARD`, `HAZARD_TOGGLE` browser events and returns UI acknowledgements.
- `android/robot/src/main/java/org/openbot/app/robot/env/PhoneController.java`: sends Firebase ID tokens in the WebSocket join and waits for the server's paired-room `CONNECTED` event before starting remote video negotiation.

Backups with `.before-accessories.bak` suffixes are created. Review the diff, then build and install the modified Robot APK using the official Android build instructions. The stock APK does not contain these command handlers or token field, so it will not work with the included secured signaling server until rebuilt.

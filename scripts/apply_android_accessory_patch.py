#!/usr/bin/env python3
"""Patch OpenBot Robot app for servo/lights and Firebase-authenticated WebSocket joins.
Run from the OpenBot repository root. Backups are made before any writes.
"""
from pathlib import Path
import re
import shutil
import sys

vehicle_path = Path("android/robot/src/main/java/org/openbot/app/robot/vehicle/Vehicle.java")
controls_path = Path("android/robot/src/main/java/org/openbot/app/robot/common/ControlsFragment.java")
phone_path = Path("android/robot/src/main/java/org/openbot/app/robot/env/PhoneController.java")
if not all(p.exists() for p in (vehicle_path, controls_path, phone_path)):
    sys.exit("Run this script from the root of the OpenBot repository.")
vehicle = vehicle_path.read_text(encoding="utf-8")
controls = controls_path.read_text(encoding="utf-8")
phone = phone_path.read_text(encoding="utf-8")
if (
    'setPhoneServoAngle(int angle)' in vehicle
    and 'setMotorTuning(int maxPwm' in vehicle
    and 'case "SERVO_ANGLE"' in controls
    and 'case "MOTOR_TUNING"' in controls
    and "case 'M':" in controls
    and 'requestMotorTuningStatus();' in controls
    and 'room.put("authToken"' in phone
    and r'ControllerToBotEventBus.emitEvent("{command: \"CONNECTED\"}");' not in phone
):
    print("Accessory and signaling authentication support already appears installed; no changes made.")
    sys.exit(0)

for p in (vehicle_path, controls_path, phone_path):
    shutil.copy2(p, p.with_suffix(p.suffix + ".before-accessories.bak"))

# Vehicle serial helper methods.
field_anchor = "  private boolean noiseEnabled = false;"
if field_anchor not in vehicle:
    sys.exit("Vehicle state anchor not found; backups are present, patch manually.")
if "private volatile boolean hazardLightsEnabled" not in vehicle:
    vehicle = vehicle.replace(field_anchor, field_anchor + "\n  private volatile boolean hazardLightsEnabled = false;", 1)

method_anchor = "\n".join([
    "  public void sendLightIntensity(float frontPercent, float backPercent) {",
    "    int front = (int) (frontPercent * 255.f);",
    "    int back = (int) (backPercent * 255.f);",
    '    sendStringToDevice(String.format(Locale.US, "l%d,%d\\n", front, back));',
    "  }",
])
methods = method_anchor + "\n" + "\n".join([
    "",
    "  /** Custom browser command: set MG995 phone-pan angle. */",
    "  public void setPhoneServoAngle(int angle) {",
    "    int safeAngle = Math.max(20, Math.min(160, angle));",
    '    sendStringToDevice(String.format(Locale.US, "p%d\\n", safeAngle));',
    "  }",
    "",
    "  public void setMotorTuning(int maxPwm, int minStartPwm, int sensitivity, int timeoutMs) {",
    "    int safeMax = Math.max(50, Math.min(255, maxPwm));",
    "    int safeMin = Math.max(0, Math.min(100, minStartPwm));",
    "    if (safeMin >= safeMax) safeMin = safeMax - 1;",
    "    int safeSensitivity = Math.max(50, Math.min(200, sensitivity));",
    "    int safeTimeout = Math.max(1000, Math.min(10000, timeoutMs));",
    '    sendStringToDevice(String.format(Locale.US, "m%d,%d,%d,%d\\n", safeMax, safeMin, safeSensitivity, safeTimeout));',
    "  }",
    "",
    '  public void requestMotorTuningStatus() { sendStringToDevice("q\\n"); }',
    "",
    "  public void setAccessoryLights(boolean front, boolean rear) {",
    '    sendStringToDevice(String.format(Locale.US, "l%d,%d\\n", front ? 255 : 0, rear ? 255 : 0));',
    "  }",
    "",
    "  public void setHazardLights(boolean enabled) {",
    "    hazardLightsEnabled = enabled;",
    '    sendStringToDevice(enabled ? "i1,1\\n" : "i0,0\\n");',
    "  }",
    "",
    "  public boolean isHazardLightsEnabled() { return hazardLightsEnabled; }",
])
if 'setPhoneServoAngle(int angle)' not in vehicle:
    if method_anchor not in vehicle:
        sys.exit("Vehicle light method anchor not found; backups are present, patch manually.")
    vehicle = vehicle.replace(method_anchor, methods, 1)

# Route browser accessory events in the existing Robot event switch to USB serial.
case_anchor = "        case Constants.CMD_CONNECTED:"
case_block = "\n".join([
    '        case "MOTOR_TUNING":',
    '          vehicle.setMotorTuning(event.optInt("maxPwm", 180), event.optInt("minStartPwm", 0), event.optInt("sensitivity", 100), event.optInt("timeoutMs", 2000));',
    '          break;',
    '        case "SERVO_ANGLE":',
    '          int safeServoAngle = Math.max(20, Math.min(160, event.optInt("angle", 90)));',
    '          vehicle.setPhoneServoAngle(safeServoAngle);',
    '          BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("SERVO_ANGLE", String.valueOf(safeServoAngle)));',
    '          break;',
    '        case "LIGHTS":',
    '          boolean frontLightOn = event.optBoolean("front", false);',
    '          boolean rearLightOn = event.optBoolean("rear", false);',
    '          vehicle.setAccessoryLights(frontLightOn, rearLightOn);',
    '          BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("LIGHTS", (frontLightOn ? "1" : "0") + "," + (rearLightOn ? "1" : "0")));',
    '          break;',
    '        case "HAZARD":',
    '          boolean hazardOn = event.optBoolean("enabled", false);',
    '          vehicle.setHazardLights(hazardOn);',
    '          BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("HAZARD", hazardOn));',
    '          break;',
    '        case "HAZARD_TOGGLE":',
    '          boolean hazardNext = !vehicle.isHazardLightsEnabled();',
    '          vehicle.setHazardLights(hazardNext);',
    '          BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus("HAZARD", hazardNext));',
    '          break;',
    '',
]) + "\n"
if 'case "SERVO_ANGLE"' not in controls:
    if case_anchor not in controls:
        sys.exit("ControlsFragment command switch anchor not found; backups are present, patch manually.")
    controls = controls.replace(case_anchor, case_block + case_anchor, 1)

# Configure ESP32 tuning and mirror its current values back to the browser controller.
controls = controls.replace("        case Constants.CMD_CONNECTED:\n          sendConnectedStatus();", "        case Constants.CMD_CONNECTED:\n          vehicle.requestMotorTuningStatus();\n          sendConnectedStatus();", 1)
serial_anchor = "                case 'v':\n                  if (FormatUtils.isNumeric(body)) {"
serial_add = "                case 'M':\n                  String[] tuneParts = body.split(\",\");\n                  if (tuneParts.length == 4 && FormatUtils.isNumeric(tuneParts[0])\n                      && FormatUtils.isNumeric(tuneParts[1]) && FormatUtils.isNumeric(tuneParts[2])\n                      && FormatUtils.isNumeric(tuneParts[3])) {\n                    BotToControllerEventBus.emitEvent(ConnectionUtils.createStatus(\"MOTOR_TUNING\", body));\n                  }\n                  return;\n                case 'v':\n                  if (FormatUtils.isNumeric(body)) {"
if "case 'M':" not in controls and serial_anchor in controls:
    controls = controls.replace(serial_anchor, serial_add, 1)

# MOTOR_TUNING is an extension command and is not a stock Constants entry. Dispatch it explicitly before the existing switch.
route_anchor = "      if (!ensureVehicleForCommand(commandType)) {\n        return;\n      }\n\n      switch (commandType) {"
route_replacement = "      if (!ensureVehicleForCommand(commandType)) {\n        return;\n      }\n\n      if (\"MOTOR_TUNING\".equals(commandType)) {\n        vehicle.setMotorTuning(event.optInt(\"maxPwm\", 180), event.optInt(\"minStartPwm\", 0), event.optInt(\"sensitivity\", 100), event.optInt(\"timeoutMs\", 2000));\n        return;\n      }\n\n      switch (commandType) {"
if 'MOTOR_TUNING.equals(commandType)' not in controls and route_anchor in controls:
    controls = controls.replace(route_anchor, route_replacement, 1)

# Send Firebase ID token with the Robot's WebSocket room join, so a public relay can verify identity.
if 'room.put("authToken"' not in phone:
    replacement_lines = [
        "  private void sendRoomId(WebSocket socket) {",
        "    final com.google.firebase.auth.FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();",
        "    if (socket == null || user == null || user.getEmail() == null) {",
        '      Timber.w("Cannot join web room: WebSocket or Firebase user is missing");',
        "      return;",
        "    }",
        "    user.getIdToken(false).addOnCompleteListener(task -> {",
        "      if (!task.isSuccessful() || task.getResult() == null) {",
        '        Timber.e(task.getException(), "Cannot obtain Firebase ID token for WebSocket join");',
        "        return;",
        "      }",
        "      try {",
        "        JSONObject room = new JSONObject();",
        '        room.put("roomId", user.getEmail());',
        '        room.put("clientType", "robot");',
        '        room.put("authToken", task.getResult().getToken());',
        "        socket.send(room.toString());",
        '        Timber.d("Sent authenticated web room join");',
        "      } catch (JSONException e) {",
        '        Timber.e(e, "Failed to send web roomId");',
        "      }",
        "    });",
        "  }",
        "",
        "  public void disconnect() {",
    ]
    replacement = "\n".join(replacement_lines)
    pattern = r"  private void sendRoomId\(WebSocket socket\) \{.*?\n  \}\s*\n  public void disconnect\(\) \{"
    phone, count = re.subn(pattern, replacement, phone, count=1, flags=re.S)
    if count != 1:
        sys.exit("PhoneController.sendRoomId method anchor not found; backups are present, patch manually.")

# The upstream PhoneController used to emit CONNECTED immediately on WebSocket
# open, before a browser peer had joined. In a remote room this can cause the
# first WebRTC offer to be dropped. The secured relay now emits CONNECTED once
# both authenticated room members are online.
open_connected_event = r'        ControllerToBotEventBus.emitEvent("{command: \"CONNECTED\"}");'
if open_connected_event in phone:
    phone = phone.replace(open_connected_event, "        // Wait for the signaling server's CONNECTED event after the browser joins.", 1)

vehicle_path.write_text(vehicle, encoding="utf-8")
controls_path.write_text(controls, encoding="utf-8")
phone_path.write_text(phone, encoding="utf-8")
print("Patched Vehicle.java, ControlsFragment.java and PhoneController.java. Backups created beside originals.")

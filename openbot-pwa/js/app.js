"use strict";
const $ = (id) => document.getElementById(id);
let transport = null,
    rxBuf = "",
    videoStream = null,
    model = null,
    detectLoop = false,
    tracking = false,
    roam = false,
    rx = 0,
    lastInference = 0,
    selectedTarget = null,
    joyActive = false,
    joyRect = null;
const encoder = new TextEncoder();
function log(msg) {
    const el = $("log");
    const stamp = new Date().toLocaleTimeString();
    el.textContent += `\n[${stamp}] ${msg}`;
    el.scrollTop = el.scrollHeight;
    const lines = el.textContent.split("\n");
    if (lines.length > 120) el.textContent = lines.slice(-100).join("\n");
}
function setConnected(on) {
    $("usbDot").classList.toggle("on", on);
    $("usbStatus").textContent = on ? "USB connected" : "USB disconnected";
    $("linkVal").textContent = on ? "ONLINE" : "OFFLINE";
    $("appStatus").textContent = on ? "CONNECTED" : "READY";
    $("connectBtn").disabled = on;
    $("disconnectBtn").disabled = !on;
    $("pingBtn").disabled = !on;
    $("sendTestBtn").disabled = !on;
}
const decoder = new TextDecoder();
function onUsbData(bytes) {
    rxBuf += decoder.decode(bytes, { stream: true });
    let idx;
    while ((idx = rxBuf.indexOf("\n")) >= 0) {
        const line = rxBuf.slice(0, idx).trim();
        rxBuf = rxBuf.slice(idx + 1);
        if (line) handleLine(line);
    }
    if (rxBuf.length > 2048) rxBuf = "";
}
async function connectUSB() {
    if (transport) return;
    const candidates = window.UsbTransport ? UsbTransport.createTransports() : [];
    if (!candidates.length) {
        const msg = !window.isSecureContext
            ? "USB needs HTTPS (or localhost). Open the deployed https:// URL in Chrome."
            : "Neither Web Serial nor WebUSB is available. Use Chrome (not Firefox/Samsung Internet/in-app browser) on Android.";
        log("Connect failed: " + msg);
        alert(msg);
        return;
    }
    let lastErr = null;
    for (const t of candidates) {
        try {
            log("Trying " + t.kind + "…");
            await t.pick();
            t.onData = onUsbData;
            t.onClose = (err) => {
                if (transport === t) {
                    log("USB link lost" + (err ? ": " + err.message : ""));
                    disconnectUSB();
                }
            };
            rxBuf = "";
            await t.open(115200);
            transport = t;
            setConnected(true);
            log(t.kind + " opened at 115200 baud");
            await send("h");
            return;
        } catch (e) {
            lastErr = e;
            try { await t.close(); } catch { }
            if (e && e.name === "NotFoundError") {
                log("No device selected");
                return; // user cancelled the chooser
            }
            log(t.kind + " failed: " + e.message);
        }
    }
    const hint =
        " Check: USB-C cable carries data, board is powered, phone is in USB host (OTG) mode, and no other app (Arduino, Serial Monitor) holds the port.";
    log("Connect failed: " + (lastErr && lastErr.message));
    alert("USB connection failed: " + (lastErr && lastErr.message) + hint);
}
function handleLine(line) {
    rx++;
    $("rxCount").textContent = rx + " RX";
    log("RX " + line);
    const m = line.match(/(?:L|left)[=: ](-?\d+).*?(?:R|right)[=: ](-?\d+)/i);
    if (m) {
        $("leftVal").textContent = m[1];
        $("rightVal").textContent = m[2];
    }
}
async function send(s) {
    if (!transport) {
        log("TX skipped: USB not connected");
        return false;
    }
    try {
        await transport.write(encoder.encode(s + "\n"));
        log("TX " + s);
        return true;
    } catch (e) {
        log("TX error: " + e.message);
        return false;
    }
}
async function disconnectUSB() {
    const t = transport;
    tracking = false;
    roam = false;
    try { await send("h"); } catch { }
    transport = null;
    try { await t?.close(); } catch { }
    setConnected(false);
    $("driveState").textContent = "STOPPED";
    log("USB disconnected");
}
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
let lastDrive = 0;
function drive(left, right) {
    const max = Number($("speed").value);
    left = Math.round(clamp(left, -max, max));
    right = Math.round(clamp(right, -max, max));
    $("leftVal").textContent = left;
    $("rightVal").textContent = right;
    $("driveState").textContent = left || right ? "MOVING" : "STOPPED";
    const now = performance.now();
    if (now - lastDrive > 60) {
        lastDrive = now;
        send(`c${left},${right}`);
    }
}
function stopDrive() {
    drive(0, 0);
    send("h").catch(() => { });
    $("driveState").textContent = "STOPPED";
}
function manual(dir) {
    const s = Number($("speed").value);
    ({
        forward: () => drive(s, s),
        reverse: () => drive(-s, -s),
        left: () => drive(-Math.round(s * 0.65), Math.round(s * 0.65)),
        right: () => drive(Math.round(s * 0.65), -Math.round(s * 0.65)),
        stop: stopDrive,
    })[dir]?.();
}
const joy = $("joystick"),
    stick = $("stick");
function joyMove(e) {
    if (!joyActive) return;
    const r = joy.getBoundingClientRect(),
        cx = r.left + r.width / 2,
        cy = r.top + r.height / 2,
        max = r.width * 0.34;
    let dx = e.clientX - cx,
        dy = e.clientY - cy;
    const mag = Math.hypot(dx, dy);
    if (mag > max) {
        dx = (dx / mag) * max;
        dy = (dy / mag) * max;
    }
    stick.style.transform = `translate(${dx}px,${dy}px)`;
    const throttle = clamp(-dy / max, -1, 1),
        turn = clamp(dx / max, -1, 1),
        s = Number($("speed").value);
    drive((throttle + turn) * s, (throttle - turn) * s);
}
joy.addEventListener("pointerdown", (e) => {
    joyActive = true;
    joy.setPointerCapture(e.pointerId);
    joyMove(e);
});
joy.addEventListener("pointermove", joyMove);
function joyEnd() {
    joyActive = false;
    stick.style.transform = "translate(0,0)";
    stopDrive();
}
joy.addEventListener("pointerup", joyEnd);
joy.addEventListener("pointercancel", joyEnd);
window.addEventListener("blur", () => {
    if (joyActive) joyEnd();
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopDrive();
});
async function startCamera() {
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 640 },
                height: { ideal: 480 },
            },
            audio: false,
        });
        $("video").srcObject = videoStream;
        $("cameraPlaceholder").style.display = "none";
        $("cameraBtn").textContent = "Stop camera";
        $("visionStatus").textContent = "CAMERA ON";
        log("Camera started locally");
        if (model) startDetection();
    } catch (e) {
        alert("Camera unavailable: " + e.message);
        log("Camera error: " + e.message);
    }
}
function stopCamera() {
    detectLoop = false;
    videoStream?.getTracks().forEach((t) => t.stop());
    videoStream = null;
    $("video").srcObject = null;
    $("cameraPlaceholder").style.display = "grid";
    $("cameraBtn").textContent = "Start camera";
    $("visionStatus").textContent = "OFF";
    $("overlay")
        .getContext("2d")
        .clearRect(0, 0, $("overlay").width, $("overlay").height);
    if (roam) {
        roam = false;
        updateModes();
        stopDrive();
    }
}
async function loadModel() {
    try {
        if (!window.cocoSsd || !window.tf)
            throw new Error(
                "ML libraries did not load. Connect to internet and reload.",
            );
        $("modelState").textContent = "Loading…";
        await tf.ready();
        model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
        $("modelState").textContent = "COCO-SSD ready";
        log("COCO-SSD model loaded; inference runs in browser");
        if (videoStream) startDetection();
    } catch (e) {
        $("modelState").textContent = "Load failed";
        log("Model error: " + e.message);
        alert("Could not load object model: " + e.message);
    }
}
function startDetection() {
    if (detectLoop || !model || !videoStream) return;
    detectLoop = true;
    let frames = 0,
        lastFps = performance.now();
    const loop = async () => {
        if (!detectLoop || !videoStream) return;
        const v = $("video");
        if (v.readyState >= 2) {
            try {
                const preds = await model.detect(v);
                drawPredictions(preds, v.videoWidth, v.videoHeight);
                $("objectCount").textContent = preds.length;
                $("detections").textContent =
                    preds
                        .slice(0, 6)
                        .map((p) => `${p.class} ${Math.round(p.score * 100)}%`)
                        .join(" · ") || "No objects detected";
                frames++;
                const now = performance.now();
                if (now - lastFps >= 1000) {
                    $("fps").textContent =
                        Math.round((frames * 1000) / (now - lastFps)) + " FPS";
                    frames = 0;
                    lastFps = now;
                }
                if (tracking && preds.length) {
                    selectedTarget = preds.sort((a, b) => b.score - a.score)[0];
                    $("detections").textContent =
                        "Target: " +
                        selectedTarget.class +
                        " " +
                        Math.round(selectedTarget.score * 100) +
                        "%";
                }
                if (roam) {
          /* Safe-by-default: generic detections do not prove free space. No autonomous motor command is issued. */ $(
                    "roamToggle",
                ).textContent = "ARM NEEDED";
                }
            } catch (e) {
                log("Inference error: " + e.message);
            }
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}
function drawPredictions(preds, w, h) {
    const c = $("overlay"),
        v = $("video");
    if (!w || !h) return;
    const rect = v.getBoundingClientRect();
    if (
        c.width !== rect.width * devicePixelRatio ||
        c.height !== rect.height * devicePixelRatio
    ) {
        c.width = rect.width * devicePixelRatio;
        c.height = rect.height * devicePixelRatio;
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = Math.max(2, w / 320);
    ctx.font = `${Math.max(13, w / 32)}px system-ui`;
    preds.forEach((p) => {
        const [x, y, bw, bh] = p.bbox;
        ctx.strokeStyle = "#53e0b2";
        ctx.strokeRect(x, y, bw, bh);
        ctx.fillStyle = "#53e0b2";
        const label = `${p.class} ${Math.round(p.score * 100)}%`;
        ctx.fillRect(x, y - 22, ctx.measureText(label).width + 10, 22);
        ctx.fillStyle = "#06111b";
        ctx.fillText(label, x + 5, y - 6);
    });
}
function updateModes() {
    $("trackingToggle").textContent = tracking ? "ON" : "OFF";
    $("trackingBtn").style.borderColor = tracking ? "#53e0b2" : "var(--line)";
    $("roamToggle").textContent = roam ? "SAFE DEMO" : "OFF";
    $("roamBtn").style.borderColor = roam ? "#53e0b2" : "var(--line)";
}
$("connectBtn").addEventListener("click", connectUSB);
$("disconnectBtn").addEventListener("click", disconnectUSB);
$("cameraBtn").addEventListener("click", () =>
    videoStream ? stopCamera() : startCamera(),
);
$("modelBtn").addEventListener("click", loadModel);
$("speed").addEventListener(
    "input",
    (e) => ($("speedLabel").textContent = e.target.value + " / 255"),
);
document.querySelectorAll("[data-drive]").forEach((b) => {
    b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        manual(b.dataset.drive);
    });
    if (b.dataset.drive !== "stop") b.addEventListener("pointerup", stopDrive);
    b.addEventListener("pointerleave", () => {
        if (b.dataset.drive !== "stop") stopDrive();
    });
});
$("estopBtn").addEventListener("click", () => {
    tracking = false;
    roam = false;
    updateModes();
    stopDrive();
    send("h");
    log("EMERGENCY STOP requested");
});
$("trackingBtn").addEventListener("click", () => {
    if (!model) {
        alert("Load the object model first.");
        return;
    }
    tracking = !tracking;
    updateModes();
    log(
        "Object tracking " +
        (tracking ? "enabled for visual target selection" : "disabled") +
        "; no automatic motor movement is enabled",
    );
});
$("roamBtn").addEventListener("click", () => {
    if (!model || !videoStream) {
        alert("Start camera and load the object model first.");
        return;
    }
    roam = !roam;
    updateModes();
    if (roam) {
        stopDrive();
        log(
            "Free-roam demo enabled in observation-only safe mode. Autonomous driving remains disabled until a validated obstacle sensor/planner is configured.",
        );
    } else {
        stopDrive();
        log("Free-roam demo disabled");
    }
});
$("pingBtn").addEventListener("click", () => send("f"));
$("sendTestBtn").addEventListener("click", async () => {
    if (
        !confirm(
            "Raise the wheels off the ground. Run a brief low-speed motor test?",
        )
    )
        return;
    drive(65, 65);
    setTimeout(stopDrive, 350);
});
$("clearLogBtn").addEventListener(
    "click",
    () => ($("log").textContent = "Log cleared."),
);
if ("serviceWorker" in navigator && location.protocol.startsWith("http"))
    navigator.serviceWorker
        .register("./sw.js")
        .catch((e) => log("Service worker: " + e.message));
window.addEventListener("beforeunload", () => {
    try {
        send("h");
    } catch { }
    stopCamera();
});

"use strict";
/*
 * USB transport for ESP32 boards.
 * 1) Web Serial (navigator.serial) when the browser provides it.
 * 2) WebUSB fallback (navigator.usb) - works on Chrome for Android, where Web Serial
 *    is missing on many builds. Supports:
 *      - CDC-ACM  (ESP32-S3/C3 native USB: VID 0x303A, plus any generic CDC device)
 *      - CP210x   (Silicon Labs CP2102 - many ESP32 DevKit "UART" USB-C ports)
 *      - CH34x    (WCH CH340/CH341 - many clone boards)
 * Both transports expose: open(baud), write(Uint8Array), onData, onClose, close().
 */
const USB_FILTERS = [
    { vendorId: 0x303a }, // Espressif native USB (USB-Serial/JTAG, TinyUSB CDC)
    { vendorId: 0x10c4 }, // Silicon Labs CP210x
    { vendorId: 0x1a86 }, // WCH CH340/CH341/CH9102
    { vendorId: 0x0403 }, // FTDI (not supported by WebUSB driver here, listed for clear error)
];

class WebSerialTransport {
    constructor() {
        this.kind = "Web Serial";
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.onData = () => { };
        this.onClose = () => { };
        this._closing = false;
    }
    static supported() {
        return "serial" in navigator;
    }
    async pick() {
        this.port = await navigator.serial.requestPort({
            filters: USB_FILTERS.filter((f) => f.vendorId !== 0x0403),
        });
    }
    async open(baud) {
        await this.port.open({ baudRate: baud });
        // Native ESP32-S3 USB-Serial/JTAG needs DTR asserted to stream data.
        // RTS stays low so the chip is not held in reset.
        try {
            await this.port.setSignals({ dataTerminalReady: true, requestToSend: false });
        } catch { }
        this.writer = this.port.writable.getWriter();
        this.reader = this.port.readable.getReader();
        this._readLoop();
    }
    async _readLoop() {
        try {
            while (this.reader) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) this.onData(value);
            }
        } catch (e) {
            if (!this._closing) this.onClose(e);
            return;
        } finally {
            try { this.reader?.releaseLock(); } catch { }
            this.reader = null;
        }
        if (!this._closing) this.onClose();
    }
    async write(bytes) {
        await this.writer.write(bytes);
    }
    async close() {
        this._closing = true;
        try { await this.reader?.cancel(); } catch { }
        try { this.writer?.releaseLock(); } catch { }
        try { await this.port?.close(); } catch { }
        this.port = this.reader = this.writer = null;
    }
}

class WebUSBTransport {
    constructor() {
        this.kind = "WebUSB";
        this.dev = null;
        this.mode = null; // "cdc" | "cp210x" | "ch34x"
        this.iface = null;
        this.epIn = null;
        this.epOut = null;
        this.ctrlIface = 0;
        this.onData = () => { };
        this.onClose = () => { };
        this._closing = false;
        this._onDisc = null;
    }
    static supported() {
        return "usb" in navigator;
    }
    async pick() {
        this.dev = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    }
    _findBulk(cfg, wantClass) {
        for (const i of cfg.interfaces) {
            for (const a of i.alternates) {
                if (wantClass !== undefined && a.interfaceClass !== wantClass) continue;
                const inEp = a.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
                const outEp = a.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
                if (inEp && outEp)
                    return { num: i.interfaceNumber, alt: a.alternateSetting, inEp, outEp };
            }
        }
        return null;
    }
    async open(baud) {
        const d = this.dev;
        await d.open();
        if (d.configuration === null) await d.selectConfiguration(1);
        const cfg = d.configuration;
        const vid = d.vendorId;
        let found = null;
        if (vid === 0x10c4) {
            this.mode = "cp210x";
            found = this._findBulk(cfg);
        } else if (vid === 0x1a86) {
            this.mode = "ch34x";
            found = this._findBulk(cfg);
        } else if (vid === 0x0403) {
            throw new Error("FTDI chips are not supported over WebUSB in this app.");
        } else {
            this.mode = "cdc";
            found = this._findBulk(cfg, 0x0a); // CDC Data class
            // CDC comm interface (class 2) is used for line control
            for (const i of cfg.interfaces) {
                if (i.alternates.some((a) => a.interfaceClass === 0x02)) this.ctrlIface = i.interfaceNumber;
            }
        }
        if (!found) throw new Error("No bulk serial endpoints found on this USB device.");
        this.iface = found.num;
        this.epIn = found.inEp.endpointNumber;
        this.epOut = found.outEp.endpointNumber;
        this.inSize = found.inEp.packetSize || 64;

        if (this.mode === "cdc" && this.ctrlIface !== this.iface) {
            try { await d.claimInterface(this.ctrlIface); } catch { }
        }
        await d.claimInterface(this.iface);
        if (found.alt) await d.selectAlternateInterface(this.iface, found.alt);

        await this._configure(baud);

        this._onDisc = (ev) => {
            if (ev.device === this.dev && !this._closing) this.onClose();
        };
        navigator.usb.addEventListener("disconnect", this._onDisc);
        this._readLoop();
    }
    _ctl(requestType, recipient, request, value, index, data) {
        const setup = { requestType, recipient, request, value, index };
        return data
            ? this.dev.controlTransferOut(setup, data)
            : this.dev.controlTransferOut(setup);
    }
    async _configure(baud) {
        if (this.mode === "cdc") {
            // SET_LINE_CODING: baud, 1 stop bit, no parity, 8 data bits
            const lc = new ArrayBuffer(7);
            const v = new DataView(lc);
            v.setUint32(0, baud, true);
            v.setUint8(4, 0);
            v.setUint8(5, 0);
            v.setUint8(6, 8);
            try { await this._ctl("class", "interface", 0x20, 0, this.ctrlIface, lc); } catch { }
            // SET_CONTROL_LINE_STATE: DTR=1, RTS=0 (required by ESP32 USB-Serial/JTAG)
            try { await this._ctl("class", "interface", 0x22, 0x0001, this.ctrlIface); } catch { }
        } else if (this.mode === "cp210x") {
            await this._ctl("vendor", "interface", 0x00, 0x0001, this.iface); // IFC_ENABLE
            const b = new ArrayBuffer(4);
            new DataView(b).setUint32(0, baud, true);
            await this._ctl("vendor", "interface", 0x1e, 0, this.iface, b); // SET_BAUDRATE
            await this._ctl("vendor", "interface", 0x03, 0x0800, this.iface); // 8N1
            await this._ctl("vendor", "interface", 0x07, 0x0101, this.iface); // DTR=1 (RTS untouched)
        } else if (this.mode === "ch34x") {
            await this._ctl("vendor", "device", 0xa1, 0xc29c, 0xb2b9); // init
            // Baud divisor: CH34x uses 12 MHz base clock
            const factor = 1532620800;
            let divisor = 3;
            let div = factor / baud;
            while (div > 0xfff0 && divisor > 0) {
                div /= 256;
                divisor--;
            }
            div = 0x10000 - Math.round(div);
            const a = (div & 0xff00) | divisor | 0x80;
            const b = div & 0xff;
            await this._ctl("vendor", "device", 0x9a, 0x1312, a);
            await this._ctl("vendor", "device", 0x9a, 0x0f2c, b);
            await this._ctl("vendor", "device", 0x9a, 0x2518, 0x00c3); // 8N1, enable TX/RX
            await this._ctl("vendor", "device", 0xa4, 0xffff ^ 0x20, 0); // DTR=1
        }
    }
    async _readLoop() {
        try {
            while (this.dev && this.dev.opened && !this._closing) {
                const r = await this.dev.transferIn(this.epIn, Math.max(this.inSize, 64));
                if (r.status === "stall") {
                    await this.dev.clearHalt("in", this.epIn);
                    continue;
                }
                if (r.data && r.data.byteLength) {
                    let u8 = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
                    // CP210x/CDC deliver raw bytes. CH34x also delivers raw bytes.
                    this.onData(u8);
                }
            }
        } catch (e) {
            if (!this._closing) this.onClose(e);
        }
    }
    async write(bytes) {
        const r = await this.dev.transferOut(this.epOut, bytes);
        if (r.status !== "ok") throw new Error("USB write status: " + r.status);
    }
    async close() {
        this._closing = true;
        if (this._onDisc) navigator.usb.removeEventListener("disconnect", this._onDisc);
        try { await this.dev?.releaseInterface(this.iface); } catch { }
        try { await this.dev?.close(); } catch { }
        this.dev = null;
    }
}

/* Pick the best available transport. Web Serial is preferred; WebUSB is the Android fallback. */
function createTransports() {
    const list = [];
    if (WebSerialTransport.supported()) list.push(new WebSerialTransport());
    if (WebUSBTransport.supported()) list.push(new WebUSBTransport());
    return list;
}

window.UsbTransport = {
    WebSerialTransport,
    WebUSBTransport,
    createTransports,
    USB_FILTERS,
};

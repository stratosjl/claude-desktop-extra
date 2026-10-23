// __CDB_KDE_GS_REBIND__
// Quick Entry hotkey on KDE Plasma 6.7.4+: re-arm the portal binding on every
// launch (upstream Chromium 152 skips BindShortcuts when its ids are already
// listed; xdg-desktop-portal-kde 6.7.4+ no longer arms listed shortcuts at
// CreateSession, so the hotkey is dead after the first restart, #281).
//
// This module opens a second GlobalShortcuts portal session from the main
// process (same app id as Chromium's own session), lists the shortcuts KDE
// stores for the app and binds exactly those ids. KDE arms a session's
// returning ids silently (no dialog) and delivers Activated to every session
// of the app, so Chromium's listener fires as on the first launch. The session
// lives as long as the app registers a global shortcut.
//
// Trigger: the electron.globalShortcut register/unregister calls, hooked here.
// Gates: Linux, Wayland session (not an XWayland launch), XDG_CURRENT_DESKTOP
// contains KDE, KWin >= 6.4 (older Plasma opens System Settings on
// BindShortcuts), Chromium < 159
// (Chromium main binds per session since 2026-10-15), CDB_KDE_GS_REBIND != 0.
// Transport: a minimal D-Bus client over the session bus socket (the bundle
// ships no D-Bus library). Diagnostics: "[quick-entry] kde-rebind:" lines in
// claude-patches.log.
(function () {
  "use strict";
  if (globalThis.__cdbKdeGsRebind) return;
  var net = require("net");
  var os = require("os");
  var cp = require("child_process");

  function log(m) {
    try { (globalThis.__cdbDiag || console.log)("[quick-entry] kde-rebind: " + m); } catch (e) {}
  }

  // ---------------------------------------------------------------- D-Bus
  var TYPE = { CALL: 1, RETURN: 2, ERROR: 3, SIGNAL: 4 };
  var ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1 };

  function parseAddress(addr) {
    var parts = String(addr || "").split(";");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf("unix:") !== 0) continue;
      var kv = {};
      var items = parts[i].slice(5).split(",");
      for (var j = 0; j < items.length; j++) {
        var eq = items[j].indexOf("=");
        if (eq > 0) kv[items[j].slice(0, eq)] = decodeURIComponent(items[j].slice(eq + 1));
      }
      if (kv.path) return kv.path;
      if (kv.abstract) return "\0" + kv.abstract;
    }
    return null;
  }

  // Signature string -> type tree. one=true parses a single complete type.
  function parseSig(sig, pos, stop, one) {
    var out = [];
    while (pos < sig.length) {
      var c = sig[pos];
      if (stop && c === stop) return [out, pos + 1];
      if (c === "a") {
        var sub = parseSig(sig, pos + 1, null, true);
        out.push({ t: "a", e: sub[0][0] });
        pos = sub[1];
      } else if (c === "(") {
        var st = parseSig(sig, pos + 1, ")", false);
        out.push({ t: "(", f: st[0] });
        pos = st[1];
      } else if (c === "{") {
        var de = parseSig(sig, pos + 1, "}", false);
        out.push({ t: "{", f: de[0] });
        pos = de[1];
      } else {
        out.push({ t: c });
        pos += 1;
      }
      if (one) return [out, pos];
    }
    return [out, pos];
  }
  function sigNodes(sig) { return parseSig(sig, 0, null, false)[0]; }

  function Writer() { this.buf = Buffer.alloc(1024); this.len = 0; }
  Writer.prototype.ensure = function (n) {
    while (this.len + n > this.buf.length) { var b = Buffer.alloc(this.buf.length * 2); this.buf.copy(b); this.buf = b; }
  };
  Writer.prototype.align = function (a) {
    var pad = (a - (this.len % a)) % a; this.ensure(pad); this.buf.fill(0, this.len, this.len + pad); this.len += pad;
  };
  Writer.prototype.u8 = function (v) { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.len); this.len += 1; };
  Writer.prototype.u16 = function (v) { this.align(2); this.ensure(2); this.buf.writeUInt16LE(v & 0xffff, this.len); this.len += 2; };
  Writer.prototype.u32 = function (v) { this.align(4); this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; };
  Writer.prototype.i32 = function (v) { this.align(4); this.ensure(4); this.buf.writeInt32LE(v | 0, this.len); this.len += 4; };
  Writer.prototype.u64 = function (v) { this.align(8); this.ensure(8); this.buf.writeBigUInt64LE(BigInt(v), this.len); this.len += 8; };
  Writer.prototype.i64 = function (v) { this.align(8); this.ensure(8); this.buf.writeBigInt64LE(BigInt(v), this.len); this.len += 8; };
  Writer.prototype.f64 = function (v) { this.align(8); this.ensure(8); this.buf.writeDoubleLE(v, this.len); this.len += 8; };
  Writer.prototype.str = function (v) {
    var b = Buffer.from(String(v), "utf8"); this.u32(b.length); this.ensure(b.length + 1); b.copy(this.buf, this.len); this.len += b.length; this.u8(0);
  };
  Writer.prototype.sig = function (v) {
    var b = Buffer.from(String(v), "ascii"); this.u8(b.length); this.ensure(b.length + 1); b.copy(this.buf, this.len); this.len += b.length; this.u8(0);
  };
  Writer.prototype.value = function (node, v) {
    switch (node.t) {
      case "y": return this.u8(v);
      case "b": return this.u32(v ? 1 : 0);
      case "n": case "q": return this.u16(v);
      case "i": return this.i32(v);
      case "u": return this.u32(v);
      case "x": return this.i64(v);
      case "t": return this.u64(v);
      case "d": return this.f64(v);
      case "s": case "o": return this.str(v);
      case "g": return this.sig(v);
      case "v": // [signature, value]
        this.sig(v[0]); return this.value(sigNodes(v[0])[0], v[1]);
      case "a": {
        this.u32(0);
        var lenPos = this.len - 4;
        this.align(ALIGN[node.e.t]);
        var start = this.len;
        if (node.e.t === "{") {
          var keys = Object.keys(v);
          for (var k = 0; k < keys.length; k++) this.value(node.e, [keys[k], v[keys[k]]]);
        } else {
          for (var i = 0; i < v.length; i++) this.value(node.e, v[i]);
        }
        this.buf.writeUInt32LE(this.len - start, lenPos);
        return;
      }
      case "(": case "{": {
        this.align(8);
        for (var f = 0; f < node.f.length; f++) this.value(node.f[f], v[f]);
        return;
      }
      default: throw new Error("unsupported D-Bus type " + node.t);
    }
  };
  Writer.prototype.bytes = function () { return this.buf.subarray(0, this.len); };

  function Reader(buf, pos) { this.buf = buf; this.pos = pos || 0; }
  Reader.prototype.align = function (a) { this.pos = (this.pos + a - 1) & ~(a - 1); };
  Reader.prototype.u8 = function () { return this.buf.readUInt8(this.pos++); };
  Reader.prototype.u16 = function () { this.align(2); var v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; };
  Reader.prototype.u32 = function () { this.align(4); var v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; };
  Reader.prototype.i32 = function () { this.align(4); var v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; };
  Reader.prototype.u64 = function () { this.align(8); var v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; };
  Reader.prototype.i64 = function () { this.align(8); var v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; };
  Reader.prototype.f64 = function () { this.align(8); var v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; };
  Reader.prototype.str = function () { var n = this.u32(); var v = this.buf.toString("utf8", this.pos, this.pos + n); this.pos += n + 1; return v; };
  Reader.prototype.sig = function () { var n = this.u8(); var v = this.buf.toString("ascii", this.pos, this.pos + n); this.pos += n + 1; return v; };
  Reader.prototype.value = function (node) {
    switch (node.t) {
      case "y": return this.u8();
      case "b": return this.u32() !== 0;
      case "n": { var sv = this.u16(); return sv > 0x7fff ? sv - 0x10000 : sv; }
      case "q": return this.u16();
      case "i": return this.i32();
      case "u": return this.u32();
      case "x": return this.i64();
      case "t": return this.u64();
      case "d": return this.f64();
      case "s": case "o": return this.str();
      case "g": return this.sig();
      case "v": return this.value(sigNodes(this.sig())[0]);
      case "a": {
        var n = this.u32(); this.align(ALIGN[node.e.t]); var end = this.pos + n;
        if (node.e.t === "{") {
          var o = {};
          while (this.pos < end) { var kv = this.value(node.e); o[kv[0]] = kv[1]; }
          this.pos = end; return o;
        }
        var arr = [];
        while (this.pos < end) arr.push(this.value(node.e));
        this.pos = end; return arr;
      }
      case "(": case "{": {
        this.align(8);
        var r = [];
        for (var f = 0; f < node.f.length; f++) r.push(this.value(node.f[f]));
        return r;
      }
      default: throw new Error("unsupported D-Bus type " + node.t);
    }
  };

  var HEADER_FIELDS = { t: "a", e: { t: "(", f: [{ t: "y" }, { t: "v" }] } };
  function buildMessage(m) {
    var bw = new Writer();
    if (m.signature) { var nodes = sigNodes(m.signature); for (var i = 0; i < nodes.length; i++) bw.value(nodes[i], m.body[i]); }
    var body = bw.bytes();
    var fields = [];
    if (m.path) fields.push([1, ["o", m.path]]);
    if (m.iface) fields.push([2, ["s", m.iface]]);
    if (m.member) fields.push([3, ["s", m.member]]);
    if (m.errorName) fields.push([4, ["s", m.errorName]]);
    if (m.replySerial !== undefined) fields.push([5, ["u", m.replySerial]]);
    if (m.dest) fields.push([6, ["s", m.dest]]);
    if (m.signature) fields.push([8, ["g", m.signature]]);
    var hw = new Writer();
    hw.u8(108); hw.u8(m.type); hw.u8(0); hw.u8(1); // 'l', type, flags, version
    hw.u32(body.length); hw.u32(m.serial);
    hw.value(HEADER_FIELDS, fields);
    hw.align(8);
    return Buffer.concat([hw.bytes(), body]);
  }
  function parseMessage(buf, headerLen) {
    var r = new Reader(buf, 1);
    var type = r.u8();
    r.pos = 8; var serial = r.u32();
    r.pos = 12;
    var fields = r.value(HEADER_FIELDS);
    var h = {};
    for (var i = 0; i < fields.length; i++) h[fields[i][0]] = fields[i][1];
    var m = { type: type, serial: serial, path: h[1], iface: h[2], member: h[3], errorName: h[4], replySerial: h[5], dest: h[6], sender: h[7], signature: h[8] || "", body: [] };
    if (m.signature) {
      var br = new Reader(buf, headerLen);
      var nodes = sigNodes(m.signature);
      for (var n = 0; n < nodes.length; n++) m.body.push(br.value(nodes[n]));
    }
    return m;
  }

  function DBus() {
    this.address = process.env.DBUS_SESSION_BUS_ADDRESS || ("unix:path=" + (process.env.XDG_RUNTIME_DIR || "/run/user/" + os.userInfo().uid) + "/bus");
    this.serial = 1;
    this.pending = {};
    this.signalHandlers = [];
    this.rx = Buffer.alloc(0);
    this.uniqueName = null;
    this.sock = null;
    this.closed = false;
    this.onClose = null;
  }
  DBus.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var path = parseAddress(self.address);
      if (!path) return reject(new Error("no unix session bus address: " + self.address));
      var sock = net.createConnection({ path: path });
      self.sock = sock;
      var authed = false, authBuf = "", settled = false;
      function fail(e) { if (!settled) { settled = true; reject(e); } self._teardown(e); }
      sock.on("error", fail);
      sock.on("close", function () { self._teardown(new Error("bus connection closed")); });
      sock.once("connect", function () {
        var uidHex = Buffer.from(String(os.userInfo().uid), "ascii").toString("hex");
        sock.write("\0AUTH EXTERNAL " + uidHex + "\r\n");
      });
      sock.on("data", function (chunk) {
        if (authed) { self._onData(chunk); return; }
        authBuf += chunk.toString("latin1");
        var nl = authBuf.indexOf("\r\n");
        if (nl < 0) return;
        var line = authBuf.slice(0, nl);
        var rest = Buffer.from(authBuf.slice(nl + 2), "latin1");
        if (line.indexOf("OK ") !== 0) return fail(new Error("bus auth failed: " + line));
        authed = true;
        sock.write("BEGIN\r\n");
        if (rest.length) self._onData(rest);
        self.call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "Hello" })
          .then(function (r) { self.uniqueName = r.body[0]; settled = true; resolve(self.uniqueName); }, fail);
      });
    });
  };
  DBus.prototype._teardown = function (err) {
    if (this.closed) return;
    this.closed = true;
    var p = this.pending; this.pending = {};
    for (var k in p) p[k].reject(err || new Error("bus closed"));
    try { this.sock && this.sock.destroy(); } catch (e) {}
    if (this.onClose) { var cb = this.onClose; this.onClose = null; cb(err); }
  };
  DBus.prototype.close = function () { this.onClose = null; this._teardown(new Error("closed")); };
  DBus.prototype._onData = function (chunk) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    for (;;) {
      if (this.rx.length < 16) return;
      if (this.rx[0] !== 108) { this._teardown(new Error("big-endian bus peer")); return; }
      var bodyLen = this.rx.readUInt32LE(4);
      var fieldsLen = this.rx.readUInt32LE(12);
      var headerLen = (16 + fieldsLen + 7) & ~7;
      var total = headerLen + bodyLen;
      if (this.rx.length < total) return;
      var raw = this.rx.subarray(0, total);
      this.rx = this.rx.subarray(total);
      try { this._dispatch(parseMessage(raw, headerLen)); } catch (e) { log("message parse error: " + (e && e.message)); }
    }
  };
  DBus.prototype._dispatch = function (m) {
    if (m.type === TYPE.RETURN || m.type === TYPE.ERROR) {
      var p = this.pending[m.replySerial];
      if (!p) return;
      delete this.pending[m.replySerial];
      if (m.type === TYPE.ERROR) { var e = new Error(m.errorName + (m.body[0] ? ": " + m.body[0] : "")); e.dbusName = m.errorName; p.reject(e); }
      else p.resolve(m);
    } else if (m.type === TYPE.SIGNAL) {
      for (var i = 0; i < this.signalHandlers.length; i++) {
        try { this.signalHandlers[i](m); } catch (e2) { log("signal handler error: " + (e2 && e2.message)); }
      }
    }
  };
  DBus.prototype.call = function (m) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (self.closed) return reject(new Error("bus closed"));
      var serial = self.serial++;
      var data = buildMessage({ type: TYPE.CALL, serial: serial, path: m.path, iface: m.iface, member: m.member, dest: m.dest, signature: m.signature, body: m.body || [] });
      var timer = setTimeout(function () {
        if (self.pending[serial]) { delete self.pending[serial]; reject(new Error("timeout calling " + m.member)); }
      }, m.timeoutMs || 25000);
      self.pending[serial] = {
        resolve: function (r) { clearTimeout(timer); resolve(r); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      self.sock.write(data);
    });
  };
  DBus.prototype.onSignal = function (fn) { this.signalHandlers.push(fn); };
  DBus.prototype.addMatch = function (rule) {
    return this.call({ dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "AddMatch", signature: "s", body: [rule] });
  };

  // -------------------------------------------------------- portal session
  var PORTAL = "org.freedesktop.portal.Desktop";
  var PORTAL_PATH = "/org/freedesktop/portal/desktop";
  var GS_IFACE = "org.freedesktop.portal.GlobalShortcuts";
  var REQ_IFACE = "org.freedesktop.portal.Request";

  var tokenSeq = 0;
  function token(prefix) { return prefix + "_" + process.pid + "_" + (++tokenSeq) + "_" + Date.now().toString(36); }

  function PortalSession() {
    this.bus = null;
    this.sender = null;
    this.session = null;
    this.waiters = {};
    this.onShortcutsChanged = null;
    this.onClose = null;
  }
  PortalSession.prototype.requestPath = function (tok) {
    return PORTAL_PATH + "/request/" + this.sender.replace(/^:/, "").replace(/\./g, "_") + "/" + tok;
  };
  // Portal methods answer through a Response signal on a Request object; the
  // waiter is installed before the call so an early answer cannot be missed.
  PortalSession.prototype.request = function (member, signature, args, options, timeoutMs) {
    var self = this;
    var tok = token("cdb");
    var path = this.requestPath(tok);
    var opts = {};
    for (var k in (options || {})) opts[k] = options[k];
    opts.handle_token = ["s", tok];
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { delete self.waiters[path]; reject(new Error("no Response for " + member)); }, timeoutMs || 120000);
      self.waiters[path] = function (code, results) { clearTimeout(timer); resolve({ code: code, results: results }); };
      self.bus.call({ dest: PORTAL, path: PORTAL_PATH, iface: GS_IFACE, member: member, signature: signature, body: args.concat([opts]) })
        .then(function (r) {
          var handle = r.body[0];
          if (handle && handle !== path && self.waiters[path]) { self.waiters[handle] = self.waiters[path]; delete self.waiters[path]; }
        }, function (e) { clearTimeout(timer); delete self.waiters[path]; reject(e); });
    });
  };
  PortalSession.prototype.connect = function () {
    var self = this;
    this.bus = new DBus();
    this.bus.onClose = function (e) { self.session = null; if (self.onClose) self.onClose(e); };
    return this.bus.connect().then(function (name) {
      self.sender = name;
      return self.bus.addMatch("type='signal',sender='" + PORTAL + "',interface='" + REQ_IFACE + "',member='Response'");
    }).then(function () {
      return self.bus.addMatch("type='signal',sender='" + PORTAL + "',interface='" + GS_IFACE + "'");
    }).then(function () {
      self.bus.onSignal(function (m) {
        if (m.iface === REQ_IFACE && m.member === "Response") {
          var w = self.waiters[m.path];
          if (w) { delete self.waiters[m.path]; w(m.body[0], m.body[1] || {}); }
        } else if (m.iface === GS_IFACE && m.member === "ShortcutsChanged" && self.session && m.body[0] === self.session) {
          if (self.onShortcutsChanged) self.onShortcutsChanged();
        }
      });
      return self.sender;
    });
  };
  PortalSession.prototype.version = function () {
    return this.bus.call({ dest: PORTAL, path: PORTAL_PATH, iface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss", body: [GS_IFACE, "version"], timeoutMs: 5000 })
      .then(function (r) { return r.body[0]; });
  };
  PortalSession.prototype.createSession = function () {
    var self = this;
    return this.request("CreateSession", "a{sv}", [], { session_handle_token: ["s", token("cdbgs")] }, 15000).then(function (r) {
      if (r.code !== 0) throw new Error("CreateSession response " + r.code);
      self.session = r.results.session_handle;
      if (!self.session) throw new Error("CreateSession returned no session_handle");
      return self.session;
    });
  };
  PortalSession.prototype.listShortcuts = function () {
    return this.request("ListShortcuts", "oa{sv}", [this.session], {}, 15000).then(function (r) {
      if (r.code !== 0) throw new Error("ListShortcuts response " + r.code);
      return r.results.shortcuts || [];
    });
  };
  // Re-sends exactly the ids the portal already knows: returning ids are armed
  // without a dialog. Descriptions are passed through; the stored key wins over
  // any preferred trigger, so none is sent.
  PortalSession.prototype.bindShortcuts = function (listed) {
    var shortcuts = [];
    for (var i = 0; i < listed.length; i++) {
      var props = listed[i][1] || {};
      var p = {};
      if (typeof props.description === "string") p.description = ["s", props.description];
      shortcuts.push([listed[i][0], p]);
    }
    return this.request("BindShortcuts", "oa(sa{sv})sa{sv}", [this.session, shortcuts, ""], {}, 180000).then(function (r) {
      if (r.code !== 0) throw new Error("BindShortcuts response " + r.code);
      return r.results.shortcuts || [];
    });
  };
  PortalSession.prototype.close = function () { this.onClose = null; if (this.bus) this.bus.close(); this.bus = null; this.session = null; };

  // ------------------------------------------------------------ controller
  var BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
  var GIVE_UP_AFTER_MS = 10 * 60 * 1000; // a first launch waits for the KDE dialog this long

  var ctl = {
    accelerators: {},   // accelerator -> true while upstream has it registered
    session: null,
    timer: null,
    attempt: 0,
    firstAttemptAt: 0,
    boundIds: "",
    gate: null,          // null = not probed, Promise<string|null> (null = pass, string = why not)
    busy: false,
    loggedGate: false
  };

  function envGate() {
    var env = process.env;
    if (process.platform !== "linux") return "not linux";
    if (env.CDB_KDE_GS_REBIND === "0") return "disabled by CDB_KDE_GS_REBIND=0";
    var wayland = env.XDG_SESSION_TYPE ? env.XDG_SESSION_TYPE === "wayland" : !!env.WAYLAND_DISPLAY;
    if (!wayland) return "not a Wayland session";
    // CLAUDE_USE_XWAYLAND=1: the app grabs keys through X11, not the portal.
    // Arming the KDE binding here would only take the key away from that grab.
    if (Array.isArray(process.argv) && process.argv.indexOf("--ozone-platform=x11") >= 0) return "XWayland launch (X11 key grabs, no portal)";
    if (!/kde/i.test(env.XDG_CURRENT_DESKTOP || "")) return "not KDE (XDG_CURRENT_DESKTOP=" + (env.XDG_CURRENT_DESKTOP || "") + ")";
    var chrome = parseInt(String((process.versions && process.versions.chrome) || "0"), 10);
    if (chrome >= 159) return "Chromium " + chrome + " binds per session itself";
    return null;
  }
  function kwinGate() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      try {
        cp.execFile("kwin_wayland", ["--version"], { encoding: "utf8", timeout: 3000 }, function (e, out) {
          if (e) return finish("kwin_wayland --version failed (" + (e.code || e.message) + ")");
          var m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(out || ""));
          if (!m) return finish("cannot parse kwin version: " + String(out || "").trim());
          var maj = parseInt(m[1], 10), min = parseInt(m[2], 10);
          if (maj > 6 || (maj === 6 && min >= 4)) return finish(null);
          finish("KWin " + m[0] + " < 6.4 (re-bind would open System Settings)");
        });
      } catch (e2) { finish("kwin_wayland probe threw: " + (e2 && e2.message)); }
    });
  }
  function gate() {
    if (!ctl.gate) {
      var envWhy = envGate();
      ctl.gate = envWhy ? Promise.resolve(envWhy) : kwinGate();
    }
    return ctl.gate;
  }

  function hasAccelerators() { return Object.keys(ctl.accelerators).length > 0; }
  function clearTimer() { if (ctl.timer) { clearTimeout(ctl.timer); ctl.timer = null; } }
  function schedule(ms, reason) {
    clearTimer();
    ctl.timer = setTimeout(function () { ctl.timer = null; attempt(reason); }, ms);
    if (ctl.timer.unref) ctl.timer.unref();
  }
  function retry(reason) {
    var idx = Math.min(ctl.attempt, BACKOFF_MS.length - 1);
    ctl.attempt++;
    if (ctl.firstAttemptAt && Date.now() - ctl.firstAttemptAt > GIVE_UP_AFTER_MS) {
      log("giving up after " + Math.round((Date.now() - ctl.firstAttemptAt) / 1000) + " s (" + reason + "); the next register call starts over");
      stop("gave up");
      return;
    }
    schedule(BACKOFF_MS[idx], reason);
  }
  function stop(why) {
    clearTimer();
    ctl.attempt = 0;
    ctl.firstAttemptAt = 0;
    ctl.boundIds = "";
    if (ctl.session) { log("closing the re-bind session (" + why + ")"); ctl.session.close(); ctl.session = null; }
  }

  function attempt(reason) {
    if (ctl.busy) { schedule(500, reason); return; }
    if (!hasAccelerators()) { stop("no global shortcut registered"); return; }
    ctl.busy = true;
    if (!ctl.firstAttemptAt) ctl.firstAttemptAt = Date.now();
    gate().then(function (why) {
      if (why) {
        if (!ctl.loggedGate) { ctl.loggedGate = true; log("inactive: " + why); }
        ctl.busy = false;
        return;
      }
      var p = Promise.resolve();
      if (!ctl.session) {
        var s = new PortalSession();
        ctl.session = s;
        s.onClose = function (e) {
          if (ctl.session !== s) return;
          ctl.session = null;
          ctl.boundIds = "";
          if (hasAccelerators()) { log("bus connection lost (" + (e && e.message) + "), reconnecting"); retry("reconnect"); }
        };
        s.onShortcutsChanged = function () { schedule(500, "ShortcutsChanged"); };
        p = s.connect().then(function () {
          return s.version();
        }).then(function (v) {
          log("portal GlobalShortcuts version " + v + ", opening a session (" + reason + ")");
          return s.createSession();
        });
      }
      return p.then(function () {
        return ctl.session.listShortcuts();
      }).then(function (listed) {
        if (!listed.length) {
          // Nothing stored yet: upstream's own bind (and KDE's dialog) is still pending.
          ctl.busy = false;
          retry("nothing listed yet");
          return;
        }
        var ids = listed.map(function (s) { return s[0]; }).sort().join("\n");
        if (ids === ctl.boundIds) { ctl.busy = false; ctl.attempt = 0; return; }
        return ctl.session.bindShortcuts(listed).then(function (bound) {
          ctl.boundIds = ids;
          ctl.attempt = 0;
          ctl.busy = false;
          // KDE reports the key it holds for each id as trigger_description. An id
          // without one is stored with NO key (the bind dialog was dismissed, or the
          // key was cleared in System Settings): KDE will never fire it, so say so.
          var names = bound.map(function (s) {
            var trig = s[1] && s[1].trigger_description;
            return trig ? trig : s[0] + " (no key assigned - set one in System Settings > Shortcuts > Claude)";
          });
          log("armed " + bound.length + " stored shortcut(s) for this session: " + names.join(", "));
        });
      });
    }).catch(function (e) {
      ctl.busy = false;
      log("attempt failed (" + reason + "): " + (e && e.message));
      if (ctl.session) { ctl.session.close(); ctl.session = null; ctl.boundIds = ""; }
      retry("error");
    });
  }

  // ---------------------------------------------------- electron API hooks
  function hook() {
    var gs;
    try { gs = require("electron").globalShortcut; } catch (e) { log("electron.globalShortcut unavailable: " + (e && e.message)); return false; }
    if (!gs || typeof gs.register !== "function") { log("electron.globalShortcut has no register()"); return false; }
    var origRegister = gs.register, origUnregister = gs.unregister, origUnregisterAll = gs.unregisterAll;
    gs.register = function (accelerator, cb) {
      var ok = origRegister.apply(this, arguments);
      try {
        if (ok) { ctl.accelerators[String(accelerator)] = true; ctl.attempt = 0; ctl.firstAttemptAt = 0; schedule(1000, "register " + accelerator); }
      } catch (e) { log("register hook error: " + (e && e.message)); }
      return ok;
    };
    gs.unregister = function (accelerator) {
      try { delete ctl.accelerators[String(accelerator)]; if (!hasAccelerators()) schedule(500, "unregister"); } catch (e) {}
      return origUnregister.apply(this, arguments);
    };
    gs.unregisterAll = function () {
      try { ctl.accelerators = {}; schedule(500, "unregisterAll"); } catch (e) {}
      return origUnregisterAll.apply(this, arguments);
    };
    return true;
  }

  globalThis.__cdbKdeGsRebind = {
    hook: hook,
    attempt: attempt,
    stop: stop,
    state: ctl,
    gate: gate,
    DBus: DBus,
    PortalSession: PortalSession,
    _wire: { Writer: Writer, Reader: Reader, sigNodes: sigNodes, buildMessage: buildMessage, parseMessage: parseMessage, parseAddress: parseAddress }
  };
  if (!process.env.CDB_KDE_GS_REBIND_NO_HOOK) hook();
})();

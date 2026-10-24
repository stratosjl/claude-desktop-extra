#!/usr/bin/env node
// X11 HiDPI coordinates in js/cu_linux_executor.js.
//
// Electron reports displays in DIP; x11-bridge (XTest motion, GetImage crop)
// works in X root PIXELS. The executor used to pass DIP straight to the bridge
// for every pointer action, so at any scale factor other than 1 (XSETTINGS
// Xft/DPI, GDK_SCALE, --force-device-scale-factor) a click aimed at the screen
// centre landed short and monitors right of / below the primary were
// unreachable. The screenshot crop multiplied by the scale instead, which is
// also wrong once displays have different scales: Chromium's
// ConvertDisplayBoundsToDips (ui/base/x/x11_display_util.cc) scales only the
// primary's origin and places the other displays next to their neighbour.
//
// The executor now maps each DIP point through its display the way Electron's
// own screen.dipToScreenPoint does on X11:
//   px = nativeOrigin + floor((dip - bounds.origin) * scaleFactor)
// and uses the same transform for the screenshot / zoom crop.
//
// The display fixtures below are what Chromium builds for the stated RandR
// layout (DIP bounds via ConvertDisplayBoundsToDips, nativeOrigin = CRTC
// origin). The real executor runs against a stub bridge; image -> DIP goes
// through the real __txC spliced out of js/cu_handler_injection.js, so the
// end-to-end cases cover model image pixel -> DIP -> root pixel.
//
// Exit codes follow the repo convention: 0 = PASS, other = FAIL.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");
const HANDLER = path.join(ROOT, "js", "cu_handler_injection.js");

// The handler's image -> DIP transform, verbatim.
const txSrc = readFileSync(HANDLER, "utf8").match(/function __txC\(c\)\{[\s\S]*?\n\}\n/);
if (!txSrc) { console.error("FAIL: could not splice __txC out of cu_handler_injection.js"); process.exit(1); }
const __txC = new Function(txSrc[0] + "\nreturn __txC;")();

// displays: Electron Display objects (displays.primaryIdx marks the primary).
// screens: what `x11-bridge screens` answers (RandR monitors, root pixels).
// zoomImg(w,h): the emitted (downscaled) image size the stub bridge reports.
// ozone: the --ozone-platform switch Electron was started with ("" = none).
function makeRig({ displays, screens = [], session = "x11", desktop = "XFCE", cursor = { x: 0, y: 0 }, zoomImg, ozone = "" }) {
  const calls = [], diag = [];
  const reply = (args) => {
    const sub = args[0];
    if (sub === "screens") return JSON.stringify(screens);
    if (sub === "zoom") {
      const w = +args[args.indexOf("--w") + 1], h = +args[args.indexOf("--h") + 1];
      const out = zoomImg ? zoomImg(w, h) : { width: w, height: h };
      return JSON.stringify({ base64: "AA", width: out.width, height: out.height });
    }
    if (sub === "app-under-point") return JSON.stringify({ bundleId: "x", displayName: "x" });
    return "{}";
  };
  const cp = {
    execFileSync(bin, args) {
      const base = path.basename(String(bin));
      if (base !== "x11-bridge") throw new Error("not found");
      calls.push(args.join(" "));
      return reply(args);
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const base = path.basename(String(bin));
      if (base !== "x11-bridge") { setTimeout(() => cb(new Error("not found"), "", ""), 0); return; }
      calls.push(args.join(" "));
      setTimeout(() => cb(null, reply(args), ""), 0);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    app: { commandLine: { getSwitchValue: (k) => (k === "ozone-platform" ? ozone : "") } },
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[displays.primaryIdx || 0],
      getCursorScreenPoint: () => cursor
    },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return { readFileSync: () => Buffer.alloc(0), writeFileSync(){}, unlinkSync(){}, existsSync: () => false, renameSync(){}, accessSync(){ throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }) };
    throw new Error("unexpected require " + id);
  };
  globalThis.__cdbDiag = (m) => diag.push(String(m));
  globalThis.__cuX11BridgeBin = "/res/x11-bridge";
  delete globalThis.__cuGnomeBridgeBin; delete globalThis.__cuWlrootsBridgeBin;
  globalThis.__cuKwinMode = false;
  process.env.XDG_CURRENT_DESKTOP = desktop;
  process.env.XDG_SESSION_TYPE = session;
  if (session === "wayland") process.env.WAYLAND_DISPLAY = "wayland-0"; else delete process.env.WAYLAND_DISPLAY;
  for (const k of ["SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "NIRI_SOCKET", "COWORK_SCREENSHOT_CMD", "X11_BRIDGE_BIN", "YDOTOOL_SOCKET"]) delete process.env[k];
  new Function("require", "process", readFileSync(EXECUTOR, "utf8"))(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  diag.length = 0; calls.length = 0;
  return { ex, calls, diag };
}

// The handler's screenshot bookkeeping (what __txC reads), from ex.screenshot.
async function shoot(ex, displayId) {
  const ss = await ex.screenshot({ displayId });
  globalThis.__cuLastShot = { imgW: ss.imgW, imgH: ss.imgH, dispW: ss.displayWidth, dispH: ss.displayHeight, originX: ss.originX, originY: ss.originY };
  return ss;
}
const d = (id, b, sf, no, label = "") => ({ id, label, bounds: b, size: { width: b.width, height: b.height }, workArea: b, scaleFactor: sf, ...(no ? { nativeOrigin: no } : {}) });
const R = (x, y, width, height) => ({ x, y, width, height });
const scr = (name, x, y, width, height, primary) => ({ id: name, name, geometry: R(x, y, width, height), scale: 1, is_primary: !!primary, is_active: !!primary });
const last = (calls, sub) => [...calls].reverse().find((c) => c.startsWith(sub + " "));
const downscale = (w, h) => { const k = Math.min(1, 1568 / Math.max(w, h)); return { width: Math.round(w * k), height: Math.round(h * k) }; };

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra ? "  -> " + extra : "")); return; }
  fail++; console.error("  FAIL " + label + (extra ? "  -> " + extra : ""));
}

console.log("\n[1] scale 1: bridge coordinates are byte-identical to the DIP passthrough");
for (const withOrigin of [true, false]) {
  const displays = [d(1, R(0, 0, 1920, 1080), 1, withOrigin ? { x: 0, y: 0 } : null)];
  const rig = makeRig({ displays, screens: [scr("screen", 0, 0, 1920, 1080, true)], cursor: { x: 7, y: 9 } });
  const tag = withOrigin ? "(nativeOrigin)" : "(no nativeOrigin)";
  await rig.ex.click(100.6, 200.4, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 101 --y 200 --button left --count 1", "click " + tag, last(rig.calls, "pointer-click"));
  await rig.ex.moveMouse(1919, 1079);
  ok(last(rig.calls, "pointer-move") === "pointer-move --x 1919 --y 1079", "move " + tag, last(rig.calls, "pointer-move"));
  await rig.ex.scroll(5, 6, 0, 3);
  ok(last(rig.calls, "pointer-scroll") === "pointer-scroll --x 5 --y 6 --dx 0 --dy 3", "scroll " + tag, last(rig.calls, "pointer-scroll"));
  await rig.ex.drag(void 0, { x: 30, y: 40 });
  ok(last(rig.calls, "pointer-drag") === "pointer-drag --from-x 7 --from-y 9 --to-x 30 --to-y 40", "drag from cursor " + tag, last(rig.calls, "pointer-drag"));
  await rig.ex.screenshot({ displayId: 0 });
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 1920 --h 1080 --display screen", "full screenshot crop " + tag, last(rig.calls, "zoom"));
  await rig.ex.zoom({ x: 10, y: 20, w: 300, h: 200 }, 1, null);
  ok(last(rig.calls, "zoom") === "zoom --x 10 --y 20 --w 300 --h 200 --display screen", "zoom crop " + tag, last(rig.calls, "zoom"));
  ok(!rig.diag.some((l) => l.includes("HiDPI")), "no HiDPI diagnostic at scale 1 " + tag);
}

console.log("\n[2] scale 1.5, one 3840x1080 monitor (measured: --force-device-scale-factor=1.5 -> 2560x720 DIP)");
{
  const displays = [d(1, R(0, 0, 2560, 720), 1.5, { x: 0, y: 0 })];
  const rig = makeRig({ displays, screens: [scr("screen", 0, 0, 3840, 1080, true)], zoomImg: downscale });
  const ss = await shoot(rig.ex, 0);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 3840 --h 1080 --display screen", "screenshot crops the whole monitor in root pixels", last(rig.calls, "zoom"));
  const c = __txC([Math.round(ss.imgW / 2), Math.round(ss.imgH / 2)]);
  await rig.ex.click(c[0], c[1], "left", 1);
  // One image pixel spans 3840/1568 ~ 2.45 root pixels, so the centre is hit to
  // within that quantum (before: 1280,360, a third of the screen away).
  const pc = last(rig.calls, "pointer-click").split(" ");
  ok(Math.abs(+pc[2] - 1920) <= 3 && Math.abs(+pc[4] - 540) <= 3,
     "a click on the image centre lands on the pixel centre (was 1280,360)", "image " + ss.imgW + "x" + ss.imgH + " -> DIP " + c + " -> " + pc.slice(0, 5).join(" "));
  await rig.ex.click(1280, 360, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 1920 --y 540 --button left --count 1", "DIP 1280,360 is root pixel 1920,540 exactly", last(rig.calls, "pointer-click"));
  const br = __txC([ss.imgW - 1, ss.imgH - 1]);
  await rig.ex.moveMouse(br[0], br[1]);
  const m = last(rig.calls, "pointer-move").split(" ");
  ok(+m[2] >= 3834 && +m[2] <= 3839 && +m[4] >= 1074 && +m[4] <= 1079, "the bottom-right image pixel reaches the bottom-right screen corner", m.join(" "));
  await rig.ex.drag({ x: 100, y: 100 }, { x: 200, y: 50 });
  ok(last(rig.calls, "pointer-drag") === "pointer-drag --from-x 150 --from-y 150 --to-x 300 --to-y 75", "both drag endpoints are mapped", last(rig.calls, "pointer-drag"));
  await rig.ex.zoom({ x: 1000, y: 300, w: 200, h: 100 }, 1, null);
  ok(last(rig.calls, "zoom") === "zoom --x 1500 --y 450 --w 300 --h 150 --display screen", "zoom crop uses the same transform", last(rig.calls, "zoom"));
  await rig.ex.appUnderPoint(1280, 360);
  ok(last(rig.calls, "app-under-point") === "app-under-point --x 1920 --y 540", "app-under-point is mapped too", last(rig.calls, "app-under-point"));
  ok(rig.diag.some((l) => l.includes("x11 HiDPI: display 0")), "the mapping is reported once in claude-patches.log");
}

console.log("\n[3] two monitors at scale 1.25, the secondary right of the primary");
{
  // RandR: DP-1 3840x2160+0+0 (primary), HDMI-1 1920x1080+3840+0.
  // Chromium: DP-1 -> 0,0 3072x1728; HDMI-1 -> 3072,0 1536x864.
  const displays = [d(1, R(0, 0, 3072, 1728), 1.25, { x: 0, y: 0 }), d(2, R(3072, 0, 1536, 864), 1.25, { x: 3840, y: 0 })];
  const rig = makeRig({ displays, screens: [scr("DP-1", 0, 0, 3840, 2160, true), scr("HDMI-1", 3840, 0, 1920, 1080)], zoomImg: downscale });
  const ss = await shoot(rig.ex, 1);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 1920 --h 1080 --display HDMI-1", "screenshot of the secondary crops HDMI-1 in its own pixels", last(rig.calls, "zoom"));
  const c = __txC([Math.round(ss.imgW / 2), Math.round(ss.imgH / 2)]);
  await rig.ex.click(c[0], c[1], "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 4800 --y 540 --button left --count 1",
     "the secondary's centre is reachable (was 3840,432 on the primary)", "DIP " + c + " -> " + last(rig.calls, "pointer-click"));
  await shoot(rig.ex, 0);
  const p = __txC([784, 441]);
  await rig.ex.click(p[0], p[1], "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 1920 --y 1080 --button left --count 1", "the primary's centre (1920,1080) is hit (was 1536,864)", last(rig.calls, "pointer-click"));
}

console.log("\n[4] primary not at 0,0 (secondary left of it), scale 1.25");
{
  // RandR: HDMI-1 1920x1080+0+0, DP-1 2560x1440+1920+0 (primary).
  // Chromium: DP-1 -> 1536,0 2048x1152; HDMI-1 -> 0,0 1536x864.
  const displays = [d(1, R(1536, 0, 2048, 1152), 1.25, { x: 1920, y: 0 }), d(2, R(0, 0, 1536, 864), 1.25, { x: 0, y: 0 })];
  const rig = makeRig({ displays, screens: [scr("HDMI-1", 0, 0, 1920, 1080), scr("DP-1", 1920, 0, 2560, 1440, true)] });
  await shoot(rig.ex, 0);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 2560 --h 1440 --display DP-1", "screenshot of the primary crops DP-1", last(rig.calls, "zoom"));
  await rig.ex.click(1536 + 1024, 576, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 3200 --y 720 --button left --count 1", "the primary's centre (3200,720) is hit", last(rig.calls, "pointer-click"));
  await rig.ex.click(768, 432, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 960 --y 540 --button left --count 1", "the left monitor's centre (960,540) is hit", last(rig.calls, "pointer-click"));
}

console.log("\n[5] mixed scales (per-monitor scale from the toolkit): plain `*sf` is wrong, the per-display map is not");
{
  // RandR: DP-1 3840x2160+0+0 (primary, scale 2), HDMI-1 1920x1080+3840+0 (scale 1).
  // ConvertDisplayBoundsToDips: DP-1 -> 0,0 1920x1080; HDMI-1 placed at the
  // midpoint of the shared edge -> 1920,-270 1920x1080.
  const displays = [d(1, R(0, 0, 1920, 1080), 2, { x: 0, y: 0 }), d(2, R(1920, -270, 1920, 1080), 1, { x: 3840, y: 0 })];
  const rig = makeRig({ displays, screens: [scr("DP-1", 0, 0, 3840, 2160, true), scr("HDMI-1", 3840, 0, 1920, 1080)] });
  await shoot(rig.ex, 1);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 1920 --h 1080 --display HDMI-1", "the secondary's crop starts at its RandR origin (`*sf` gave 1920,-270)", last(rig.calls, "zoom"));
  await rig.ex.click(1920 + 100, -270 + 100, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 3940 --y 100 --button left --count 1", "a click on the secondary lands on it", last(rig.calls, "pointer-click"));
  await rig.ex.click(960, 540, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 1920 --y 1080 --button left --count 1", "a click on the scale-2 primary is doubled", last(rig.calls, "pointer-click"));
}

console.log("\n[6] fallbacks are logged once per distinct miss");
{
  const displays = [d(1, R(0, 0, 1920, 1080), 1, { x: 0, y: 0 })];
  // The bridge lists a monitor that does not contain the capture origin.
  const rig = makeRig({ displays, screens: [scr("screen", 100, 100, 1820, 980, true)] });
  await rig.ex.zoom({ x: 10, y: 10, w: 50, h: 50 }, 1, null);
  await rig.ex.zoom({ x: 10, y: 10, w: 60, h: 60 }, 1, null);
  ok(rig.diag.filter((l) => l.includes("is on no RandR monitor")).length === 1, "an off-monitor capture origin falls back to the primary and is logged once",
     rig.diag.filter((l) => l.includes("RandR")).join(" | "));
  await rig.ex.click(-50, 10, "left", 1);
  await rig.ex.click(-50, 10, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x -50 --y 10 --button left --count 1", "an off-display point maps through the nearest display", last(rig.calls, "pointer-click"));
  ok(rig.diag.filter((l) => l.includes("is on no display")).length === 1, "and is logged once");
}

console.log("\n[7] Wayland sessions are untouched: the XWayland fallback keeps raw coordinates");
{
  const displays = [d(1, R(0, 0, 2560, 720), 1.5, { x: 0, y: 0 })];
  const rig = makeRig({ displays, session: "wayland", desktop: "COSMIC" });
  await rig.ex.click(1280, 360, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 1280 --y 360 --button left --count 1", "exotic Wayland passes DIP through as before", last(rig.calls, "pointer-click"));
}

console.log("\n[8] overlapping DIP bounds: 2560x1440 + 1920x1080 at 1.5 (ToEnclosingRect shares column 1706)");
{
  // RandR: DP-1 2560x1440+0+0 (primary), HDMI-1 1920x1080+2560+0, both 1.5.
  // Chromium: DP-1 -> 0,0 1707x960; HDMI-1 -> 1706.67 enclosed to 1706,0 1281x720.
  const displays = [d(1, R(0, 0, 1707, 960), 1.5, { x: 0, y: 0 }), d(2, R(1706, 0, 1281, 720), 1.5, { x: 2560, y: 0 })];
  const rig = makeRig({ displays, screens: [scr("DP-1", 0, 0, 2560, 1440, true), scr("HDMI-1", 2560, 0, 1920, 1080)], zoomImg: downscale });
  const ss = await shoot(rig.ex, 1);
  const z = last(rig.calls, "zoom").split(" ");
  ok(z[2] === "0" && z[4] === "0" && Math.abs(+z[6] - 1920) <= 1 && +z[8] === 1080 && z[10] === "HDMI-1",
     "screenshot of the secondary crops HDMI-1 (was --x 2559 ... --display DP-1, a 1-px sliver)", z.join(" "));
  const c = __txC([Math.round(ss.imgW / 2), Math.round(ss.imgH / 2)]);
  await rig.ex.click(c[0], c[1], "left", 1);
  const pc = last(rig.calls, "pointer-click").split(" ");
  ok(Math.abs(+pc[2] - 3520) <= 2 && Math.abs(+pc[4] - 540) <= 2, "the secondary's image centre lands on its pixel centre (3520,540)", "DIP " + c + " -> " + pc.slice(0, 5).join(" "));
  await rig.ex.click(1706, 100, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 2560 --y 150 --button left --count 1", "a point in the shared column maps through the screenshotted display (HDMI-1)", last(rig.calls, "pointer-click"));
  await shoot(rig.ex, 0);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 2560 --h 1440 --display DP-1", "screenshot of the primary crops DP-1", last(rig.calls, "zoom"));
  await rig.ex.click(1706, 100, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 2559 --y 150 --button left --count 1", "after a primary screenshot the shared column maps through DP-1", last(rig.calls, "pointer-click"));
  await rig.ex.click(853, 480, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 1279 --y 720 --button left --count 1", "the primary's centre is hit", last(rig.calls, "pointer-click"));
  await rig.ex.zoom({ x: 1706, y: 0, w: 100, h: 100 }, 1, 1);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 150 --h 150 --display HDMI-1", "a zoom that names its display maps through it", last(rig.calls, "zoom"));
}

console.log("\n[9] 1366x768 laptop at 1.25 with a 1920x1080 monitor right of it");
{
  // Chromium: eDP-1 -> 0,0 1093x615 (1092.8 x 614.4 enclosed); HDMI-1 -> 1092,0 1537x864.
  const displays = [d(1, R(0, 0, 1093, 615), 1.25, { x: 0, y: 0 }), d(2, R(1092, 0, 1537, 864), 1.25, { x: 1366, y: 0 })];
  const rig = makeRig({ displays, screens: [scr("eDP-1", 0, 0, 1366, 768, true), scr("HDMI-1", 1366, 0, 1920, 1080)], zoomImg: downscale });
  const ss = await shoot(rig.ex, 1);
  const z = last(rig.calls, "zoom").split(" ");
  ok(z[2] === "0" && z[4] === "0" && Math.abs(+z[6] - 1920) <= 1 && +z[8] === 1080 && z[10] === "HDMI-1", "screenshot of the monitor crops HDMI-1", z.join(" "));
  const c = __txC([Math.round(ss.imgW / 2), Math.round(ss.imgH / 2)]);
  await rig.ex.click(c[0], c[1], "left", 1);
  const pc = last(rig.calls, "pointer-click").split(" ");
  ok(Math.abs(+pc[2] - 2326) <= 2 && Math.abs(+pc[4] - 540) <= 2, "its image centre lands on its pixel centre (2326,540)", "DIP " + c + " -> " + pc.slice(0, 5).join(" "));
  await shoot(rig.ex, 0);
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 1366 --h 768 --display eDP-1", "screenshot of the laptop crops eDP-1", last(rig.calls, "zoom"));
  await rig.ex.click(546, 307, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 682 --y 383 --button left --count 1", "the laptop's centre is hit", last(rig.calls, "pointer-click"));
}

console.log("\n[10] Wayland session with Electron on XWayland (CLAUDE_USE_XWAYLAND=1 -> --ozone-platform=x11)");
{
  const displays = [d(1, R(0, 0, 2560, 720), 1.5, { x: 0, y: 0 })];
  const rig = makeRig({ displays, session: "wayland", desktop: "COSMIC", ozone: "x11", screens: [scr("XWAYLAND0", 0, 0, 3840, 1080, true)] });
  await rig.ex.click(1280, 360, "left", 1);
  ok(last(rig.calls, "pointer-click") === "pointer-click --x 1920 --y 540 --button left --count 1", "x11-bridge input is mapped like an X11 session", last(rig.calls, "pointer-click"));
  await rig.ex.screenshot({ displayId: 0 });
  ok(last(rig.calls, "zoom") === "zoom --x 0 --y 0 --w 3840 --h 1080 --display XWAYLAND0", "and so is the crop", last(rig.calls, "zoom"));
  const nat = makeRig({ displays, session: "wayland", desktop: "COSMIC", ozone: "wayland" });
  await nat.ex.click(1280, 360, "left", 1);
  ok(last(nat.calls, "pointer-click") === "pointer-click --x 1280 --y 360 --button left --count 1", "native Wayland Electron keeps the passthrough", last(nat.calls, "pointer-click"));
}

console.log("\n[11] per-point misses cannot starve the layout diagnostic");
{
  const displays = [d(1, R(0, 0, 1920, 1080), 1, { x: 0, y: 0 }), d(2, R(1920, 0, 1280, 720), 1.5, { x: 1920, y: 0 })];
  const rig = makeRig({ displays });
  for (let i = 0; i < 40; i++) await rig.ex.click(-10 - i, 5, "left", 1);
  await rig.ex.click(2000, 10, "left", 1);
  ok(rig.diag.some((l) => l.includes("x11 HiDPI: display 1")), "the mapping line still lands after 40 distinct misses");
  ok(rig.diag.filter((l) => l.includes("is on no display")).length <= 16, "misses are capped", String(rig.diag.filter((l) => l.includes("is on no display")).length));
}

delete globalThis.__linuxExecutor;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");
const { BrowserSessionManager, resolveBrowserBinary } = require("#server/browser-session-manager");

function hasBrowser() {
  try {
    resolveBrowserBinary();
    return true;
  } catch {
    return false;
  }
}

// Fixed positions, so the test can aim without reading the layout. The page
// writes what it receives into #log, which snapshots return as text.
const PAGE = `<body style="margin:0">
  <form id="form" action="javascript:void 0"><input id="name" style="position:absolute;left:10px;top:10px;width:200px;height:30px"></form>
  <input id="secret" type="password" style="position:absolute;left:10px;top:60px;width:200px;height:30px">
  <button id="plain" style="position:absolute;left:10px;top:110px;width:100px;height:30px">Plain</button>
  <div id="track" style="position:absolute;left:10px;top:170px;width:300px;height:40px;background:#ccc"></div>
  <pre id="log" style="position:absolute;left:10px;top:240px"></pre>
  <script>
    const log = (line) => { document.getElementById("log").textContent += line + "\\n"; };
    const name = document.getElementById("name");
    name.addEventListener("keydown", (e) => log("down " + e.key + " " + e.keyCode));
    name.addEventListener("keyup", (e) => log("up " + e.key));
    let dragging = false;
    const track = document.getElementById("track");
    track.addEventListener("mousedown", (e) => { dragging = true; log("drag start " + e.clientX); });
    window.addEventListener("mousemove", (e) => { if (dragging && e.buttons === 1) log("drag move " + e.clientX); });
    window.addEventListener("mouseup", (e) => { if (dragging) log("drag end " + e.clientX); dragging = false; });
    document.getElementById("form").addEventListener("submit", (e) => { e.preventDefault(); log("submitted"); });
    document.getElementById("plain").addEventListener("contextmenu", (e) => { e.preventDefault(); log("context menu"); });
  </script>
</body>`;

test("viewer pointer and key events reach the page the way local input does", {
  skip: !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 60_000,
}, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manager = new BrowserSessionManager();
  const profile = `test-input-${crypto.randomBytes(4).toString("hex")}`;
  t.after(async () => {
    await manager.clear(profile).catch(() => {});
    server.close();
  });
  await manager.open(profile, `http://127.0.0.1:${address.port}/`);

  /**
   * @param {"down" | "move" | "up"} phase
   * @param {number} x
   * @param {number} y
   * @param {{ button?: "left" | "right" | "none", buttons?: number, clickCount?: number }} [options]
   */
  const pointer = (phase, x, y, options = {}) => manager.phoneInput(profile, {
    action: "pointer",
    phase,
    x,
    y,
    button: options.button ?? "left",
    buttons: options.buttons ?? 0,
    clickCount: options.clickCount ?? 1,
    modifiers: 0,
  });
  /** @param {number} x @param {number} y @param {"left" | "right"} [button] */
  const click = async (x, y, button = "left") => {
    await pointer("down", x, y, { button, buttons: button === "left" ? 1 : 2 });
    await pointer("up", x, y, { button });
  };
  /**
   * @param {string} code
   * @param {string} key
   * @param {{ text?: string, modifiers?: number }} [options]
   */
  const press = async (code, key, options = {}) => {
    const shared = { action: /** @type {const} */ ("keyboard"), code, key, modifiers: options.modifiers ?? 0, repeat: false };
    await manager.phoneInput(profile, { ...shared, phase: "down", ...(options.text ? { text: options.text } : {}) });
    await manager.phoneInput(profile, { ...shared, phase: "up" });
  };
  const logText = async () => {
    const snapshot = await manager.snapshot(profile);
    const start = snapshot.text.indexOf("Plain");
    return start < 0 ? snapshot.text : snapshot.text.slice(start);
  };
  /** @param {string} expected */
  const waitForLog = async (expected) => {
    let text = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      text = await logText();
      if (text.includes(expected)) return text;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Page log never showed "${expected}". It was:\n${text}`);
  };

  // A click on a text field focuses it, and focus reports it as editable.
  await click(100, 25);
  assert.deepEqual(await manager.focusState(profile), { editable: true, inputKind: "text" });

  // Shift+H, i, then Backspace and a retype, as separate key events.
  await press("KeyH", "H", { text: "H", modifiers: 8 });
  await press("KeyI", "i", { text: "i" });
  await press("Backspace", "Backspace");
  await press("KeyO", "o", { text: "o" });
  let log = await waitForLog("up o");
  assert.match(log, /down H 72/);
  assert.match(log, /down Backspace 8/);

  // Ctrl+A selects the field, so the next key replaces everything.
  await press("KeyA", "a", { modifiers: 2 });
  await press("KeyZ", "z", { text: "z" });
  const snapshot = await manager.snapshot(profile);
  assert.ok(snapshot.elements.some((element) => element.value === "z"), "Ctrl+A then z should leave only z");

  // Enter in a field submits its form, as a real keyboard's Enter does.
  await press("Enter", "Enter");
  await waitForLog("submitted");

  // Focus follows the page: a password field reports so, a button does not take typing.
  await click(100, 75);
  assert.deepEqual(await manager.focusState(profile), { editable: true, inputKind: "password" });
  await click(60, 125);
  assert.deepEqual(await manager.focusState(profile), { editable: false });

  // Right click opens the page's context menu handler.
  await click(60, 125, "right");
  await waitForLog("context menu");

  // A held button moving across the track is a drag the page can follow.
  await pointer("move", 30, 190, { button: "none" });
  await pointer("down", 30, 190, { buttons: 1 });
  for (const x of [80, 160, 240]) await pointer("move", x, 190, { buttons: 1 });
  await pointer("up", 240, 190);
  log = await waitForLog("drag end 240");
  assert.match(log, /drag start 30/);
  assert.match(log, /drag move 160/);
});

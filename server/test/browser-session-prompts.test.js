const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
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
  <select id="fruit" style="position:absolute;left:10px;top:10px;width:200px;height:30px">
    <option value="a">Apple</option>
    <optgroup label="Stone"><option value="p">Peach</option></optgroup>
  </select>
  <input id="day" type="date" style="position:absolute;left:10px;top:60px;width:200px;height:30px">
  <button id="ask" style="position:absolute;left:10px;top:110px;width:100px;height:30px">Ask</button>
  <input id="upload" type="file" style="position:absolute;left:10px;top:160px;width:200px;height:30px">
  <button id="pop" style="position:absolute;left:10px;top:210px;width:100px;height:30px">Pop</button>
  <pre id="log" style="position:absolute;left:10px;top:260px"></pre>
  <script>
    const log = (line) => { document.getElementById("log").textContent += line + "\\n"; };
    document.getElementById("fruit").addEventListener("change", (e) => log("fruit " + e.target.value));
    document.getElementById("day").addEventListener("change", (e) => log("day " + e.target.value));
    document.getElementById("ask").addEventListener("click", () => log("confirmed " + confirm("Delete it?")));
    document.getElementById("upload").addEventListener("change", (e) => log("file " + e.target.files[0].name));
    document.getElementById("pop").addEventListener("click", () => window.open("/popup", "_blank"));
  </script>
</body>`;

test("pickers, dialogs, file choosers, sign-ins, and pop-ups reach the viewer as prompts and tabs", {
  skip: !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 90_000,
}, async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/secret") {
      if (request.headers.authorization !== `Basic ${Buffer.from("ann:pw").toString("base64")}`) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Back office"' });
        response.end("no");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<body>Welcome back</body>");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(request.url === "/popup" ? "<title>Popup</title><body>Popup page</body>" : PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const manager = new BrowserSessionManager();
  const profile = `test-prompts-${crypto.randomBytes(4).toString("hex")}`;
  /** @type {import("#server/browser-session-manager").BrowserSessionEvent[]} */
  const events = [];
  const unsubscribe = manager.onEvent((event) => { if (event.profile === profile) events.push(event); });
  t.after(async () => {
    unsubscribe();
    await manager.clear(profile).catch(() => {});
    server.close();
  });
  await manager.open(profile, `${origin}/`);

  /** @param {number} x @param {number} y */
  const click = async (x, y) => {
    const shared = { action: /** @type {const} */ ("pointer"), x, y, button: /** @type {const} */ ("left"), clickCount: 1, modifiers: 0 };
    await manager.phoneInput(profile, { ...shared, phase: "down", buttons: 1 });
    await manager.phoneInput(profile, { ...shared, phase: "up", buttons: 0 });
  };
  /**
   * @template {string} K
   * @param {K} kind
   * @returns {Promise<import("#server/browser-session-manager").BrowserSessionEvent & { type: "browser_prompt" }>}
   */
  const waitForPrompt = async (kind) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const found = events.find((event) => event.type === "browser_prompt" && event.prompt.kind === kind);
      if (found && found.type === "browser_prompt") {
        events.length = 0;
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`No ${kind} prompt arrived. Events: ${JSON.stringify(events)}`);
  };
  /** @param {string} expected */
  const waitForText = async (expected) => {
    let text = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      text = (await manager.snapshot(profile)).text;
      if (text.includes(expected)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Page never showed "${expected}". It was:\n${text}`);
  };

  // A dropdown reports its options instead of opening Chrome's popup.
  await click(100, 25);
  const select = await waitForPrompt("select");
  assert.deepEqual(select.prompt.kind === "select" && select.prompt.options.map((option) => [option.label, option.group ?? ""]), [
    ["Apple", ""],
    ["Peach", "Stone"],
  ]);
  await manager.answerPrompt(profile, select.id, { accept: true, value: "p" });
  await waitForText("fruit p");

  await click(100, 75);
  const day = await waitForPrompt("picker");
  assert.equal(day.prompt.kind === "picker" && day.prompt.inputType, "date");
  await manager.answerPrompt(profile, day.id, { accept: true, value: "2026-10-07" });
  await waitForText("day 2026-10-07");

  // A confirm() pauses the page until the viewer answers it.
  await click(60, 125);
  const dialog = await waitForPrompt("dialog");
  assert.deepEqual(dialog.prompt, { kind: "dialog", dialogType: "confirm", message: "Delete it?" });
  assert.match((await manager.snapshot(profile)).text, /confirm dialog/);
  await manager.answerPrompt(profile, dialog.id, { accept: true });
  await waitForText("confirmed true");

  // A file chooser asks for uploads in the profile's folder.
  await click(100, 175);
  const chooser = await waitForPrompt("file");
  assert.ok(chooser.prompt.kind === "file");
  const uploaded = path.join(chooser.prompt.uploadDir, "notes.txt");
  fs.writeFileSync(uploaded, "hello");
  await assert.rejects(
    manager.answerPrompt(profile, chooser.id, { accept: true, files: ["/etc/hostname"] }),
    /upload folder/,
  );
  await click(100, 175);
  const retry = await waitForPrompt("file");
  await manager.answerPrompt(profile, retry.id, { accept: true, files: [uploaded] });
  await waitForText("file notes.txt");

  // A pop-up becomes the shown tab, and closing it returns to the page that opened it.
  await click(60, 225);
  /** @returns {Promise<{ id: string, url: string, active: boolean }>} */
  const waitForPopupTab = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      for (const event of events) {
        if (event.type !== "browser_tabs" || event.tabs.length !== 2) continue;
        const active = event.tabs.find((tab) => tab.active && tab.url.endsWith("/popup"));
        if (active) return active;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`No pop-up tab became active. Events: ${JSON.stringify(events)}`);
  };
  const popup = await waitForPopupTab();
  await waitForText("Popup page");
  await manager.closeTab(profile, popup.id);
  await waitForText("confirmed true");

  // A site asking for a password gets it from the viewer.
  await manager.navigate(profile, `${origin}/secret`);
  const auth = await waitForPrompt("auth");
  assert.deepEqual(auth.prompt, { kind: "auth", origin, scheme: "basic", realm: "Back office", proxy: false });
  await manager.answerPrompt(profile, auth.id, { accept: true, username: "ann", password: "pw" });
  await waitForText("Welcome back");
});

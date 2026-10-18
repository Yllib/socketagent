const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
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

// Each control writes what happened to #log, which snapshots return as text.
const PAGE = `<body>
  <label for="email">Email</label><input id="email">
  <input id="password" type="password" aria-label="Password">
  <div id="notes" contenteditable="true" aria-label="Notes">Hello</div>
  <textarea id="release" aria-label="Release notes">Old line one
Old line two</textarea>
  <shadow-host></shadow-host>
  <button id="menu">Menu</button>
  <button id="delete">Delete</button>
  <input id="upload" type="file" aria-label="Upload">
  <input id="date" type="date" aria-label="Date">
  <pre id="log"></pre>
  <script>
    const log = (line) => { document.getElementById("log").textContent += line + "\\n"; };
    customElements.define("shadow-host", class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = "<button>Shadow button</button>";
        root.querySelector("button").addEventListener("click", () => log("shadow clicked"));
      }
    });
    // Some web apps take Ctrl+A for themselves, so typing must not rely on it.
    document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "a") e.preventDefault(); });
    document.getElementById("password").addEventListener("input", (e) => log("password length " + e.target.value.length));
    document.getElementById("menu").addEventListener("mouseenter", () => log("hovered"));
    document.getElementById("delete").addEventListener("click", () => log("confirm " + confirm("Delete it?")));
    document.getElementById("upload").addEventListener("change", (e) => log("file " + e.target.files[0].name));
    document.getElementById("date").addEventListener("change", (e) => log("date " + e.target.value));
    setTimeout(() => log("Ready now"), 600);
  </script>
</body>`;

test("agents fill forms, answer page prompts and reach web components", {
  skip: !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 90_000,
}, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manager = new BrowserSessionManager();
  const profile = `test-agent-${crypto.randomBytes(4).toString("hex")}`;
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-agent-test-"));
  const upload = path.join(uploadDir, "report.txt");
  fs.writeFileSync(upload, "report");
  t.after(async () => {
    await manager.clear(profile).catch(() => {});
    server.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });
  await manager.open(profile, `http://127.0.0.1:${address.port}/`);

  const snapshot = await manager.snapshot(profile);
  /** @param {string} name */
  const ref = (name) => {
    const element = snapshot.elements.find((candidate) => candidate.name === name);
    assert.ok(element, `${name} is in the snapshot`);
    return element.ref;
  };
  /** Waits for the page to ask for something. */
  const prompt = async () => {
    for (let attempt = 0; attempt < 40 && !manager.pendingPrompt(profile); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return manager.pendingPrompt(profile) ?? "";
  };

  assert.equal(await manager.type(profile, ref("Email"), "a"), "a");
  assert.equal(await manager.type(profile, ref("Email"), "bc", { append: true }), "abc");
  assert.equal(await manager.type(profile, ref("Password"), "hunter2"), "", "a typed password is not read back");
  assert.equal(await manager.type(profile, ref("Notes"), " world", { append: true }), "Hello world");
  assert.equal(await manager.type(profile, ref("Release notes"), "New notes"), "New notes");
  assert.equal(await manager.type(profile, ref("Notes"), "Replaced"), "Replaced");
  assert.equal(await manager.type(profile, ref("Release notes"), ""), "");

  await manager.click(profile, ref("Shadow button"));
  await manager.hover(profile, ref("Menu"));

  await manager.click(profile, ref("Delete"));
  assert.match(await prompt(), /confirm dialog: "Delete it\?"/);
  await manager.respond(profile, { accept: true });

  await manager.click(profile, ref("Upload"));
  assert.match(await prompt(), /file chooser/);
  await manager.respond(profile, { accept: true, files: [upload] });

  await manager.click(profile, ref("Date"));
  assert.match(await prompt(), /date picker/);
  await manager.respond(profile, { accept: true, text: "2026-10-20" });

  assert.equal(await manager.waitForText(profile, "ready now", 5_000), true);
  assert.equal(await manager.waitForText(profile, "never shown", 500), false);
  const log = (await manager.snapshot(profile)).text;
  for (const line of ["password length 7", "shadow clicked", "hovered", "confirm true", "file report.txt", "date 2026-10-20"]) {
    assert.ok(log.includes(line), `${line} happened`);
  }
  assert.ok(!log.includes("hunter2"), "the snapshot never shows the password");
});

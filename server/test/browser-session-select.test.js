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

// #locked undoes every change, like a controlled component that rejects it.
const PAGE = `<body>
  <label for="country">Country</label>
  <select id="country"><option value="">Choose</option><option value="us">United States</option><option value="ca">Canada</option></select>
  <select id="locked" aria-label="Locked"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <input id="name" aria-label="Name">
  <pre id="log"></pre>
  <script>
    const log = (line) => { document.getElementById("log").textContent += line + "\\n"; };
    document.getElementById("country").addEventListener("change", (e) => log("change " + e.target.value));
    const locked = document.getElementById("locked");
    locked.addEventListener("change", () => setTimeout(() => { locked.value = "a"; }, 20));
    document.getElementById("name").addEventListener("keydown", (e) => log("key " + e.key));
  </script>
</body>`;

test("agents choose dropdown options by label or value and see what the page kept", {
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
  const profile = `test-select-${crypto.randomBytes(4).toString("hex")}`;
  t.after(async () => {
    await manager.clear(profile).catch(() => {});
    server.close();
  });
  await manager.open(profile, `http://127.0.0.1:${address.port}/`);

  const snapshot = await manager.snapshot(profile);
  /** @param {string} name */
  const ref = (name) => {
    const element = snapshot.elements.find((candidate) => candidate.name === name);
    assert.ok(element, `${name} is in the snapshot`);
    return element;
  };
  const country = ref("Country");
  assert.equal(country.value, "Choose");
  assert.deepEqual(country.options, ["Choose", "United States", "Canada"]);

  assert.deepEqual(await manager.select(profile, country.ref, "canada"), { label: "Canada", value: "ca" });
  assert.deepEqual(await manager.select(profile, country.ref, "us"), { label: "United States", value: "us" });
  await assert.rejects(manager.select(profile, country.ref, "Mexico"), /Options: Choose \| United States \| Canada/);
  await assert.rejects(manager.click(profile, country.ref), /Use the select action/);
  await assert.rejects(manager.select(profile, ref("Locked").ref, "Beta"), /changed the dropdown back to "Alpha"/);

  await manager.type(profile, ref("Name").ref, "x");
  await manager.key(profile, "ArrowDown");
  const log = (await manager.snapshot(profile)).text;
  assert.match(log, /change ca\nchange us\n/);
  assert.match(log, /key ArrowDown/);
});

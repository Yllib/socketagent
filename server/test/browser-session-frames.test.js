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

/**
 * Serves one page on two ports. Ports do not change the site, so a frame from
 * the other port is cross-origin but stays in the page's process, the way
 * Google embeds business.google.com. A frame from localhost is cross-site, so
 * Chrome runs it in its own process.
 * @param {number[]} ports filled in once both servers listen
 */
function pages(ports) {
  /** @param {string} label */
  const button = (label) => `<button onclick="this.textContent='${label} clicked'">${label}</button>`;
  /** @type {Record<string, () => string>} */
  const routes = {
    "/": () => `<body style="margin:0">
      ${button("Top")}
      <iframe src="http://127.0.0.1:${ports[1]}/same-site" style="position:absolute;left:40px;top:60px;width:300px;height:120px;border:7px solid;padding:5px"></iframe>
      <iframe src="http://127.0.0.1:${ports[1]}/same-site" style="display:none"></iframe>
      <div style="height:1400px"></div>
      <iframe src="http://localhost:${ports[0]}/cross-site" style="margin-left:25px;width:340px;height:260px;border:3px solid;padding:9px"></iframe>
    </body>`,
    "/same-site": () => `<body style="margin:12px">${button("Same site")}</body>`,
    "/cross-site": () => `<body style="margin:4px">
      <input aria-label="Manager email"> ${button("Cross site")}
      <iframe src="http://127.0.0.1:${ports[1]}/nested" style="display:block;margin-top:30px;width:240px;height:90px;border:2px solid"></iframe>
    </body>`,
    "/nested": () => `<body style="margin:6px">${button("Nested")}</body>`,
  };
  return http.createServer((request, response) => {
    const route = routes[new URL(request.url || "/", "http://127.0.0.1").pathname];
    response.writeHead(route ? 200 : 404, { "Content-Type": "text/html" });
    response.end(route ? route() : "");
  });
}

/** @param {import("node:http").Server} server */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "0.0.0.0", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("snapshot reaches into same-site and cross-site frames, and clicks and types land there", {
  skip: !hasBrowser() && "No Chrome or Chromium installed",
  timeout: 60_000,
}, async (t) => {
  /** @type {number[]} */
  const ports = [];
  const servers = [pages(ports), pages(ports)];
  for (const server of servers) ports.push(await listen(server));
  const manager = new BrowserSessionManager();
  const profile = `test-frames-${crypto.randomBytes(4).toString("hex")}`;
  t.after(async () => {
    await manager.clear(profile).catch(() => {});
    for (const server of servers) server.close();
  });

  await manager.open(profile, `http://127.0.0.1:${ports[0]}/`);
  /**
   * @param {string} name
   * @param {string} [value]
   */
  const find = async (name, value) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const snapshot = await manager.snapshot(profile);
      const element = snapshot.elements.find((candidate) => candidate.name === name);
      if (element && (value === undefined || element.value === value)) return { snapshot, element };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No element named ${name}`);
  };

  const { snapshot } = await find("Nested");
  // The hidden duplicate frame lists nothing.
  assert.equal(snapshot.elements.filter((element) => element.name === "Same site").length, 1);
  assert.equal(snapshot.frames.length, 3);
  assert.equal(snapshot.elements.find((element) => element.name === "Top")?.frame, undefined);
  assert.match(snapshot.text, /\[Frame \d: http:\/\/localhost:\d+\/cross-site\]/);

  for (const name of ["Same site", "Cross site", "Nested", "Top"]) {
    const { element } = await find(name);
    await manager.click(profile, element.ref);
    await find(`${name} clicked`);
  }

  const { element: field } = await find("Manager email");
  await manager.type(profile, field.ref, "manager@example.com");
  await find("Manager email", "manager@example.com");
});

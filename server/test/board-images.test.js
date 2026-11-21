const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const root = require("./test-data-dir");
const { attachBoardImages } = require("#server/board-images");
const { loadOrCreateKeyPair, toBase64 } = require("#server/relay-crypto");
const { socketAgentDataPath } = require("#server/socket-agent-paths");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const before = path.join(root, "before.png");
fs.writeFileSync(before, png);

/** @param {string} text */
const imageLinks = (text) => [...text.matchAll(/socketagent:\/\/image\?[^\s)"]+/g)].map((match) => new URL(match[0]));

test("card images are saved on this computer and linked to it, code examples untouched", async () => {
  const detail = [
    `![Before](${before})`,
    "",
    "```socketagent-compare",
    JSON.stringify({ images: [{ src: before, label: "Before" }, { src: before, label: "After" }] }),
    "```",
    "",
    `Write \`![x](${before})\` to show one.`,
  ].join("\n");
  const result = await attachBoardImages(detail, "s1");
  assert.equal(result.failed, 0);
  const links = imageLinks(result.detail);
  assert.equal(links.length, 3);
  const key = toBase64(loadOrCreateKeyPair(socketAgentDataPath("relay-keys.json")).publicKey);
  for (const link of links) {
    assert.equal(link.searchParams.get("computer"), key);
    assert.ok(link.searchParams.get("computerName"));
    assert.match(link.searchParams.get("id") ?? "", /^[0-9a-f-]{36}$/);
  }
  assert.ok(result.detail.includes(`\`![x](${before})\``), "an example in code stays as written");

  const again = await attachBoardImages(result.detail, "s1");
  assert.equal(again.detail, result.detail, "saved links keep their computer and aren't saved twice");
});

test("an image that can't be saved counts once, not on later writes", async () => {
  const first = await attachBoardImages(`![Gone](${path.join(root, "missing.png")})`, "s1");
  assert.equal(first.failed, 1);
  const later = await attachBoardImages(`${first.detail}\n\nMore text.`, "s1");
  assert.equal(later.failed, 0);
});

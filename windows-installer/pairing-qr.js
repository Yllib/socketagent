// Draws the server's pairing code as a BMP for the installer's last page.
// Usage: node pairing-qr.js <server dir> <output.bmp> <max pixels>
// The code comes straight from show-pairing.js, so its tokens never pass
// through a command line or the setup log.

const { execFileSync } = require("child_process");
const fs = require("fs");
const { createRequire } = require("module");
const path = require("path");

const [serverArg, output, maxArg] = process.argv.slice(2);
if (!serverArg || !output) {
  console.error("Usage: node pairing-qr.js <server dir> <output.bmp> [max pixels]");
  process.exit(2);
}
const serverDir = path.resolve(serverArg);

const payload = execFileSync(process.execPath, [path.join(serverDir, "scripts", "show-pairing.js"), "--raw"], {
  encoding: "utf8",
}).trim();

// qrcode-terminal ships the QR encoder the console pairing code already uses.
const serverRequire = createRequire(path.join(serverDir, "package.json"));
const QRCode = serverRequire("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = serverRequire("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const qr = new QRCode(-1, QRErrorCorrectLevel.L);
qr.addData(payload);
qr.make();

const quiet = 4;
const modules = qr.getModuleCount() + quiet * 2;
// Whole pixels per module keep the edges sharp enough to scan off a screen.
const scale = Math.max(2, Math.floor(Number(maxArg || 240) / modules));
const size = modules * scale;
const rowBytes = Math.ceil((size * 3) / 4) * 4;
const pixels = Buffer.alloc(rowBytes * size, 0xff);
for (let y = 0; y < size; y++) {
  // BMP rows run bottom to top.
  const row = (size - 1 - y) * rowBytes;
  const r = Math.floor(y / scale) - quiet;
  for (let x = 0; x < size; x++) {
    const c = Math.floor(x / scale) - quiet;
    const dark = r >= 0 && c >= 0 && r < modules - quiet * 2 && c < modules - quiet * 2 && qr.isDark(r, c);
    if (dark) pixels.fill(0, row + x * 3, row + x * 3 + 3);
  }
}

const header = Buffer.alloc(54);
header.write("BM", 0, "ascii");
header.writeUInt32LE(54 + pixels.length, 2);
header.writeUInt32LE(54, 10);
header.writeUInt32LE(40, 14);
header.writeInt32LE(size, 18);
header.writeInt32LE(size, 22);
header.writeUInt16LE(1, 26);
header.writeUInt16LE(24, 28);
header.writeUInt32LE(pixels.length, 34);
fs.writeFileSync(output, Buffer.concat([header, pixels]));

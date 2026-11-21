#!/usr/bin/env node
"use strict";

/**
 * Installs SocketAgent's managed Antigravity CLI (`agy`) into
 * `~/.socket-agent/toolchains/agy` during OS bootstrap (`install-server.sh` /
 * `install.ps1`). Reuses the compiled SHA-512-verified downloader in
 * `server/dist/gemini-cli.js`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { agyVersion, installAgy, managedAgyDir } = require("../dist/gemini-cli");

async function main() {
  const binaryName = process.platform === "win32" ? "agy.exe" : "agy";
  const managedPath = path.join(managedAgyDir(process.env), binaryName);
  if (fs.existsSync(managedPath)) {
    const existingVersion = await agyVersion(managedPath, process.env);
    if (existingVersion) {
      console.log(`Managed Antigravity CLI already installed (${existingVersion})`);
      return;
    }
  }
  const version = await installAgy({
    env: process.env,
    onProgress: (message) => console.log(`  ${message}`),
  });
  console.log(`Managed Antigravity CLI installed (${version})`);
}

main().catch(
  /** @param {unknown} error */
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  },
);

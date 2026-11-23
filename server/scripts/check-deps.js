#!/usr/bin/env node
// Exits 0 when node_modules holds every package package-lock.json pins, at
// the pinned version, and 1 with the first few problems otherwise. Updates
// and service wrappers run `npm ci` only when this fails, so an update that
// leaves the lockfile alone skips the reinstall, and a node_modules that
// something else broke is repaired on the next start.
//
// Needs nothing from node_modules, so it runs before any install or build.
"use strict";
const fs = require("fs");
const path = require("path");

const serverDir = path.resolve(process.argv[2] || path.join(__dirname, ".."));

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** @returns {string[]} What is missing or stale, empty when node_modules matches the lockfile. */
function problems() {
  const lock = readJson(path.join(serverDir, "package-lock.json"));
  if (!isRecord(lock) || !isRecord(lock.packages)) return ["package-lock.json has no packages"];
  /** @type {string[]} */
  const found = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/") || !isRecord(entry) || entry.link === true) continue;
    // npm skips optional packages built for other platforms.
    const optional = entry.optional === true || entry.devOptional === true;
    /** @type {unknown} */
    let installed;
    try {
      installed = readJson(path.join(serverDir, key, "package.json"));
    } catch {
      if (!optional) found.push(`${key.slice("node_modules/".length)} is missing`);
      continue;
    }
    const version = isRecord(installed) ? installed.version : undefined;
    if (typeof entry.version === "string" && version !== entry.version) {
      found.push(`${key.slice("node_modules/".length)} is ${String(version)}, the lockfile pins ${entry.version}`);
    }
  }
  return found;
}

/** @type {string[]} */
let found;
try {
  found = problems();
} catch (error) {
  found = [error instanceof Error ? error.message : String(error)];
}
if (found.length) {
  console.log(`[deps] node_modules does not match package-lock.json: ${found.slice(0, 5).join("; ")}${found.length > 5 ? `; ${found.length - 5} more` : ""}`);
  process.exit(1);
}

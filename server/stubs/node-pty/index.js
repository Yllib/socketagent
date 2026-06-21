"use strict";

function spawn() {
  throw new Error("node-pty is not bundled with SocketAgent; use child_process.spawn instead.");
}

module.exports = { spawn };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repairWindowsManagedShims } = require('../dist/windows-managed-shims');
test('restricted PowerShell repair removes only managed npm shims with cmd alternatives', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-shims-'));
  try {
    const script = path.join(prefix, 'claude.ps1');
    const npmShim = '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\nnode_modules';
    fs.writeFileSync(script, npmShim);
    repairWindowsManagedShims(prefix, 'win32');
    assert.ok(fs.existsSync(script), 'preserve the only launcher');
    fs.writeFileSync(path.join(prefix, 'claude.cmd'), '@echo off');
    repairWindowsManagedShims(prefix, 'linux');
    assert.ok(fs.existsSync(script), 'do not change other platforms');
    repairWindowsManagedShims(prefix, 'win32');
    assert.ok(!fs.existsSync(script));
    fs.writeFileSync(script, 'Write-Output "custom launcher"');
    repairWindowsManagedShims(prefix, 'win32');
    assert.ok(fs.existsSync(script), 'preserve customized scripts');
    assert.ok(fs.existsSync(path.join(prefix, 'claude.cmd')));
  } finally { fs.rmSync(prefix, { recursive: true, force: true }); }
});

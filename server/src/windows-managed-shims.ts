import * as fs from "fs";
import * as path from "path";

// npm creates both .cmd and .ps1 launchers. PowerShell selects the .ps1 first,
// which breaks a bare `claude`/`codex` command under Restricted execution policy.
// Only remove npm-generated shims in our managed prefix, with a working .cmd sibling.
export function repairWindowsManagedShims(prefix: string, platform = process.platform): void {
  if (platform !== "win32") return;
  for (const name of ["claude", "codex"]) {
    const script = path.join(prefix, `${name}.ps1`);
    try {
      if (!fs.existsSync(path.join(prefix, `${name}.cmd`))) continue;
      const content = fs.readFileSync(script, "utf8");
      if (content.includes('$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent')
          && content.includes('node_modules')) fs.unlinkSync(script);
    } catch (error: any) {
      if (error.code !== "ENOENT") console.warn(`[Startup] Could not repair ${name} PowerShell shim: ${error.message}`);
    }
  }
}

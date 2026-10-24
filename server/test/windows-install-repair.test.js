const test = require("node:test");
const assert = require("node:assert/strict");
const { commandLineUses, repairInterruptedMove, wrapperWithHandoff } = require("#server/windows-install-repair");

/** @typedef {import("#server/windows-install-repair").InstallRepairHost} InstallRepairHost */
/** @typedef {import("#server/windows-install-repair").InstallRepairContext} InstallRepairContext */
/** @typedef {import("#server/windows-install-repair").TaskAction} TaskAction */
/** @typedef {import("#server/windows-install-repair").MachineProcess} MachineProcess */
/** @typedef {Partial<Record<import("#server/windows-install-repair").RepairTaskName, TaskAction>>} Tasks */
/**
 * @typedef {object} Layout
 * @property {Record<string, string>} [files]
 * @property {Tasks} [tasks]
 * @property {MachineProcess[]} [processes]
 * @property {Record<string, number>} [mtimes]
 * @property {string[]} [locked] folders something holds open
 * @property {number} [idleFor] how many waits pass before the server is idle
 * @property {boolean} [armGuard]
 */

// The layouts 384e156 left behind, as a fake host. Paths are compared
// case-insensitively like Windows does; a folder exists while any file does.

const ORIGINAL = "C:\\Users\\bobby\\socketclaude";
const ORIGINAL_SERVER = `${ORIGINAL}\\server`;
const ORIGINAL_BAT = `${ORIGINAL_SERVER}\\run-service.bat`;
const MACHINE_ROOT = "C:\\ProgramData\\SocketAgent";
const COPY = `${MACHINE_ROOT}\\socketagent`;
const COPY_SERVER = `${COPY}\\server`;
const COPY_BAT = `${COPY_SERVER}\\run-service.bat`;
const LOCAL_APP_DATA = "C:\\Users\\bobby\\AppData\\Local";
const LOCATION = `${LOCAL_APP_DATA}\\SocketAgent\\install-location.txt`;
const OWNER_LAUNCHER = `${LOCAL_APP_DATA}\\SocketAgent\\launchers\\socketagent-launcher-abc.exe`;
const COPY_LAUNCHER = `${COPY_SERVER}\\windows-service\\launchers\\socketagent-launcher-abc.exe`;
const SYSTEM = "S-1-5-18";
const OWNER = "S-1-5-21-1-2-3-1001";

const WRAPPER = [
  "@echo off",
  "setlocal EnableExtensions",
  ":loop",
  "call :arm_recovery",
  '"%NODE_EXE%" "%SERVER_SCRIPT%" >> "%LOG_FILE%" 2>&1',
  "goto loop",
  "",
  ":arm_recovery",
  "call :pin_profile",
  "exit /b 0",
  "",
].join("\r\n");

/** @param {string} root @param {Record<string, string>} [extra] */
const checkoutFiles = (root, extra = {}) => ({
  [`${root}\\.git\\HEAD`]: "ref: refs/heads/master",
  [`${root}\\server\\package.json`]: "{}",
  [`${root}\\server\\.env`]: "PORT=8085",
  [`${root}\\server\\windows-service.json`]: "{}",
  [`${root}\\server\\run-service.bat`]: WRAPPER,
  [`${root}\\server\\node_modules\\.package-lock.json`]: "{}",
  [`${root}\\server\\dist\\index.js`]: "",
  ...extra,
});

const copyFiles = (movedFrom = ORIGINAL) => checkoutFiles(COPY, {
  [`${COPY_SERVER}\\windows-service\\moved-from.txt`]: `\uFEFF${movedFrom}\r\n`,
  [COPY_LAUNCHER]: "MZ",
});

/** @param {string} bat @param {string} [execute] @param {string} [state] @returns {TaskAction} */
const task = (bat, execute = OWNER_LAUNCHER, state = "Running") => ({ execute, arguments: `"${bat}"`, actions: 1, state });

/** @param {number} pid @param {string} sid @param {string} commandLine @param {string} [name] @returns {MachineProcess} */
const process_ = (pid, sid, commandLine, name = "node.exe") => ({ pid, name, sid, commandLine });
/** @param {string} serverDir @param {number} [pid] */
const standbyFrom = (serverDir, pid = 500) => process_(pid, SYSTEM, `"C:\\Program Files\\nodejs\\node.exe" "${serverDir}\\dist\\windows-service-cli.js" arbitrate`);

/** @param {Layout} [layout] */
function fakeHost({ files = {}, tasks = {}, processes = [], mtimes = {}, locked = [], idleFor = 0, armGuard = true } = {}) {
  const store = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  const times = new Map(Object.entries(mtimes).map(([file, time]) => [file.toLowerCase(), time]));
  /** @param {string} file */
  const key = (file) => file.toLowerCase();
  /** @param {string} dir */
  const under = (dir) => Array.from(store.keys()).filter((file) => file === key(dir) || file.startsWith(`${key(dir)}\\`));
  const state = {
    tasks: structuredClone(tasks),
    processes: structuredClone(processes),
    log: /** @type {string[]} */ ([]),
    writes: /** @type {string[]} */ ([]),
    removed: /** @type {string[]} */ ([]),
    copied: /** @type {[string, string][]} */ ([]),
    serviceRestarts: 0,
    inspections: 0,
    exited: false,
    armed: 0,
    slept: 0,
    idleFor,
  };
  /** @type {InstallRepairHost} */
  const host = {
    exists: (file) => under(file).length > 0,
    readText: (file) => store.get(key(file)),
    writeText: (file, text) => { store.set(key(file), text); state.writes.push(file); },
    modifiedAt: (file) => times.get(key(file)),
    copyFile: (from, to) => { store.set(key(to), store.get(key(from))); state.copied.push([from, to]); },
    removeDir: (dir) => {
      if (locked.some((held) => key(held) === key(dir))) throw new Error("EBUSY: resource busy or locked");
      for (const file of under(dir)) store.delete(file);
      state.removed.push(dir);
    },
    inspect: async () => { state.inspections++; return { tasks: structuredClone(state.tasks), processes: structuredClone(state.processes) }; },
    pointTasks: async (serverDir, previousServerDir) => {
      for (const action of Object.values(state.tasks)) {
        if (action.arguments.toLowerCase() === `"${previousServerDir}\\run-service.bat"`.toLowerCase()) {
          action.arguments = `"${serverDir}\\run-service.bat"`;
          action.execute = OWNER_LAUNCHER;
        }
      }
    },
    restartServiceTask: async () => {
      state.serviceRestarts++;
      state.processes = state.processes.filter((process) => process.sid !== SYSTEM);
      const action = state.tasks.SocketAgentService;
      if (action) state.processes.push(standbyFrom(action.arguments.replace(/"/g, "").replace(/\\run-service\.bat$/i, ""), 900));
    },
    idleBlocker: () => (state.idleFor > 0 ? "sessions are running (s1:busy)" : null),
    armRecoveryGuard: () => { state.armed++; return armGuard; },
    exit: () => { state.exited = true; },
    sleep: async () => { state.slept++; state.idleFor--; },
    log: (message) => state.log.push(message),
  };
  /** @param {string} file */
  const text = (file) => store.get(key(file));
  return { host, state, text };
}

/** @param {Partial<InstallRepairContext>} [overrides] @returns {InstallRepairContext} */
const context = (overrides = {}) => ({
  serverDir: ORIGINAL_SERVER,
  repoRoot: ORIGINAL,
  machineRoot: MACHINE_ROOT,
  localAppData: LOCAL_APP_DATA,
  service: false,
  ...overrides,
});

// State 1: the owner's server runs from the original on the revert, and
// both tasks point at the copy, which nothing runs.
/** @returns {Required<Pick<Layout, "files" | "tasks" | "processes">>} */
function halfMoved() {
  return {
    files: {
      ...checkoutFiles(ORIGINAL),
      ...copyFiles(),
      [`${COPY}.copying\\server\\package.json`]: "{}",
      [`${MACHINE_ROOT}\\toolchains\\npm-global\\claude.cmd`]: "",
      [`${MACHINE_ROOT}\\browser-runtime\\executable-path`]: "",
      [`${MACHINE_ROOT}\\machine-server.json`]: "{}",
      [LOCATION]: `\uFEFF${COPY}`,
    },
    tasks: {
      SocketClaude: task(COPY_BAT, COPY_LAUNCHER),
      SocketAgentService: task(COPY_BAT, COPY_LAUNCHER, "Running"),
    },
    processes: [standbyFrom(ORIGINAL_SERVER)],
  };
}

test("an install the move never touched is left alone without a single read of the tasks", async () => {
  const { host, state } = fakeHost({
    files: { ...checkoutFiles(ORIGINAL), [`${MACHINE_ROOT}\\machine-server.json`]: "{}", [LOCATION]: ORIGINAL },
    tasks: { SocketClaude: task(ORIGINAL_BAT), SocketAgentService: task(ORIGINAL_BAT) },
  });
  assert.deepEqual(await repairInterruptedMove(host, context()), { status: "untouched" });
  assert.equal(state.inspections, 0);
  assert.deepEqual(state.log, []);
  assert.deepEqual(state.writes, []);
});

test("half-moved: the tasks come back to the original, the leftovers go, and the server keeps running", async () => {
  const { host, state, text } = fakeHost(halfMoved());
  assert.deepEqual(await repairInterruptedMove(host, context()), { status: "repaired" });
  assert.equal(state.tasks.SocketClaude?.arguments, `"${ORIGINAL_BAT}"`);
  assert.equal(state.tasks.SocketClaude?.execute, OWNER_LAUNCHER);
  assert.equal(state.tasks.SocketAgentService?.arguments, `"${ORIGINAL_BAT}"`);
  assert.equal(text(LOCATION), ORIGINAL);
  assert.deepEqual(state.removed, [COPY, `${COPY}.copying`, `${MACHINE_ROOT}\\toolchains`, `${MACHINE_ROOT}\\browser-runtime`]);
  assert.ok(host.exists(`${MACHINE_ROOT}\\machine-server.json`), "the machine marker stays");
  assert.ok(host.exists(ORIGINAL_SERVER), "the original is untouched");
  assert.equal(state.serviceRestarts, 0, "a SYSTEM standby from the original is left alone");
  assert.equal(state.exited, false);
  assert.equal(state.slept, 0, "no restart, so no waiting for idle");
});

test("half-moved, then repaired, is untouched the second time", async () => {
  const { host } = fakeHost(halfMoved());
  await repairInterruptedMove(host, context());
  assert.deepEqual(await repairInterruptedMove(host, context()), { status: "untouched" });
});

test("half-moved with SocketAgentService standing by from the copy restarts that task after re-pointing it", async () => {
  const layout = halfMoved();
  layout.processes = [standbyFrom(COPY_SERVER)];
  const { host, state } = fakeHost(layout);
  assert.deepEqual(await repairInterruptedMove(host, context()), { status: "repaired" });
  assert.equal(state.serviceRestarts, 1);
  assert.equal(state.tasks.SocketAgentService?.arguments, `"${ORIGINAL_BAT}"`);
  assert.ok(state.processes.some((process) => process.commandLine.includes(ORIGINAL_SERVER)), "stands by from the original now");
  assert.ok(state.removed.includes(COPY));
});

test("a server running from the copy is not ended, and the copy stays until the next start", async () => {
  const layout = halfMoved();
  layout.processes = [process_(600, SYSTEM, `node "${COPY_SERVER}\\dist\\index.js"`)];
  const { host, state } = fakeHost(layout);
  const result = await repairInterruptedMove(host, context());
  assert.equal(result.status, "pending");
  assert.match(result.reason, /in use \(600 node\.exe\)/);
  assert.equal(state.serviceRestarts, 0);
  assert.equal(state.tasks.SocketClaude?.arguments, `"${ORIGINAL_BAT}"`, "the tasks are still repaired");
  assert.ok(!state.removed.includes(COPY));
  assert.ok(state.removed.includes(`${MACHINE_ROOT}\\toolchains`), "folders nothing uses still go");
});

test("a SYSTEM server never ends its own task over a copy process", async () => {
  const layout = halfMoved();
  layout.processes = [process_(700, SYSTEM, `cmd /c "${COPY_SERVER}\\run-recovery.bat"`, "cmd.exe")];
  const { host, state } = fakeHost(layout);
  const result = await repairInterruptedMove(host, context({ service: true }));
  assert.equal(result.status, "pending");
  assert.match(result.reason, /in use \(700 cmd\.exe\)/);
  assert.equal(state.serviceRestarts, 0);
  assert.ok(!state.removed.includes(COPY));
});

test("a copy that came from another checkout is reported, not taken", async () => {
  const layout = halfMoved();
  Object.assign(layout.files, copyFiles("C:\\Users\\other\\socketagent"));
  const { host, state } = fakeHost(layout);
  const result = await repairInterruptedMove(host, context());
  assert.equal(result.status, "blocked");
  assert.match(result.warning, /copied from C:\\Users\\other\\socketagent rather than from C:\\Users\\bobby\\socketclaude/);
  assert.equal(state.tasks.SocketClaude?.arguments, `"${COPY_BAT}"`);
  assert.deepEqual(state.removed, []);
  assert.deepEqual(state.writes, []);
});

test("tasks pointing at a copy that is already gone come back to the only install left", async () => {
  const { host, state } = fakeHost({
    files: { ...checkoutFiles(ORIGINAL), [LOCATION]: COPY },
    tasks: { SocketAgent: task(COPY_BAT, COPY_LAUNCHER), SocketAgentService: task(COPY_BAT, COPY_LAUNCHER) },
  });
  assert.deepEqual(await repairInterruptedMove(host, context()), { status: "repaired" });
  assert.equal(state.tasks.SocketAgent?.arguments, `"${ORIGINAL_BAT}"`);
  assert.equal(state.tasks.SocketAgentService?.arguments, `"${ORIGINAL_BAT}"`);
});

test("tasks that will not change are reported after the attempt", async () => {
  const layout = halfMoved();
  const { host, state } = fakeHost(layout);
  host.pointTasks = async () => {};
  const result = await repairInterruptedMove(host, context());
  assert.equal(result.status, "blocked");
  assert.match(result.warning, /Could not point SocketClaude and SocketAgentService back/);
  assert.deepEqual(state.removed, []);
});

test("leftovers alone, after a hand repair, are removed", async () => {
  const { host, state } = fakeHost({
    files: {
      ...checkoutFiles(ORIGINAL),
      [`${COPY}.copying\\server\\package.json`]: "{}",
      [`${MACHINE_ROOT}\\toolchains\\npm-global\\claude.cmd`]: "",
    },
    tasks: { SocketClaude: task(ORIGINAL_BAT), SocketAgentService: task(ORIGINAL_BAT) },
  });
  assert.deepEqual(await repairInterruptedMove(host, context()), { status: "repaired" });
  assert.deepEqual(state.removed, [`${COPY}.copying`, `${MACHINE_ROOT}\\toolchains`]);
  assert.deepEqual(state.writes, []);
});

test("a folder something holds is kept whole and left for the next start, without a warning", async () => {
  const layout = halfMoved();
  layout.processes = [];
  const { host, state } = fakeHost({ ...layout, locked: [COPY] });
  const result = await repairInterruptedMove(host, context());
  assert.equal(result.status, "pending");
  assert.match(result.reason, /could not be removed: EBUSY/);
  assert.ok(host.exists(`${COPY_SERVER}\\windows-service\\moved-from.txt`));
  assert.deepEqual(state.removed, [`${COPY}.copying`, `${MACHINE_ROOT}\\toolchains`, `${MACHINE_ROOT}\\browser-runtime`]);
});

// State 2: a task started the copy, which updated itself to the revert and
// serves. The owner is signed in, so SocketAgentService stands by, also from
// the copy.
/** @returns {Required<Pick<Layout, "files" | "tasks" | "processes" | "mtimes">>} */
function runningFromCopy() {
  return {
    files: {
      ...checkoutFiles(ORIGINAL),
      ...copyFiles(),
      [`${COPY_SERVER}\\.env`]: "PORT=8085\nNEW=1",
      [`${MACHINE_ROOT}\\toolchains\\npm-global\\claude.cmd`]: "",
      [LOCATION]: COPY,
    },
    mtimes: { [`${COPY_SERVER}\\.env`]: 2000, [`${ORIGINAL_SERVER}\\.env`]: 1000 },
    tasks: { SocketAgent: task(COPY_BAT, COPY_LAUNCHER), SocketAgentService: task(COPY_BAT, COPY_LAUNCHER) },
    // This server's own launcher and wrapper name the copy too.
    processes: [
      process_(40, OWNER, `"${COPY_LAUNCHER}" "${COPY_BAT}"`, "socketagent-launcher-abc.exe"),
      process_(41, OWNER, `cmd.exe /d /s /c ""${COPY_BAT}""`, "cmd.exe"),
      standbyFrom(COPY_SERVER),
    ],
  };
}

const copyContext = (overrides = {}) => context({ serverDir: COPY_SERVER, repoRoot: COPY, ...overrides });

test("running from the copy: tasks and settings go back, then the wrapper hands over once idle", async () => {
  const { host, state, text } = fakeHost({ ...runningFromCopy(), idleFor: 2 });
  assert.deepEqual(await repairInterruptedMove(host, copyContext()), { status: "restarting" });
  assert.equal(state.tasks.SocketAgent?.arguments, `"${ORIGINAL_BAT}"`);
  assert.equal(state.tasks.SocketAgentService?.arguments, `"${ORIGINAL_BAT}"`);
  assert.equal(text(LOCATION), ORIGINAL);
  assert.equal(state.serviceRestarts, 1, "the SYSTEM standby moves to the original; this server's own tree does not count");
  assert.equal(state.slept, 2, "waited out the running session");
  assert.deepEqual(state.copied, [[`${COPY_SERVER}\\.env`, `${ORIGINAL_SERVER}\\.env`]]);
  assert.equal(text(`${ORIGINAL_SERVER}\\.env`), "PORT=8085\nNEW=1");
  assert.equal(state.armed, 1);
  assert.ok(state.exited);
  const bat = text(COPY_BAT);
  assert.match(bat, new RegExp(`:arm_recovery\\r\\nif exist "${ORIGINAL_BAT.replace(/\\/g, "\\\\")}" goto moved\\r\\ncall :pin_profile`));
  assert.match(bat, new RegExp(`:moved\\r\\n.*\\r\\ncall "${ORIGINAL_BAT.replace(/\\/g, "\\\\")}"\\r\\n.*returned.*\\r\\nexit 1\\r\\n$`));
  assert.ok(text(`${COPY_SERVER}\\windows-service\\moved-back-at.txt`), "the attempt is recorded");
  assert.equal(text(ORIGINAL_BAT), WRAPPER, "the original wrapper is not touched");
  assert.deepEqual(state.removed, [], "nothing is deleted under a running server");
  assert.ok(state.log.some((line) => line.startsWith("Waiting to move back")));
});

test("a handoff that bounced back is not tried again for ten minutes", async () => {
  const layout = runningFromCopy();
  layout.files[`${COPY_SERVER}\\windows-service\\moved-back-at.txt`] = new Date(Date.now() - 60_000).toISOString();
  const { host, state, text } = fakeHost(layout);
  const result = await repairInterruptedMove(host, copyContext());
  assert.equal(result.status, "pending");
  assert.match(result.reason, /started from C:\\ProgramData\\SocketAgent\\socketagent again/);
  assert.equal(state.exited, false);
  assert.equal(state.armed, 0);
  assert.equal(text(COPY_BAT), WRAPPER);
  assert.equal(state.tasks.SocketAgent?.arguments, `"${ORIGINAL_BAT}"`, "the tasks are repaired all the same");
  layout.files[`${COPY_SERVER}\\windows-service\\moved-back-at.txt`] = new Date(Date.now() - 11 * 60_000).toISOString();
  const again = fakeHost(layout);
  assert.deepEqual(await repairInterruptedMove(again.host, copyContext()), { status: "restarting" });
});

test("running from the copy with an older .env there keeps the original's settings", async () => {
  const layout = runningFromCopy();
  layout.mtimes = { [`${COPY_SERVER}\\.env`]: 1000, [`${ORIGINAL_SERVER}\\.env`]: 1000 };
  const { host, state } = fakeHost(layout);
  await repairInterruptedMove(host, copyContext());
  assert.deepEqual(state.copied, []);
});

test("running from the copy as SYSTEM hands over without touching its own task", async () => {
  const layout = runningFromCopy();
  layout.processes = [];
  const { host, state } = fakeHost(layout);
  assert.deepEqual(await repairInterruptedMove(host, copyContext({ service: true })), { status: "restarting" });
  assert.equal(state.serviceRestarts, 0);
  assert.ok(state.exited);
});

test("running from the copy, the next start from the original clears the copy once its launcher lets go", async () => {
  const first = fakeHost(runningFromCopy());
  await repairInterruptedMove(first.host, copyContext());
  // The copy's launcher still runs the wrapper that moved over.
  const held = fakeHost({
    files: { ...checkoutFiles(ORIGINAL), ...copyFiles(), [COPY_BAT]: first.text(COPY_BAT), [LOCATION]: ORIGINAL },
    tasks: first.state.tasks,
    processes: [process_(42, OWNER, `"${COPY_LAUNCHER}" --hide-parent-console "${COPY_BAT}"`, "socketagent-launcher-abc.exe")],
  });
  const pending = await repairInterruptedMove(held.host, context());
  assert.equal(pending.status, "pending");
  assert.match(pending.reason, /in use \(42 socketagent-launcher-abc\.exe\)/);
  assert.ok(held.host.exists(COPY));
  held.state.processes = [];
  assert.deepEqual(await repairInterruptedMove(held.host, context()), { status: "repaired" });
  assert.ok(!held.host.exists(COPY));
  assert.deepEqual(await repairInterruptedMove(held.host, context()), { status: "untouched" });
});

test("running from the copy with no original to go back to is reported and left serving", async () => {
  const layout = runningFromCopy();
  for (const file of Object.keys(layout.files)) if (file.startsWith(ORIGINAL)) delete layout.files[file];
  const { host, state } = fakeHost(layout);
  const result = await repairInterruptedMove(host, copyContext());
  assert.equal(result.status, "blocked");
  assert.match(result.warning, /copied from, C:\\Users\\bobby\\socketclaude, is missing or incomplete/);
  assert.equal(state.inspections, 0);
  assert.equal(state.tasks.SocketAgent?.arguments, `"${COPY_BAT}"`);
  assert.equal(state.exited, false);
});

test("running from the copy without a restart guard keeps serving and tries again later", async () => {
  const { host, state, text } = fakeHost({ ...runningFromCopy(), armGuard: false });
  const result = await repairInterruptedMove(host, copyContext());
  assert.equal(result.status, "pending");
  assert.equal(state.exited, false);
  assert.equal(text(COPY_BAT), WRAPPER, "no handoff without a guard");
  assert.equal(state.tasks.SocketAgent?.arguments, `"${ORIGINAL_BAT}"`, "the tasks are repaired all the same");
});

test("wrapperWithHandoff inserts the jump after :arm_recovery once and keeps the line endings", () => {
  const once = wrapperWithHandoff(WRAPPER, ORIGINAL_BAT);
  assert.equal(once.split("\r\n").length, WRAPPER.split("\r\n").length + 7);
  assert.ok(once.startsWith(WRAPPER.split(":arm_recovery")[0]), "nothing above the label moves");
  assert.equal(wrapperWithHandoff(once, ORIGINAL_BAT), once);
  assert.equal(wrapperWithHandoff("@echo off\r\n:loop\r\ngoto loop\r\n", ORIGINAL_BAT), undefined);
});

test("commandLineUses matches a folder and its contents, not a sibling with the same prefix", () => {
  assert.ok(commandLineUses(`node "${COPY_SERVER}\\dist\\index.js"`, COPY));
  assert.ok(commandLineUses(`cmd /c ${COPY}`, COPY));
  assert.ok(commandLineUses(`"${COPY}"`, `${COPY}\\`));
  assert.ok(!commandLineUses(`rd /s /q "${COPY}.copying"`, COPY));
  assert.ok(!commandLineUses(`node "${MACHINE_ROOT}\\toolchains\\npm-global\\cli.js"`, COPY));
  assert.ok(commandLineUses(`node "${MACHINE_ROOT}\\toolchains\\npm-global\\cli.js"`, `${MACHINE_ROOT}\\toolchains`));
});

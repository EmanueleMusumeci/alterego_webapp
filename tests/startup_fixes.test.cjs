const assert = require('node:assert/strict');
const { loadModule } = require('./vm_loader.cjs');

const R = 'robot_adriano';
const TTS = `/${R}/text2speech`, STT = `/${R}/speech2text`;

// Fake ROS graph: `present` holds running nodes; relaunching a launch may add its node.
async function loadWorkflow({ present, onLaunch = () => {} }) {
    const log = { launches: [], events: [], popups: [] };
    const waitForNodes = async (nodes) => {
        const missing = nodes.filter(n => !present.has(n));
        return { ready: missing.length === 0, missing };
    };
    const never = new Promise(() => {});
    const wf = await loadModule('workflow.js', {
        './api.js': {
            sendCommand: async () => true,
            sendLocalCommand: (cmd) => { log.launches.push(cmd); onLaunch(cmd); return never; },
            getRobotName: async () => R, initializeIMU: async () => true,
            handleDockingMovement: async () => true, initializeSystem: async () => true,
            waitForPowerAlertTrigger: async () => true,
            showSyncedPopup: async (_ws, p) => { log.popups.push(p.title); return true; },
            targetReachedCheck: async () => true, checkNodeStatus: async () => true,
            pingRemoteComputer: async () => true, waitForNodes
        },
        './batterymonitor.js': { batteryMonitor: {
            updateFSMState() {}, timerIsSet: () => false, getState: () => 0,
            checkNeedChargeTrigger: () => false, getNeedCharge: () => false, getPowerAlert: () => true
        } },
        './constants.js': {
            ROS_COMMANDS: { SETUP: 'base', SETUP_LOCAL: 'local', CLEAR_LOG: 'clear' },
            LAUNCH_COMMANDS: { TTS: 'launch_tts', STT2: 'launch_stt', FACE_TRACKING: 'launch_face', BREATH: 'launch_breath' },
            STATE: { INIT: 0, ACTIVATE_ROBOT: 1, STAND_UP: 2, WORK_MODE: 3, PAUSED: 4 }
        },
        './utils.js': { showLoading() {}, updateUI() {} },
        './startupLog.js': {
            logStartupEvent: (_id, event, f) => log.events.push({ event, ...f }),
            newStartupAttemptId: () => 'test-attempt'
        }
    }, {
        // Collapse the owner's fixed sleeps so tests run fast.
        setTimeout: (fn) => setTimeout(fn, 0), setInterval: () => 0, clearInterval() {}
    });
    return { wf, log };
}

async function testBothPresent() {
    const { wf, log } = await loadWorkflow({ present: new Set([TTS, STT]) });
    assert.equal(await wf.ensureSpeechReady(R, 'a'), true);
    assert.equal(log.launches.length, 0, 'no relaunch when both nodes run');
}

async function testRelaunchOnlyMissing() {
    const present = new Set([TTS]);
    // The launch promise never resolves: ensureSpeechReady must not await it.
    const { wf, log } = await loadWorkflow({ present, onLaunch: c => { if (c.includes('launch_stt')) present.add(STT); } });
    assert.equal(await wf.ensureSpeechReady(R, 'a'), true);
    assert.equal(log.launches.length, 1);
    assert.match(log.launches[0], /launch_stt$/);
}

async function testStillMissingBlocksWorkMode() {
    const { wf, log } = await loadWorkflow({ present: new Set([TTS, '/rosout', `/${R}/move_base`, `/${R}/navigation`]) });
    assert.equal(await wf.ensureSpeechReady(R, 'a'), false);
    const states = [];
    const state = { pipelineState: 0, isPowered: true };
    const ws = { send: (m) => { const d = JSON.parse(m).data; if (d && 'pipelineState' in d) states.push(d.pipelineState); } };
    assert.equal(await wf.robotPowerOnClick(ws, state, R, 'a'), false);
    assert.ok(!states.includes(3), 'WORK_MODE must not be set when speech is missing');
    assert.notEqual(state.pipelineState, 3);
    assert.ok(log.events.some(e => e.event === 'startup.check' && e.stage === 'speech' && e.outcome === 'failed'));
}

async function testResumeStaysPaused() {
    const { wf, log } = await loadWorkflow({ present: new Set([TTS]) });
    const state = { pipelineState: 4 };
    assert.equal(await wf.restartFromPauseProcedures({ send() {} }, state, R), false);
    assert.equal(state.pipelineState, 4);
    assert.deepEqual(log.popups, ['Speech not ready']);
}

async function testOptionalNodesDoNotAbort() {
    const { wf, log } = await loadWorkflow({ present: new Set([TTS, STT, `/${R}/move_base`, `/${R}/navigation`]) });
    assert.equal(await wf.standUpProcedures({ send() {} }, R, 'a'), true);
    for (const stage of ['face_tracking', 'breath']) {
        assert.ok(log.events.some(e => e.event === 'startup.check' && e.stage === stage && e.outcome === 'failed'), stage);
    }
}

async function testLaunchOutputGoesToFile() {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { execSync } = require('node:child_process');
    const c = await loadModule('constants.js', {}, { fetch: async () => ({ ok: false }) });
    c.updateLaunchCommands();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'launchlog-'));
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'roslaunch'), '#!/bin/sh\necho out-$2; echo err-$2 >&2\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, 'webapp_launch_logs'));
    const old = path.join(home, 'webapp_launch_logs', 'tts_old.log');
    fs.writeFileSync(old, 'x');
    fs.utimesSync(old, new Date(Date.now() - 20 * 86400e3), new Date(Date.now() - 20 * 86400e3));
    for (const [key, name] of [['TTS', 'tts'], ['STT2', 'stt'], ['FACE_TRACKING', 'face_tracking']]) {
        const cmd = c.LAUNCH_COMMANDS[key];
        assert.ok(!cmd.includes("'"), `${key} must not contain single quotes (bash -c '...')`);
        assert.match(cmd, new RegExp(` >> ~/webapp_launch_logs/${name}_\\$\\(date \\+%F_%H%M%S\\)\\.log 2>&1$`));
        // Same wrapper as executeLocal in src/webapp.js.
        const stdout = execSync(`bash -c '${cmd}'`, { env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}` } });
        assert.equal(stdout.toString(), '', `${key} stdout must not reach exec()`);
    }
    const logs = fs.readdirSync(path.join(home, 'webapp_launch_logs'));
    assert.ok(!logs.includes('tts_old.log'), 'logs older than 14 days are pruned');
    for (const name of ['tts', 'stt', 'face_tracking']) {
        const f = logs.find(l => new RegExp(`^${name}_\\d{4}-\\d\\d-\\d\\d_\\d{6}\\.log$`).test(l));
        assert.ok(f, `log file for ${name}`);
        assert.match(fs.readFileSync(path.join(home, 'webapp_launch_logs', f), 'utf8'), /out-.*\nerr-/s);
    }
    fs.rmSync(home, { recursive: true, force: true });
}

async function testStartWaitsForBase() {
    // updateUI: Start disabled in INIT until the base answers over SSH.
    const els = {};
    const el = () => ({ disabled: null, style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} } });
    const document = { getElementById: id => (els[id] = els[id] || el()), querySelector: q => (els[q] = els[q] || el()) };
    const utils = await loadModule('utils.js', {
        './api.js': { sendLocalCommand() {} },
        './batterymonitor.js': { batteryMonitor: { getPowerAlert: () => false } },
        './constants.js': {
            STATE: { INIT: 0, WORK_MODE: 3 },
            UI_STATES: { POWER_ON: {}, POWER_OFF: {}, SYSTEM_RUNNING: {}, SYSTEM_READY: {} }
        }
    }, { document, localStorage: {} });
    utils.updateUI({ pipelineState: 0, baseReady: false });
    assert.equal(els.mainBtn.disabled, true);
    assert.equal(els['#systemStatus + span'].textContent, 'Waiting for base computer');
    utils.updateUI({ pipelineState: 0, baseReady: true });
    assert.equal(els.mainBtn.disabled, false);

    // isBaseReady reads /api/base-ready and treats any failure as not ready.
    let reply;
    const api = await loadModule('api.js', {
        './batterymonitor.js': { batteryMonitor: {} },
        './constants.js': { NUC_BASE_IP: '', ROS_CATKIN_WS: '', ROS_HOSTNAME: '', ROS_IP: '', ROS_MASTER_URI: '',
            ROS_SRC_FOLDER: '', ROS_COMMANDS: { SETUP: '' }, LAUNCH_COMMANDS: {} },
        './utils.js': { updateBatteryGraphics() {} },
        './startupLog.js': { logStartupEvent() {} }
    }, { fetch: async (url) => { assert.equal(url, '/api/base-ready'); return reply(); } });
    reply = () => ({ ok: true, json: async () => ({ ready: true }) });
    assert.equal(await api.isBaseReady(), true);
    reply = () => ({ ok: true, json: async () => ({ ready: false }) });
    assert.equal(await api.isBaseReady(), false);
    reply = () => { throw new Error('offline'); };
    assert.equal(await api.isBaseReady(), false);

    // A Start press with the base not ready does not start the robot.
    let starts = 0;
    const state = { pipelineState: 0, isPowered: false, baseReady: true };
    const handler = await loadModule('handlerButtonClick/handleMainButtonClick.js', {
        '../api.js': { isBaseReady: async () => false, showSyncedPopup: async () => true },
        '../constants.js': { STATE: { INIT: 0, DOCKED: 1, RECOVERY_FROM_EMERGENCY: 2, WORK_MODE: 3, PAUSED: 4 } },
        '../utils.js': { updateUI() {} },
        '../workflow.js': { robotPowerOnClick: async () => { starts++; return true; },
            pauseProcedures() {}, restartFromPauseProcedures() {}, endChargeProcedures() {} },
        '../startupLog.js': { logStartupEvent() {}, newStartupAttemptId: () => 't' }
    }, { document: { getElementById: () => ({ disabled: false }) } });
    await handler.handleMainButtonClick({ send() {} }, state, R);
    assert.equal(starts, 0);
    assert.equal(state.baseReady, false);
}

// A hung await leaves the event loop empty and node exits 0: fail unless the end is reached.
process.exitCode = 1;
(async () => {
    await testBothPresent();
    await testRelaunchOnlyMissing();
    await testStillMissingBlocksWorkMode();
    await testResumeStaysPaused();
    await testOptionalNodesDoNotAbort();
    await testLaunchOutputGoesToFile();
    await testStartWaitsForBase();
    console.log('startup fixes tests passed');
    process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

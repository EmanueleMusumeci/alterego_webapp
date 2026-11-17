const assert = require('node:assert/strict');
const { loadModule } = require('./vm_loader.cjs');

const R = 'robot_adriano';
const TTS = `/${R}/text2speech`, STT = `/${R}/speech2text`;

// Fake ROS graph: `present` holds running nodes; relaunching a launch may add its node.
// Any other command name (also nested, e.g. STOP_PILOT.R_CTRL) reads as its own path.
function anyCommand(name, known = {}) {
    return new Proxy(known, { get: (t, k) => k === Symbol.toPrimitive ? () => name
        : (k in t ? t[k] : anyCommand(`${name}.${String(k)}`)) });
}

const EVENT_RE = /^([a-z]+\.)?[a-z_]{2,40}$/;  // server whitelist in src/webapp.js

async function loadWorkflow({ present, onLaunch = () => {}, battery = {}, settings = {} }) {
    const log = { launches: [], events: [], popups: [], order: [], commands: [], calls: [] };
    const cfg = { autoShutdownOnDock: true, headMotion: true, gestures: true, ...settings };
    let ids = 0;
    const waitForNodes = async (nodes) => {
        const missing = nodes.filter(n => !present.has(n));
        return { ready: missing.length === 0, missing };
    };
    const never = new Promise(() => {});
    const wf = await loadModule('workflow.js', {
        './api.js': {
            sendCommand: async (cmd) => { log.commands.push(cmd); log.order.push(cmd); return true; },
            sendLocalCommand: (cmd) => { log.launches.push(cmd); log.order.push(cmd); onLaunch(cmd); return never; },
            getRobotName: async () => R, initializeIMU: async () => { log.calls.push('imu'); return true; },
            handleDockingMovement: async () => { log.calls.push('docking'); return true; },
            initializeSystem: async () => { log.calls.push('system'); return true; },
            waitForPowerAlertTrigger: async () => true,
            showSyncedPopup: async (_ws, p) => { log.popups.push(p.title); return true; },
            targetReachedCheck: async () => true, checkNodeStatus: async () => true,
            pingRemoteComputer: async () => true, waitForNodes
        },
        './batterymonitor.js': { batteryMonitor: {
            updateFSMState() {}, timerIsSet: () => false, getState: () => 0,
            checkNeedChargeTrigger: () => false, getNeedCharge: () => false, getPowerAlert: () => true,
            getBatteryLevel: () => 50, getReadingAgeMs: () => null, getIsCharging: () => false, getIsDocked: () => false,
            ...battery
        } },
        './constants.js': {
            ROS_COMMANDS: { SETUP: 'base', SETUP_LOCAL: 'local', CLEAR_LOG: 'clear' },
            LAUNCH_COMMANDS: anyCommand('', { TTS: 'launch_tts', STT2: 'launch_stt', FACE_TRACKING: 'launch_face',
                BREATH: 'launch_breath', SAY_TIRED: 'launch_say_tired', NAVIGATION: 'launch_nav', ROSCORE: 'launch_roscore',
                TOUR_NAVIGATION: 'launch_tour_nav', TOUR_STATE_MACHINE: 'launch_tour_sm',
                TOUR_NODES: ['/obstacle_manager', '/navigation_server', '/top_level_state_machine_node'] }),
            STATE: { INIT: 0, ACTIVATE_ROBOT: 1, STAND_UP: 2, WORK_MODE: 3, PAUSED: 4 }
        },
        './utils.js': { showLoading() {}, updateUI() {} },
        './settings.js': { loadSettings: async () => cfg, getSetting: k => cfg[k] },
        './startupLog.js': {
            logStartupEvent: (id, event, f) => {
                assert.match(event, EVENT_RE, `event name ${event} must pass the server whitelist`);
                log.events.push({ id, event, ...f }); log.order.push(event);
            },
            newStartupAttemptId: () => `attempt-${++ids}`
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
    fs.mkdirSync(path.join(home, '.ros', 'log', 'webapp_launch'), { recursive: true });
    const old = path.join(home, '.ros', 'log', 'webapp_launch', 'tts_old.log');
    fs.writeFileSync(old, 'x');
    fs.utimesSync(old, new Date(Date.now() - 20 * 86400e3), new Date(Date.now() - 20 * 86400e3));
    for (const [key, name] of [['TTS', 'tts'], ['STT2', 'stt'], ['FACE_TRACKING', 'face_tracking']]) {
        const cmd = c.LAUNCH_COMMANDS[key];
        assert.ok(!cmd.includes("'"), `${key} must not contain single quotes (bash -c '...')`);
        assert.match(cmd, new RegExp(` >> ~/.ros/log/webapp_launch/${name}_\\$\\(date \\+%F_%H%M%S\\)\\.log 2>&1$`));
        // Same wrapper as executeLocal in src/webapp.js.
        const stdout = execSync(`bash -c '${cmd}'`, { env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}` } });
        assert.equal(stdout.toString(), '', `${key} stdout must not reach exec()`);
    }
    const logs = fs.readdirSync(path.join(home, '.ros', 'log', 'webapp_launch'));
    assert.ok(!logs.includes('tts_old.log'), 'logs older than 14 days are pruned');
    for (const name of ['tts', 'stt', 'face_tracking']) {
        const f = logs.find(l => new RegExp(`^${name}_\\d{4}-\\d\\d-\\d\\d_\\d{6}\\.log$`).test(l));
        assert.ok(f, `log file for ${name}`);
        assert.match(fs.readFileSync(path.join(home, '.ros', 'log', 'webapp_launch', f), 'utf8'), /out-.*\nerr-/s);
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
            pauseProcedures() {}, restartFromPauseProcedures() {}, endChargeProcedures() {}, startTour() {} },
        '../startupLog.js': { logStartupEvent() {}, newStartupAttemptId: () => 't' }
    }, { document: { getElementById: () => ({ disabled: false }) } });
    await handler.handleMainButtonClick({ send() {} }, state, R);
    assert.equal(starts, 0);
    assert.equal(state.baseReady, false);
}

async function testBatteryAge() {
    const { BatteryMonitor } = await loadModule('batterymonitor.js', {});
    const m = new BatteryMonitor();
    assert.equal(m.getReadingAgeMs(), null);
    m.updateState(false, false, true, true, 17);
    assert.equal(typeof m.lastUpdateMs, 'number');
    assert.ok(m.getReadingAgeMs() >= 0 && m.getReadingAgeMs() < 1000);
}

async function testLowBatteryShutdownLogged() {
    const { wf, log } = await loadWorkflow({ present: new Set(),
        battery: { getBatteryLevel: () => 12, getReadingAgeMs: () => 800, getIsDocked: () => true } });
    assert.equal(await wf.dockingProcedures({ send() {} }, { pipelineState: 3 }, 0.0, R), true);
    await new Promise(r => setTimeout(r, 50));  // robotPowerOffClick is not awaited
    const auto = log.events.find(e => e.event === 'shutdown.auto');
    assert.ok(auto, 'shutdown.auto logged');
    assert.match(auto.detail, /^reason=low_battery_docked level=12 age_ms=800 /);
    assert.ok(auto.detail.length <= 160);
    assert.ok(log.order.indexOf('shutdown.auto') < log.order.findIndex(c => /launch_say_tired$/.test(c)), 'logged before SAY_TIRED');
    const begin = log.events.find(e => e.event === 'shutdown.begin');
    assert.equal(begin && begin.id, auto.id, 'power-off uses the same attemptId');
}

async function testRetryAfterFailedStart() {
    const present = new Set([TTS, '/rosout', `/${R}/move_base`, `/${R}/navigation`]);  // STT missing
    const { wf, log } = await loadWorkflow({ present });
    const state = { pipelineState: 0, isPowered: true };
    const ws = { send() {} };
    assert.equal(await wf.robotPowerOnClick(ws, state, R, 'a'), false);
    assert.equal(state.startFailed, 'stand_up');
    assert.equal(state.pipelineState, 2);
    const before = log.events.filter(e => e.event === 'startup.state' && e.stage === 'activate_robot').length;
    present.add(STT);
    assert.equal(await wf.robotPowerOnClick(ws, state, R, 'b'), true);
    assert.equal(state.pipelineState, 3);
    assert.equal(state.startFailed, false);
    const after = log.events.filter(e => e.event === 'startup.state' && e.stage === 'activate_robot').length;
    assert.equal(after, before, 'retry after a failed stand-up skips activation (no second backward move)');

    // A stale flag in INIT (e.g. after a reboot) means a full start.
    const s2 = { pipelineState: 0, startFailed: 'stand_up' };
    await wf.robotPowerOnClick(ws, s2, R, 'c');
    assert.equal(log.events.filter(e => e.event === 'startup.state' && e.stage === 'activate_robot').length, after + 1);

    // Touch screen: Retry and Power Off enabled after a failed start, disabled while starting.
    const els = {};
    const el = () => ({ disabled: null, style: {}, textContent: '', innerHTML: '', classList: { add() {}, remove() {} } });
    const document = { getElementById: id => (els[id] = els[id] || el()), querySelector: q => (els[q] = els[q] || el()) };
    const utils = await loadModule('utils.js', {
        './api.js': { sendLocalCommand() {} },
        './batterymonitor.js': { batteryMonitor: { getPowerAlert: () => false } },
        './constants.js': { STATE: { INIT: 0, ACTIVATE_ROBOT: 1, STAND_UP: 2, WORK_MODE: 3 },
            UI_STATES: { POWER_ON: {}, POWER_OFF: {}, SYSTEM_RUNNING: {}, SYSTEM_READY: {} } }
    }, { document, localStorage: {} });
    utils.updateUI({ pipelineState: 2, startFailed: false });
    assert.equal(els.mainBtn.disabled, true);
    assert.equal(els.secondBtn.disabled, true);
    utils.updateUI({ pipelineState: 2, startFailed: 'stand_up' });
    assert.equal(els.mainBtn.disabled, false);
    assert.equal(els.secondBtn.disabled, false);
    assert.match(els.mainBtn.innerHTML, /Retry/);
}

const NAV = [`/${R}/move_base`, `/${R}/navigation`];
const has = (list, re) => list.some(c => re.test(c));

async function testStartModes() {
    // Start without motion: no IMU, body, docking move, breath or navigation; head off before face tracking.
    let w = await loadWorkflow({ present: new Set([TTS, STT, '/rosout']) });
    let state = { pipelineState: 0 };
    assert.equal(await w.wf.robotPowerOnClick({ send() {} }, state, R, 'a', 'static'), true);
    assert.equal(state.pipelineState, 3);
    assert.equal(state.startMode, 'static');
    assert.deepEqual(w.log.calls, [], 'static start must not call IMU, system or docking');
    assert.ok(!has(w.log.commands, /launch_breath|launch_nav|target_location/), 'static start: no breath or navigation');
    const headOff = w.log.order.findIndex(c => /auto_mode_status std_msgs\/Bool "data: false"/.test(c));
    assert.ok(headOff >= 0 && headOff < w.log.order.findIndex(c => /launch_face$/.test(c)), 'head off is published before face tracking starts');

    // Balance only: body activation yes, navigation no.
    w = await loadWorkflow({ present: new Set([TTS, STT, '/rosout']) });
    state = { pipelineState: 0 };
    assert.equal(await w.wf.robotPowerOnClick({ send() {} }, state, R, 'a', 'balance'), true);
    assert.ok(w.log.calls.includes('imu') && w.log.calls.includes('system'));
    assert.ok(!has(w.log.commands, /launch_nav|target_location/), 'balance start: no navigation');

    // Gestures off: no breathing rosbag; head motion on: no head-off message.
    w = await loadWorkflow({ present: new Set([TTS, STT, '/rosout', ...NAV]), settings: { gestures: false } });
    assert.equal(await w.wf.robotPowerOnClick({ send() {} }, { pipelineState: 0 }, R, 'a'), true);
    assert.ok(!has(w.log.commands, /launch_breath/));
    assert.ok(has(w.log.commands, /launch_nav/), 'full start still launches navigation');
    assert.ok(!has(w.log.launches, /auto_mode_status/));
}

async function testAutoShutdownSetting() {
    const { wf, log } = await loadWorkflow({ present: new Set(), settings: { autoShutdownOnDock: false },
        battery: { getBatteryLevel: () => 12, getReadingAgeMs: () => 800, getIsDocked: () => true } });
    assert.equal(await wf.dockingProcedures({ send() {} }, { pipelineState: 3 }, 0.0, R), true);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!has(log.launches, /launch_say_tired/), 'no say_tired when auto power-off is off');
    assert.ok(!log.events.some(e => e.event === 'shutdown.begin'), 'no power-off when auto power-off is off');
    assert.ok(log.events.some(e => e.event === 'shutdown.auto_skipped'));
}

async function testTour() {
    const tour = ['/obstacle_manager', '/navigation_server', '/top_level_state_machine_node'].map(n => `/${R}${n}`);
    const { wf, log } = await loadWorkflow({ present: new Set([...tour]) });
    const state = { pipelineState: 3, startMode: 'full' };
    assert.equal(await wf.startTour({ send() {} }, state, R, 'a'), true);
    assert.equal(state.startMode, 'tour');
    assert.ok(!has(log.commands, /launch_roscore/), 'robot already started: tour nodes only');
    const nav = log.launches.findIndex(c => /launch_tour_nav$/.test(c));
    const sm = log.launches.findIndex(c => /launch_tour_sm$/.test(c));
    assert.ok(nav >= 0 && sm > nav, 'navigation server before the tour state machine');
    await wf.pauseProcedures({ send() {} }, state, R);
    assert.ok(has(log.launches, /rosnode kill .*top_level_state_machine_node/), 'pause stops the tour');
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
    await testBatteryAge();
    await testLowBatteryShutdownLogged();
    await testRetryAfterFailedStart();
    await testStartModes();
    await testAutoShutdownSetting();
    await testTour();
    console.log('startup fixes tests passed');
    process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

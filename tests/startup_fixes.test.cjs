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

// A hung await leaves the event loop empty and node exits 0: fail unless the end is reached.
process.exitCode = 1;
(async () => {
    await testBothPresent();
    await testRelaunchOnlyMissing();
    await testStillMissingBlocksWorkMode();
    await testResumeStaysPaused();
    await testOptionalNodesDoNotAbort();
    console.log('startup fixes tests passed');
    process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

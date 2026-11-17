const assert = require('node:assert/strict');

const { loadModule } = require('./vm_loader.cjs');

async function testNodeReadiness() {
    let output = '/rosout\n';
    const api = await loadModule('api.js', {
        './batterymonitor.js': { batteryMonitor: {} },
        './constants.js': {
            NUC_BASE_IP: '', ROS_CATKIN_WS: '', ROS_HOSTNAME: '', ROS_IP: '',
            ROS_MASTER_URI: '', ROS_SRC_FOLDER: '',
            ROS_COMMANDS: { SETUP: 'source setup' }, LAUNCH_COMMANDS: {}
        },
        './utils.js': { updateBatteryGraphics() {} },
        './startupLog.js': { logStartupEvent() {} }
    }, {
        fetch: async (url, options) => {
            assert.equal(url, '/grep-command');
            assert.match(JSON.parse(options.body).command, /rosnode list$/);
            return { ok: true, json: async () => ({ output }) };
        }
    });

    const ready = await api.waitForNodes(['/rosout'], 100);
    assert.equal(ready.ready, true);
    const missing = await api.waitForNodes(['/robot_adriano/move_base'], 20);
    assert.equal(missing.ready, false);
    assert.deepEqual(Array.from(missing.missing), ['/robot_adriano/move_base']);
    output = '/robot_adriano/move_base\n';
    const exact = await api.waitForNodes(['/robot_adriano/move_base_extra'], 20);
    assert.equal(exact.ready, false, 'readiness must use exact node names');
}

async function testStartStaysBusy() {
    let resolveStart;
    const startup = new Promise(resolve => { resolveStart = resolve; });
    const button = { disabled: false };
    let updates = 0;
    let starts = 0;
    const state = { pipelineState: 0, isPowered: false, isRunning: false };
    const ws = { send() {} };
    const handler = await loadModule('handlerButtonClick/handleMainButtonClick.js', {
        '../api.js': { isBaseReady: async () => true, showSyncedPopup: async () => true },
        '../constants.js': { STATE: { INIT: 0, DOCKED: 1, RECOVERY_FROM_EMERGENCY: 2, WORK_MODE: 3, PAUSED: 4 } },
        '../utils.js': { updateUI() { updates++; } },
        '../workflow.js': {
            robotPowerOnClick: async () => { starts++; return startup; },
            pauseProcedures() {}, restartFromPauseProcedures() {}, endChargeProcedures() {}
        },
        '../startupLog.js': { logStartupEvent() {}, newStartupAttemptId: () => 'test-attempt' }
    }, { document: { getElementById: () => button } });

    const first = handler.handleMainButtonClick(ws, state, 'robot_adriano');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(button.disabled, true);
    assert.equal(await handler.handleMainButtonClick(ws, state, 'robot_adriano'), false);
    assert.equal(starts, 1, 'a second click must not start another workflow');
    resolveStart(true);
    await first;
    assert.equal(updates, 1, 'UI refresh happens after startup settles');
}

// A hung await leaves the event loop empty and node exits 0: fail unless the end is reached.
process.exitCode = 1;
(async () => {
    await testNodeReadiness();
    await testStartStaysBusy();
    console.log('startup synchronization tests passed');
    process.exitCode = 0;
})().catch(error => { console.error(error); process.exitCode = 1; });

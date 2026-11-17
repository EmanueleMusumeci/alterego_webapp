// Settings and Status panels (Admin Menu). Touch screen only: big buttons, no typed input.
import { batteryMonitor } from './batterymonitor.js';
import { ROS_COMMANDS, STATE } from './constants.js';
import { showSyncedPopup } from './api.js';
import { loadSettings, saveSetting } from './settings.js';
import { applyHeadMotion, stopBreath, startBreathNow, restartSpeech } from './workflow.js';
import { handleStartMode } from './handlerButtonClick/handleMainButtonClick.js';
import { closeAdminMenu } from './utils.js';

const NODE_GROUPS = [
    ['Core', ['/rosout']],
    ['Speech', ['/text2speech', '/speech2text']],
    ['Perception', ['/face_tracker', '/face_recognition']],
    ['Body', ['/rosbag_play']],
    ['Navigation', ['/move_base', '/navigation']],
    ['Tour', ['/obstacle_manager', '/navigation_server', '/top_level_state_machine_node']]
];
const STATE_NAMES = Object.keys(STATE).reduce((m, k) => { m[STATE[k]] = k; return m; }, {});

let ctx;            // { getWs, state, robotName }
let statusTimer = null;

const $ = (sel) => document.querySelector(sel);
const robotIsUp = () => ctx.state.pipelineState == STATE.WORK_MODE || ctx.state.pipelineState == STATE.PAUSED;

function renderToggles(settings) {
    document.querySelectorAll('#settingsPanel [data-setting]').forEach(btn => {
        const on = settings[btn.dataset.setting] === true;
        btn.classList.toggle('on', on);
        btn.textContent = on ? 'ON' : 'OFF';
    });
}

async function toggleSetting(key) {
    const current = (await loadSettings())[key];
    const settings = await saveSetting(key, !current);
    renderToggles(settings);
    const { state, robotName } = ctx;
    // Apply at once where it is safe; otherwise the value is used at the next start or resume.
    if (key === 'headMotion' && robotIsUp() && !(settings.headMotion && state.startMode === 'static')) {
        applyHeadMotion(robotName, settings.headMotion);
    }
    if (key === 'gestures' && state.pipelineState == STATE.WORK_MODE) {
        if (!settings.gestures) stopBreath(robotName);
        else if (state.startMode !== 'static') startBreathNow(robotName);
    }
}

async function refreshLog() {
    try {
        const rows = await (await fetch('/api/startup-log/recent')).json();
        $('#sgLog').textContent = rows.length ? rows.map(r =>
            `${(r.serverTime || '').slice(11, 19)} ${r.event}${r.stage ? ' ' + r.stage : ''}` +
            `${r.outcome ? ' ' + r.outcome : ''}${r.detail ? ' (' + r.detail + ')' : ''}`).join('\n') : 'No events since the webapp started.';
    } catch (error) {
        $('#sgLog').textContent = 'Log not available: ' + error.message;
    }
}

function tile(label, ok, text) {
    const cls = ok === null ? 'na' : (ok ? 'ok' : 'bad');
    return `<div class="sg-tile ${cls}"><b>${label}</b>${text || (ok === null ? 'n/a' : (ok ? 'OK' : 'missing'))}</div>`;
}

async function refreshStatus() {
    const { state, robotName } = ctx;
    let status = null, nodes = null;
    try { status = await (await fetch('/api/status')).json(); } catch (error) { /* shown as n/a */ }
    try {
        const r = await fetch('/grep-command', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: `${ROS_COMMANDS.SETUP} && rosnode list` })
        });
        const out = r.ok ? ((await r.json()).output || '') : '';
        nodes = out.includes('Unable to communicate') ? null : new Set(out.split(/\r?\n/).map(s => s.trim()));
    } catch (error) { /* shown as n/a */ }
    const age = batteryMonitor.getReadingAgeMs();
    const fresh = age !== null && age < 10000;
    let html = '<div class="sg-group">Robot</div><div class="sg-tiles">' +
        tile('State', true, `${STATE_NAMES[state.pipelineState] || state.pipelineState}${state.startMode ? ' · ' + state.startMode : ''}`) +
        tile('Battery', age === null ? null : fresh, age === null ? 'no reading' :
            `${batteryMonitor.getBatteryLevel()} % · ${Math.round(age / 1000)} s ago${batteryMonitor.getIsCharging() ? ' · charging' : ''}${batteryMonitor.getIsDocked() ? ' · docked' : ''}`) +
        '</div><div class="sg-group">PCs</div><div class="sg-tiles">' +
        tile('Base PC', status ? status.base.reachable : null, status && status.base.reachable ? `up ${Math.round(status.base.uptimeS / 60)} min` : '') +
        tile('Vision PC', status ? true : null, status ? `up ${Math.round(status.vision.uptimeS / 60)} min · disk ${status.vision.diskFree} free` : '') +
        '</div><div class="sg-group">Speech servers</div><div class="sg-tiles">' +
        (status ? status.backends.map(b => tile(b.name.toUpperCase(), b.ok, b.ok ? 'answers' : 'no answer')).join('') : tile('Backends', null)) +
        '</div>';
    html += `<div class="sg-group">ROS ${nodes ? '' : '(master not running)'}</div>`;
    for (const [group, names] of NODE_GROUPS) {
        html += `<div class="sg-note">${group}</div><div class="sg-tiles">` + names.map(n => {
            const full = n === '/rosout' ? n : `/${robotName}${n}`;
            return tile(n.slice(1), nodes ? nodes.has(full) : null);
        }).join('') + '</div>';
    }
    if (status) html += `<div class="sg-note">Webapp ${status.webapp.branch} @ ${status.webapp.commit}</div>`;
    $('#sgStatus').innerHTML = html;
}

async function onRestartSpeech() {
    const { state, robotName } = ctx;
    const ws = ctx.getWs();
    if (!robotIsUp()) {
        await showSyncedPopup(ws, { title: 'Restart speech', text: 'Start the robot first.', icon: 'info' });
        return;
    }
    const ok = await showSyncedPopup(ws, {
        title: 'Restart speech', text: 'Speech recognition and synthesis will restart (about 1 minute). Continue?',
        icon: 'warning', showCancelButton: true, confirmButtonText: 'OK'
    });
    if (!ok) return;
    const ready = await restartSpeech(ws, robotName);
    await showSyncedPopup(ws, ready
        ? { title: 'Speech ready', text: 'Speech recognition and synthesis are running.', icon: 'success', timer: 3000, showConfirmButton: false }
        : { title: 'Speech not ready', text: 'See Settings > Generale > Startup log.', icon: 'error' });
}

function openPanel(id) {
    closeAdminMenu();
    $(id).classList.add('open');
}

function closePanels() {
    document.querySelectorAll('.sg-panel').forEach(p => p.classList.remove('open'));
    clearInterval(statusTimer);
    statusTimer = null;
}

export async function openSettingsPanel() {
    openPanel('#settingsPanel');
    renderToggles(await loadSettings());
    refreshLog();
}

export function openStatusPanel() {
    openPanel('#statusPanel');
    refreshStatus();
    statusTimer = setInterval(refreshStatus, 5000);
}

export function initSettingsPanel(context) {
    ctx = context;
    document.querySelectorAll('.sg-panel [data-close]').forEach(b => b.addEventListener('click', closePanels));
    document.querySelectorAll('#settingsPanel .sg-tab').forEach(tab => tab.addEventListener('click', () => {
        document.querySelectorAll('#settingsPanel .sg-tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('#settingsPanel .sg-section').forEach(s => s.classList.toggle('active', s.dataset.section === tab.dataset.tab));
    }));
    document.querySelectorAll('#settingsPanel [data-setting]').forEach(b =>
        b.addEventListener('click', () => toggleSetting(b.dataset.setting)));
    document.querySelectorAll('#settingsPanel [data-start]').forEach(b => b.addEventListener('click', () => {
        closePanels();
        handleStartMode(ctx.getWs(), ctx.state, ctx.robotName, b.dataset.start);
    }));
    $('#settingsPanel [data-action="refreshLog"]').addEventListener('click', refreshLog);
    $('#settingsPanel [data-action="restartSpeech"]').addEventListener('click', onRestartSpeech);
}

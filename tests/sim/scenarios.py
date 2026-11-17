"""Workflow tests of the real webapp against the simulated robot (tests/sim). Droplet only.

Runs in the Playwright image with --network host and the Docker socket, so it can pause, stop and
restart the simulated PCs. Each scenario resets the fake ROS graph, injects faults, drives the
touch screen like an operator and checks the outcome. Usage: python3 scenarios.py [name ...]
"""
import http.client
import json
import os
import socket
import sys
import time
import traceback
import urllib.request

from playwright.sync_api import sync_playwright

SIM = '/sim'
FR = SIM + '/fakeros'
STATE = SIM + '/w/src/js/state.json'
SETTINGS = SIM + '/w/src/js/settings.json'
URL = 'http://localhost:3000/'
WORK_MODE, STAND_UP, ACTIVATE, INIT, PAUSED, RECOVERY = 3, 2, 1, 0, 4, None

BATTERY_OK = dict(power_alert=False, is_charging=False, is_docked=True, need_for_charge=False, battery_level=80.0)

# Auto-confirm every SweetAlert popup and record its title (window.__autoConfirm = false to stop).
INIT_JS = """
window.__popups = []; window.__autoConfirm = true;
setInterval(() => {
  const t = document.querySelector('.swal2-popup.swal2-show .swal2-title');
  if (t && t.textContent && window.__popups[window.__popups.length - 1] !== t.textContent) window.__popups.push(t.textContent);
  const b = document.querySelector('.swal2-popup.swal2-show .swal2-confirm');
  if (b && window.__autoConfirm && getComputedStyle(b).display !== 'none') b.click();
}, 300);
"""


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def docker(action, name):
    c = UnixHTTP('localhost')
    c.request('POST', '/containers/%s/%s' % (name, action))
    r = c.getresponse()
    r.read()
    assert r.status in (204, 304), 'docker %s %s -> %s' % (action, name, r.status)


def http_json(path, timeout=10):
    t = time.time()
    with urllib.request.urlopen('http://localhost:3000' + path, timeout=timeout) as r:
        return json.loads(r.read()), time.time() - t


def write(path, text):
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, 0o666)


def battery(**kw):
    b = dict(BATTERY_OK, **kw)
    write(FR + '/battery.txt', ''.join('%s: %s\n' % (k, v) for k, v in b.items()))


def events():
    out = []
    for line in open(FR + '/events.log'):
        parts = line.split()
        if len(parts) >= 3:
            out.append((float(parts[0]), parts[1], parts[2:]))
    return out


def launched(key):
    return sum(1 for _, _, w in events() if w[0] == 'roslaunch' and w[1] == key)


def state():
    try:
        return json.load(open(STATE))
    except (OSError, ValueError):
        return {}


def wait(cond, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(1)
    raise AssertionError('timeout after %d s: %s' % (timeout, what))


class Sim:
    def __init__(self, browser):
        self.browser = browser
        self.page = None

    def reset(self, faults=None, settings=None, **bat):
        # Stop the fake ROS (all fake launches exit when the master file disappears), clear state.
        for p in ('master',):
            if os.path.exists(FR + '/' + p):
                os.remove(FR + '/' + p)
        time.sleep(1.5)
        for d in ('launches', 'kill', 'counts', 'topics'):
            os.makedirs(FR + '/' + d, exist_ok=True)
            os.chmod(FR + '/' + d, 0o777)  # the fake PCs run as other users
            for f in os.listdir(FR + '/' + d):
                os.remove(FR + '/' + d + '/' + f)
        write(FR + '/events.log', '')
        write(FR + '/faults.json', json.dumps(faults or {}))
        battery(**bat)
        write(STATE, json.dumps({'isPowered': False, 'isRunning': False, 'pipelineState': 0,
                                 'uiState': {'activePopup': None, 'notifications': []}}))
        write(SETTINGS, json.dumps(dict({'autoShutdownOnDock': True, 'headMotion': True, 'gestures': True}, **(settings or {}))))
        for name in ('sim-base', 'sim-vision'):
            try:
                docker('unpause', name)
            except AssertionError:
                pass
            docker('start', name)
        docker('restart', 'sim-vision')
        wait(lambda: self._ready(), 30, 'webapp up')
        self.load()

    def _ready(self):
        try:
            return http_json('/api/base-ready', 8)[0].get('ready') is True
        except Exception:
            return False

    def load(self):
        if self.page:
            self.page.close()
        self.page = self.browser.new_page(viewport={'width': 480, 'height': 800})
        self.page.add_init_script(INIT_JS)
        self.page.goto(URL)
        self.page.wait_for_selector('#mainBtn', state='attached', timeout=30000)
        time.sleep(7)  # page-load "Initialization" popup (5 s) and first base probe

    def ui(self):
        return self.page.evaluate("""() => {
          const b = id => { const e = document.getElementById(id); return e ? { text: e.innerText.trim(), disabled: e.disabled } : null; };
          const s = document.querySelector('#systemStatus + span');
          return { main: b('mainBtn'), second: b('secondBtn'), status: s ? s.textContent : null, popups: window.__popups };
        }""")

    def press(self, element_id):
        self.page.evaluate("""id => { const u = document.getElementById('unlockOverlay'); if (u) u.style.display = 'none';
                                     document.getElementById(id).click(); }""", element_id)

    def settings_start(self, mode):
        self.page.evaluate("""m => { document.getElementById('settingsBtn').click();
                                    document.querySelector('#settingsPanel [data-start="' + m + '"]').click(); }""", mode)

    def shot(self, name):
        self.page.screenshot(path='%s/results/%s.png' % (SIM, name))


def start_full(sim):
    sim.press('mainBtn')
    return wait(lambda: state().get('pipelineState') == WORK_MODE or state().get('startFailed'), 300,
                'start settles')


# ---------------- scenarios ----------------

def s_base_down_at_load(sim):
    sim.reset()
    docker('stop', 'sim-base')
    sim.load()
    ui = sim.ui()
    assert ui['main']['disabled'] is True, ui
    assert ui['status'] == 'Waiting for base computer', ui
    docker('start', 'sim-base')
    wait(lambda: sim.ui()['main']['disabled'] is False, 20, 'Start enabled after the base comes back')


def s_base_hangs(sim):
    sim.reset()
    docker('pause', 'sim-base')
    try:
        body, took = http_json('/api/base-ready', 15)
        assert body == {'ready': False} and took < 7, (body, took)
        wait(lambda: sim.ui()['main']['disabled'] is True, 15, 'Start disabled while the base hangs')
    finally:
        docker('unpause', 'sim-base')
    wait(lambda: sim.ui()['main']['disabled'] is False, 20, 'Start enabled after the base answers')
    return 'base-ready answered false in %.1f s' % took


def s_happy_path(sim):
    sim.reset()
    start_full(sim)
    st = state()
    assert st.get('pipelineState') == WORK_MODE, st
    assert launched('speech2text_multilang.launch') == 1, 'no relaunch expected'
    ui = sim.ui()
    assert ui['main']['text'] == 'Pause' and ui['second']['text'] == 'Home', ui
    return 'WORK_MODE; popups: %s' % ', '.join(ui['popups'])


def s_no_duplicate_launches(sim):
    # Node closes idle requests after 120 s; a resent launch request used to start a second copy.
    sim.reset()
    start_full(sim)
    before = {k: launched(k) for k in ('face_tracking.launch', 'text2speech_prefetch.launch', 'speech2text_multilang.launch')}
    time.sleep(150)
    after = {k: launched(k) for k in before}
    assert before == after, (before, after)
    assert all(v == 1 for v in after.values()), after


def s_imu_first_launch_fails(sim):
    sim.reset(faults={'imu.launch': {'first_fail': True}})
    start_full(sim)
    assert state().get('pipelineState') == WORK_MODE, state()
    assert launched('imu.launch') == 2, launched('imu.launch')


def s_stt_never_then_retry(sim):
    sim.reset(faults={'speech2text_multilang.launch': {'never': True}})
    start_full(sim)
    st = state()
    assert st.get('startFailed') == 'stand_up' and st.get('pipelineState') == STAND_UP, st
    assert launched('speech2text_multilang.launch') == 2, 'one relaunch expected'
    assert launched('autonomous_nav.launch') == 0, 'navigation must not start without speech'
    ui = sim.ui()
    assert ui['main']['text'] == 'Retry' and not ui['main']['disabled'], ui
    assert ui['second']['text'] == 'Power Off' and not ui['second']['disabled'], ui
    # The popup follows the state change by a moment: wait for it.
    wait(lambda: 'Startup incomplete' in sim.ui()['popups'], 10, 'Startup incomplete popup')
    imu_before, dock_before = launched('imu.launch'), launched('docking.launch')
    write(FR + '/faults.json', '{}')
    sim.press('mainBtn')
    wait(lambda: state().get('pipelineState') == WORK_MODE, 300, 'retry reaches WORK_MODE')
    assert launched('imu.launch') == imu_before and launched('docking.launch') == dock_before, 'retry must skip activation'


def s_stt_after_relaunch(sim):
    sim.reset(faults={'speech2text_multilang.launch': {'first_fail': True}})
    start_full(sim)
    assert state().get('pipelineState') == WORK_MODE, state()
    assert launched('speech2text_multilang.launch') == 2, launched('speech2text_multilang.launch')


def s_roscore_fails(sim):
    sim.reset(faults={'roscore': {'fail': True}})
    start_full(sim)
    st = state()
    assert st.get('startFailed') == 'activate_robot', st
    assert launched('imu.launch') == 0, 'no IMU launch without a master'
    ui = sim.ui()
    assert ui['main']['text'] == 'Retry' and not ui['second']['disabled'], ui


def s_navigation_missing(sim):
    sim.reset(faults={'autonomous_nav.launch': {'never': True}})
    start_full(sim)
    assert state().get('startFailed') == 'stand_up', state()
    assert not any(w[0] == 'rostopic_pub' and 'target_location' in w[1] for _, _, w in events()), 'no drive without navigation'


def s_face_tracker_missing(sim):
    sim.reset(faults={'face_tracking.launch': {'never': True}})
    start_full(sim)
    assert state().get('pipelineState') == WORK_MODE, state()


def s_tts_floods_stdout(sim):
    sim.reset(faults={'text2speech_prefetch.launch': {'spam_mb': 64}})
    start_full(sim)
    assert state().get('pipelineState') == WORK_MODE, state()
    time.sleep(20)
    nodes = http_json('/api/status')[0]
    alive = any(l.endswith('.json') and 'text2speech' in open(FR + '/launches/' + l).read() for l in os.listdir(FR + '/launches'))
    assert alive, 'TTS launch must survive 64 MiB of output'
    assert not any(w[0] == 'roslaunch_exit' and w[1] == 'text2speech_prefetch.launch' for _, _, w in events())


def s_double_click_start(sim):
    sim.reset()
    sim.page.evaluate("""() => { document.getElementById('unlockOverlay').style.display = 'none';
        const b = document.getElementById('mainBtn'); b.click(); b.click(); }""")
    wait(lambda: state().get('pipelineState') == WORK_MODE, 300, 'start')
    assert sum(1 for _, _, w in events() if w[0] == 'roscore') == 1, 'one workflow only'


def s_start_without_motion(sim):
    sim.reset()
    sim.settings_start('static')
    wait(lambda: state().get('pipelineState') == WORK_MODE or state().get('startFailed'), 200, 'static start')
    assert state().get('pipelineState') == WORK_MODE and state().get('startMode') == 'static', state()
    moving = [k for k in ('imu.launch', 'wheels.launch', 'body_activation.launch', 'body_movement.launch',
                          'docking.launch', 'play_breath.launch', 'autonomous_nav.launch', 'pilot.launch') if launched(k)]
    assert not moving, 'motion launches in static mode: %s' % moving
    ev = [w for _, _, w in events()]
    head = next(i for i, w in enumerate(ev) if w[0] == 'rostopic_pub' and 'auto_mode_status' in w[1])
    face = next(i for i, w in enumerate(ev) if w[0] == 'roslaunch' and w[1] == 'face_tracking.launch')
    assert head < face and 'false' in ' '.join(ev[head]), 'head off before face tracking'
    assert sim.ui()['second']['text'] == 'Power Off', sim.ui()


def s_tour_then_pause(sim):
    sim.reset()
    start_full(sim)
    sim.settings_start('tour')
    wait(lambda: state().get('startMode') == 'tour', 120, 'tour started')
    ev = [w for _, _, w in events() if w[0] == 'roslaunch']
    order = [w[1] for w in ev]
    assert order.index('navigation.launch') < order.index('state_machine.launch'), order
    assert order.count('roscore') == 0 and sum(1 for _, _, w in events() if w[0] == 'roscore') == 1
    sim.press('mainBtn')  # Pause
    wait(lambda: any(w[0] == 'rosnode_kill' and 'top_level_state_machine_node' in ' '.join(w) for _, _, w in events()), 30, 'pause stops the tour')


def s_low_battery_at_dock(sim, auto=True):
    sim.reset(settings={'autoShutdownOnDock': auto})
    start_full(sim)
    battery(battery_level=15.0)
    time.sleep(4)
    sim.press('secondBtn')  # Home (confirm is auto-clicked)
    if auto:
        wait(lambda: any(w[0] == 'SUDO' for _, _, w in events()), 240, 'automatic power-off')
        log = http_json('/api/startup-log/recent')[0]
        auto_ev = next(e for e in log if e['event'] == 'shutdown.auto')
        assert 'reason=low_battery_docked level=15' in auto_ev['detail'], auto_ev
        assert launched('say_tired.launch') == 1
        return auto_ev['detail']
    wait(lambda: any(e['event'] == 'shutdown.auto_skipped' for e in http_json('/api/startup-log/recent')[0]), 240, 'skip logged')
    time.sleep(20)
    assert not any(w[0] == 'SUDO' for _, _, w in events()), 'no power-off when the setting is off'
    assert launched('say_tired.launch') == 0


def s_low_battery_setting_off(sim):
    return s_low_battery_at_dock(sim, auto=False)


def s_restart_speech(sim):
    sim.reset()
    start_full(sim)
    sim.page.evaluate("""() => { document.getElementById('settingsBtn').click();
        document.querySelector('[data-tab=comunicazione]').click();
        document.querySelector('[data-action=restartSpeech]').click(); }""")
    wait(lambda: 'Speech ready' in sim.ui()['popups'], 120, 'speech restarted')
    assert launched('speech2text_multilang.launch') == 2 and launched('text2speech_prefetch.launch') == 2


def s_emergency_button(sim):
    sim.reset()
    start_full(sim)
    battery(power_alert=True)
    wait(lambda: state().get('pipelineState') == 6 or sim.ui()['main']['text'] == 'Start Robot', 60, 'emergency handled')
    return 'state %s' % state().get('pipelineState')


SCENARIOS = [s_base_down_at_load, s_base_hangs, s_happy_path, s_no_duplicate_launches, s_imu_first_launch_fails, s_stt_never_then_retry,
             s_stt_after_relaunch, s_roscore_fails, s_navigation_missing, s_face_tracker_missing, s_tts_floods_stdout,
             s_double_click_start, s_start_without_motion, s_tour_then_pause, s_low_battery_at_dock,
             s_low_battery_setting_off, s_restart_speech, s_emergency_button]


def main():
    os.makedirs(SIM + '/results', exist_ok=True)
    wanted = sys.argv[1:]
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        sim = Sim(browser)
        for fn in SCENARIOS:
            name = fn.__name__[2:]
            if wanted and name not in wanted:
                continue
            t = time.time()
            try:
                note = fn(sim) or ''
                results.append((name, 'PASS', note))
            except Exception as e:
                results.append((name, 'FAIL', '%s: %s' % (type(e).__name__, e)))
                traceback.print_exc()
                try:
                    sim.shot(name)
                except Exception:
                    pass
            print('%-26s %s  %4.0f s  %s' % (name, results[-1][1], time.time() - t, results[-1][2][:200]), flush=True)
        browser.close()
    json.dump(results, open(SIM + '/results/results.json', 'w'), indent=1)
    print('SUMMARY %d/%d passed' % (sum(r[1] == 'PASS' for r in results), len(results)))


if __name__ == '__main__':
    main()

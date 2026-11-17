#!/usr/bin/env python3
"""Fake ROS for webapp workflow tests (droplet only, never on a robot).

One script, dispatched by the name it is called with (roslaunch, rosnode, rostopic, rosrun,
roscore, killall, sudo). The base and vision containers share /fakeros:
  master              exists while the fake roscore runs
  launches/<id>.json  nodes registered by one running launch
  kill/<id>           request to stop launch <id> (works across containers)
  faults.json         per launch file: delay, never, fail, first_fail, spam_mb, exit_after
  counts/<launch>     how many times each launch file was started
  topics/<topic>      last value published with rostopic pub
  events.log          one line per command, for the test assertions
"""
import json
import os
import sys
import time
import uuid

ROOT = '/fakeros'
NS = '/' + os.environ.get('ROBOT_NAME', 'robot_adriano')
HOST = 'base' if os.getuid() == 1002 else 'vision'   # users created in tests/sim/Dockerfile

NODES = {
    'imu.launch': ['imu/Sensor', 'imu/qb_interface_imu_node', 'alterego_state_publisher'],
    'wheels.launch': ['wheels/qb_interface_node', 'wheels/lqr'],
    'body_activation.launch': ['left/qb_interface_node', 'right/qb_interface_node'],
    'body_movement.launch': ['left/arm_inv_dyn', 'right/arm_inv_dyn', 'head/head_inv_kin'],
    'pilot.launch': ['r_ctrl', 'l_ctrl', 'inbound', 'socket'],
    'face_expressions.launch': ['face_expressions'],
    'face_tracking.launch': ['face_tracker', 'face_recognition'],
    'text2speech_prefetch.launch': ['text2speech'],
    'speech2text_multilang.launch': ['speech2text'],
    'play_breath.launch': ['rosbag_play'],
    'autonomous_nav.launch': ['move_base', 'navigation'],
    'navigation.launch': ['obstacle_manager', 'navigation_server'],
    'state_machine.launch': ['top_level_state_machine_node'],
    'docking.launch': ['wheels/docking'],
}
DELAY = {'speech2text_multilang.launch': 4, 'text2speech_prefetch.launch': 2, 'autonomous_nav.launch': 3}
EXIT_AFTER = {'docking.launch': 5, 'say_tired.launch': 3, 'say_move_over.launch': 3}


def path(*parts):
    return os.path.join(ROOT, *parts)


def event(*words):
    with open(path('events.log'), 'a') as f:
        f.write('%.3f %s %s\n' % (time.time(), HOST, ' '.join(words)))


def faults():
    try:
        with open(path('faults.json')) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def master_up():
    return os.path.exists(path('master'))


def launches():
    out = []
    for name in os.listdir(path('launches')):
        try:
            with open(path('launches', name)) as f:
                out.append(json.load(f))
        except (OSError, ValueError):
            pass
    return out


def register(key, nodes):
    lid = uuid.uuid4().hex[:8]
    tmp = path('launches', lid + '.tmp')
    with open(tmp, 'w') as f:
        json.dump({'id': lid, 'key': key, 'nodes': nodes, 'host': HOST}, f)
    os.rename(tmp, path('launches', lid + '.json'))
    return lid


def unregister(lid):
    for p in (path('launches', lid + '.json'), path('kill', lid)):
        try:
            os.remove(p)
        except OSError:
            pass


def count(key):
    p = path('counts', key)
    n = int(open(p).read()) + 1 if os.path.exists(p) else 1
    open(p, 'w').write(str(n))
    return n


def run_until_stopped(lid, needs_master, exit_after, spam_mb):
    start = time.time()
    chunk = ('x' * 1023 + '\n') * 1024  # 1 MiB
    spammed = 0
    try:
        while not os.path.exists(path('kill', lid)):
            if needs_master and not master_up():
                break
            if exit_after is not None and time.time() - start >= exit_after:
                break
            if spam_mb and spammed < spam_mb:
                sys.stdout.write(chunk)
                sys.stdout.flush()
                spammed += 1
                continue
            time.sleep(0.2)
    finally:
        unregister(lid)


def roslaunch(args):
    key = next((a for a in args if a.endswith('.launch')), ' '.join(args))
    n = count(key)
    fault = faults().get(key, {})
    event('roslaunch', key, 'n=%d' % n)
    if not master_up():
        sys.stderr.write('ERROR: unable to contact ROS master\n')
        sys.exit(1)
    if fault.get('fail') or (fault.get('first_fail') and n == 1):
        sys.stderr.write('RLException: run_id on parameter server does not match declared run_id\n')
        event('roslaunch_failed', key)
        sys.exit(1)
    time.sleep(fault.get('delay', DELAY.get(key, 1)))
    nodes = [] if fault.get('never') else ['%s/%s' % (NS, n_) for n_ in NODES.get(key, [])]
    if key == 'imu.launch':
        syscheck = os.path.expanduser('~/catkin_ws/src/AlterEGO_Adriano/alterego_robot/config/SystemCheck.txt')
        with open(syscheck, 'a') as f:
            f.write('Number of connected IMUs: %d\n' % fault.get('imus', 3))
    lid = register(key, nodes)
    run_until_stopped(lid, True, fault.get('exit_after', EXIT_AFTER.get(key)), fault.get('spam_mb', 0))
    event('roslaunch_exit', key)


def roscore(_args):
    event('roscore')
    if faults().get('roscore', {}).get('fail'):
        sys.stderr.write('roscore failed (injected)\n')
        sys.exit(1)
    if master_up():
        sys.stderr.write('roscore cannot run as another roscore/master is already running.\n')
        sys.exit(1)
    open(path('master'), 'w').write(HOST)
    lid = register('roscore', ['/rosout'])
    try:
        while master_up() and not os.path.exists(path('kill', lid)):
            time.sleep(0.2)
    finally:
        for p in (path('master'),):
            if os.path.exists(p):
                os.remove(p)
        for launch in launches():
            open(path('kill', launch['id']), 'w').close()
        unregister(lid)


def rosnode(args):
    if not master_up():
        sys.stderr.write('ERROR: Unable to communicate with master!\n')
        sys.exit(1)
    if args[:1] == ['list']:
        names = sorted({n for launch in launches() for n in launch['nodes']})
        print('\n'.join(names))
    elif args[:1] == ['kill']:
        targets = args[1:]
        event('rosnode_kill', ' '.join(targets))
        for launch in launches():
            if targets == ['-a'] or set(launch['nodes']) & set(targets):
                if launch['key'] != 'roscore':
                    open(path('kill', launch['id']), 'w').close()


def rostopic(args):
    if not master_up():
        sys.stderr.write('ERROR: Unable to communicate with master!\n')
        sys.exit(1)
    if args[:1] == ['pub']:
        rest = [a for a in args[1:] if a not in ('-1', '-l')]
        topic, value = rest[0], ' '.join(rest[2:])
        event('rostopic_pub', topic, value)
        with open(path('topics', topic.strip('/').replace('/', '__')), 'w') as f:
            f.write('%.3f %s' % (time.time(), value))
        if '-l' in args:
            while True:
                time.sleep(1)
        time.sleep(0.3)
    elif args[:1] == ['echo']:
        topic = args[-1]
        if topic.endswith('/alterego_state/upperbody'):
            on = any(l['key'] == 'body_activation.launch' for l in launches())
            dead = faults().get('body_activation.launch', {}).get('motors_dead')
            print('left_meas_arm_shaft: [%s]' % ('0.31, 0.12' if on and not dead else '0.0, 0.0'))
        elif topic.endswith('/goal_reached'):
            p = path('topics', topic.strip('/').replace('/', '__').replace('goal_reached', 'target_location'))
            reached = os.path.exists(p) and time.time() - float(open(p).read().split()[0]) > 3
            print('data: %s' % ('True' if reached else 'False'))
        else:
            print('data: 0')


def killall(args):
    event('killall', ' '.join(args))
    if 'rosmaster' in args and master_up():
        os.remove(path('master'))


def sudo(args):
    stdin = '' if sys.stdin.isatty() else sys.stdin.read()
    event('SUDO', ' '.join(args), '(no real effect)')


def main():
    os.umask(0)  # both containers write the shared /fakeros
    for d in ('launches', 'kill', 'counts', 'topics'):
        os.makedirs(path(d), exist_ok=True)
    name = os.path.basename(sys.argv[0])
    handler = {'roslaunch': roslaunch, 'roscore': roscore, 'rosnode': rosnode, 'rostopic': rostopic,
               'killall': killall, 'sudo': sudo, 'rosrun': lambda a: event('rosrun', ' '.join(a))}.get(name)
    if handler is None:
        sys.exit('fakeros: unknown command %s' % name)
    handler(sys.argv[1:])


if __name__ == '__main__':
    main()

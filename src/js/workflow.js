import { sendCommand,sendLocalCommand, getRobotName, initializeIMU, handleDockingMovement, initializeSystem, waitForPowerAlertTrigger, showSyncedPopup, targetReachedCheck, checkNodeStatus, pingRemoteComputer, waitForNodes} from './api.js';
import { batteryMonitor } from './batterymonitor.js';
import { ROS_COMMANDS, LAUNCH_COMMANDS, STATE } from './constants.js';
import { showLoading, updateUI } from './utils.js';
import { logStartupEvent, newStartupAttemptId } from './startupLog.js';
import { loadSettings, getSetting } from './settings.js';

var batteryInterval;

// Battery facts for shutdown logs (11 Nov: two automatic power-offs with no level recorded).
function batteryDetail() {
    return `level=${batteryMonitor.getBatteryLevel()} age_ms=${batteryMonitor.getReadingAgeMs()} ` +
        `charging=${batteryMonitor.getIsCharging()} docked=${batteryMonitor.getIsDocked()}`;
}

function updatePipelineState(ws, state, value){
    state.pipelineState = value;
            
    ws.send(JSON.stringify({
        type: 'stateUpdate',
        data: { pipelineState: value }
    }));

    batteryMonitor.updateFSMState(state.pipelineState);
}

async function poweroffNUCs(ws, attemptId) {

    // Power Off BASE NUC
    logStartupEvent(attemptId, 'shutdown.phase', { stage: 'poweroff_base', outcome: 'dispatched' });
    sendCommand('echo 111 | sudo -S poweroff', { attemptId, stage: 'poweroff_base' });
    await new Promise(r => setTimeout(r, 2000));
    
    // Power Off VISION NUC
    logStartupEvent(attemptId, 'shutdown.phase', { stage: 'poweroff_vision', outcome: 'dispatched' });
    sendLocalCommand(`echo 111 | sudo -S poweroff`, { attemptId, stage: 'poweroff_vision' });
}

async function startPowerMonitor(ws, state, robotName){
    const POLLING_INTERVAL = 1500;

    batteryInterval = setInterval(async () => {
        try {
            
            if (batteryMonitor.timerIsSet()){
                // Battery topic is monitored
       
                const fsmState = batteryMonitor.getState(); // Need something that is updated on the background
                //console.log("FSM PIPELINE STATE: " + fsmState);
                
                if (batteryMonitor.checkNeedChargeTrigger()) {
                    logStartupEvent(newStartupAttemptId(), 'battery.need_charge', {
                        pipelineState: fsmState, detail: `need=${batteryMonitor.getNeedCharge()} ${batteryDetail()}`
                    });
                    // Detect and handle change in power alert 
                    // Driving home needs navigation: not in the 'static' and 'balance' start modes.
                    const canDriveHome = state.startMode !== 'static' && state.startMode !== 'balance';
                    if (fsmState == STATE.WORK_MODE && batteryMonitor.getNeedCharge() && !canDriveHome){
                        logStartupEvent(newStartupAttemptId(), 'battery.home_skipped', { detail: `mode=${state.startMode}` });
                    }
                    if (fsmState == STATE.WORK_MODE && batteryMonitor.getNeedCharge() && canDriveHome){
                        // Triggered when need_for_charge = true

                        // Send Home to Charge
                        batteryMonitor.setShouldAutoRestart(true);
                        robotHomeClick(ws, state, robotName);                        
                        state.isRunning = false;

                        ws.send(JSON.stringify({
                            type: 'stateUpdate',
                            data: { isRunning: false }
                        }));

                        updateUI(state);
                    }

                    if (fsmState == STATE.DOCKED && !batteryMonitor.getNeedCharge() && batteryMonitor.getShouldAutoRestart()){
                        // Triggered when need_for_charge = false
    
                        endChargeProcedures(ws, state);
                    }
                }

                // Always check for Emergency Button Pressed
                if (batteryMonitor.checkPowerAlertTrigger()) {
                    // Detect and handle change in power alert 
                    if (batteryMonitor.getPowerAlert()){
                        // Trigger from False to True
                        
                        console.log("Emergency Button Pressed to remove power");
                        
                        if (fsmState != STATE.INIT &&
                            fsmState != STATE.DOCKED &&
                            fsmState != STATE.RECOVERY_FROM_EMERGENCY){
                            // Emergency Button must deactivate the robot that is working
                            emergencyButtonPressed(ws, state, robotName);
                        }
                        
                    }
                    else {
                        // Trigger from True to False
                        console.log("Emergency Button Pressed to give power");
                        
                    }
                }
            }       

        } catch (error) {
            console.error('Error in global timer:', error);
        }
    }, POLLING_INTERVAL);
}

function stopPowerMonitor(){
    if (batteryInterval) {
        clearInterval(batteryInterval);
    }
}

// --------------------- PROCEDURES --------------------------------- //
async function stopRobot(ws, attemptId) {

    stopPowerMonitor(); // Need max. 1500 ms to close

    // Kill everything
    logStartupEvent(attemptId, 'shutdown.phase', { stage: 'cleanup', outcome: 'dispatched' });
    sendCommand(ROS_COMMANDS.CLEANUP, { attemptId, stage: 'cleanup' });

    // Popup - Wait nodes have been killed
    await showSyncedPopup(ws, {
        title: 'Stop Robot',
        text: "Robot is deactivating. Please wait...",
        icon: 'warning',
        showCancelButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        timer: 18000,           // 18 sec. to be sure nodes have been killed
        timerProgressBar: true,
        showConfirmButton: false
    });  

    sendCommand(ROS_COMMANDS.CLEAR_LOG);
}

async function deactivateRobot(ws) {

    stopPowerMonitor(); // Need max. 1500 ms to close

    // Kill everything
    sendCommand(ROS_COMMANDS.CLEANUP);
    
    // Popup - Wait nodes have been killed
    await showSyncedPopup(ws, {
        title: 'Stop Robot',
        text: "Robot is deactivating. Please wait...",
        icon: 'warning',
        showCancelButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        timer: 18000,           // 18 sec. to be sure nodes have been killed
        timerProgressBar: true,
        showConfirmButton: false
    });  

    sendCommand(ROS_COMMANDS.CLEAR_LOG);
}

async function checkForPowerOn(ws, robotName){

    // Wait for Power Alert Trigger before moving
    const powerIsOn = await waitForPowerAlertTrigger(ws, true);
    if (!powerIsOn) {
        return false;
    }

    return true;
}

export async function activateRobotProcedures(ws, robotName, attemptId) {
    logStartupEvent(attemptId, 'startup.phase', { stage: 'roscore', outcome: 'dispatched' });
    const roscoreAccepted = await sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.ROSCORE}`,
        { attemptId, stage: 'roscore' });
    if (!roscoreAccepted) return false;
    const masterReady = await waitForNodes(['/rosout'], 15000);
    logStartupEvent(attemptId, 'startup.check', { stage: 'ros_master', outcome: masterReady.ready ? 'passed' : 'failed' });
    if (!masterReady.ready) return false;
    await new Promise(r => setTimeout(r, 5000));  // 2000 -> 5000 ms (2026-11-11: let roscore/IMU/TTS settle)
    logStartupEvent(attemptId, 'startup.phase', { stage: 'usb_detector', outcome: 'dispatched' });
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.USB_DETECTOR}`,
        { attemptId, stage: 'usb_detector' });
    await new Promise(r => setTimeout(r, 2000));
    sendCommand(ROS_COMMANDS.CLEAR_LOG);
    await new Promise(r => setTimeout(r, 5000));  // 2000 -> 5000 ms (2026-11-11: let roscore/IMU/TTS settle)
    
    // Initialize IMU
    logStartupEvent(attemptId, 'startup.phase', { stage: 'imu', outcome: 'checking' });
    const imuInitialized = await initializeIMU(ws, robotName, attemptId);
    logStartupEvent(attemptId, 'startup.check', { stage: 'imu_first', outcome: imuInitialized ? 'passed' : 'failed' });
    if (!imuInitialized) {
        sendCommand(ROS_COMMANDS.CLEAR_LOG);
        await new Promise(r => setTimeout(r, 2000));
        
        // Try once again
        const imuInitRetry = await initializeIMU(ws, robotName, attemptId);
        logStartupEvent(attemptId, 'startup.check', { stage: 'imu_retry', outcome: imuInitRetry ? 'passed' : 'failed' });
        if (!imuInitRetry){
            return false;
        }
    }

    // Check For Power ON
    const checkPowerON = await checkForPowerOn(ws, robotName);
    logStartupEvent(attemptId, 'startup.check', { stage: 'power_on', outcome: checkPowerON ? 'passed' : 'failed' });
    if (!checkPowerON) {
        return false;
    }

    // Docking Backward
    const backwardComplete =  await handleDockingMovement(ws, robotName, "backward", 0.5, attemptId);
    logStartupEvent(attemptId, 'startup.check', { stage: 'docking_backward', outcome: backwardComplete ? 'reported_complete' : 'failed' });
    if (!backwardComplete) {
        return false;
    }

    return true;
}

// Settings > Movimento "Head movements": the face tracker keeps detecting faces but stops moving
// the head while auto_mode_status is false. Latched for 30 s, so a face tracker that starts within
// that time still receives it (it starts with head motion on). Not awaited.
export function applyHeadMotion(robotName, enabled) {
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ` +
        `timeout 30 rostopic pub -l /${robotName}/face_tracking/auto_mode_status std_msgs/Bool "data: ${enabled}"`);
}

// Settings > Movimento "Gestures" also covers the breathing rosbag, which moves the body.
function startBreath(robotName, attemptId) {
    if (!getSetting('gestures')) {
        logStartupEvent(attemptId, 'startup.service', { stage: 'breath', outcome: 'skipped', detail: 'gestures=false' });
        return false;
    }
    logStartupEvent(attemptId, 'startup.service', { stage: 'breath', outcome: 'dispatched' });
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.BREATH}`,
        { attemptId, stage: 'breath' });
    return true;
}

export function startBreathNow(robotName) {
    return startBreath(robotName, newStartupAttemptId());
}

// Settings > Comunicazione "Restart speech": stop both speech nodes, launch both, wait until both run.
export async function restartSpeech(ws, robotName) {
    const attemptId = newStartupAttemptId();
    logStartupEvent(attemptId, 'speech.restart', { outcome: 'dispatched' });
    showLoading(true);
    try {
        sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && rosnode kill /${robotName}/speech2text /${robotName}/text2speech`);
        await new Promise(r => setTimeout(r, 3000));
        await startAudio(ws, robotName, attemptId);
        return await ensureSpeechReady(robotName, attemptId);
    } finally {
        showLoading(false);
    }
}

export function stopBreath(robotName) {
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_BREATH}`);
}

function setStartMode(ws, state, mode) {
    state.startMode = mode;
    ws.send(JSON.stringify({ type: 'stateUpdate', data: { startMode: mode } }));
}

// Tour nodes only (the robot must already be in WORK_MODE after a full start).
async function launchTourNodes(robotName, attemptId) {
    const [obstacles, navServer, stateMachine] = LAUNCH_COMMANDS.TOUR_NODES.map(n => `/${robotName}${n}`);
    logStartupEvent(attemptId, 'tour.phase', { stage: 'tour_navigation', outcome: 'dispatched' });
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.TOUR_NAVIGATION}`,
        { attemptId, stage: 'tour_navigation' });
    const nav = await waitForNodes([obstacles, navServer], 30000);
    logStartupEvent(attemptId, 'tour.check', { stage: 'tour_navigation', outcome: nav.ready ? 'passed' : 'failed', detail: nav.missing.join(',') });
    if (!nav.ready) return false;
    logStartupEvent(attemptId, 'tour.phase', { stage: 'tour_state_machine', outcome: 'dispatched' });
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.TOUR_STATE_MACHINE}`,
        { attemptId, stage: 'tour_state_machine' });
    const sm = await waitForNodes([stateMachine], 30000);
    logStartupEvent(attemptId, 'tour.check', { stage: 'tour_state_machine', outcome: sm.ready ? 'passed' : 'failed', detail: sm.missing.join(',') });
    return sm.ready;
}

// Pause, Home and the emergency button stop the tour: its state machine drives the robot.
export function stopTour(robotName) {
    const nodes = LAUNCH_COMMANDS.TOUR_NODES.map(n => `/${robotName}${n}`).join(' ');
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill ${nodes}`);
}

// Start Tour: full start first when the robot is off, otherwise only the tour nodes.
export async function startTour(ws, state, robotName, attemptId = newStartupAttemptId()) {
    if (state.pipelineState != STATE.WORK_MODE) {
        if (!(await robotPowerOnClick(ws, state, robotName, attemptId, 'full'))) return false;
    }
    showLoading(true);
    try {
        const ok = await launchTourNodes(robotName, attemptId);
        if (ok) setStartMode(ws, state, 'tour');
        else stopTour(robotName);
        return ok;
    } finally {
        showLoading(false);
    }
}

// Face tracking and breath are not required for WORK_MODE: log a miss, do not abort.
async function checkOptionalNode(attemptId, stage, node) {
    const check = await waitForNodes([node], 15000);
    logStartupEvent(attemptId, 'startup.check', { stage, outcome: check.ready ? 'passed' : 'failed', detail: node });
}

const SPEECH_SERVICES = [
    { stage: 'tts', node: 'text2speech', launch: 'TTS' },
    { stage: 'stt', node: 'speech2text', launch: 'STT2' }
];

// Wait for TTS and STT; relaunch only the missing ones once. Launches are not awaited:
// /execute-local answers only when roslaunch exits.
export async function ensureSpeechReady(robotName, attemptId) {
    const nodeOf = s => `/${robotName}/${s.node}`;
    const nodes = SPEECH_SERVICES.map(nodeOf);
    let check = await waitForNodes(nodes, 30000);
    if (!check.ready) {
        for (const s of SPEECH_SERVICES.filter(s => check.missing.includes(nodeOf(s)))) {
            logStartupEvent(attemptId, 'startup.service', { stage: s.stage, outcome: 'relaunched' });
            sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS[s.launch]}`,
                { attemptId, stage: s.stage });
        }
        check = await waitForNodes(nodes, 30000);
    }
    logStartupEvent(attemptId, 'startup.check', {
        stage: 'speech', outcome: check.ready ? 'passed' : 'failed', detail: check.missing.join(',')
    });
    return check.ready;
}

// "Start without motion": roscore, face tracking, TTS and STT only. No IMU, wheels, body
// activation, backward move, breath or navigation, so the robot can be tested while it must not move.
async function staticProcedures(ws, robotName, attemptId) {
    logStartupEvent(attemptId, 'startup.phase', { stage: 'roscore', outcome: 'dispatched', detail: 'mode=static' });
    const accepted = await sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.ROSCORE}`,
        { attemptId, stage: 'roscore' });
    if (!accepted) return false;
    const master = await waitForNodes(['/rosout'], 15000);
    logStartupEvent(attemptId, 'startup.check', { stage: 'ros_master', outcome: master.ready ? 'passed' : 'failed' });
    if (!master.ready) return false;
    await new Promise(r => setTimeout(r, 5000));
    // Head motion stays off in this mode whatever the setting: the head is a motor too.
    applyHeadMotion(robotName, false);
    logStartupEvent(attemptId, 'startup.service', { stage: 'face_tracking', outcome: 'dispatched' });
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.FACE_TRACKING}`,
        { attemptId, stage: 'face_tracking' });
    await checkOptionalNode(attemptId, 'face_tracking', `/${robotName}/face_tracker`);
    await startAudio(ws, robotName, attemptId);
    return ensureSpeechReady(robotName, attemptId);
}

export async function standUpProcedures(ws, robotName, attemptId, { navigation = true } = {}) {

    // Initialize system (activates wheels and arms (activation e movement))
    logStartupEvent(attemptId, 'startup.phase', { stage: 'system', outcome: 'checking' });
    const systemInitialized = await initializeSystem(ws, robotName, attemptId);
    logStartupEvent(attemptId, 'startup.check', { stage: 'system', outcome: systemInitialized ? 'passed' : 'failed' });
    if (!systemInitialized) {
        return false;
    }

    // Activate all remaining additional nodes

    // Start Pilot
    logStartupEvent(attemptId, 'startup.service', { stage: 'pilot', outcome: 'dispatched' });
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.PILOT}`,
        { attemptId, stage: 'pilot' });

    // Start FACE EXPRESSION
    logStartupEvent(attemptId, 'startup.service', { stage: 'face_expression', outcome: 'dispatched' });
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.FACE_EXPRESSION}`,
        { attemptId, stage: 'face_expression' });

    // Start FACE TRACKING and FACE RECOGNITION (head-motion setting published first, latched)
    if (!getSetting('headMotion')) applyHeadMotion(robotName, false);
    logStartupEvent(attemptId, 'startup.service', { stage: 'face_tracking', outcome: 'dispatched' });
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.FACE_TRACKING}`,
        { attemptId, stage: 'face_tracking' });
    await checkOptionalNode(attemptId, 'face_tracking', `/${robotName}/face_tracker`);

    // Start Audio Services
    await startAudio(ws, robotName, attemptId);

    // Start Breath Rosbag
    if (startBreath(robotName, attemptId)) await checkOptionalNode(attemptId, 'breath', `/${robotName}/rosbag_play`);

    // STT and TTS must be up before WORK_MODE (11 Nov: WORK_MODE was reported with STT dead).
    if (!(await ensureSpeechReady(robotName, attemptId))) return false;

    // "Balance only" start: the robot stands and balances, no navigation and no drive to the target.
    if (!navigation) {
        logStartupEvent(attemptId, 'startup.service', { stage: 'navigation', outcome: 'skipped', detail: 'mode=balance' });
        return true;
    }

    // Start Navigation
    logStartupEvent(attemptId, 'startup.service', { stage: 'navigation', outcome: 'dispatched' });
    const navigationAccepted = await sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.NAVIGATION}`,
        { attemptId, stage: 'navigation' });
    if (!navigationAccepted) return false;
    const navigationReady = await waitForNodes([
        `/${robotName}/move_base`, `/${robotName}/navigation`
    ], 20000);
    logStartupEvent(attemptId, 'startup.check', {
        stage: 'navigation_node', outcome: navigationReady.ready ? 'passed' : 'failed',
        detail: navigationReady.missing.join(',')
    });
    if (!navigationReady.ready) return false;

    // Send to Target Location
    logStartupEvent(attemptId, 'startup.service', { stage: 'target_location', outcome: 'dispatched' });
    const targetAccepted = await sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rostopic pub -1 /${robotName}/target_location std_msgs/String "data: '${LAUNCH_COMMANDS.TARGET_LOC}'"`,
        { attemptId, stage: 'target_location' });
    if (!targetAccepted) return false;
    await new Promise(r => setTimeout(r, 4000));

    return true;
}


export async function reStartAudio(ws, robotName) {
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.TTS}`);
    await new Promise(r => setTimeout(r, 5000));  // 2000 -> 5000 ms (2026-11-11: let roscore/IMU/TTS settle)

    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.STT2}`);
    await new Promise(r => setTimeout(r, 5000));  // 2000 -> 5000 ms (2026-11-11: let roscore/IMU/TTS settle)

    return true;
}

export async function startAudio(ws, robotName, attemptId) {
    if (attemptId) logStartupEvent(attemptId, 'startup.service', { stage: 'tts', outcome: 'dispatched' });
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.TTS}`,
        { attemptId, stage: 'tts' });
    await new Promise(r => setTimeout(r, 5000));  // 2000 -> 5000 ms (2026-11-11: let roscore/IMU/TTS settle)
    
    if (attemptId) logStartupEvent(attemptId, 'startup.service', { stage: 'stt', outcome: 'dispatched' });
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.STT2}`,
        { attemptId, stage: 'stt' });
    await new Promise(r => setTimeout(r, 5000));  // 2000 -> 5000 ms (2026-11-11: let roscore/IMU/TTS settle)

    
    return true;
}

export async function stopAudio(ws, robotName){
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.KILL_SPEECH}`);
    await new Promise(r => setTimeout(r, 2000));
  
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_TTS}`);
    await new Promise(r => setTimeout(r, 2000));

    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_STT}`);
    await new Promise(r => setTimeout(r, 2000));

    return true;
}

export async function stopRobotMovement(ws, robotName){
    // Kill all movement and tracking nodes

    // Stop Pilot
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_PILOT.R_CTRL} /${robotName}${LAUNCH_COMMANDS.STOP_PILOT.L_CTRL} /${robotName}${LAUNCH_COMMANDS.STOP_PILOT.INBOUND} /${robotName}${LAUNCH_COMMANDS.STOP_PILOT.SOCKET}`);
    await new Promise(r => setTimeout(r, 3000));

    // Stop Body Movement
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_BODY_MOVEMENT.R_ARM} /${robotName}${LAUNCH_COMMANDS.STOP_BODY_MOVEMENT.L_ARM} /${robotName}${LAUNCH_COMMANDS.STOP_BODY_MOVEMENT.HEAD} /${robotName}${LAUNCH_COMMANDS.STOP_BODY_MOVEMENT.R_MAIN} /${robotName}${LAUNCH_COMMANDS.STOP_BODY_MOVEMENT.L_MAIN} /${robotName}${LAUNCH_COMMANDS.STOP_BODY_MOVEMENT.PITCH}`);
    await new Promise(r => setTimeout(r, 3000));

    // Stop Body Activation
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_BODY_ACTIVATION.R_ARM} /${robotName}${LAUNCH_COMMANDS.STOP_BODY_ACTIVATION.L_ARM}`);
    await new Promise(r => setTimeout(r, 3000));
    
    // Stop Breath Rosbag
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_BREATH}`);
    await new Promise(r => setTimeout(r, 3000));

    // Stop Audio Services
    stopAudio(ws, robotName);
    await new Promise(r => setTimeout(r, 3000));

    // Stop Additional Nodes
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_FACE_EXPRESSION}`);
    await new Promise(r => setTimeout(r, 3000));
  
    // Stop Navigation
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.AMCL} /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.MOVE_BASE} /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.MAP_SERVER} /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.MAP_SERVER_OBSTACLE} /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.LIDAR} /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.NAVIGATION} /${robotName}${LAUNCH_COMMANDS.STOP_NAVIGATION.VIS_ROBOT}`);
    await new Promise(r => setTimeout(r, 4000));

    return true;
}

export async function goHomeProcedures(ws, robotName) {

    // Send Home

    // Stop Face Tracking and Recognition (to do before adjust docking)
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_FACE_RECOGNITION}`);
    await new Promise(r => setTimeout(r, 3000));
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_FACE_TRACKING}`);
    await new Promise(r => setTimeout(r, 3000));
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_STT}`);
    await new Promise(r => setTimeout(r, 3000));
    
    // Navigation from current position to home room
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rostopic pub -1 /${robotName}/target_location std_msgs/String "data: '${LAUNCH_COMMANDS.DOCK_STATION}'"`);  // Doubled to be sure
    await new Promise(r => setTimeout(r, 4000));

    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.SAY_MOVE_OVER}`);
    await new Promise(r => setTimeout(r, 1000));

    // Alignment to charging station within fwdDistance distance (in meters)
    var targetReached = false;
    do {
        targetReached = await targetReachedCheck(robotName);
        await new Promise(r => setTimeout(r, 2000));
    }
    while (!targetReached);
/*
    var approachActive = true;
    do {
        approachActive = await checkNodeStatus(`/${robotName}${LAUNCH_COMMANDS.ADJUST_DOCKING}`);
        await new Promise(r => setTimeout(r, 2000));
    } while(approachActive);
*/    

    var fwdDistance = 0.0;      // Override previous valutation
    
    return fwdDistance;
}

// --------------------- STATE CHANGE --------------------------------- //

async function stopRobotToPowerOff(ws, state, do_check = true, attemptId) {
    
    // Wait for Power Alert Trigger
    if (do_check && batteryMonitor.timerIsSet()){
        const powerIsOff = await waitForPowerAlertTrigger(ws, false);
        logStartupEvent(attemptId, 'shutdown.check', { stage: 'power_alert', outcome: powerIsOff ? 'passed' : 'failed' });

        /*if (!powerIsOff) {
            // Error on trigger or battery timer or ROS not set
            // Go ahead the same to power off the system        
        }*/
    }
    
    if (state.pipelineState != STATE.RECOVERY_FROM_EMERGENCY){
        stopRobot(ws, attemptId);
    }

    return true;
}

// After a failed start the touch screen offers Retry and Power Off (no keyboard, no reload).
// The value is the failed stage: a retry after a failed stand-up skips activation and its backward move.
function setStartFailed(ws, state, stage) {
    state.startFailed = stage;
    ws.send(JSON.stringify({ type: 'stateUpdate', data: { startFailed: stage } }));
}

// mode: 'full' (normal start), 'balance' (stand and balance, no navigation),
// 'static' (no motion: roscore, face tracking, speech). Retry keeps the mode of the failed start.
export async function robotPowerOnClick(ws, state, robotName, attemptId = newStartupAttemptId(), mode) {

    // Only straight after a failed stand-up (state persists across reloads; INIT means a full start).
    const retryStandUp = state.startFailed === 'stand_up' && state.pipelineState == STATE.STAND_UP;
    mode = retryStandUp ? (state.startMode || 'full') : (mode || 'full');
    logStartupEvent(attemptId, 'startup.begin', { pipelineState: state.pipelineState, isPowered: state.isPowered,
        detail: `mode=${mode}` + (retryStandUp ? ' retry_from=stand_up' : '') });
    setStartFailed(ws, state, false);
    setStartMode(ws, state, mode);
    await loadSettings();
    robotName = await getRobotName();   // Doubled to be sure

    showLoading(true);
    try {
    // Initialize Timer to monitor power issues and battery level (once, also on a retry)
    stopPowerMonitor();
    startPowerMonitor(ws, state, robotName);

    if (!retryStandUp && mode !== 'static') {
    // Notify next workflow state
    updatePipelineState(ws, state, STATE.ACTIVATE_ROBOT);
    logStartupEvent(attemptId, 'startup.state', { stage: 'activate_robot', pipelineState: state.pipelineState });
    
    // Activate Robot Core nodes and moves backward
    if (!(await activateRobotProcedures(ws, robotName, attemptId))){
        logStartupEvent(attemptId, 'startup.failed', { stage: 'activate_robot', pipelineState: state.pipelineState });
        setStartFailed(ws, state, 'activate_robot');
        return false;
    }
    }
    
    // Notify next workflow state
    updatePipelineState(ws, state, STATE.STAND_UP);
    logStartupEvent(attemptId, 'startup.state', { stage: 'stand_up', pipelineState: state.pipelineState });
    
    // Activate all the rest of nodes 
    const stoodUp = mode === 'static' ? await staticProcedures(ws, robotName, attemptId)
        : await standUpProcedures(ws, robotName, attemptId, { navigation: mode === 'full' });
    if (!stoodUp){
        logStartupEvent(attemptId, 'startup.failed', { stage: 'stand_up', pipelineState: state.pipelineState });
        setStartFailed(ws, state, 'stand_up');
        return false;
    }         
    
    // Notify next workflow state
    updatePipelineState(ws, state, STATE.WORK_MODE);
    logStartupEvent(attemptId, 'startup.complete', { pipelineState: state.pipelineState });

    return true;
    } finally {
        showLoading(false);
    }
}

export async function robotPowerOffClick(ws, state, do_check = true, attemptId = newStartupAttemptId()) {

    logStartupEvent(attemptId, 'shutdown.begin', { pipelineState: state.pipelineState, doCheck: do_check });
    if (state.startFailed) setStartFailed(ws, state, false);
    // Stop Robot to Power Off
    if (do_check) {
        const stopRobotPowerOff = await stopRobotToPowerOff(ws, state, do_check, attemptId);
        if (!stopRobotPowerOff) {
            logStartupEvent(attemptId, 'shutdown.failed', { stage: 'stop_robot' });
            return false;
        }
    }
    
    // Notify next workflow state
    updatePipelineState(ws, state, STATE.POWER_OFF_NUCS);
    
    // Power Off the system
    poweroffNUCs(ws, attemptId);            // Power Off everything

    // Notify next workflow state (useless, everything is off)
    updatePipelineState(ws, state, STATE.INIT);

    return true;
}

export async function robotHomeClick(ws, state, robotName) {
    if (state.startMode === 'tour') { stopTour(robotName); setStartMode(ws, state, 'full'); }

    showLoading(true);

    // Send Home
    const fwdDistance = await goHomeProcedures(ws, robotName);

    // Dock to charging station
    const dockProc= await dockingProcedures(ws, state, fwdDistance, robotName);

    showLoading(false);

}

export async function restartFromPauseProcedures(ws, state, robotName) {
    const attemptId = newStartupAttemptId();
    logStartupEvent(attemptId, 'resume.begin', { pipelineState: state.pipelineState, detail: `mode=${state.startMode}` });
    await loadSettings();
    const noMotion = state.startMode === 'static';
    showLoading(true);
    try {
    // Start FACE TRACKING (head-motion setting published first, latched)
    if (noMotion || !getSetting('headMotion')) applyHeadMotion(robotName, false);
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.FACE_TRACKING}`);
    await checkOptionalNode(attemptId, 'face_tracking', `/${robotName}/face_tracker`);

    // Start Audio Services
    await reStartAudio(ws, robotName);

    // Start Breath Rosbag (not in the no-motion mode)
    if (!noMotion) startBreath(robotName, attemptId);

    if (!(await ensureSpeechReady(robotName, attemptId))) {
        logStartupEvent(attemptId, 'resume.failed', { stage: 'speech', pipelineState: state.pipelineState });
        showSyncedPopup(ws, {
            title: 'Speech not ready',
            text: 'Speech recognition or speech synthesis did not start. The robot stays paused.',
            icon: 'error'
        });
        return false;
    }

    // Notify next workflow state
    updatePipelineState(ws, state, STATE.WORK_MODE);
    logStartupEvent(attemptId, 'resume.complete', { pipelineState: state.pipelineState });
    return true;
    } finally {
        showLoading(false);
    }
}

export async function pauseProcedures(ws, state, robotName) {
    if (state.startMode === 'tour') { stopTour(robotName); setStartMode(ws, state, 'full'); }

    showLoading(true);

    // Stop Face Recognition
    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_FACE_RECOGNITION}`);
    await new Promise(r => setTimeout(r, 2000));

    sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_FACE_TRACKING}`);
    await new Promise(r => setTimeout(r, 2000));

    // Stop Breath Rosbag
    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && rosnode kill /${robotName}${LAUNCH_COMMANDS.STOP_BREATH}`);
    await new Promise(r => setTimeout(r, 2000));

    // Stop Audio Services
    stopAudio(ws, robotName);
    await new Promise(r => setTimeout(r, 2000));

    // Notify next workflow state
    updatePipelineState(ws, state, STATE.PAUSED);

    showLoading(false);

    return true;
}

export async function dockingProcedures(ws, state, maxLinDistance, robotName) {
    
    // Kill all movement
    stopRobotMovement(ws, robotName);

    // Prepare to docking Forward
    const forwardComplete =  await handleDockingMovement(ws, robotName, "forward", maxLinDistance);
    if (!forwardComplete) {
        return false;
    }

    // Ask for help only if is_docked = TRUE but is_charging = FALSE ?!?
    // TODO: Check is_docked condition when having automatic docking procedure ready
    if (maxLinDistance == 0.0){
        //while (!batteryMonitor.getIsCharging()){
            await loadSettings();
            if (batteryMonitor.getBatteryLevel() < 20 && !getSetting('autoShutdownOnDock')) {
                logStartupEvent(newStartupAttemptId(), 'shutdown.auto_skipped', { detail: `setting=off ${batteryDetail()}` });
            }
            else if (batteryMonitor.getBatteryLevel() < 20) {
                const attemptId = newStartupAttemptId();
                logStartupEvent(attemptId, 'shutdown.auto', { detail: `reason=low_battery_docked ${batteryDetail()}` });
                sendLocalCommand(`${ROS_COMMANDS.SETUP_LOCAL} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.SAY_TIRED}`);
                await new Promise(r => setTimeout(r, 15000));
                robotPowerOffClick(ws, state, false, attemptId);
            }   
            //await new Promise(r => setTimeout(r, 60000));   // 1 minute
        //}
    }

    // Notify next workflow state
    updatePipelineState(ws, state, STATE.DOCKED);

    return true;
}

// ----------- ASYNC ROUTINES WITH STATE CHANGE -------------------- //
export async function endChargeProcedures(ws, state) {
    
    // Stop Robot
    stopRobot(ws);
    
    // Notify next workflow state
    updatePipelineState(ws, state, STATE.RESTART_AUTO);

    // Reload the web page and force clear the cache
    window.location.reload(true);

    return true;
}

export async function restartAuto(ws, state, robotName) {

    // Popup - Info to auto restart
    await showSyncedPopup(ws, {
        title: 'Restart Work',
        text: "Pay attention! In a few time the system will move back and activate the robot",
        icon: 'warning',
        showCancelButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        timer: 10000,
        timerProgressBar: true,
        showConfirmButton: false
    });
    
    robotPowerOnClick(ws, state, robotName);   //Restart
    state.isPowered = true;

    // Notify new state
    ws.send(JSON.stringify({
        type: 'stateUpdate',
        data: { isPowered: state.isPowered }
    }));

    // Update graphics to show both buttons
    updateUI(state);

    return true;
}

export async function emergencyButtonPressed(ws, state, robotName) {
    // Triggered when power_alert = true

    // Deactivate Robot
    if (state.startMode === 'tour') stopTour(robotName);
    deactivateRobot(ws);

    // Notify next workflow state
    updatePipelineState(ws, state, STATE.RECOVERY_FROM_EMERGENCY);

    // Update graphics to show both buttons
    updateUI(state);

    return true;
}

export async function overrideInitRobotState(ws, state){

    const isRemoteComputerOnline = await pingRemoteComputer();
    if (isRemoteComputerOnline) {
        sendCommand(ROS_COMMANDS.CLEANUP);
        sendCommand(ROS_COMMANDS.CLEAR_LOG);
    }

    await showSyncedPopup(ws, {
        title: 'Initialization',
        text: 'State is initializing. Please wait...',
        icon: 'warning',
        showCancelButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
        timer: 5000,
        timerProgressBar: true,
        showConfirmButton: false
    });    

    state.pipelineState = STATE.INIT;
    state.isPowered = false;
        
    ws.send(JSON.stringify({
        type: 'stateUpdate',
        data: { pipelineState: state.pipelineState,
                isPowered: state.isPowered
        }
    })); 
}

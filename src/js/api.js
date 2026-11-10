import { batteryMonitor } from './batterymonitor.js';
import { NUC_BASE_IP, ROS_CATKIN_WS, ROS_HOSTNAME, ROS_IP, ROS_MASTER_URI, ROS_SRC_FOLDER } from './constants.js';
import { ROS_COMMANDS, LAUNCH_COMMANDS } from './constants.js';
import { updateBatteryGraphics } from './utils.js';
import { logStartupEvent } from './startupLog.js';

/**
 * Executes a generic command through the server
 * @param {string} command - The command to execute
 * @returns {Promise<void>}
 */
function commandPayload(command, startup) {
    const payload = { command };
    if (startup && typeof startup === 'object' && startup.attemptId) {
        payload.startupAttemptId = startup.attemptId;
        payload.startupStage = startup.stage;
    }
    return payload;
}

export function sendCommand(command, startup) {
    fetch('/execute', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commandPayload(command, startup)),
    })
    .then(() => console.log(`Command sent: ${command}`))
    .catch(error => console.error('Error sending command:', error));
}

/**
 * Executes a generic command on the local computer through the server
 * @param {string} command - The command to execute
 * @returns {Promise<string>}
 */
export async function sendLocalCommand(command, startup) {
    try {
        const response = await fetch('/execute-local', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(commandPayload(command, startup)),
        });
        if (!response.ok) {
            throw new Error(`Error in command execution: ${response.status}`);
        }
        const data = await response.json();
        console.log(`Local command sent: ${command}`);
        return data;
    } catch (error) {
        return console.error('Error sending local command:', error);
    }
}
  

/**
 * Retrieves the battery info from script
 * @returns {Promise<output|null>} Current battery status
 * @throws {Error} If battery info cannot be retrieved
 */
export async function getBatteryStatus() {
    try {
        const catCommand = `cat ` + ROS_CATKIN_WS + ROS_SRC_FOLDER + `/utils/alterego_battery_status/BatteryStatus.txt`;
        const response = await fetch('/grep-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                command: catCommand
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data || !data.output) {
            throw new Error(`No data read from battery status file`);
            //return null;
        }
        
        return data.output;
    } catch (error) {
        console.error('Error getting battery status:', error);
        throw error;
    }
}

/**
 * Retrieves the robot name from .bashrc
 * @returns {Promise<string>} The robot name
 * @throws {Error} If robot name cannot be retrieved
 */
export async function getRobotName() {
    try {
        const response = await fetch('/grep-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                command: 'grep -oP "(?<=export ROBOT_NAME=).*" ~/.bashrc' 
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data.output.trim();
    } catch (error) {
        console.error('Error getting robot name:', error);
        throw error;
    }
}

/**
 * Checks if a ROS node is currently running
 * @param {string} nodeName - Name of the node to check
 * @returns {Promise<boolean>} True if node is running, false otherwise
 * @throws {Error} If node status cannot be checked
 */
export async function checkNodeStatus(nodeName) {
    try {
        //console.log("Checking the node in the list");

        const response = await fetch('/grep-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                command: `${ROS_COMMANDS.SETUP} && rosnode list | grep ${nodeName}`
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        return data.output.includes(nodeName);
    } catch (error) {
        console.error('Error checking node status:', error);
        throw error;
    }
}

/**
 * Checks connection with remote computer via ping
 * @returns {Promise<boolean>} True if connection successful, false otherwise
 */
export async function pingRemoteComputer() {
    try {
        const response = await fetch('/ping', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ip: NUC_BASE_IP })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('Error pinging remote computer:', error);
        return false;
    }
}

/**
 * Initializes IMU sensors with calibration process
 * Shows synchronized popups for calibration steps
 * @param {WebSocket} ws - WebSocket connection for sync
 * @param {string} robotName - Name of the robot
 * @returns {Promise<boolean>} True if initialization successful
 */
export async function initializeIMU(ws, robotName, attemptId) {
    try {
        // First popup - Calibration warning
        /*const initIMU = await showSyncedPopup(ws, {
            title: 'Calibration in Progress',
            text: "Do not touch the robot during calibration.",
            icon: 'warning',
            showCancelButton: false,
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            //confirmButtonText: 'OK, start calibration'
        });
        
        if (!initIMU) return false;
        */

        // Send IMU command
        sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.IMU}`,
            { attemptId, stage: 'imu' });
        console.log('IMU initialization command sent');

        // Add a small delay to ensure the first popup is fully closed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Second popup - Calibration progress
        await showSyncedPopup(ws, {
            title: 'Calibrating IMU...',
            html: 'Do not touch the robot during calibration. Wait for 5 seconds',
            timer: 5000,
            timerProgressBar: true,
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            willOpen: () => {
                if (Swal.getPopup()) {
                    Swal.showLoading();
                }
            }
        });


        // Check IMU connection
        const grepCommand = `grep 'Number of connected' ` + ROS_CATKIN_WS + ROS_SRC_FOLDER +`/alterego_robot/config/SystemCheck.txt`;
        const response = await fetch('/grep-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: grepCommand })
        });
        
        const data = await response.json();
        const numIMUs = parseInt(data.output.match(/\d+/)?.[0] || '0');
        
        if (numIMUs !== 3) {
            await showSyncedPopup(ws, {
                title: 'ERROR',
                text: 'IMU not Connected',
                icon: 'error'
            });
            
            // Cleanup IMU
            sendCommand(`${ROS_COMMANDS.SETUP} && rosnode kill -a`);
            return false;
        }
        console.log('IMU Connected :', numIMUs);
        
        return true;
        
    } catch (error) {
        console.error('IMU initialization error:', error);
        await showSyncedPopup(ws, {
            title: 'Error',
            text: 'IMU initialization failed',
            icon: 'error'
        });
        return false;
    }
}

/**
 * Checks battery status from topic
 * @param {string} robotName - Name of the robot
 */
export async function startBatteryCheck(robotName) {
    const MAX_NULL_READINGS = 3;
    const POLLING_INTERVAL = 2000;
    var topicDataOutput;
            
    // Start checking stability
    const bInterval = setInterval(async () => {
        try {

            topicDataOutput = await getBatteryStatus();      // Last at max. 3 retries 
            
            if (topicDataOutput == null) {
                batteryMonitor.updateErrorCounter();
                console.warn(`Null reading battery check #${batteryMonitor.getErrorCounter()}`);
                
                if (batteryMonitor.getErrorCounter() >= MAX_NULL_READINGS) {
                    throw Error('Too many failed topic readings');
                }
                return;
            }
            else {
                // Extract topic valueS
                const matchPA = topicDataOutput.match(/power_alert:\s*(True|False)/i);
                const matchIC = topicDataOutput.match(/is_charging:\s*(True|False)/i);
                const matchID = topicDataOutput.match(/is_docked:\s*(True|False)/i);
                const matchNC = topicDataOutput.match(/need_for_charge:\s*(True|False)/i);
                const matchBL = topicDataOutput.match(/battery_level:\s*([-]?\d*\.?\d*)/);
                if (!matchPA || !matchIC || !matchID || !matchNC || !matchBL) {
                    console.warn('Could not parse battery_level value from:', topicDataOutput);
                    return null;
                }                            
                
                const powerAlert = matchPA ? (matchPA[1].toLowerCase() === 'true') : false;
                const isCharging = matchIC ? (matchIC[1].toLowerCase() === 'true') : false;
                const isDocked = matchID ? (matchID[1].toLowerCase() === 'true') : false;
                const needCharge = matchNC ? (matchNC[1].toLowerCase() === 'true') : false;
                const batteryLevel = parseFloat(matchBL[1]);
                    
                //console.log('Battery Status:', batteryLevel, 'PA:', powerAlert, 'IC:', isCharging, 'ID:', isDocked, 'NC:', needCharge);

                // Update Monitor state
                batteryMonitor.resetErrorCounter();                              
                batteryMonitor.updateState(powerAlert, isCharging, isDocked, needCharge, batteryLevel);

                // State changes
                updateBatteryGraphics(powerAlert, isCharging, isDocked, batteryLevel);

                // Once a first message has arrived set monitor timer
                if (!batteryMonitor.timerIsSet()){
                    batteryMonitor.updateInterval(bInterval);
                }

                if (batteryMonitor.checkLastBatteryLevel() && batteryLevel != 0 && batteryLevel != 100){
                    // Reset battery monitor script if it is stucked
                    sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.BATTERY_MONITOR.RESTART}`);
                    await new Promise(r => setTimeout(r, 1000));
                    console.log("Restart Battery Monitoring");
                }
                
            }
            
        } catch (error) {
            if (topicDataOutput != null){
                console.error('Error in file reading:', error);
            }
            if (batteryMonitor.getErrorCounter() >= MAX_NULL_READINGS) {
                console.error('Too many failed file readings');
                batteryMonitor.resetErrorCounter();
                batteryMonitor.clearIntervalTimer();
                clearInterval(bInterval);                    
                return;
            }
        }
    }, POLLING_INTERVAL);

}

export async function stopBatteryCheck(){

    // Kill battery monitor timers
    batteryMonitor.clearIntervalTimer();    // Stop Battery Check
}

/**
 * Checks target reached from topic
 * @param {string} robotName - Name of the robot
 */
export async function targetReachedCheck(robotName) {
    var topicDataOutput;
            
    // Start checking stability
    try {

        topicDataOutput = await getTopicValue(`/${robotName}/goal_reached`);      // Last at max. 3 retries x 500 ms = 1500 ms      

        if (topicDataOutput == null) {
            
            return false;
        }
        else {
            // Extract topic valueS
            const matchSUC = topicDataOutput.match(/data:\s*(True|False)/i);
            if (!matchSUC) {
                console.warn('Could not parse target_reached value from:', topicDataOutput);
                return false;
            }                            
            
            const targetReached = matchSUC ? (matchSUC[1].toLowerCase() === 'true') : false;
            
            return targetReached;
        }
        
    } catch (error) {
        if (topicDataOutput != null){
            console.error('Error in topic reading:', error);
            return false;
        }
    }
}

/**
 * Wait for Power Alert trigger to switch power off
 * Shows synchronized popups while waiting
 * @param {WebSocket} ws - WebSocket connection for sync
 * @returns {Promise<boolean>} True if initialization successful
 */
export async function waitForPowerAlertTrigger(ws, needPower) {
    try {
            
        while (!batteryMonitor.timerIsSet()){
            await new Promise(resolve => setTimeout(resolve, 500));   
        }
        
        if (batteryMonitor.timerIsSet()){
            // Battery topic is monitored            
            while (needPower == batteryMonitor.getPowerAlert()){ 

                await showSyncedPopup(ws, {
                    title: 'Power Alert',
                    text: 'Power is still ' + ((needPower)?'off':'on') + '. Please push the Emergency Button to switch ' + ((needPower)?'on':'off') + ' power',
                    icon: 'warning',
                    showCancelButton: false,
                    allowOutsideClick: false,
                    allowEscapeKey: false,
                    confirmButtonText: 'OK, Check Now'
                });
                
                // Add a small delay to ensure the first popup is fully closed
                await new Promise(resolve => setTimeout(resolve, 500));            
            }     

            return true;
        }   
        return false;
        
    } catch (error) {
        console.error('Power Alert Trigger error:', error);
        await showSyncedPopup(ws, {
            title: 'Error',
            text: 'Power Alert Trigger failed',
            icon: 'error'
        });
        return false;
    }
}

/**
 * Handles backward movement of the robot
 * Shows synchronized warning popup and monitors movement
 * @param {WebSocket} ws - WebSocket connection for sync
 * @param {string} robotName - Name of the robot
 * @returns {Promise<boolean>} True if movement completed
 */
export async function handleDockingMovement(ws, robotName, direction, maxLinDistance, attemptId) {
    try {
        console.log("Starting " + direction + " movement...");
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Popup - Info to clear space
        await showSyncedPopup(ws, {
            title: 'Moving ' + direction,
            text: 'Pay attention!! Clear the space ' + ((direction=="forward")?'in front of':'behind') + ' the robot...',
            icon: 'info',
            timer: 5000,
            timerProgressBar: true,
            showConfirmButton: false
        });
        
        // First popup - Safety warning
        // await showSyncedPopup(ws, {
        //     title: 'Safety Check',
        //     text: Clear the space ' + ((direction=="forward")?'in front of':'behind') + ' the robot...',
        //     icon: 'warning',
        //     showCancelButton: false,
        //     allowOutsideClick: false,
        //     allowEscapeKey: false,
        //     showConfirmButton: false,
        //     //confirmButtonText: 'OK, start calibration'
        // });
        

        // Send docking movement command
        sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.DOCKING} movementDirection:="${direction}" maxLinDistance:=${maxLinDistance}`,
            { attemptId, stage: `docking_${direction}` });
        
        // Add a small delay before showing the progress popup
        await new Promise(resolve => setTimeout(resolve, 1000));

        return new Promise((resolve) => {
            var checkInterval;
            
            // Show progress popup with node status checking
            Swal.fire({
                title: 'Moving ' + direction + '...',
                text: 'Please wait',
                allowOutsideClick: false,
                allowEscapeKey: false,
                showConfirmButton: false,
                didOpen: () => {
                    Swal.showLoading();
                    // Start checking node status
                    checkInterval = setInterval(async () => {
                        const isNodeActive = await checkNodeStatus(`/${robotName}/wheels/docking`);
                        if (!isNodeActive) {
                            clearInterval(checkInterval);
                            Swal.close();
                            // Show completion popup
                            await showSyncedPopup(ws, {
                                title: 'Complete',
                                text: direction + ' movement completed',
                                icon: 'success',
                                timer: 1500,
                                showConfirmButton: false
                            });
                            resolve(true);
                        }
                    }, 2000);
                },
                willClose: () => {
                    // Cleanup interval if popup is closed
                    if (checkInterval) {
                        clearInterval(checkInterval);
                    }
                }
            });
        });

    } catch (error) {
        console.error('Error in ' + direction + ' movement:', error);
        await showSyncedPopup(ws, {
            title: 'Error',
            text: 'Failed to move ' + direction,
            icon: 'error'
        });
        return false;
    }
}

/**
 * Initializes the robot system
 * Checks stability, activates wheels and arms
 * @param {WebSocket} ws - WebSocket connection for sync
 * @param {string} robotName - Name of the robot
 * @returns {Promise<boolean>} True if initialization successful
 */
export async function initializeSystem(ws, robotName, attemptId) {
    try {
        // Wait for system stabilization
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Check stability (Uncomment if an external help is needed to raise)
//        const isStable = await checkStability(ws, robotName);
//        if (!isStable) return false;

        const confirmWheels = await showSyncedPopup(ws, { // Added await and variable to store result
            title: 'Activating Wheels',
            text: 'Pay attention!! Robot is activating balancing...', // RAISE the ROBOT and then Click OK to continue.', // Modified text
            icon: 'warning',
            timer: 5000, // Removed timer
            timerProgressBar: true, // Removed timer progress bar
            showConfirmButton: false, //true, // Show confirm button
            // confirmButtonText: 'OK', // Set confirm button text
            // allowOutsideClick: false, // Prevent closing by clicking outside
            // allowEscapeKey: false, // Prevent closing with ESC key
            // showCancelButton: false // Ensure no cancel button is shown
        });

        // Check if the user confirmed
        /*if (!confirmWheels) {
            console.log('Wheel activation cancelled by user.');
            // Optionally, show another popup or handle cancellation
            await showSyncedPopup(ws, {
                title: 'Cancelled',
                text: 'Wheel activation was cancelled.',
                icon: 'info',
                timer: 2000,
                showConfirmButton: false
            });
            return false; // Stop the initialization if cancelled
        }*/

        // Start wheels control
        logStartupEvent(attemptId, 'startup.service', { stage: 'wheels', outcome: 'dispatched' });
        sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.WHEELS}`,
            { attemptId, stage: 'wheels' });
        await new Promise(r => setTimeout(r, 2000));
        
        // Activate arm motors
        logStartupEvent(attemptId, 'startup.service', { stage: 'body_activation', outcome: 'dispatched' });
        sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.BODY_ACTIVATION}`,
            { attemptId, stage: 'body_activation' });
        await new Promise(r => setTimeout(r, 2000));

        console.log("Pre Checking arm motors activation...");

        // Check motors activation
        const motorsActivated = await checkMotorsActivation(ws, robotName);
        logStartupEvent(attemptId, 'startup.check', { stage: 'arm_motors', outcome: motorsActivated ? 'passed' : 'failed' });
        if (!motorsActivated) return false;
        
        await new Promise(r => setTimeout(r, 2000));
        console.log("Pre Checking arm motors movement...");
        
        // Start movement control
        logStartupEvent(attemptId, 'startup.service', { stage: 'body_movement', outcome: 'dispatched' });
        sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.BODY_MOVEMENT}`,
            { attemptId, stage: 'body_movement' });
        await new Promise(r => setTimeout(r, 2000));
        
        
        const movementInitialized = await checkMovementController(ws);
        logStartupEvent(attemptId, 'startup.check', { stage: 'movement_timer', outcome: movementInitialized ? 'elapsed' : 'failed' });
        if (!movementInitialized) return false;       

        return true;

    } catch (error) {
        logStartupEvent(attemptId, 'startup.exception', { stage: 'system', detail: error.message });
        console.error('Error in system initialization:', error);
        await showSyncedPopup(ws, {
            title: 'Error',
            text: 'System initialization failed',
            icon: 'error'
        });
        return false;
    }
}
/**
 * Retrieves value from a ROS topic with retry mechanism
 * @param {string} topic - ROS topic path
 * @returns {Promise<output|null>} Topic values or null if unavailable
 */
export async function getTopicValue(topic) {
    try {
        // Add retry mechanism
        let retries = 3;
        while (retries > 0) {
            try {
                const response = await fetch('/grep-command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        command: ROS_MASTER_URI + ' && ' + ROS_IP + ' && ' + ROS_HOSTNAME + ` && source /opt/ros/noetic/setup.bash && source ` + ROS_CATKIN_WS + `/devel/setup.bash && rostopic echo -n 1 ${topic}`
                    })
                });
 
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const data = await response.json();
                if (!data || !data.output) {
                    //console.warn('No data received from topic:', topic);
                    throw new Error(`No data received from topic: ${topic}`);
                    //return null;
                }
                
                return data.output;
                
            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                console.warn(`Retry attempt left: ${retries}`);
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
            }
        }
    } catch (error) {
        console.error('Error reading topic:', error);
        // If it's an SSH error, try to reconnect
        if (error.message.includes('SSH') || error.message.includes('Channel open failure')) {
            console.log('SSH connection lost, attempting to reconnect...');
            // Notify user of connection issue
            Swal.fire({
                title: 'Connection Lost',
                text: 'Attempting to reconnect...',
                icon: 'warning',
                showConfirmButton: false,
                allowOutsideClick: false,
                allowEscapeKey: false,
                timer: 2000
            });
        }
        return null;
    }
}

/**
 * Checks robot stability using IMU readings
 * @param {string} robotName - Name of the robot
 * @returns {Promise<boolean>} True if robot is stable
 */
export async function checkStability(ws, robotName) {
    try {
        console.log("Starting stability check...");
        await new Promise(resolve => setTimeout(resolve, 500));

        return new Promise((resolve) => {
            let checkInterval;
            let consecutiveNullReadings = 0;
            const MAX_NULL_READINGS = 5;
            const POLLING_INTERVAL = 500;
            
            let stableStartTime = null;
            
            // Show progress popup with stability checking
            showSyncedPopup(ws, {
                title: 'Checking Stability...',
                text: 'Please wait and raise the robot',
                allowOutsideClick: false,
                allowEscapeKey: false,
                showConfirmButton: false,
                didOpen: () => {
                    if (Swal.getPopup()) {
                        Swal.showLoading();
                    }
                    // Start checking stability
                    checkInterval = setInterval(async () => {
                        try {
                            const topicDataOutput = await getTopicValue(`/${robotName}/imu/RPY`);
                            
                            // Extract y value
                            const match = topicDataOutput.match(/y:\s*([-]?\d*\.?\d*)/);
                            if (!match) {
                                console.warn('Could not parse y value from:', topicDataOutput);
                                return null;
                            }                            
                            const value = parseFloat(match[1]);

                            console.log('IMU value:', value, 'Time:', new Date().toISOString());
                            
                            if (value === null) {
                                consecutiveNullReadings++;
                                console.warn(`Null reading #${consecutiveNullReadings}`);
                                
                                if (consecutiveNullReadings >= MAX_NULL_READINGS) {
                                    console.error('Too many failed readings');
                                    clearInterval(checkInterval);
                                    Swal.close();
                                    await showSyncedPopup(ws, {
                                        title: 'Error',
                                        text: 'Stability check failed - No readings',
                                        icon: 'error'
                                    });
                                    resolve(false);
                                    return;
                                }
                                return;
                            }
                            
                            consecutiveNullReadings = 0;
                            
                            if (value >= -0.2 && value <= 0.1) {
                                if (!stableStartTime) {
                                    stableStartTime = Date.now();
                                    console.log('Started stability timer');
                                }
                                
                                const stableTime = Date.now() - stableStartTime;
                                console.log('Stable for:', (stableTime/1000).toFixed(1), 'seconds');
                                
                                if (stableTime >= 2000) {
                                    console.log('Stability achieved');
                                    clearInterval(checkInterval);
                                    Swal.close();
                                    await showSyncedPopup(ws, {
                                        title: 'Complete',
                                        text: 'Stability check successful',
                                        icon: 'success',
                                        timer: 1500,
                                        showConfirmButton: false
                                    });
                                    resolve(true);
                                    return;
                                }
                            } else {
                                if (stableStartTime) {
                                    console.log('Stability lost, resetting timer');
                                    stableStartTime = null;
                                }
                            }
                        } catch (error) {
                            console.error('Error in stability check:', error);
                        }
                    }, POLLING_INTERVAL);
                },
                willClose: () => {
                    if (checkInterval) {
                        clearInterval(checkInterval);
                    }
                }
            });
        });

    } catch (error) {
        console.error('Error in stability check:', error);
        await showSyncedPopup(ws, {
            title: 'Error',
            text: 'Stability check failed',
            icon: 'error'
        });
        return false;
    }
}
/**
 * Checks if arm motors are properly activated
 * @param {WebSocket} ws - WebSocket connection for sync
 * @param {string} robotName - Name of the robot
 * @returns {Promise<boolean>} True if motors are activated
 */
export async function checkMotorsActivation(ws, robotName) {
    return new Promise((resolve) => {
        let activationDetected = false;
        let checkCount = 0;
        const MAX_ATTEMPTS = 10; // 20 seconds (10 * 2000ms)
        console.log("Checking arm motors activation...");
        // Show progress popup with activation checking
        showSyncedPopup(ws, {
            title: 'Activating arms...',
            text: 'Waiting for activation',
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            willOpen: () => {
                if (Swal.getPopup()) {
                    Swal.showLoading();
                }

                // Start checking activation in intervals
                const checkInterval = setInterval(async () => {
                    try {
                        const response = await fetch('/grep-command', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                command: `source /opt/ros/noetic/setup.bash && source ` + ROS_CATKIN_WS + `/devel/setup.bash && rostopic echo -n 1 /${robotName}/alterego_state/upperbody | grep left_meas_arm_shaft`
                            })
                        });
                         
                        const data = await response.json();
                        if (data?.output) {
                            const values = data.output.match(/[-]?\d*\.?\d+/g);
                            if (values?.some(v => Math.abs(parseFloat(v)) > 0.01)) {
                                console.log('Activation detected:', values);
                                clearInterval(checkInterval);
                                Swal.close();
                                resolve(true);
                                return;
                            }
                        }

                        checkCount++;
                        if (checkCount >= MAX_ATTEMPTS) {
                            clearInterval(checkInterval);
                            Swal.close();
                            resolve(false);
                        }
                    } catch (error) {
                        console.error('Error checking arm movement:', error);
                        checkCount++;
                    }
                }, 2000);

                // Cleanup on popup close
                Swal.getPopup().addEventListener('swal-closed', () => {
                    clearInterval(checkInterval);
                    resolve(false);
                });
            }
        });
    });
}
/**
 * Checks if movement controller is running
 * @param {WebSocket} ws - WebSocket connection for sync
 * @returns {Promise<boolean>} True if controller is active
 */
export async function checkMovementController(ws) {
    return new Promise((resolve) => {
        showSyncedPopup(ws, {
            title: 'Activating movement...',
            text: 'Please wait...',
            timer: 5000,
            timerProgressBar: true,
            allowOutsideClick: false,
            allowEscapeKey: false,
            showConfirmButton: false,
            willOpen: () => {
                if (Swal.getPopup()) {
                    Swal.showLoading();
                }
            }
        }).then(() => {
            resolve(true);
        });
    });
}
/**
 * Initializes WebSocket connection for state synchronization
 * @param {Object} state - Current application state
 * @param {Function} updateUI - Function to update UI with new state
 * @returns {WebSocket} Configured WebSocket instance
 */
export function initializeWebSocket(state, updateUI) {
    const socket = new WebSocket('ws://localhost:3000');
    
    socket.onopen = () => {
        console.log('WebSocket connected');
        socket.send(JSON.stringify({ type: 'stateRequest' }));
    };

    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'stateUpdate') {
            Object.assign(state, data.data);
            updateUI(state);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    socket.onclose = () => {
        console.log('WebSocket disconnected');
    };

    return socket;
}
/**
 * Shows a synchronized popup across all connected clients
 * @param {WebSocket} ws - WebSocket connection
 * @param {Object} popupData - SweetAlert2 configuration object
 * @param {string} popupData.title - Popup title
 * @param {string} popupData.text - Popup message
 * @param {string} [popupData.icon] - Popup icon type
 * @param {boolean} [popupData.showCancelButton] - Show cancel button
 * @param {boolean} [popupData.allowOutsideClick] - Allow clicking outside
 * @param {boolean} [popupData.allowEscapeKey] - Allow ESC key to close
 * @returns {Promise<boolean>} True if confirmed, false otherwise
 */
export function showSyncedPopup(ws, popupData) {
    // Evita duplicati
    if (Swal.isVisible()) return Promise.resolve(false);
    
    // Notifica altri client
    ws.send(JSON.stringify({
        type: 'popup',
        data: popupData
    }));

    // Visualizza il popup localmente e ritorna la Promise
    return Swal.fire({
        ...popupData,
        // Handler per la chiusura del popup
        didClose: () => {
            // Notifica la chiusura agli altri client
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'closePopup'
                }));
            }
        }
    }).then((result) => {
        // Gestione click sul pulsante OK
        if (result.isConfirmed) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'closePopup'
                }));
            }
        }
        return result.isConfirmed;
    });
}

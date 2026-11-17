import { isBaseReady, showSyncedPopup} from '../api.js';
import { STATE } from '../constants.js';
import { updateUI } from '../utils.js';
import { robotPowerOnClick, pauseProcedures, restartFromPauseProcedures, endChargeProcedures, startTour } from '../workflow.js';
import { logStartupEvent, newStartupAttemptId } from '../startupLog.js';

let mainButtonBusy = false;

/**
 * Gestisce il click sul pulsante di accensione
 * Controlla la connessione e avvia/spegne il sistema
 */
export async function handleMainButtonClick(ws, state, robotName) {

    const attemptId = newStartupAttemptId();
    if (mainButtonBusy) {
        logStartupEvent(attemptId, 'button.ignored', { outcome: 'busy', pipelineState: state.pipelineState });
        return false;
    }
    mainButtonBusy = true;
    let handled = false;
    const mainBtn = document.getElementById('mainBtn');
    mainBtn.disabled = true;
    logStartupEvent(attemptId, 'button.press', { pipelineState: state.pipelineState, isPowered: state.isPowered });

    try {
        // Verifica connessione al computer base
        state.baseReady = await isBaseReady();
        const isRemoteComputerOnline = state.baseReady;
        logStartupEvent(attemptId, 'button.base_ping', { outcome: isRemoteComputerOnline ? 'ok' : 'failed' });
        if (!isRemoteComputerOnline) {
            // Mostra errore se non connesso
            const popupData = {
                title: 'ERROR',
                text: 'Base computer not connected',
                icon: 'error'
            };
            
            ws.send(JSON.stringify({
                type: 'popup',
                data: popupData
            }));
            return;
        }
        
                                 

        if (state.pipelineState == STATE.WORK_MODE ||
            state.pipelineState == STATE.PAUSED){
            handled = true;
            console.log('work mode or paused');

            // The system is already active --> Play / Pause

            if (state.pipelineState == STATE.WORK_MODE){
                // Clicked to Pause
                pauseProcedures(ws, state, robotName);
                state.isRunning = false;
            }
            else {
                // Clicked to Play
                state.isRunning = await restartFromPauseProcedures(ws, state, robotName);
            }                    
            
            // Notify new state
            ws.send(JSON.stringify({
                type: 'stateUpdate',
                data: { isRunning: state.isRunning }
            }));
        }
        //print state
        console.log(state.pipelineState);

        if (state.pipelineState == STATE.INIT ||
            state.pipelineState == STATE.DOCKED ||
            state.pipelineState == STATE.RECOVERY_FROM_EMERGENCY ||
            state.startFailed){
            handled = true;
            
            // First popup - Global warning
            const warnAnsw = await showSyncedPopup(ws, {
                title: 'Start Robot',
                text: "The system will move back and activate the robot now. Are you sure?",
                icon: 'warning',
                showCancelButton: true,
                allowOutsideClick: false,
                allowEscapeKey: false,
                confirmButtonText: 'OK, Activate Robot'
            });
            
            logStartupEvent(attemptId, 'button.confirm', { outcome: warnAnsw ? 'accepted' : 'cancelled' });
            if (!warnAnsw) return false;

            if (state.pipelineState == STATE.DOCKED) {  // In this case, the robot is still active
                endChargeProcedures(ws, state);
            }
            else {
                // Clicked to Start Robot
                logStartupEvent(attemptId, 'button.start_dispatched', { pipelineState: state.pipelineState });
                state.isPowered = true;

                // Notify new state
                ws.send(JSON.stringify({
                    type: 'stateUpdate',
                    data: { isPowered: state.isPowered }
                }));
                const started = await robotPowerOnClick(ws, state, robotName, attemptId);
                logStartupEvent(attemptId, 'button.start_settled', {
                    outcome: started ? 'success' : 'failed', pipelineState: state.pipelineState
                });
                if (!started) {
                    await showSyncedPopup(ws, {
                        title: 'Startup incomplete',
                        text: 'Robot startup did not finish. Keep the robot supported and use the supervised recovery procedure.',
                        icon: 'error'
                    });
                    return false;
                }
            }            
        }
        if (!handled) {
            logStartupEvent(attemptId, 'button.ignored', { pipelineState: state.pipelineState, isPowered: state.isPowered });
        }

    } catch (error) {
        logStartupEvent(attemptId, 'button.exception', { pipelineState: state.pipelineState, detail: error.message });
        console.error('Main button error:', error);
        // No need to restore state, since change happens after procedures    
        ws.send(JSON.stringify({
            type: 'popup',
            data: {
                title: 'Error',
                text: error.message,
                icon: 'error'
            }
        }));
    }
    finally {
        mainButtonBusy = false;
        updateUI(state);
        logStartupEvent(attemptId, 'button.settled', { pipelineState: state.pipelineState, isPowered: state.isPowered });
    }
}

const START_MODES = {
    static: { title: 'Start without motion', text: 'Starts ROS, face tracking and speech only. No wheels, no body activation, no head motion. Continue?' },
    balance: { title: 'Start balance only', text: 'The robot moves back from the dock, stands up and balances. No navigation. Continue?' },
    tour: { title: 'Start Tour', text: 'The robot will drive the tour autonomously. Keep the area clear. Continue?' }
};

// Start buttons on the Settings page. Same guards as Start: one action at a time, base reachable, confirm.
export async function handleStartMode(ws, state, robotName, mode) {
    const attemptId = newStartupAttemptId();
    if (mainButtonBusy) {
        logStartupEvent(attemptId, 'button.ignored', { outcome: 'busy', detail: `mode=${mode}` });
        return false;
    }
    const tourOnly = mode === 'tour' && state.pipelineState == STATE.WORK_MODE;
    const startable = state.pipelineState == STATE.INIT || state.pipelineState == STATE.DOCKED ||
        state.pipelineState == STATE.RECOVERY_FROM_EMERGENCY || state.startFailed;
    if (!tourOnly && !startable) {
        await showSyncedPopup(ws, { title: START_MODES[mode].title, text: 'Not available now: power off or finish the current start first.', icon: 'info' });
        return false;
    }
    mainButtonBusy = true;
    try {
        state.baseReady = await isBaseReady();
        if (!state.baseReady) {
            await showSyncedPopup(ws, { title: 'ERROR', text: 'Base computer not connected', icon: 'error' });
            return false;
        }
        const ok = await showSyncedPopup(ws, {
            title: START_MODES[mode].title, text: START_MODES[mode].text, icon: 'warning',
            showCancelButton: true, allowOutsideClick: false, allowEscapeKey: false, confirmButtonText: 'OK'
        });
        logStartupEvent(attemptId, 'button.confirm', { outcome: ok ? 'accepted' : 'cancelled', detail: `mode=${mode}` });
        if (!ok) return false;
        if (!tourOnly) {
            state.isPowered = true;
            ws.send(JSON.stringify({ type: 'stateUpdate', data: { isPowered: true } }));
        }
        const started = mode === 'tour' ? await startTour(ws, state, robotName, attemptId)
            : await robotPowerOnClick(ws, state, robotName, attemptId, mode);
        if (!started) {
            await showSyncedPopup(ws, { title: 'Startup incomplete', text: `${START_MODES[mode].title} did not finish. See Settings > Generale > Startup log.`, icon: 'error' });
        }
        return started;
    } finally {
        mainButtonBusy = false;
        updateUI(state);
    }
}

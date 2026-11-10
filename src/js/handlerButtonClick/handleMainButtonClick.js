import { pingRemoteComputer, showSyncedPopup} from '../api.js';
import { STATE } from '../constants.js';
import { updateUI } from '../utils.js';
import { robotPowerOnClick, pauseProcedures, restartFromPauseProcedures, endChargeProcedures } from '../workflow.js';
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
        const isRemoteComputerOnline = await pingRemoteComputer();
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
                restartFromPauseProcedures(ws, state, robotName);
                state.isRunning = true;
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
            state.pipelineState == STATE.RECOVERY_FROM_EMERGENCY){
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

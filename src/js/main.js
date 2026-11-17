// Importa le costanti e le funzioni utilities necessarie
import { handleMainButtonClick } from './handlerButtonClick/handleMainButtonClick.js';
import { ClickMonitor, clickMonitorClose, UnlockClickMonitor } from './handlerButtonClick/handleAdminMenuButtonClick.js';
import { handleSecondButtonClick } from './handlerButtonClick/handleSecondButtonClick.js';

// Importa le costanti e le funzioni utilities necessarie
import { updateUI, loadComponent, closeAdminMenu, setVolume, closeVolumeMenu } from './utils.js';
import { initSettingsPanel, openSettingsPanel, openStatusPanel } from './settingsPanel.js';
import { getRobotName, isBaseReady, sendCommand, showSyncedPopup, startBatteryCheck } from './api.js';
import { batteryMonitor } from './batterymonitor.js';
import { LAUNCH_COMMANDS, ROS_COMMANDS, STATE , initializeConfig } from './constants.js';
import { overrideInitRobotState, restartAuto } from './workflow.js';

// Stato globale dell'applicazione
// Mantiene lo stato di accensione, esecuzione e UI
let state = {
    isPowered: false,    // Stato di accensione del sistema
    isRunning: false,    // Stato di esecuzione del sistema
    pipelineState: 0,    // Workflow State
    uiState: {
        activePopup: null,     // Popup attualmente visualizzato
        notifications: []      // Coda delle notifiche (max 10)
    }
};

// Connessione WebSocket globale
let ws;

// Nome del robot nel file .bashrc
let robotName;

/**
 * Inizializza la connessione WebSocket
 * Gestisce gli aggiornamenti di stato e la riconnessione automatica
 */
// Resolves on the first server state: initApp reads pipelineState (RESTART_AUTO) only after it.
let resolveFirstState;
const firstState = new Promise(resolve => { resolveFirstState = resolve; });

function initWebSocket() {
    ws = new WebSocket(`ws://localhost:3000`);
    ws.onopen = () => {
        console.log('WebSocket connected');
        ws.send(JSON.stringify({ type: 'requestInitialState' }));
    };
   
    // Handler per i messaggi in arrivo
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'stateUpdate') {
            // Aggiorna lo stato locale con i nuovi dati
            const newState = message.data;
            Object.assign(state, newState, {
                uiState: { ...state.uiState, ...(newState.uiState || {}) }
            });
            
            // Aggiorna l'interfaccia utente
            updateUI(state);
            resolveFirstState();
            
            // Gestione sincronizzata dei popup
            if (!state.uiState.activePopup && Swal.isVisible()) {
                Swal.close();  // Chiudi popup se non più attivo
            }
            else if (state.uiState.activePopup) {
                showSyncedPopup(ws, state.uiState.activePopup);
            }
        }
    };
    
    // Gestione riconnessione automatica
    ws.onclose = () => {
        setTimeout(initWebSocket, 5000);  // Riprova ogni 5 secondi
    };
}


/**
 * Inizializza l'applicazione
 * Carica i componenti e configura gli event listener
 */
async function initApp() {
    // Initialize config first
    await initializeConfig();
    console.log('Config initialized');

    // Carica i componenti UI
    const resLoad = await loadComponent('button-grid', 'components/button-grid.html');
    const resComp = await loadComponent('status-panel', 'components/status-panel.html');
    await loadComponent('settings-panel', 'components/settings-panel.html');

    // Connect after the controls exist: the server sends state immediately on connect.
    initWebSocket();

    // Configura i pulsanti
    const mainBtn = document.getElementById('mainBtn');
    const secondBtn = document.getElementById('secondBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const volumeBtn = document.getElementById('volumeBtn');
    const closeBtn = document.getElementById('closeBtn');
    const logoBtn = document.getElementById('alterEgoLogo');
    const unlockOverlay = document.getElementById('unlockOverlay');
    
    // Configura monitor per clicks e batteria
    const monitor = new ClickMonitor(ws, logoBtn);
    const unlockMonitor = new UnlockClickMonitor(ws, unlockOverlay);

    // Get Robot Name
    robotName = "robot_adriano"; //await getRobotName();

    // Aggiungi event listener
    mainBtn.addEventListener('click', () => handleMainButtonClick(ws, state, robotName));   
    secondBtn.addEventListener('click',  () => handleSecondButtonClick(ws, state, robotName));
    settingsBtn.addEventListener('click',  () => openSettingsPanel());
    document.getElementById('statusBtn').addEventListener('click', () => openStatusPanel());
    initSettingsPanel({ getWs: () => ws, state, robotName });
    volumeBtn.addEventListener('click',  () => setVolume());
    closeBtn.addEventListener('click',  () => clickMonitorClose(monitor, unlockMonitor));

    // Gestione del click fuori dal popup per chiuderlo
    document.getElementById('popupOverlay').addEventListener('click', function(e) {
        if (e.target === this) {
            closeAdminMenu();
            closeVolumeMenu();
        }
    });

    // Rimuovi classe loading
    document.querySelectorAll('.loading').forEach(el => {
        el.classList.add('loaded');
    });
    
    // Wait for the server state (max 5 s), or a reload after charging never sees RESTART_AUTO.
    await Promise.race([firstState, new Promise(r => setTimeout(r, 5000))]);

    if (state.pipelineState == STATE.RESTART_AUTO){
        restartAuto(ws, state, robotName);

        state.pipelineState = STATE.INIT;
            
        ws.send(JSON.stringify({
            type: 'stateUpdate',
            data: { pipelineState: state.pipelineState }
        }));    
    }
    else {
        overrideInitRobotState(ws, state);
    }

    // Aggiorna l'interfaccia utente 
    updateUI(state);

    // Probe the base over SSH every 2 s while in INIT; updateUI keeps Start disabled until it answers.
    let batteryStarted = false;
    for (;;) {
        if (state.pipelineState == STATE.INIT || !state.baseReady) {
            const ready = await isBaseReady();
            if (ready !== state.baseReady) {
                state.baseReady = ready;
                updateUI(state);
            }
        }
        if (state.baseReady && !batteryStarted) {
            batteryStarted = true;
            // Start battery monitor script
            sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.BATTERY_MONITOR.START}`);
            await new Promise(r => setTimeout(r, 1000));
            console.log("Start Battery Monitoring");
            batteryMonitor.start(ws, state.pipelineState);
            // Start checking battery
            startBatteryCheck(robotName);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// Avvia l'applicazione quando il DOM è pronto
document.addEventListener('DOMContentLoaded', initApp);

// Importa le costanti e le funzioni utilities necessarie
import { handleMainButtonClick } from './handlerButtonClick/handleMainButtonClick.js';
import { ClickMonitor, clickMonitorClose, UnlockClickMonitor } from './handlerButtonClick/handleAdminMenuButtonClick.js';
import { handleSecondButtonClick } from './handlerButtonClick/handleSecondButtonClick.js';

// Importa le costanti e le funzioni utilities necessarie
import { updateUI, loadComponent, closeAdminMenu, settingsAction, setVolume, closeVolumeMenu } from './utils.js';
import { getRobotName, pingRemoteComputer, sendCommand, showSyncedPopup, startBatteryCheck } from './api.js';
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
function initWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}`);
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
    settingsBtn.addEventListener('click',  () => settingsAction());
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

    // Start Battery Monitor
    var isRemoteComputerOnline = await pingRemoteComputer();
    while (!isRemoteComputerOnline) {
        // Mostra errore se non connesso
        const popupData = {
            title: 'ERROR',
            text: 'Base computer still not connected. Try again in 5 seconds..',
            icon: 'warning',
            timer: 5000, // Removed timer
            timerProgressBar: true, // Removed timer progress bar
            showConfirmButton: false,
        };
        
        // Try once again
        isRemoteComputerOnline = await pingRemoteComputer();
    }

    if (isRemoteComputerOnline) {        
        // Start battery monitor script
        sendCommand(`${ROS_COMMANDS.SETUP} && export ROBOT_NAME=${robotName} && ${LAUNCH_COMMANDS.BATTERY_MONITOR.START}`);
        await new Promise(r => setTimeout(r, 1000));
        console.log("Start Battery Monitoring");
    }
    batteryMonitor.start(ws, state.pipelineState);
    
    // Start checking battery
    startBatteryCheck(robotName);
}

// Avvia l'applicazione quando il DOM è pronto
document.addEventListener('DOMContentLoaded', initApp);

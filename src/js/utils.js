import { sendLocalCommand } from './api.js';
import { batteryMonitor } from './batterymonitor.js';
import { STATE, UI_STATES } from './constants.js';

// Salva lo stato dei pulsanti nel localStorage
export function saveButtonState(buttonId, state) {
    localStorage.setItem(buttonId, state);
}

// Carica lo stato dei pulsanti dal localStorage
export function loadButtonState(buttonId) {
    return localStorage.getItem(buttonId) === 'true';
}

// Aggiorna l'interfaccia utente in base allo stato
export function updateUI(state) {    

    const mainBtn = document.getElementById('mainBtn');
    const secondBtn = document.getElementById('secondBtn');
    const powerStatus = document.getElementById('powerStatus');
    const systemStatus = document.getElementById('systemStatus');

    // Aggiorna stato power
    if (state.isPowered && !batteryMonitor.getPowerAlert()) {
        powerStatus.style.backgroundColor = UI_STATES.POWER_ON.color;
        document.querySelector('#powerStatus + span').textContent = UI_STATES.POWER_ON.text;
    } else {
        powerStatus.style.backgroundColor = UI_STATES.POWER_OFF.color;
        document.querySelector('#powerStatus + span').textContent = UI_STATES.POWER_OFF.text;
    }

    // Aggiorna stato sistema
    if (state.isRunning) {
        systemStatus.style.backgroundColor = UI_STATES.SYSTEM_RUNNING.color;
        document.querySelector('#systemStatus + span').textContent = UI_STATES.SYSTEM_RUNNING.text;
    } else {
        systemStatus.style.backgroundColor = UI_STATES.SYSTEM_READY.color;
        document.querySelector('#systemStatus + span').textContent = UI_STATES.SYSTEM_READY.text;
    }
    
    // Aggiorna stato dei pulsanti
    switch(state.pipelineState){
        case STATE.INIT:
            mainBtn.disabled = !state.baseReady;
            if (!state.baseReady) document.querySelector('#systemStatus + span').textContent = 'Waiting for base computer';
            secondBtn.disabled = false;        
            updateMainBtn('start_robot');
            updateSecondBtn('power_off');
            break;
        case STATE.ACTIVATE_ROBOT:
        case STATE.STAND_UP:
            // Disabled while starting; Retry and Power Off after a failed start.
            mainBtn.disabled = !state.startFailed;
            secondBtn.disabled = !state.startFailed;
            if (state.startFailed) {
                mainBtn.innerHTML = '<i class="fas fa-rotate-right"></i><span>Retry</span>';
                updateSecondBtn('power_off');
            }
            break;
        case STATE.WORK_MODE:
            mainBtn.disabled = false;
            secondBtn.disabled = false;        
            updateMainBtn('pause');
            updateSecondBtn(state.startMode === 'static' || state.startMode === 'balance' ? 'power_off' : 'home');
            break;
        case STATE.PAUSED:
            mainBtn.disabled = false;        
            secondBtn.disabled = false;        
            updateMainBtn('play');
            if (state.startMode === 'static' || state.startMode === 'balance') updateSecondBtn('power_off');
            break;
        case STATE.DOCKED:
            mainBtn.disabled = false;        
            secondBtn.disabled = false;        
            updateMainBtn('start_robot');
            updateSecondBtn('power_off');
            break;    
        case STATE.RECOVERY_FROM_EMERGENCY:
            mainBtn.disabled = false;        
            secondBtn.disabled = false;        
            updateMainBtn('start_robot');
            updateSecondBtn('power_off');
            break;
        default:
            break;
    }
}

function updateMainBtn(show){

    const mainBtn = document.getElementById('mainBtn');

    if (show == 'start_robot'){
        mainBtn.innerHTML = '<i class="fas fa-circle-play"></i><span>Start Robot</span>';        
        mainBtn.classList.remove('play');
        mainBtn.classList.remove('pause');
    }
    else if (show == 'pause'){
        mainBtn.innerHTML = '<i class="fas fa-pause"></i><span>Pause</span>';
        mainBtn.classList.add('play'); 
        mainBtn.classList.remove('pause');       
    }
    else if (show == 'play'){
        mainBtn.innerHTML = '<i class="fas fa-play"></i><span>Play</span>';
        mainBtn.classList.add('pause');
        mainBtn.classList.remove('play');
    }
}

function updateSecondBtn(show){

    const secondBtn = document.getElementById('secondBtn');

    if (show == 'power_off'){
        secondBtn.innerHTML = '<i class="fas fa-power-off"></i><span>Power Off</span>';  
        secondBtn.classList.remove('home');      
    }
    else if (show == 'home'){
        secondBtn.innerHTML = '<i class="fas fa-home"></i><span>Home</span>';
        secondBtn.classList.add('home');        
    }
}

// Carica i componenti HTML
export async function loadComponent(elementId, componentPath) {
    try {
        const response = await fetch(componentPath);
        const html = await response.text();
        document.getElementById(elementId).innerHTML = html;
    } catch (error) {
        console.error(`Error loading component ${componentPath}:`, error);
    }
}

export function updateBatteryGraphics(powerAlert, isCharging, isDocked, batteryLevel){
    const batteryIcon = document.getElementById('batteryIcon');
    const batteryStatus = document.getElementById('batteryStatus');
    const dockingStation = document.getElementById('dockingStation');
    const dockingIcon = document.getElementById('dockingIcon');

    batteryIcon.innerHTML = "Battery ";        

    if (powerAlert) {
        batteryStatus.style.backgroundColor = UI_STATES.BATTERY_ALERT.color;
        batteryIcon.innerHTML += "<span style=\"color:rgb(250, 155, 30)\"><i class=\"fa fa-triangle-exclamation blink\"></i></span>";
        dockingIcon.innerHTML = "<span style=\"color:rgb(250, 155, 30)\"><i class=\"fas fa-charging-station blink\"></i></span>";
    } else {
        batteryStatus.style.backgroundColor = UI_STATES.BATTERY_OK.color;
        dockingIcon.innerHTML = "<i class=\"fas fa-charging-station\"></i>";

        if (batteryLevel > 75){          //75-100%
            batteryIcon.innerHTML += "<i class=\"fa fa-battery-full\"></i>";
        }
        else {
            if (batteryLevel > 50){      //50-75%
                batteryIcon.innerHTML += "<i class=\"fa fa-battery-three-quarters\"></i>";
            }
            else {
                if (batteryLevel > 25){  //25-50%
                    batteryIcon.innerHTML += "<i class=\"fa fa-battery-half\"></i>";
                }
                else {                  //0-25%
                    batteryIcon.innerHTML += "<i class=\"fa fa-battery-quarter\"></i>";
                }
            }   
        }
    }

    if (isCharging){
        batteryIcon.innerHTML += " <i class=\"fa fa-bolt blink\"></i>";
    }    

    dockingStation.style.display = (isDocked == true)?'block':'none';

}

export function openPopup() {
    document.getElementById('popupOverlay').style.display = 'block';
    document.getElementById('popup').style.display = 'block';
}

function handleVolumeChange (e) {
    const volume = e.target.value;
    
    // Aggiorna il volume del sistema
    setVolumeLevel(volume);
}

// Funzione per ottenere il volume corrente
async function getInitialVolume() {
    try {
        const command = "pactl list sinks | grep \"Volume:\" | head -n 1";
        const volumeString = await sendLocalCommand(command, undefined, true);  // needs the output
        // Extract the percentage value (e.g. 75%)
        let pactlVolume = parseInt(volumeString.output.split('%')[0].split('/').pop().trim());
        // Limits to 150 and map on the slider
        if (isNaN(pactlVolume)) pactlVolume = 50;
        if (pactlVolume > 150) pactlVolume = 150;
        return pactlVolume;
    } catch (error){
        return 50;      //Default in case of error
    }
}

function setVolumeLevel(level){
    // Limits the level between 0 and 150
    let pactlLevel = Math.max(0, Math.min(150, parseInt(level)));
    // Use of pactl to control output volume (accepts also >100%)
    sendLocalCommand(`pactl set-sink-volume @DEFAULT_SINK@ ${pactlLevel}%`);
}

export async function setVolume() {
    document.getElementById('popupOverlay').style.display = 'block';
    document.getElementById('popupVolume').style.display = 'block';

    const volumeSlider = document.getElementById('volumeSlider');
    volumeSlider.value = await getInitialVolume();
    volumeSlider.addEventListener('input', handleVolumeChange);
    setTimeout(() => {
        closeVolumeMenu();
    }, 10000);      // Close after 10 seconds
}

// Funzione per l'azione Settings
export function closeAdminMenu() {
    document.getElementById('popupOverlay').style.display = 'none';
    document.getElementById('popup').style.display = 'none';
}

export function closeVolumeMenu() {
    document.getElementById('popupOverlay').style.display = 'none';
    document.getElementById('popupVolume').style.display = 'none';
    document.getElementById('volumeSlider').removeEventListener('input', handleVolumeChange);    
}

export function showLoading(val) {
    const overlay = document.getElementById('loadingOverlay');
    overlay.style.display = (val)?'flex':'none';
}

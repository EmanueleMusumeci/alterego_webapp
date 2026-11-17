
export class BatteryMonitor {
    static instance;

    static getInstance() {
        if (!BatteryMonitor.instance) {
            BatteryMonitor.instance = new BatteryMonitor();
        }
        return BatteryMonitor.instance;
    }

    constructor() {
        
        this.powerAlert = false;
        this.isCharging = false;
        this.isDocked = false;
        this.needCharge = false;
        this.batteryLevel = 0;
        this.lastUpdateMs = null;  // time of the last battery reading

        this.oldPowerAlertTrigger = -1;
        this.isSetOldPowerAlertTrigger = false;
        this.oldNeedChargeTrigger = -1;
        this.isSetOldNeedChargeTrigger = false;
        this.firstNeedCharge = false;
        this.shouldAutoRestart = false;
        this.errorCounter = 0;
        this.lastBatteryLevel = 0;
        this.sameBatteryLevelCounter = 0;

        this.batteryInterval = [];
        this.isTimerSet = false;
        this.websocket = 0;
        this.fsmState = 0;  
    }

    start(ws, initState){

        this.websocket = ws;
        this.fsmState = initState;
    }   

    getState(){
        return this.fsmState;
    }

    updateFSMState(val){
        this.fsmState = val;
    }

    timerIsSet() {
        return this.isTimerSet;
    }

    updateInterval(int){
        this.batteryInterval = int;
        this.isTimerSet = true;
    }

    clearIntervalTimer(){
        if (this.batteryInterval){
            clearInterval(this.batteryInterval);
            this.isTimerSet = false;
            this.clearOldPowerAlertTrigger();
            this.clearOldNeedChargeTrigger();
        }
    }

    checkPowerAlertTrigger(){
        // Trigger should be detected and handled on time
        if (this.isSetOldPowerAlertTrigger && this.oldPowerAlertTrigger != this.powerAlert){
            this.oldPowerAlertTrigger = this.powerAlert;
            return true;
        }
        return false;
    }
    
    checkNeedChargeTrigger(){
        // Trigger should be detected and handled on time
        if (this.isSetOldNeedChargeTrigger && this.oldNeedChargeTrigger != this.needCharge){
            this.oldNeedChargeTrigger = this.needCharge;
            return true;
        }
        return false;
    }

    getPowerAlert() {
        return this.powerAlert;         
    } 

    getNeedCharge() {
        return this.needCharge;         
    } 

    getIsCharging() {
        return this.isCharging;
    }

    getIsDocked() {
        return this.isDocked;
    }

    clearOldPowerAlertTrigger(){
        this.oldPowerAlertTrigger = [];
        this.isSetOldPowerAlertTrigger = false;
    }

    clearOldNeedChargeTrigger(){
        this.oldNeedChargeTrigger = [];
        this.isSetOldNeedChargeTrigger = false;
    }

    updateState(pA, iC, iD, nC, bL){
        this.lastUpdateMs = Date.now();

        if (!this.isTimerSet){
            // It's first message, update oldPowerAlert
            this.oldPowerAlertTrigger = pA;
            this.isSetOldPowerAlertTrigger = true;
            this.oldNeedChargeTrigger = nC;
            this.isSetOldNeedChargeTrigger = true;
        }

        // Update with new values
        this.powerAlert = pA;
        this.isCharging = iC;
        this.isDocked = iD;
        this.needCharge = nC;
        this.lastBatteryLevel = this.batteryLevel;
        this.batteryLevel = bL;
    }

    checkLastBatteryLevel(){
        if (this.lastBatteryLevel == this.batteryLevel){
            this.sameBatteryLevelCounter++;
        }
        else {
            this.sameBatteryLevelCounter = 0;
        }
        
        if (this.sameBatteryLevelCounter >= 50){
            this.sameBatteryLevelCounter = 0;
            return true;
        }
        else {
            return false;
        }
    }

    getErrorCounter(){
        return this.errorCounter;
    }

    updateErrorCounter(){
        this.errorCounter++;
    }

    resetErrorCounter(){
        this.errorCounter = 0;
    }

    getFirstNeedCharge(){
        return this.firstNeedCharge;
    }

    setFirstNeedCharge(val){
        this.firstNeedCharge = val;
    }

    getShouldAutoRestart(){
        return this.shouldAutoRestart;
    }

    setShouldAutoRestart(val){
        this.shouldAutoRestart = val;
    }

    getBatteryLevel(){
        return this.batteryLevel;
    }

    // Age of the last reading in ms; null before the first reading.
    getReadingAgeMs(){
        return this.lastUpdateMs === null ? null : Date.now() - this.lastUpdateMs;
    }
}

export const batteryMonitor = BatteryMonitor.getInstance();
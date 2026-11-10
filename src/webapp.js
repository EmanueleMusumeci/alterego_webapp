const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const bodyParser = require('body-parser');
const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os'); // Add os module to get system information

// Importa WebSocket
const { wss } = require('./js/websocket');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const isolatedTest = process.env.WEBAPP_TEST_MODE === '1';
// Initialize with a default value
let NUC_BASE_IP = '192.168.88.110';
let NUC_VISION_IP = '192.168.88.111';

// Get current username
const currentUsername = os.userInfo().username;
// Create the remote username once for consistent use
const remoteUsername = currentUsername.replace('-vision', '-base');
console.log(`\nCurrent Username: ${currentUsername} \nRemote Username: ${remoteUsername}\n`);

// Middleware setup
app.use(bodyParser.json());
app.use(express.json());
if (isolatedTest) {
    app.use(['/execute', '/execute-local', '/grep-command'], (_req, res) => {
        res.status(503).json({ error: 'Hardware commands disabled in isolated test mode' });
    });
}

app.post('/api/startup-log', (req, res) => {
    const { attemptId, event, clientTime, stage, outcome, pipelineState, isPowered, detail } = req.body || {};
    if (typeof attemptId !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(attemptId) ||
        typeof event !== 'string' || !/^([a-z]+\.)?[a-z_]{2,40}$/.test(event)) {
        return res.status(400).json({ error: 'Invalid startup event' });
    }

    const entry = { serverTime: new Date().toISOString(), attemptId, event };
    if (typeof clientTime === 'string' && /^\d{4}-\d\d-\d\dT/.test(clientTime)) entry.clientTime = clientTime.slice(0, 30);
    if (typeof stage === 'string') entry.stage = stage.replace(/[^a-z0-9_]/gi, '').slice(0, 40);
    if (typeof outcome === 'string') entry.outcome = outcome.replace(/[^a-z0-9_]/gi, '').slice(0, 40);
    if (Number.isInteger(pipelineState)) entry.pipelineState = pipelineState;
    if (typeof isPowered === 'boolean') entry.isPowered = isPowered;
    if (typeof detail === 'string') entry.detail = detail.replace(/[\r\n]/g, ' ').slice(0, 160);
    console.log('[startup] ' + JSON.stringify(entry));
    res.status(204).end();
});

function logStartupCommand(req, event, outcome, detail) {
    const { startupAttemptId, startupStage } = req.body || {};
    if (typeof startupAttemptId !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(startupAttemptId) ||
        typeof startupStage !== 'string' || !/^[a-z0-9_]{2,40}$/.test(startupStage)) return;
    const entry = {
        serverTime: new Date().toISOString(), attemptId: startupAttemptId,
        event, stage: startupStage, outcome
    };
    if (detail !== undefined) entry.detail = String(detail).replace(/[\r\n]/g, ' ').slice(0, 100);
    console.log('[startup] ' + JSON.stringify(entry));
}

// Static file serving
app.use(express.static(__dirname));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Configure timeouts
app.keepAliveTimeout = 35000; // 35 seconds
app.headersTimeout = 60000; // 60 seconds

// Get host IP and derive NUC_BASE_IP using hostname -I
// Fixed function with proper Promise handling
function getMyIP() {
    return new Promise((resolve, reject) => {
        exec('hostname -I', async (error, stdout, stderr) => {
            if (error) {
                console.error('Error getting IPs:', error);
                reject(error);
                return;
            }
            
            // Get first IP address from hostname -I output
            const hostIP = stdout.trim().split(' ')[0];
            if (hostIP === '127.0.0.1') {
                console.log(`Only localhost found (127.0.0.1), try again`);
                resolve(null);          
            }
            resolve({ hostIP });
        });
    });
}

function getNucIPs() {
    return new Promise(async (resolve, reject) => {
        
        let ip = await getMyIP();        
        while (ip == null){
            await new Promise(r => setTimeout(r, 2000)); 
            ip = await getMyIP();
        }

        // Only remove the last digit from the last octet
        const ipParts = ip.hostIP.split('.');
        const lastOctet = ipParts[3];
        ipParts[3] = lastOctet.slice(0, -1) + '0';
        
        const nucIP = ipParts.join('.');
        
        console.log(`\nCurrent UserIP: ${ip.hostIP} \nRemote UserIP: ${nucIP}\n`);
        resolve({ base: nucIP, vision: ip.hostIP });
        
    });
}
// Use the async function properly
getNucIPs().then(async ips => {
    NUC_BASE_IP = isolatedTest ? '127.0.0.1' : ips.base;
    NUC_VISION_IP = isolatedTest ? '127.0.0.1' : ips.vision;
    
    // Get the robot version from .bashrc
    let robotVersion = 2; // Default value
    try {
        // Execute the command directly without SSH
        const result = await new Promise((resolve, reject) => {
            exec('grep -oP "(?<=export AlterEgoVersion=).*" ~/.bashrc', (error, stdout, stderr) => {
                if (error) {
                    console.warn('Could not find AlterEgoVersion in .bashrc, using default value');
                    resolve(null);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
        
        if (result) {
            const version = parseInt(result, 10);
            if (!isNaN(version)) {
                robotVersion = version;
                console.log(`\nRobot Version: ${robotVersion}\n`);
            }
        }
    } catch (error) {
        console.error('Error getting robot version:', error);
    }
    
    // Update config endpoint to include robot version
    app.get('/api/config', (req, res) => {
        res.json({ 
            NUC_BASE_IP: NUC_BASE_IP, 
            NUC_VISION_IP: NUC_VISION_IP,
            AlterEgoVersion: robotVersion
        });
    });
    
    // Start server only after IPs are set
    startServer();
}).catch(err => {
    console.error('Failed to get IPs:', err);
    // Use default IPs
    startServer();
});

// Move server startup to a function
function startServer() {   
    const server = app.listen(port, host, () => {
        console.log(`Server running at http://${host}:${port}`);
    });
    
    // Collegamento WebSocket al server HTTP
    server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });
}

// SSH setup
let sshConnected = false;
const sshClient = new Client();

function connectSSH() {
    if (sshConnected) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const connectionParams = {
            host: NUC_BASE_IP,
            username: remoteUsername,
            privateKey: fs.readFileSync(`/home/${currentUsername}/.ssh/id_rsa`)
        };

        sshClient.connect(connectionParams);

        sshClient.on('ready', () => {
            console.log('Connected via SSH!');
            sshConnected = true;
            resolve();
        });

        sshClient.on('error', (err) => {
            console.error('Error connecting via SSH:', err);
            sshConnected = false;
            reject(err);
        });
        // sshClient.on('error', (err) => {
        //     console.error('SSH error:', err);
        //     sshConnected = false;
        //     // Prova a riconnetterti
        //     setTimeout(() => {
        //     if (!sshConnected) connectSSH();
        //     }, 5000);
        // });

    });
}

function executeLocal(command) {
    return new Promise((resolve, reject) => {
        exec(`bash -c '${command}'`, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

app.post('/execute-local', async (req, res) => {
    logStartupCommand(req, 'command.local', 'requested');
    try {
        const output = await executeLocal(req.body.command);
        logStartupCommand(req, 'command.local', 'completed');
        res.json({ success: true, output });
    } catch (error) {
        logStartupCommand(req, 'command.local', 'failed', error.code || error.signal || 'unknown');
        console.error('Execute local error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


function execute(command) {
    return new Promise((resolve, reject) => {
        sshClient.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let output = '';
            let errorOutput = '';

            stream.on('data', (data) => {
                output += data.toString();
            });

            stream.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            stream.on('close', () => {
                if (errorOutput) {
                    console.error('Command error:', errorOutput);
                }
                resolve(output);
            });
        });
    });
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


app.post('/execute', async (req, res) => {
    logStartupCommand(req, 'command.remote', 'requested');
    const client = new Client(); // Create a new SSH client for this request
    const connectionParams = {
        host: NUC_BASE_IP,
        username: remoteUsername,
        privateKey: fs.readFileSync(`/home/${currentUsername}/.ssh/id_rsa`)
    };
    let output = '';
    let errorOutput = '';

    try {
        client.on('ready', () => {
            client.exec(req.body.command, (err, stream) => {
                if (err) {
                    logStartupCommand(req, 'command.remote', 'failed', err.code || 'exec');
                    console.error('Execute error:', err);
                    res.status(500).json({ success: false, error: err.message });
                    client.end(); // Close the connection
                    return;
                }

                stream.on('data', (data) => {
                    output += data.toString();
                });

                stream.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                stream.on('close', (code, signal) => {
                    logStartupCommand(req, 'command.remote', code === 0 ? 'completed' : 'failed',
                        `exit=${code} signal=${signal}`);
                });

                /*stream.on('close', () => {
                    client.end(); // Close the connection
                    if (errorOutput) {
                        console.error('Command error:', errorOutput);
                        res.status(500).json({ success: false, error: errorOutput });
                    } else {
                        res.json({ success: true, output });
                    }
                });*/

                // Rispondi subito con successo
                logStartupCommand(req, 'command.remote', 'accepted');
                res.json({ success: true });
            });
        });

        client.on('error', (err) => {
            logStartupCommand(req, 'command.remote', 'failed', err.code || 'connection');
            console.error('SSH connection error:', err);
            if (err.code === 'ECONNRESET') {
                console.log('ECONNRESET noticed...');  // Allow to move on turn off other NUC
                res.json({ success: true, output });
            } else {
                res.status(500).json({ success: false, error: err.message });
            }            
        });

        client.connect(connectionParams); // Connect the client
    } catch (error) {
        logStartupCommand(req, 'command.remote', 'failed', error.code || 'exception');
        console.error('Execute error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/grep-command', async (req, res) => {
    try {
        if (!sshConnected) {
            await connectSSH();
        }
        const output = await execute(req.body.command);
        res.json({ output });
    } catch (error) {
        console.error('Grep command error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-videocommand', (req, res) => {
    exec(req.body.command, (error, stdout, stderr) => {
        if (error) {
            console.error('Video command error:', error);
            res.status(500).json({ success: false, error: error.message });
            return;
        }
        res.json({ success: true, output: stdout });
    });
});

app.post('/ping', (req, res) => {
    const ip = req.body.ip;
    exec(`ping -c 1 ${ip}`, (error) => {
        res.json({ success: !error });
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Application error:', err);
    res.status(500).send('Something broke!');
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    process.exit(1);
});

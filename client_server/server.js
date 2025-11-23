const fs = require('fs');
const WebSocket = require('ws');
const { URL } = require('url');
const { SerialPort } = require('serialport');

// --- Startup Banner ---
console.log('===============================================================');
console.log(' PA100-D <-> Thetis - Remote Control Server by IW7DLE v1.6 ');
console.log('                       22 Oct 2025                             ');
console.log('===============================================================');
console.log('Loading configuration...\n');

// --- Load Configuration ---
let config;
try {
  config = JSON.parse(fs.readFileSync('server_config.json', 'utf8'));
  console.log('Configuration loaded from server_config.json\n');
} catch (err) {
  console.error('Error reading server_config.json:', err.message);
  process.exit(1);
}

const DEBUG = config.debug || false;
const AUTH_TOKEN = config.auth_token;
const WS_PORT = config.websocket_port || 8080;
const SERIAL_PORT = config.serial_port || 'COM5';
const SERIAL_BAUDRATE = config.serial_baudrate || 115200;
const POLL_INTERVAL = config.poll_interval_ms || 2000;

// --- Debug Logger ---
const debugLog = (msg) => {
  if (DEBUG) console.log(msg);
};

// --- Globals ---
let serial;
let wss;
let serialConnected = false;
let pollTimer = null;
let serialBuffer = ''; // buffer for incomplete serial data

// --- Broadcast Helper (global) ---
global.broadcastToClients = (message, sender = null) => {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
};

// --- Serial Initialization with Retry ---
function initSerialPort() {
  console.log(`Attempting to open serial port ${SERIAL_PORT} at ${SERIAL_BAUDRATE}...`);
  serial = new SerialPort({
    path: SERIAL_PORT,
    baudRate: SERIAL_BAUDRATE,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    autoOpen: false,
  });

  serial.open((err) => {
    if (err) {
      console.error(`Failed to open ${SERIAL_PORT}: ${err.message}`);
      console.log('Retrying in 5 seconds...\n');
      setTimeout(initSerialPort, 5000);
      return;
    }

    serialConnected = true;
    console.log(`Serial port ${SERIAL_PORT} opened successfully at ${SERIAL_BAUDRATE} 8N1\n`);

    // Start WebSocket server after serial is ready
    startWebSocketServer();

    // Now safe to broadcast
    broadcastToClients('[STATUS] Serial connected');

    setupSerialHandlers();
    startPolling();
  });
}

function setupSerialHandlers() {
  serial.on('error', (err) => {
    console.error(`Serial port error: ${err.message}`);
    serialConnected = false;
    stopPolling();
    broadcastToClients(`[STATUS] Serial error: ${err.message}`);
    console.log('Reconnecting to serial port in 5 seconds...');
    setTimeout(initSerialPort, 5000);
  });

  serial.on('close', () => {
    console.warn('Serial port closed. Retrying connection in 5 seconds...');
    serialConnected = false;
    stopPolling();
    broadcastToClients('[STATUS] Serial disconnected');
    setTimeout(initSerialPort, 5000);
  });

  serial.on('data', (data) => {
    // Log raw data for debugging
    debugLog(`RAW COM DATA: ${data.toString()}`);

    // Append incoming data to buffer
    serialBuffer += data.toString();

    // Normalize line endings to '\n' and split into lines
    serialBuffer = serialBuffer.replace(/\r/g, '');
    let lines = serialBuffer.split('\n');

    // Keep last line in buffer if incomplete
    serialBuffer = lines.pop();

    // Broadcast all complete lines
    lines.forEach(line => {
      line = line.trim();
      if (line.length > 0) {
        debugLog(`COM->WS | ${line}`);
        broadcastToClients(line);
      }
    });

    // Safety: prevent buffer overflow
    if (serialBuffer.length > 1024) {
      console.warn('Serial buffer overflow, clearing incomplete data');
      serialBuffer = '';
    }
  });
}

// --- Polling logic ---
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (serialConnected) {
      serial.write('=R\r\n', (err) => {
        if (err) console.error(`Error writing to serial: ${err.message}`);
      });
    }
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// --- Start WebSocket Server ---
function startWebSocketServer() {
  if (wss) return;

  wss = new WebSocket.Server({ port: WS_PORT });
  console.log(`WebSocket Server started on port ${WS_PORT}`);

  wss.on('connection', (ws, req) => {
    let ip = req.socket.remoteAddress;
    if (ip && ip.startsWith('::ffff:')) ip = ip.substring(7);
    console.log(`WebSocket client connected from IP: ${ip}`);

    const urlObj = new URL(req.url, 'http://' + req.headers.host);
    const token = urlObj.searchParams.get('token');

    if (token !== AUTH_TOKEN) {
      console.log(`Invalid token from IP: ${ip}`);
      ws.close();
      return;
    }

    // Send =R immediately when a client connects
    if (serialConnected) {
      serial.write('=R\r\n');
    }

    ws.on('message', (message) => {
      if (!serialConnected) {
        console.warn('Serial not connected — WS message ignored');
        return;
      }
      serial.write(message + '\r\n', (err) => {
        if (err) console.error(`Error writing to serial: ${err.message}`);
      });
    });

    ws.on('close', () => {
      debugLog(`WebSocket client from ${ip} disconnected`);
    });
  });
}

// --- Start the Process ---
initSerialPort();

'use strict';

// First-party username/password auth. Credentials and signing secret MUST be
// configured as private Render environment variables, never committed to Git.
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT || 8080);
const USERNAME = String(process.env.OPENBOT_USERNAME || '').trim();
const PASSWORD = String(process.env.OPENBOT_PASSWORD || '');
const SESSION_SECRET = String(process.env.OPENBOT_SESSION_SECRET || '');
const ROOM_ID = String(process.env.OPENBOT_ROOM_ID || 'main').trim();
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
if (!USERNAME || !PASSWORD || SESSION_SECRET.length < 32 || !ROOM_ID) {
  throw new Error('Configure OPENBOT_USERNAME, OPENBOT_PASSWORD, OPENBOT_SESSION_SECRET (32+ chars), and OPENBOT_ROOM_ID in the private server environment.');
}

const buildDir = path.resolve(__dirname, '../build');
const mimeTypes = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.woff':'font/woff','.woff2':'font/woff2' };
const loginAttempts = new Map();
function sendJson(res, status, body) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' }); res.end(JSON.stringify(body)); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function loginAllowed(ip) {
  const now = Date.now(); const item = loginAttempts.get(ip);
  if (!item || now - item.start > 60_000) { loginAttempts.set(ip, { start: now, count: 1 }); return true; }
  item.count += 1; return item.count <= 8;
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 8192) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}
const httpServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!loginAllowed(ip)) return sendJson(res, 429, { error: 'Too many login attempts. Try again in one minute.' });
    let body;
    try { body = await parseBody(req); } catch (_) { return sendJson(res, 400, { error: 'Invalid request body.' }); }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const clientType = body.clientType;
    const validUsername = safeEqual(username, USERNAME);
    const validPassword = safeEqual(password, PASSWORD);
    if (!['browser', 'robot'].includes(clientType) || !validUsername || !validPassword) {
      // Constant-time comparisons are used for both fields; don't reveal which one failed.
      return sendJson(res, 401, { error: 'Invalid username or password.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ sub: USERNAME, roomId: ROOM_ID, clientType }, SESSION_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS, issuer: 'openbot-self-hosted', audience: 'openbot-controller' });
    return sendJson(res, 200, { token, username: USERNAME, roomId: ROOM_ID, expiresAt: (now + TOKEN_TTL_SECONDS) * 1000, expiresIn: TOKEN_TTL_SECONDS });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow:'GET, HEAD, POST' }); return res.end('Method not allowed'); }
  let requestedPath;
  try { requestedPath = decodeURIComponent(pathname); } catch (_) { res.writeHead(400); return res.end('Bad request'); }
  if (requestedPath === '/') requestedPath = '/index.html';
  const target = path.resolve(buildDir, '.' + requestedPath);
  if (target !== buildDir && !target.startsWith(buildDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(target, (error, stat) => {
    const filePath = !error && stat.isFile() ? target : path.join(buildDir, 'index.html');
    fs.readFile(filePath, (readError, data) => {
      if (readError) { res.writeHead(503, { 'content-type':'text/plain; charset=utf-8' }); return res.end('Web controller is building or unavailable'); }
      res.writeHead(200, { 'content-type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'x-content-type-options':'nosniff', 'cache-control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
});

const wss = new WebSocket.Server({ server: httpServer, path: '/ws', maxPayload: 64 * 1024 });
const rooms = new Map();
function closePolicy(ws, reason) { try { ws.close(1008, reason.slice(0, 120)); } catch (_) {} }
function askIdOfClient(ws) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ roomId: 'request-roomId' })); }
function isJoinMessage(msg) { return !!msg && typeof msg.roomId === 'string' && msg.roomId && msg.roomId !== 'request-roomId' && ['browser','robot'].includes(msg.clientType) && typeof msg.authToken === 'string' && msg.authToken && Object.keys(msg).every(k => ['roomId','clientType','authToken'].includes(k)); }
function authenticateJoin(ws, msg) {
  if (!isJoinMessage(msg)) { closePolicy(ws, 'Authentication required'); return false; }
  try {
    const decoded = jwt.verify(msg.authToken, SESSION_SECRET, { algorithms:['HS256'], issuer:'openbot-self-hosted', audience:'openbot-controller' });
    if (decoded.sub !== USERNAME || decoded.roomId !== ROOM_ID || decoded.clientType !== msg.clientType || msg.roomId !== ROOM_ID) { closePolicy(ws, 'Room or client mismatch'); return false; }
    ws.roomId = ROOM_ID; ws.clientType = msg.clientType; ws.authenticated = true;
    joinRoom(ROOM_ID, ws, msg.clientType);
    const ttl = Math.max(0, decoded.exp * 1000 - Date.now());
    ws.tokenExpiryTimer = setTimeout(() => { closePolicy(ws, 'Session expired; sign in again'); ws.terminate(); }, ttl);
    if (ws.tokenExpiryTimer.unref) ws.tokenExpiryTimer.unref();
    return true;
  } catch (_) { closePolicy(ws, 'Invalid or expired session'); return false; }
}
wss.on('connection', ws => {
  ws.isAlive = true; ws.authenticated = false; ws.clientType = null; ws.roomId = null;
  ws.on('pong', () => { ws.isAlive = true; }); askIdOfClient(ws);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return closePolicy(ws, 'Binary messages not supported');
    const raw = data.toString(); if (raw.length > 64 * 1024) return closePolicy(ws, 'Message too large');
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (isJoinMessage(msg)) {
      if (ws.authenticated && msg.roomId === ws.roomId && msg.clientType === ws.clientType) return;
      if (!ws.authenticated) authenticateJoin(ws, msg); else closePolicy(ws, 'Cannot change authenticated room');
      return;
    }
    if (!ws.authenticated) return;
    if (msg.roomId && msg.roomId !== ws.roomId) return closePolicy(ws, 'Room mismatch');
    // Browser can send commands to the robot; robot can relay WebRTC signaling/status.
    relayToPeer(ws.roomId, raw, ws);
  });
  ws.on('close', () => { if (ws.tokenExpiryTimer) clearTimeout(ws.tokenExpiryTimer); leaveRoom(ws); });
  ws.on('error', error => console.warn('WebSocket error:', error.message));
});
const heartbeatTimer = setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (_) { ws.terminate(); } } }, 1000);
if (heartbeatTimer.unref) heartbeatTimer.unref();
function joinRoom(roomId, ws, clientType) {
  if (!rooms.has(roomId)) rooms.set(roomId, { browser:null, robot:null, readyNotified:false });
  const room = rooms.get(roomId); const prior = room[clientType];
  if (prior && prior !== ws && prior.readyState === WebSocket.OPEN) {
    if (room.readyNotified) { const peer = clientType === 'browser' ? room.robot : room.browser; if (peer && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ command:'DISCONNECTED' })); }
    room.readyNotified = false; prior.close(4000, 'Replaced by newer authenticated connection');
  }
  room[clientType] = ws; announceRoomReady(room);
}
function announceRoomReady(room) {
  if (room.readyNotified || !room.browser || !room.robot || room.browser.readyState !== WebSocket.OPEN || room.robot.readyState !== WebSocket.OPEN) return;
  room.readyNotified = true; const ready = JSON.stringify({ command:'CONNECTED' }); room.robot.send(ready); room.browser.send(ready);
}
function leaveRoom(ws) {
  if (!ws.roomId) return; const room = rooms.get(ws.roomId); if (!room) { ws.roomId = null; return; }
  let current = false;
  if (ws.clientType === 'browser' && room.browser === ws) { room.browser = null; current = true; }
  if (ws.clientType === 'robot' && room.robot === ws) { room.robot = null; current = true; }
  if (current) { room.readyNotified = false; const peer = ws.clientType === 'browser' ? room.robot : room.browser; if (peer && peer.authenticated && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ command:'DISCONNECTED' })); }
  if (!room.browser && !room.robot) rooms.delete(ws.roomId); ws.roomId = null;
}
function relayToPeer(roomId, message, sender) { const room = rooms.get(roomId); if (!room || !sender.authenticated) return; const peer = sender.clientType === 'browser' ? room.robot : room.browser; if (peer && peer.authenticated && peer.readyState === WebSocket.OPEN) peer.send(message); }
httpServer.listen(PORT, '0.0.0.0', () => console.log(`OpenBot self-hosted signaling server listening on ${PORT}; room=${ROOM_ID}`));

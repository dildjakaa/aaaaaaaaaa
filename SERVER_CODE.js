// SERVER_CODE.js
// Node.js server with Express + Socket.io + PostgreSQL for multiplayer sync and auth.
// Run: node SERVER_CODE.js
// Env: PORT (optional), DATABASE_URL (optional; defaults to the provided DSN)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
// No database: we run fully in-memory and auto-assign nicknames

// Create express app and HTTP server
const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// No database pool needed

// In-memory state
const players = new Map(); // socket.id => { username, pos, rot, kills, deaths, hp, lastShot }
// Generate a random 5-letter uppercase nickname
function generateNickname(existing) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let name = '';
  let tries = 0;
  do {
    name = '';
    for (let i = 0; i < 5; i++) {
      name += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    tries++;
  } while (existing.has(name) && tries < 1000);
  return name;
}

function collectExistingNames() {
  const set = new Set();
  for (const [, p] of players) set.add(p.username);
  return set;
}

const SHOT_COOLDOWN_MS = 250;
const MAX_RAY_DISTANCE = 100.0;
const PLAYER_RADIUS = 0.5;
const PLAYER_HEIGHT = 1.8;
const DAMAGE = 34;

// Utility vector ops
function vec(x, y, z) { return { x, y, z }; }
function vAdd(a, b) { return vec(a.x+b.x, a.y+b.y, a.z+b.z); }
function vSub(a, b) { return vec(a.x-b.x, a.y-b.y, a.z-b.z); }
function vMul(a, s) { return vec(a.x*s, a.y*s, a.z*s); }
function vLen(a) { return Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z); }
function vDot(a, b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function vNorm(a) { const l = vLen(a) || 1; return vec(a.x/l, a.y/l, a.z/l); }

// Ray-sphere intersection: returns nearest t >= 0, or null if no hit
function raySphere(origin, dir, center, radius) {
  const oc = vSub(origin, center);
  const a = vDot(dir, dir);
  const b = 2.0 * vDot(oc, dir);
  const c = vDot(oc, oc) - radius * radius;
  const disc = b*b - 4*a*c;
  if (disc < 0) return null;
  const sqrt = Math.sqrt(disc);
  const t1 = (-b - sqrt) / (2*a);
  const t2 = (-b + sqrt) / (2*a);
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}

// No registration or login endpoints

io.on('connection', (socket) => {
  console.log('[IO] Client connected:', socket.id);

  // Auto-join flow: assign random nickname and spawn immediately
  const spawn = { pos: [ (Math.random()*8-4), 1, (Math.random()*8-4) ], rot: [0, Math.random()*360, 0] };
  const nickname = generateNickname(collectExistingNames());

  const player = {
    username: nickname,
    pos: { x: spawn.pos[0], y: spawn.pos[1], z: spawn.pos[2] },
    rot: { x: spawn.rot[0], y: spawn.rot[1], z: spawn.rot[2] },
    kills: 0,
    deaths: 0,
    hp: 100,
    lastShot: 0,
  };
  players.set(socket.id, player);

  // Send current world state to this client
  const others = [];
  for (const [sid, p] of players) {
    if (sid === socket.id) continue;
    others.push({
      id: sid,
      username: p.username,
      pos: [p.pos.x, p.pos.y, p.pos.z],
      rot: [p.rot.x, p.rot.y, p.rot.z],
    });
  }
  socket.emit('login_success', {
    id: socket.id,
    username: player.username,
    stats: { kills: player.kills, deaths: player.deaths },
    spawn,
    players: others
  });

  // Inform existing clients about this new player
  socket.broadcast.emit('spawn_player', {
    id: socket.id,
    username: player.username,
    pos: [player.pos.x, player.pos.y, player.pos.z],
    rot: [player.rot.x, player.rot.y, player.rot.z],
  });

  // Also give full world state upon new connect (optional redundancy)
  socket.emit('world_state', { players: others });

  socket.on('player_move', (data) => {
    const player = players.get(socket.id);
    if (!player || !data || !data.pos || !data.rot) return;

    // Update authoritative server state
    const [x, y, z] = data.pos;
    const [rx, ry, rz] = data.rot;
    player.pos = { x: x*1.0, y: y*1.0, z: z*1.0 };
    player.rot = { x: rx*1.0, y: ry*1.0, z: rz*1.0 };

    // Broadcast to others
    socket.broadcast.emit('player_moved', {
      id: socket.id,
      pos: [player.pos.x, player.pos.y, player.pos.z],
      rot: [player.rot.x, player.rot.y, player.rot.z]
    });
  });

  socket.on('player_shoot', (data) => {
    const player = players.get(socket.id);
    if (!player || !data || !data.origin || !data.dir) return;

    const now = Date.now();
    if (now - player.lastShot < SHOT_COOLDOWN_MS) {
      return; // cooldown
    }
    player.lastShot = now;

    const origin = vec(data.origin[0], data.origin[1], data.origin[2]);
    let dir = vec(data.dir[0], data.dir[1], data.dir[2]);
    dir = vNorm(dir);
    const maxDist = Math.min(Math.max(data.range || MAX_RAY_DISTANCE, 1), 200);

    // Server-side validation: hitscan vs other players (approximate chest sphere)
    let closestT = Infinity;
    let targetSid = null;
    for (const [sid, p] of players) {
      if (sid === socket.id) continue; // don't hit self

      // center at chest height
      const center = vec(p.pos.x, p.pos.y + PLAYER_HEIGHT*0.6, p.pos.z);
      const t = raySphere(origin, dir, center, PLAYER_RADIUS);
      if (t !== null && t >= 0 && t <= maxDist) {
        if (t < closestT) {
          closestT = t;
          targetSid = sid;
        }
      }
    }

    if (targetSid) {
      const target = players.get(targetSid);
      if (!target) return;

      target.hp -= DAMAGE;
      if (target.hp < 0) target.hp = 0;

      // Inform all clients about the hit
      io.emit('player_hit', { attackerId: socket.id, targetId: targetSid, hp: target.hp });

      if (target.hp <= 0) {
        // Register kill/death and respawn target
        player.kills += 1;
        target.deaths += 1;

        // Reset target HP and respawn somewhere nearby
        target.hp = 100;
        target.pos = { x: (Math.random()*8-4), y: 1, z: (Math.random()*8-4) };

        // Notify everyone about death and respawn
        io.emit('player_died', {
          killerId: socket.id,
          victimId: targetSid,
          killerKills: player.kills,
          victimDeaths: target.deaths
        });

        io.emit('player_moved', {
          id: targetSid,
          pos: [target.pos.x, target.pos.y, target.pos.z],
          rot: [target.rot.x, target.rot.y, target.rot.z]
        });
      }
    }
  });

  socket.on('disconnect', async () => {
    const player = players.get(socket.id);
    if (!player) {
      console.log('[IO] Client disconnected:', socket.id);
      return;
    }
    players.delete(socket.id);
    console.log('[IO] Client disconnected:', socket.id, 'username:', player.username);

    // Notify others
    socket.broadcast.emit('player_disconnected', { id: socket.id });
  });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', players: players.size });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// No auth: players auto-join with random nicknames. Stats are in-memory only.

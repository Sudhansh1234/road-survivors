// Road Survivors - authoritative multiplayer game server
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---- Static file server ----
const server = http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const full = path.join(__dirname, 'public', file);
  if (!full.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full);
    const type = ext === '.html' ? 'text/html'
      : ext === '.js' ? 'text/javascript'
      : ext === '.css' ? 'text/css'
      : ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
      : ext === '.svg' ? 'image/svg+xml' : 'text/plain';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---- Constants ----
const W = 480, H = 640;
const LANEW = 62;                 // constant lane width; road widens as lanes are added
function roadBounds(lanes) {
  const w = lanes * LANEW;
  const x0 = Math.round((W - w) / 2);
  return { x0, x1: x0 + w, lw: LANEW };
}
const CAR_W = 34, CAR_H = 56;
const TICK = 1000 / 30;
const RACE_TARGET = 6000; // distance to win race mode

const POWERUPS = ['shield', 'slowmo', 'life', 'oil', 'missile'];

// oncoming vehicles â€” sprite = client asset key, w/h = collision size, spd scales speed, weight = spawn chance
// w is uniform (vehicles are all the same width); h varies by length
const VEHICLES = [
  { sprite: 'taxi',         w: 38, h: 64,  spd: 1.05, weight: 4 },
  { sprite: 'police',       w: 38, h: 64,  spd: 1.2,  weight: 1 },
  { sprite: 'white-van',    w: 38, h: 72,  spd: 0.9,  weight: 2 },
  { sprite: 'van-rundown',  w: 38, h: 72,  spd: 0.85, weight: 2 },
  { sprite: 'bus-blue',     w: 38, h: 104, spd: 0.65, weight: 1 },
  { sprite: 'bus-orange',   w: 38, h: 104, spd: 0.65, weight: 1 },
  { sprite: 'school-bus',   w: 38, h: 104, spd: 0.6,  weight: 1 },
  { sprite: 'truck-red',    w: 38, h: 100, spd: 0.7,  weight: 1 },
  { sprite: 'truck-white',  w: 38, h: 100, spd: 0.7,  weight: 1 },
  { sprite: 'truck2-red',   w: 38, h: 104, spd: 0.68, weight: 1 },
  { sprite: 'truck2-white', w: 38, h: 104, spd: 0.68, weight: 1 },
];
function pickVehicle() {
  const total = VEHICLES.reduce((s, v) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const v of VEHICLES) { if ((r -= v.weight) < 0) return v; }
  return VEHICLES[0];
}
const COLORS = ['#ff4d4d', '#4d9bff', '#54e36b', '#ffd24d', '#c44dff', '#4dffe0'];

// ---- Rooms ----
const rooms = new Map();
const highScores = new Map(); // roomName -> best score (survives empty rooms)
let nextPid = 1;

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, {
      name,
      players: new Map(),
      traffic: [],
      items: [],
      slicks: [],
      missiles: [],
      booms: [],
      nextId: 1,
      tick: 0,
      spawnTimer: 0,
      itemTimer: 120,
      lanes: 4,
      running: false,
      startedAt: 0,
      over: false,
      result: null,
      phase: 'lobby',
      countdownEnd: 0,
      mode: 'lms',
      slowmoUntil: 0,
      collide: true, // solid cars (false = ghost / pass through)
    });
  }
  return rooms.get(name);
}

function laneX(lanes, lane) {
  const b = roadBounds(lanes);
  return b.x0 + lane * b.lw + (b.lw - CAR_W) / 2;
}

function spawnPlayer(room, ws, name, opts = {}) {
  const id = nextPid++;
  const slot = room.players.size;
  const token = crypto.randomBytes(8).toString('hex');
  // âœ¨ secret: anyone named "shreya" gets the special pretty pink car âœ¨
  const special = /^\s*shreya\s*$/i.test(name || '') ? 'shreya' : null;
  const p = {
    id, ws, token, name: name || ('Player ' + id),
    color: special ? '#ff5fb0' : (opts.color || COLORS[slot % COLORS.length]),
    car: opts.car || 'red',
    special,
    x: laneX(3, slot % 3), y: H - 120,
    input: {},
    alive: true, lives: 1, distance: 0,
    shieldUntil: 0, invulnUntil: 0,
    boost: 100, oil: 0, lastDrop: 0,
    missiles: 0, lastFire: 0,
    score: 0, finished: false, place: 0,
    disconnectedAt: 0,
  };
  room.players.set(id, p);
  return p;
}

function cleanColor(c) { return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c : null; }

function startingLives(mode) { return mode === 'lms' ? 1 : 3; }

function resetGame(room) {
  room.traffic = []; room.items = []; room.slicks = []; room.missiles = []; room.booms = [];
  room.spawnTimer = 0; room.itemTimer = 120; room.tick = 0;
  room.over = false; room.result = null; room.lanes = 4;
  room.slowmoUntil = 0;
  let slot = 0;
  const n = room.players.size;
  for (const p of room.players.values()) {
    p.alive = true;
    p.lives = startingLives(room.mode);
    p.distance = 0; p.score = 0; p.finished = false; p.place = 0;
    p.shieldUntil = 0; p.invulnUntil = Date.now() + 4000; // safe during countdown
    p.boost = 100; p.oil = 0; p.missiles = 0;
    p.x = laneX(Math.max(n, 2), slot % Math.max(n, 2));
    p.y = H - 120;
    slot++;
  }
  room.phase = 'countdown';
  room.countdownEnd = Date.now() + 3800;
  room.running = true;
}

function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

// pick a lane that has clearance at the top so cars never overlap,
// and never block every lane at once (keep the race survivable)
function spawnTraffic(room, difficulty) {
  const lanes = room.lanes;
  const v = pickVehicle();
  const b = roadBounds(lanes);
  const lw = b.lw;
  const minGap = v.h + 70;
  let speed = (4.8 + Math.random() * 2.4) * difficulty * v.spd * 1.3;
  const open = [];
  for (let l = 0; l < lanes; l++) {
    const cx = b.x0 + l * lw + lw / 2;              // lane center
    const inLane = room.traffic.filter(t => Math.abs((t.x + t.w / 2) - cx) < lw * 0.55);
    // rearmost vehicle already in this lane (smallest y = closest to where we spawn)
    let topY = Infinity, rearSpeed = Infinity;
    for (const t of inLane) { if (t.y < topY) { topY = t.y; rearSpeed = t.speed; } }
    if (topY === Infinity || topY > minGap) open.push({ x: cx - v.w / 2, rearSpeed });
  }
  // leave at least one lane open so a wall is always passable
  if (open.length <= 1) return;
  const pick = open[Math.floor(Math.random() * open.length)];
  // never spawn faster than the vehicle ahead in this lane -> no catch-up, no overlap,
  // and every vehicle keeps a constant speed for its whole run
  if (isFinite(pick.rearSpeed)) speed = Math.min(speed, pick.rearSpeed);
  room.traffic.push({
    id: room.nextId++, sprite: v.sprite, x: pick.x, y: -v.h, w: v.w, h: v.h,
    speed,
  });
}

function spawnItem(room) {
  const lanes = room.lanes;
  const l = Math.floor(Math.random() * lanes);
  const type = POWERUPS[Math.floor(Math.random() * POWERUPS.length)];
  room.items.push({
    id: room.nextId++, type,
    x: laneX(lanes, l) + 4, y: -40, speed: 3.2,
  });
}

function killOrHurt(room, p) {
  const now = Date.now();
  if (now < p.invulnUntil) return;
  if (now < p.shieldUntil) { p.shieldUntil = 0; p.invulnUntil = now + 1200; return; } // shield pops
  p.lives--;
  if (p.lives <= 0) { p.alive = false; }
  else { p.invulnUntil = now + 2000; }
}

function step(room) {
  if (!room.running || room.over) return;

  if (room.phase === 'countdown') {
    if (Date.now() >= room.countdownEnd) {
      room.phase = 'racing';
      room.startedAt = Date.now();
    } else return;
  }

  room.tick++;
  const now = Date.now();
  const elapsed = (now - room.startedAt) / 1000;
  const difficulty = 1 + elapsed / 18; // NPC speed ramps up faster over time
  const slow = now < room.slowmoUntil ? 0.45 : 1;

  // spawn traffic
  if (--room.spawnTimer <= 0) {
    spawnTraffic(room, difficulty);
    room.spawnTimer = Math.max(14, 34 - Math.floor(elapsed / 4));
  }
  // spawn powerups
  if (--room.itemTimer <= 0) {
    spawnItem(room);
    room.itemTimer = 240 + Math.floor(Math.random() * 180);
  }

  // move world
  for (const t of room.traffic) t.y += t.speed * slow;
  room.traffic = room.traffic.filter(t => t.y < H + 120);
  for (const it of room.items) it.y += it.speed * slow;
  room.items = room.items.filter(it => it.y < H + 60);
  for (const s of room.slicks) { s.y += s.speed * slow; s.life--; }
  room.slicks = room.slicks.filter(s => s.y < H + 60 && s.life > 0);

  // ---- missiles fly up the road, blow up traffic & opponents ----
  room.booms = [];
  for (const m of room.missiles) {
    m.y -= m.speed;
    // hit traffic
    for (const t of room.traffic) {
      if (aabb(m.x, m.y, 8, 16, t.x, t.y, t.w, t.h)) {
        m.dead = true; t.dead = true;
        room.booms.push({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
        break;
      }
    }
    if (m.dead) continue;
    // hit an opponent player
    for (const q of room.players.values()) {
      if (q.id === m.owner || !q.alive) continue;
      if (aabb(m.x, m.y, 8, 16, q.x, q.y, CAR_W, CAR_H)) {
        m.dead = true; room.booms.push({ x: q.x + CAR_W / 2, y: q.y + CAR_H / 2 });
        killOrHurt(room, q); break;
      }
    }
  }
  room.traffic = room.traffic.filter(t => !t.dead);
  room.missiles = room.missiles.filter(m => !m.dead && m.y > -30);

  const PSPEED = 5.2;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const i = p.input || {};

    // boost / brake affect personal forward speed (distance), handling, and screen position
    let fwd = 1, surge = 0, handling = 1;
    const boosting = i.boost && p.boost > 0;
    if (boosting) { fwd = 2.4; handling = 1.8; surge = -3.2; p.boost = Math.max(0, p.boost - 1.6); }
    else if (i.brake) { fwd = 0.3; handling = 0.9; surge = 2.4; p.boost = Math.min(100, p.boost + 0.4); }
    else { p.boost = Math.min(100, p.boost + 0.3); }

    p.x += ((i.right ? 1 : 0) - (i.left ? 1 : 0)) * PSPEED * handling;
    // forward surge pushes the car up the road when boosting, drops back when braking
    p.y += ((i.down ? 1 : 0) - (i.up ? 1 : 0)) * PSPEED * 0.9 + surge;
    const rb = roadBounds(room.lanes);
    p.x = Math.min(Math.max(p.x, rb.x0 + 6), rb.x1 - CAR_W - 6);
    p.y = Math.min(Math.max(p.y, 60), H - CAR_H - 10);
    p.boosting = boosting;

    p.distance += 6 * fwd * slow;
    p.score = Math.floor(p.distance / 10);

    // drop oil slick
    if (i.drop && p.oil > 0 && now - p.lastDrop > 400) {
      p.oil--; p.lastDrop = now;
      room.slicks.push({ id: room.nextId++, owner: p.id, x: p.x, y: p.y + CAR_H, speed: 3.0, life: 220 });
    }

    // fire missile (travels up the road)
    if (i.fire && p.missiles > 0 && now - p.lastFire > 500) {
      p.missiles--; p.lastFire = now;
      room.missiles.push({ id: room.nextId++, owner: p.id, x: p.x + CAR_W / 2 - 4, y: p.y - 10, speed: 12 });
    }

    // collide with traffic
    for (const t of room.traffic) {
      if (aabb(p.x + 4, p.y + 4, CAR_W - 8, CAR_H - 8, t.x + 3, t.y + 3, t.w - 6, t.h - 6)) {
        killOrHurt(room, p); break;
      }
    }
    // collide with oil slicks (not your own)
    for (const s of room.slicks) {
      if (s.owner !== p.id && aabb(p.x + 6, p.y + 6, CAR_W - 12, CAR_H - 12, s.x, s.y, 30, 30)) {
        killOrHurt(room, p); break;
      }
    }
    // pick up items
    for (const it of room.items) {
      if (it.taken) continue;
      if (aabb(p.x, p.y, CAR_W, CAR_H, it.x, it.y, 30, 30)) {
        it.taken = true;
        if (it.type === 'shield') p.shieldUntil = now + 6000;
        else if (it.type === 'life') p.lives++;
        else if (it.type === 'oil') p.oil = Math.min(3, p.oil + 1);
        else if (it.type === 'missile') p.missiles = Math.min(3, p.missiles + 1);
        else if (it.type === 'slowmo') room.slowmoUntil = now + 4000;
        p.lastPickup = it.type;
        p.pickupAt = now;
      }
    }

    // race finish
    if (room.mode === 'race' && p.distance >= RACE_TARGET && !p.finished) {
      p.finished = true;
    }
  }
  room.items = room.items.filter(it => !it.taken);

  // ---- player vs player collision (solid bump, push apart) ----
  const live = room.collide ? [...room.players.values()].filter(p => p.alive) : [];
  const rb2 = roadBounds(room.lanes);
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const p = live[a], q = live[b];
      const ox = Math.min(p.x + CAR_W, q.x + CAR_W) - Math.max(p.x, q.x); // x overlap
      const oy = Math.min(p.y + CAR_H, q.y + CAR_H) - Math.max(p.y, q.y); // y overlap
      if (ox > 0 && oy > 0) {
        if (ox < oy) {
          // separate horizontally along smaller penetration
          const push = ox / 2 + 0.5;
          if (p.x < q.x) { p.x -= push; q.x += push; } else { p.x += push; q.x -= push; }
        } else {
          const push = oy / 2 + 0.5;
          if (p.y < q.y) { p.y -= push; q.y += push; } else { p.y += push; q.y -= push; }
        }
        // keep both on the road after the shove
        p.x = Math.min(Math.max(p.x, rb2.x0 + 6), rb2.x1 - CAR_W - 6);
        q.x = Math.min(Math.max(q.x, rb2.x0 + 6), rb2.x1 - CAR_W - 6);
        p.y = Math.min(Math.max(p.y, 60), H - CAR_H - 10);
        q.y = Math.min(Math.max(q.y, 60), H - CAR_H - 10);
        p.bumpAt = q.bumpAt = now;
      }
    }
  }

  // ---- win / over conditions per mode ----
  const players = [...room.players.values()].filter(p => p.disconnectedAt === 0 || p.alive);
  const all = [...room.players.values()];
  if (room.mode === 'race') {
    const fin = all.find(p => p.finished);
    if (fin) endGame(room, fin.name + ' wins the race!');
  } else if (room.mode === 'coop') {
    if (all.length && all.every(p => !p.alive)) {
      const score = Math.max(...all.map(p => p.score), 0);
      endGame(room, 'Team survived to ' + score, score);
    }
  } else { // lms
    const alive = all.filter(p => p.alive);
    if (all.length > 1 && alive.length <= 1) {
      endGame(room, (alive[0] ? alive[0].name : 'Nobody') + ' survives!');
    } else if (all.length === 1 && alive.length === 0) {
      endGame(room, 'Game over');
    }
  }
}

function endGame(room, result, coopScore) {
  room.over = true; room.running = false; room.phase = 'over';
  room.result = result;
  const best = Math.max(...[...room.players.values()].map(p => p.score), coopScore || 0, 0);
  const prev = highScores.get(room.name) || 0;
  room.newRecord = best > prev;
  if (best > prev) highScores.set(room.name, best);
}

function serialize(room) {
  let count = null;
  if (room.phase === 'countdown') {
    const left = room.countdownEnd - Date.now();
    count = left > 800 ? String(Math.ceil((left - 800) / 1000)) : 'GO!';
  }
  const now = Date.now();
  return {
    t: 'state',
    phase: room.phase, mode: room.mode, count,
    over: room.over, result: room.result, running: room.running,
    lanes: room.lanes,
    roadX0: roadBounds(room.lanes).x0,
    roadX1: roadBounds(room.lanes).x1,
    raceTarget: RACE_TARGET,
    highScore: highScores.get(room.name) || 0,
    newRecord: !!room.newRecord,
    slowmo: now < room.slowmoUntil,
    elapsed: room.phase === 'racing' && room.startedAt ? Math.floor((now - room.startedAt) / 1000) : 0,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, special: p.special, car: p.car,
      x: Math.round(p.x), y: Math.round(p.y),
      alive: p.alive, lives: p.lives, distance: Math.round(p.distance),
      score: p.score, boost: Math.round(p.boost), oil: p.oil, missiles: p.missiles,
      shield: now < p.shieldUntil, invuln: now < p.invulnUntil,
      boosting: !!p.boosting,
      bump: !!(p.bumpAt && Date.now() - p.bumpAt < 150),
      finished: p.finished, disconnected: p.disconnectedAt > 0,
      pickup: (p.pickupAt && now - p.pickupAt < 200) ? p.lastPickup : null,
    })),
    traffic: room.traffic.map(t => ({ id: t.id, x: Math.round(t.x), y: Math.round(t.y), w: t.w, h: t.h, sp: t.sprite })),
    items: room.items.map(it => ({ id: it.id, x: Math.round(it.x), y: Math.round(it.y), type: it.type })),
    slicks: room.slicks.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y) })),
    missiles: room.missiles.map(m => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y) })),
    booms: room.booms.map(b => ({ x: Math.round(b.x), y: Math.round(b.y) })),
  };
}

function lobbyMsg(room) {
  return {
    t: 'lobby', mode: room.mode, collide: room.collide,
    players: [...room.players.values()].map(p => ({ name: p.name, color: p.color })),
  };
}

function broadcast(room, msg) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

// ---- main loop ----
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // drop players disconnected for >20s
    for (const p of [...room.players.values()]) {
      if (p.disconnectedAt && now - p.disconnectedAt > 20000) room.players.delete(p.id);
    }
    step(room);
    if (room.players.size > 0) broadcast(room, serialize(room));
    else rooms.delete(room.name);
  }
}, TICK);

// ---- connections ----
wss.on('connection', (ws) => {
  let room = null, player = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      const roomName = (msg.room || 'lobby').toString().slice(0, 24);
      room = getRoom(roomName);
      // reconnect with token
      if (msg.token) {
        for (const p of room.players.values()) {
          if (p.token === msg.token) { player = p; break; }
        }
      }
      if (player) {
        player.ws = ws; player.disconnectedAt = 0;
      } else {
        player = spawnPlayer(room, ws, (msg.name || '').toString().slice(0, 16),
          { car: (msg.car || 'red').toString().slice(0, 16), color: cleanColor(msg.color) });
      }
      if (msg.mode && ['lms', 'coop', 'race'].includes(msg.mode) && room.phase === 'lobby') {
        room.mode = msg.mode;
      }
      ws.send(JSON.stringify({ t: 'joined', id: player.id, token: player.token, room: roomName, W, H, mode: room.mode, collide: room.collide }));
      broadcast(room, lobbyMsg(room));
      return;
    }

    if (!room || !player) return;

    if (msg.t === 'input') {
      player.input = {
        left: !!msg.left, right: !!msg.right, up: !!msg.up, down: !!msg.down,
        boost: !!msg.boost, brake: !!msg.brake, drop: !!msg.drop, fire: !!msg.fire,
      };
    } else if (msg.t === 'mode' && room.phase === 'lobby' || (msg.t === 'mode' && room.over)) {
      if (['lms', 'coop', 'race'].includes(msg.mode)) { room.mode = msg.mode; broadcast(room, lobbyMsg(room)); }
    } else if (msg.t === 'collide' && (room.phase === 'lobby' || room.over)) {
      room.collide = !!msg.collide; broadcast(room, lobbyMsg(room));
    } else if (msg.t === 'car' && (room.phase === 'lobby' || room.over)) {
      player.car = (msg.car || 'red').toString().slice(0, 16);
      if (!player.special) { const c = cleanColor(msg.color); if (c) player.color = c; }
      broadcast(room, lobbyMsg(room));
    } else if (msg.t === 'start') {
      if (room.players.size >= 1) resetGame(room);
    }
  });

  ws.on('close', () => {
    if (player) { player.disconnectedAt = Date.now(); player.ws = null; }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — a server is probably already running.`);
    console.error(`  Stop it first:  (Windows)  Get-Process node | Stop-Process -Force\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
server.listen(PORT, () => console.log(`Road Survivors running on http://localhost:${PORT}`));

// Road Survivors - client
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
let D = ctx; // active draw context (game canvas by default; swapped for car preview)

let ws = null, myId = null, myToken = null, pendingRoom = null;
let W = 480, H = 640;
let mode = 'lms';
let prev = null, curr = null, recvAt = 0; // snapshots for interpolation
let particles = [];
let scroll = 0;
let soundOn = true;

const input = { left: false, right: false, up: false, down: false, boost: false, brake: false, drop: false, fire: false };
let lastSent = '';

// ---- pixel-art sprite assets (Car game v4 pack) ----
function loadImg(src) { const i = new Image(); i.src = src; return i; }
// player cars (rear view, face up) + crashed variants
const PLAYER_CARS = ['red', 'blue', 'grey', 'yellow', 'striped'];
const PLAYER_IMG = {}, PLAYER_CRASH = {};
PLAYER_CARS.forEach(c => { PLAYER_IMG[c] = loadImg(`assets/cars/${c}.png`); PLAYER_CRASH[c] = loadImg(`assets/cars/${c}-crash.png`); });
// player-selectable models map to the sprite colours
const MODELS = [
  { id: 'red', name: 'Red', tint: '#ff4d4d' },
  { id: 'blue', name: 'Blue', tint: '#4d9bff' },
  { id: 'grey', name: 'Grey', tint: '#aab2c0' },
  { id: 'yellow', name: 'Yellow', tint: '#ffd24d' },
  { id: 'striped', name: 'Striped', tint: '#ff6a3a' },
];
// oncoming NPC vehicles (front view, face down)
const NPC_KEYS = ['taxi', 'police', 'white-van', 'van-rundown', 'bus-blue', 'bus-orange', 'school-bus', 'truck-red', 'truck-white', 'truck2-red', 'truck2-white'];
const NPC_IMG = {}; NPC_KEYS.forEach(k => NPC_IMG[k] = loadImg(`assets/npc/${k}.png`));
// frame animations
const EXPLOSION_FR = []; for (let i = 0; i < 8; i++) EXPLOSION_FR.push(loadImg(`assets/fx/explosion/${i}.png`));
const BOOST_FR = []; for (let i = 0; i < 4; i++) BOOST_FR.push(loadImg(`assets/fx/boost/${i}.png`));
const OILCAN_IMG = loadImg('assets/items/oil-can.png');
const OILSPILL_IMG = loadImg('assets/items/oil-spill.png');
// environment tiles & props
const ENV = {};
['grass', 'sidewalk', 'lane-dash', 'lane-edge', 'street-light', 'sign-speed', 'sign-stop', 'traffic-red', 'traffic-green', 'hydrant', 'mailbox', 'trashcan', 'cone', 'pothole', 'manhole', 'cracks']
  .forEach(k => ENV[k] = loadImg(`assets/env/${k}.png`));
const SMOKE_FR = []; for (let i = 0; i < 12; i++) SMOKE_FR.push(loadImg(`assets/fx/smoke/${i}.png`));
const SIDEWALK_PROPS = ['hydrant', 'mailbox', 'trashcan', 'sign-speed', 'sign-stop', 'traffic-red', 'traffic-green'];
const ROAD_DECALS = ['pothole', 'manhole', 'cracks'];
// scrolling scenery + smoke state (client-side cosmetic)
let worldY = 0, props = [], decals = [], smokes = [], decalLastY = 0, propLastY = 0;
function imgPattern(img) { if (!img._pat && img.complete && img.naturalWidth) { img._pat = ctx.createPattern(img, 'repeat'); } return img._pat; }
function blit(img, cx, cy, size) { if (img && img.complete && img.naturalWidth) { ctx.imageSmoothingEnabled = false; ctx.drawImage(img, Math.round(cx - size / 2), Math.round(cy - size / 2), size, size); } }
// draw a square pixel-art vehicle sprite centred in its collision box (front up/down per sprite)
function drawVehicleSprite(img, x, y, w, h) {
  if (!img || !img.complete || !img.naturalWidth) return false;
  const dh = h * 1.12, dw = dh; // square sprite; scale to ~box height, padding handled
  D.imageSmoothingEnabled = false;
  D.drawImage(img, Math.round(x + w / 2 - dw / 2), Math.round(y + h / 2 - dh / 2), dw, dh);
  return true;
}
// active crash explosions (client-side visual)
let explosions = [];

// ===================== AUDIO =====================
const Audio = (() => {
  let actx, engine, engineGain, master;
  function ensure() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = 0.4; master.connect(actx.destination);
    engine = actx.createOscillator(); engine.type = 'sawtooth'; engine.frequency.value = 70;
    engineGain = actx.createGain(); engineGain.gain.value = 0;
    engine.connect(engineGain); engineGain.connect(master); engine.start();
  }
  function blip(freq, dur, type = 'square', vol = 0.5) {
    if (!soundOn) return; ensure();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g); g.connect(master); o.start(); o.stop(actx.currentTime + dur);
  }
  return {
    resume() { ensure(); if (actx.state === 'suspended') actx.resume(); },
    engine(speed, on) {
      if (!actx) return;
      engineGain.gain.value = (soundOn && on) ? 0.06 : 0;
      engine.frequency.value = 60 + speed * 70;
    },
    beep() { blip(440, 0.15, 'square', 0.4); },
    go() { blip(880, 0.3, 'square', 0.5); },
    pickup() { blip(660, 0.08); setTimeout(() => blip(990, 0.12), 60); },
    bump() { blip(140, 0.1, 'square', 0.5); },
    crash() {
      if (!soundOn) return; ensure();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(200, actx.currentTime);
      o.frequency.exponentialRampToValueAtTime(40, actx.currentTime + 0.4);
      g.gain.setValueAtTime(0.6, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.4);
      o.connect(g); g.connect(master); o.start(); o.stop(actx.currentTime + 0.4);
    },
    win() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.18), i * 120)); },
  };
})();

// ===================== TITLE SCREEN =====================
(function () {
  const title = $('title');
  let started = false;
  function start() {
    if (started) return; started = true;
    Audio.resume();
    title.style.transition = 'opacity .4s'; title.style.opacity = '0';
    setTimeout(() => { title.style.display = 'none'; }, 400);
    $('name').focus();
  }
  title.addEventListener('click', start);
  addEventListener('keydown', start);
})();

function show(id) {
  ['home', 'createPanel', 'joinPanel', 'lobby'].forEach(p => $(p).classList.toggle('hidden', p !== id));
}
function showError(text) {
  const s = $('status'); s.classList.remove('hidden'); s.style.color = '#ff7b72'; s.textContent = text;
}

// ===================== STARTUP NAV =====================
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
$('createChoice').onclick = () => { if (!$('name').value.trim()) return $('name').focus(); $('genCode').textContent = genCode(); show('createPanel'); };
$('joinChoice').onclick = () => { if (!$('name').value.trim()) return $('name').focus(); show('joinPanel'); $('room').focus(); };
$('backFromCreate').onclick = () => show('home');
$('backFromJoin').onclick = () => show('home');
$('copyBtn').onclick = () => { navigator.clipboard?.writeText($('genCode').textContent); $('copyBtn').textContent = '✓ Copied!'; setTimeout(() => $('copyBtn').textContent = '📋 Copy code', 1500); };
$('createJoinBtn').onclick = () => { pendingRoom = $('genCode').textContent; connect(); };
$('joinBtn').onclick = () => { const c = $('room').value.trim(); if (!/^\d{6}$/.test(c)) return showError('Enter a 6-digit code.'); pendingRoom = c; connect(); };
$('soundChk').onchange = (e) => { soundOn = e.target.checked; };

// mode buttons
document.querySelectorAll('.modebtn').forEach(b => {
  b.onclick = () => { mode = b.dataset.mode; setModeUI(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'mode', mode })); };
});
function setModeUI() { document.querySelectorAll('.modebtn').forEach(b => b.classList.toggle('sel', b.dataset.mode === mode)); }
setModeUI();

// solid / ghost cars toggle
let collide = true;
document.querySelectorAll('.carmodebtn').forEach(b => {
  b.onclick = () => { collide = b.dataset.collide === '1'; setCollideUI(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'collide', collide })); };
});
function setCollideUI() { document.querySelectorAll('.carmodebtn').forEach(b => b.classList.toggle('sel', (b.dataset.collide === '1') === collide)); }
setCollideUI();
$('startBtn').onclick = () => { Audio.resume(); ws.send(JSON.stringify({ t: 'start' })); };

// ===================== CAR PICKER =====================
let carIdx = Math.max(0, MODELS.findIndex(m => m.id === (localStorage.getItem('rs_car') || 'red')));
let selectedColor = MODELS[carIdx].tint;
const carCanvas = $('carCanvas'), carCtx = carCanvas.getContext('2d');
$('swatches').style.display = 'none'; // sprites are pre-coloured

function drawPreview() {
  carCtx.clearRect(0, 0, carCanvas.width, carCanvas.height);
  carCtx.imageSmoothingEnabled = false;
  const prevD = D; D = carCtx;            // route the sprite draw to the preview canvas
  paintCarModel(MODELS[carIdx].id, 23, 18, 34, 84);
  D = prevD;
  $('carName').textContent = MODELS[carIdx].name;
}
function sendCar() {
  selectedColor = MODELS[carIdx].tint;
  localStorage.setItem('rs_car', MODELS[carIdx].id);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'car', car: MODELS[carIdx].id, color: selectedColor }));
}
$('carPrev').onclick = () => { carIdx = (carIdx + MODELS.length - 1) % MODELS.length; drawPreview(); sendCar(); };
$('carNext').onclick = () => { carIdx = (carIdx + 1) % MODELS.length; drawPreview(); sendCar(); };
// redraw the preview once each car sprite finishes loading (avoids the "red blob")
PLAYER_CARS.forEach(c => { PLAYER_IMG[c].addEventListener('load', () => drawPreview()); });
drawPreview();

// ===================== NETWORK =====================
function connect() {
  if (location.protocol === 'file:') return showError('Open at http://localhost:3000 — not the file directly.');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onerror = () => showError('Could not reach the server. Is "node server.js" running?');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: $('name').value.trim() || 'Player', room: pendingRoom || 'lobby', mode, token: myToken, car: MODELS[carIdx].id, color: selectedColor }));
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => showError('Disconnected — refresh to rejoin (your spot is held ~20s).');
}

let prevPlayers = {}; // for detecting events (crash/pickup) per player
function handle(msg) {
  if (msg.t === 'joined') {
    myId = msg.id; myToken = msg.token; W = msg.W; H = msg.H; mode = msg.mode || mode;
    canvas.width = W; canvas.height = H;
    localStorage.setItem('rs_token', myToken);
    $('lobbyCode').textContent = msg.room;
    if (typeof msg.collide === 'boolean') collide = msg.collide;
    setModeUI(); setCollideUI();
    show('lobby');
  } else if (msg.t === 'lobby') {
    mode = msg.mode || mode;
    if (typeof msg.collide === 'boolean') collide = msg.collide;
    setModeUI(); setCollideUI();
    renderLobby(msg.players);
  } else if (msg.t === 'state') {
    prev = curr; curr = msg; recvAt = performance.now();
    detectEvents(msg);
    if (msg.running || msg.over) canvas.classList.remove('hidden');
    document.body.classList.toggle('playing', !!msg.running && !msg.over);
    $('mobileBtns').classList.toggle('hidden', !(msg.running && !msg.over));
    updateStatus(msg);
  }
}

function detectEvents(msg) {
  const me = msg.players.find(p => p.id === myId);
  msg.players.forEach(p => {
    const old = prevPlayers[p.id];
    if (old) {
      if (old.lives > p.lives || (old.alive && !p.alive)) {
        Audio.crash();
        explosions.push({ x: p.x + CAR_W / 2, y: p.y + CAR_H / 2, start: performance.now() });
      }
      if (p.pickup && !old.pickup) Audio.pickup();
      if (p.bump && !old.bump) { Audio.bump(); smokes.push({ x: p.x + CAR_W / 2, y: p.y + CAR_H / 2, start: performance.now(), size: 12 }); }
    }
    prevPlayers[p.id] = { lives: p.lives, alive: p.alive, pickup: p.pickup, bump: p.bump };
  });
  // missile explosions
  if (msg.booms) msg.booms.forEach(b => { Audio.crash(); explosions.push({ x: b.x, y: b.y, start: performance.now() }); });
  if (msg.count === 'GO!' && lastCount !== 'GO!') Audio.go();
  else if (msg.count && msg.count !== lastCount && msg.count !== 'GO!') Audio.beep();
  lastCount = msg.count;
}
let lastCount = null;

function renderLobby(players) {
  const ul = $('players'); ul.innerHTML = '';
  players.forEach(p => { const li = document.createElement('li'); li.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.name}`; ul.appendChild(li); });
}

function updateStatus(msg) {
  const s = $('status');
  if (msg.over) {
    if (!s._shown) { Audio.win(); s._shown = true; }
    s.classList.remove('hidden');
    const me = msg.players.find(p => p.id === myId);
    const won = mode === 'coop' ? null : (me && me.alive && (mode !== 'race' || me.finished));
    const board = [...msg.players].sort((a, b) => b.score - a.score)
      .map((p, i) => `<div style="display:flex;justify-content:space-between;gap:18px;color:${p.color};font-size:11px;margin:4px 0;">
        <span>${i === 0 ? '👑 ' : ''}${p.name}</span><span>${p.score}</span></div>`).join('');
    let head = mode === 'coop' ? '🤝 GAME OVER' : (won ? '🏆 YOU WIN!' : '💥 ' + msg.result);
    s.style.color = '#fff';
    s.innerHTML = `<h2 style="margin:.2em 0;font-size:16px;color:var(--accent)">${head}</h2>
      <div class="sub" style="margin:6px 0 10px">${msg.result}</div>
      ${msg.newRecord ? '<div style="color:#54e36b;font-size:11px;margin-bottom:8px">★ NEW HIGH SCORE ★</div>' : `<div class="sub" style="margin-bottom:8px">Best: ${msg.highScore}</div>`}
      <div style="text-align:left;max-width:240px;margin:0 auto 12px">${board}</div>
      <button id="again" style="max-width:240px;margin:4px auto 0;">RACE AGAIN</button>`;
    $('again').onclick = () => { s.classList.add('hidden'); s._shown = false; ws.send(JSON.stringify({ t: 'start' })); };
  } else if (msg.running) { s.classList.add('hidden'); s._shown = false; }
}

// ===================== INPUT =====================
const keymap = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', Shift: 'boost', ' ': 'brake', e: 'drop', q: 'fire' };
function typing(e) { const el = e.target; return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }
function key(e, down) {
  if (typing(e)) return;
  const k = keymap[e.key] || keymap[e.key.toLowerCase?.()];
  if (k) { input[k] = down; sendInput(); e.preventDefault(); }
}
addEventListener('keydown', e => key(e, true));
addEventListener('keyup', e => key(e, false));

function sendInput() {
  if (!ws || ws.readyState !== 1) return;
  const sig = JSON.stringify(input); if (sig === lastSent) return;
  lastSent = sig; ws.send(JSON.stringify({ t: 'input', ...input }));
}

// mobile steering (drag) + action buttons
let dragging = false;
function steer(cx, cy) {
  const me = curr && curr.players.find(p => p.id === myId); if (!me) return;
  const r = canvas.getBoundingClientRect();
  const tx = (cx - r.left) * (W / r.width), ty = (cy - r.top) * (H / r.height);
  input.left = tx < me.x; input.right = tx > me.x + CAR_W; input.up = ty < me.y; input.down = ty > me.y + CAR_H;
  sendInput();
}
canvas.addEventListener('touchstart', e => { dragging = true; steer(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); });
canvas.addEventListener('touchmove', e => { if (dragging) steer(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); });
canvas.addEventListener('touchend', e => { dragging = false; input.left = input.right = input.up = input.down = false; sendInput(); e.preventDefault(); });
function holdBtn(id, k) {
  const el = $(id);
  const on = e => { input[k] = true; sendInput(); e.preventDefault(); };
  const off = e => { input[k] = false; sendInput(); e.preventDefault(); };
  el.addEventListener('touchstart', on); el.addEventListener('touchend', off);
  el.addEventListener('mousedown', on); el.addEventListener('mouseup', off);
}
holdBtn('boostBtn', 'boost'); holdBtn('brakeBtn', 'brake'); holdBtn('oilBtn', 'drop'); holdBtn('fireBtn', 'fire');

// ===================== RENDER =====================
const ROAD_X0 = 114, ROAD_X1 = 366, CAR_W = 34, CAR_H = 56; // 3-lane defaults (84px lanes, centered)
let roadL = ROAD_X0, roadR = ROAD_X1; // animated road edges
function roundRect(x, y, w, h, r) { D.beginPath(); D.moveTo(x + r, y); D.arcTo(x + w, y, x + w, y + h, r); D.arcTo(x + w, y + h, x, y + h, r); D.arcTo(x, y + h, x, y, r); D.arcTo(x, y, x + w, y, r); D.closePath(); }
function mkParticle(x, y, c) { return { x, y, vx: (Math.random() - .5) * 8, vy: (Math.random() - .5) * 8 - 2, life: 1, c }; }

function drawCar(x, y, color, opts = {}) {
  ctx.save();
  if (opts.dead) ctx.globalAlpha = 0.3;
  if (opts.invuln && !opts.dead) ctx.globalAlpha = 0.4 + 0.4 * Math.sin(performance.now() / 60);
  // boost flame animation out the back
  if (opts.boosting && !opts.dead) {
    const fr = BOOST_FR[Math.floor(performance.now() / 70) % BOOST_FR.length];
    if (fr && fr.complete && fr.naturalWidth) {
      ctx.imageSmoothingEnabled = false;
      const s = 26; ctx.drawImage(fr, Math.round(x + CAR_W / 2 - s / 2), Math.round(y + CAR_H - 6), s, s);
    }
  }

  // ✨ Shreya's special pretty pink car ✨
  if (opts.special === 'shreya') {
    const cx = x + CAR_W / 2, t = performance.now();
    // glittery glow aura
    ctx.save();
    ctx.shadowColor = '#ff9ed6'; ctx.shadowBlur = 16;
    const body = ctx.createLinearGradient(x, y, x + CAR_W, y);
    body.addColorStop(0, '#ff8ccb'); body.addColorStop(.5, '#ffd6ee'); body.addColorStop(.5, '#ff5fb0'); body.addColorStop(1, '#e0388c');
    ctx.fillStyle = body; roundRect(x, y, CAR_W, CAR_H, 9); ctx.fill();
    ctx.restore();
    // white racing stripes
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(cx - 7, y + 2, 4, CAR_H - 4); ctx.fillRect(cx + 3, y + 2, 4, CAR_H - 4);
    // sparkly windshield
    const ws = ctx.createLinearGradient(x, y + 10, x, y + 24);
    ws.addColorStop(0, '#fff'); ws.addColorStop(1, '#bfeaff');
    ctx.fillStyle = ws; roundRect(x + 6, y + 11, CAR_W - 12, 13, 4); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.55)'; roundRect(x + 6, y + CAR_H - 18, CAR_W - 12, 10, 4); ctx.fill();
    // heart on the hood
    const hy = y + CAR_H - 14;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(cx, hy + 6);
    ctx.bezierCurveTo(cx - 8, hy - 3, cx - 4, hy - 8, cx, hy - 3);
    ctx.bezierCurveTo(cx + 4, hy - 8, cx + 8, hy - 3, cx, hy + 6);
    ctx.fill();
    // wheels (pink rims)
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(x - 2, y + 8, 4, 13); ctx.fillRect(x + CAR_W - 2, y + 8, 4, 13);
    ctx.fillRect(x - 2, y + CAR_H - 23, 4, 13); ctx.fillRect(x + CAR_W - 2, y + CAR_H - 23, 4, 13);
    // twinkling sparkles around the car
    for (let s = 0; s < 4; s++) {
      const a = t / 600 + s * 1.8;
      const sx = cx + Math.cos(a) * (CAR_W * 0.9), sy = y + CAR_H / 2 + Math.sin(a * 1.3) * (CAR_H * 0.55);
      const tw = 1.5 + 1.5 * Math.abs(Math.sin(t / 200 + s));
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.beginPath(); ctx.moveTo(sx, sy - tw * 2); ctx.lineTo(sx + tw, sy); ctx.lineTo(sx, sy + tw * 2); ctx.lineTo(sx - tw, sy); ctx.fill();
    }
    // little crown
    ctx.fillStyle = '#ffe24d';
    const cyk = y - 5;
    ctx.beginPath(); ctx.moveTo(cx - 8, cyk + 6); ctx.lineTo(cx - 8, cyk); ctx.lineTo(cx - 4, cyk + 4);
    ctx.lineTo(cx, cyk - 2); ctx.lineTo(cx + 4, cyk + 4); ctx.lineTo(cx + 8, cyk); ctx.lineTo(cx + 8, cyk + 6); ctx.fill();
    if (opts.shield) { ctx.globalAlpha = 1; ctx.strokeStyle = '#7ee0ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, y + CAR_H / 2, CAR_W, 0, 7); ctx.stroke(); }
    if (opts.me) { ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; roundRect(x - 3, y - 3, CAR_W + 6, CAR_H + 6, 9); ctx.stroke(); }
    ctx.restore();
    return;
  }

  // player car sprite (crashed sprite when dead)
  const model = PLAYER_CARS.includes(opts.model) ? opts.model : 'red';
  ctx.globalAlpha = 1;
  const sprite = opts.dead ? PLAYER_CRASH[model] : PLAYER_IMG[model];
  if (!drawVehicleSprite(sprite, x, y, CAR_W, CAR_H)) {
    // fallback if image not yet loaded
    ctx.fillStyle = color || '#ff4d4d'; roundRect(x, y, CAR_W, CAR_H, 7); ctx.fill();
  }
  if (opts.shield) { ctx.strokeStyle = '#7ee0ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x + CAR_W / 2, y + CAR_H / 2, CAR_W, 0, 7); ctx.stroke(); }
  if (opts.me && !opts.dead) {
    // small bobbing arrow marker above your own car
    const cx = x + CAR_W / 2, ay = y - 14 + Math.sin(performance.now() / 200) * 2;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(cx - 6, ay); ctx.lineTo(cx + 6, ay); ctx.lineTo(cx, ay + 7); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// draw a player car sprite into an arbitrary box (used by the lobby preview)
function paintCarModel(model, x, y, w, h) {
  const m = PLAYER_CARS.includes(model) ? model : 'red';
  if (!drawVehicleSprite(PLAYER_IMG[m], x, y, w, h)) {
    D.fillStyle = '#ff4d4d'; roundRect(x, y, w, h, 6); D.fill();
  }
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, gg = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r)); gg = Math.max(0, Math.min(255, gg)); b = Math.max(0, Math.min(255, b));
  return '#' + ((1 << 24) + (r << 16) + (gg << 8) + b).toString(16).slice(1);
}
const NPC_VIS_W = 36; // uniform on-road width for every NPC vehicle
function drawTraffic(x, y, c, w = CAR_W, h = CAR_H, sprite = 'taxi') {
  ctx.save();
  const img = NPC_IMG[sprite];
  if (img && img.complete && img.naturalWidth) {
    // the actual car fills ~half a 32px frame, ~quarter of a 64px frame -> normalise to a fixed visible width
    const wFrac = img.naturalWidth <= 32 ? 0.5 : 0.27;
    const dw = NPC_VIS_W / wFrac; // square sprite; length follows automatically
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, Math.round(x + w / 2 - dw / 2), Math.round(y + h / 2 - dw / 2), dw, dw);
  } else {
    ctx.fillStyle = c || '#9aa4b2'; roundRect(x, y, w, h, 7); ctx.fill();
  }
  ctx.restore();
}
const ITEM_ICON = { shield: '🛡️', slowmo: '⏱️', life: '❤️', missile: '🚀' };
function drawItem(x, y, type) {
  ctx.save();
  if (type === 'oil') {
    // oil-can sprite for the oil pickup
    if (!drawVehicleSprite(OILCAN_IMG, x, y, 30, 30)) { ctx.fillStyle = '#3a3a3a'; ctx.fillRect(x + 6, y + 6, 18, 18); }
    ctx.restore(); return;
  }
  ctx.translate(x + 15, y + 15);
  const s = 1 + 0.1 * Math.sin(performance.now() / 150);
  ctx.scale(s, s);
  ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(0, 0, 18, 0, 7); ctx.fill();
  ctx.font = '22px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(ITEM_ICON[type] || '?', 0, 1);
  ctx.restore();
}

function lerp(a, b, t) { return a + (b - a) * t; }
function interpEntities() {
  // interpolate traffic/items/slicks/other players between prev & curr snapshots
  if (!curr) return null;
  const t = prev ? Math.min(1, (performance.now() - recvAt) / TICK) : 1;
  const map = (arr, parr, key) => arr.map(e => {
    const pe = parr && parr.find(x => x[key] === e[key]);
    return pe ? { ...e, x: lerp(pe.x, e.x, t), y: lerp(pe.y, e.y, t) } : e;
  });
  return {
    ...curr,
    traffic: map(curr.traffic, prev && prev.traffic, 'id'),
    items: map(curr.items, prev && prev.items, 'id'),
    slicks: map(curr.slicks, prev && prev.slicks, 'id'),
    missiles: map(curr.missiles || [], prev && prev.missiles, 'id'),
    players: map(curr.players, prev && prev.players, 'id'),
  };
}

const TICK = 1000 / 30;

// ---- client-side prediction for MY car (kills input lag) ----
// simulate my own car locally with the same rules as the server, then
// gently reconcile toward the authoritative position to correct drift.
const pred = { x: 0, y: 0, boost: 100, init: false };
let predAcc = 0, predLast = performance.now();
function predictSelf(st) {
  const me = st.players.find(p => p.id === myId);
  if (!me) { pred.init = false; return null; }
  // when not actively racing (countdown/over/dead) just track the server
  if (st.phase !== 'racing' || !me.alive) {
    pred.x = me.x; pred.y = me.y; pred.boost = me.boost; pred.init = true;
    return { ...me };
  }
  if (!pred.init) { pred.x = me.x; pred.y = me.y; pred.boost = me.boost; pred.init = true; }

  const now = performance.now();
  predAcc += Math.min(100, now - predLast); predLast = now;
  const PSPEED = 5.2;
  while (predAcc >= TICK) {
    predAcc -= TICK;
    const i = input;
    let handling = 1, surge = 0; let boosting = i.boost && pred.boost > 0;
    if (boosting) { handling = 1.8; surge = -3.2; pred.boost = Math.max(0, pred.boost - 1.6); }
    else if (i.brake) { handling = 0.9; surge = 2.4; pred.boost = Math.min(100, pred.boost + 0.4); }
    else { pred.boost = Math.min(100, pred.boost + 0.3); }
    pred.x += ((i.right ? 1 : 0) - (i.left ? 1 : 0)) * PSPEED * handling;
    pred.y += ((i.down ? 1 : 0) - (i.up ? 1 : 0)) * PSPEED * 0.9 + surge;
    pred.x = Math.min(Math.max(pred.x, roadL + 6), roadR - CAR_W - 6);
    pred.y = Math.min(Math.max(pred.y, 60), H - CAR_H - 10);
  }
  // soft reconcile to server truth (handles collisions/teleports/drift)
  pred.x += (me.x - pred.x) * 0.12;
  pred.y += (me.y - pred.y) * 0.12;
  return { ...me, x: pred.x, y: pred.y };
}

function render() {
  requestAnimationFrame(render);
  ctx.clearRect(0, 0, W, H);
  const st = interpEntities();
  const lanes = (st && st.lanes) || 3;
  const meNow = st && st.players.find(p => p.id === myId);
  // road rushes faster when boosting, crawls when braking — driven by local input for instant feel
  // background scroll: slow base, but grows with the same difficulty ramp as the NPC cars
  // keep background scroll well BELOW the slowest NPC (~3.7*diff) so oncoming cars
  // never appear to drift backwards, even while boosting
  const diff = st ? 1 + (st.elapsed || 0) / 18 : 1;
  let roadSpeed = 1.3 * diff;
  if (meNow && meNow.alive && st.phase === 'racing') {
    if (input.boost && pred.boost > 0) roadSpeed = 2.4 * diff; else if (input.brake) roadSpeed = 0.6 * diff;
  }
  // smoothly animate the road edges toward the server's current width
  const tgt0 = st ? st.roadX0 : ROAD_X0, tgt1 = st ? st.roadX1 : ROAD_X1;
  roadL += (tgt0 - roadL) * 0.08;
  roadR += (tgt1 - roadR) * 0.08;
  // frame-time factor: normalise per-frame motion to a 60fps baseline so the
  // background scrolls at the same real speed on 60/120/144Hz displays
  const _now = performance.now();
  const dtf = Math.min(3, (_now - (render._last || _now)) / (1000 / 60));
  render._last = _now;
  const rs = roadSpeed * dtf; // framerate-independent scroll step
  worldY += rs;

  // ---- grass background (tiled, scrolling) ----
  const gp = imgPattern(ENV.grass);
  if (gp) { ctx.save(); ctx.imageSmoothingEnabled = false; ctx.fillStyle = gp; ctx.translate(0, worldY % 16); ctx.fillRect(0, -16, W, H + 16); ctx.restore(); }
  else { ctx.fillStyle = '#1d4427'; ctx.fillRect(0, 0, W, H); }

  // ---- sidewalk strips just outside the road ----
  const SW = 18;
  const sp = imgPattern(ENV.sidewalk);
  if (sp) {
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.fillStyle = sp; ctx.translate(0, worldY % 16);
    ctx.fillRect(roadL - SW, -16, SW, H + 16); ctx.fillRect(roadR, -16, SW, H + 16); ctx.restore();
  }

  // ---- asphalt road ----
  ctx.fillStyle = '#3a3f47'; ctx.fillRect(roadL, 0, roadR - roadL, H);

  // ---- road decals (cracks/potholes/manholes under the cars; purely cosmetic) ----
  if (worldY - decalLastY > 170 + Math.random() * 240) {
    decalLastY = worldY;
    const lane = Math.floor(Math.random() * lanes);
    decals.push({ kind: ROAD_DECALS[Math.floor(Math.random() * ROAD_DECALS.length)], x: roadL + (roadR - roadL) * (lane + 0.5) / lanes, y: -20 });
  }
  decals.forEach(d => { d.y += rs; blit(ENV[d.kind], d.x, d.y, 18); });
  decals = decals.filter(d => d.y < H + 40);

  // ---- lane lines (sprites) ----
  ctx.imageSmoothingEnabled = false;
  const off = worldY % 16;
  for (let y = -16 + off; y < H + 16; y += 16) {
    // solid edge lines
    blit(ENV['lane-edge'], roadL + 2, y, 16);
    blit(ENV['lane-edge'], roadR - 2, y, 16);
    // dashed dividers
    for (let l = 1; l < lanes; l++) { const lx = roadL + (roadR - roadL) * l / lanes; blit(ENV['lane-dash'], lx, y, 16); }
  }

  // ---- roadside props (sidewalk objects + overhead street lights) ----
  if (worldY - propLastY > 120) {
    propLastY = worldY;
    const side = Math.random() < 0.5 ? -1 : 1;
    const streetLight = Math.random() < 0.3;
    const kind = streetLight ? 'street-light' : SIDEWALK_PROPS[Math.floor(Math.random() * SIDEWALK_PROPS.length)];
    const size = streetLight ? 38 : 18;
    props.push({ kind, x: side < 0 ? roadL - SW / 2 - 1 : roadR + SW / 2 + 1, y: -30, size, flip: side > 0 });
  }
  props.forEach(p => p.y += rs);
  props.forEach(p => {
    if (p.flip && ENV[p.kind] && ENV[p.kind].complete) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.scale(-1, 1); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(ENV[p.kind], Math.round(-p.size / 2), Math.round(-p.size / 2), p.size, p.size); ctx.restore();
    } else blit(ENV[p.kind], p.x, p.y, p.size);
  });
  props = props.filter(p => p.y < H + 80);

  // ---- emit smoke behind boosting cars ----
  if (st && st.phase === 'racing') {
    st.players.forEach(p => {
      if (p.alive && p.boosting && Math.random() < 0.6) smokes.push({ x: p.x + CAR_W / 2 + (Math.random() - .5) * 8, y: p.y + CAR_H, start: performance.now(), size: 14 });
    });
  }
  smokes = smokes.filter(s => performance.now() - s.start < SMOKE_FR.length * 45);
  smokes.forEach(s => { s.y += rs * 0.6; const fi = Math.floor((performance.now() - s.start) / 45); blit(SMOKE_FR[Math.min(fi, SMOKE_FR.length - 1)], s.x, s.y, s.size + fi); });

  if (st) {
    st.slicks.forEach(s => {
      if (!drawVehicleSprite(OILSPILL_IMG, s.x - 6, s.y - 6, 42, 42)) {
        ctx.save(); ctx.fillStyle = 'rgba(20,20,30,.75)'; ctx.beginPath(); ctx.ellipse(s.x + 15, s.y + 15, 18, 14, 0, 0, 7); ctx.fill(); ctx.restore();
      }
    });
    st.items.forEach(it => drawItem(it.x, it.y, it.type));
    st.traffic.forEach(t => drawTraffic(t.x, t.y, t.c, t.w, t.h, t.sp));
    // missiles
    (st.missiles || []).forEach(m => {
      ctx.save();
      // exhaust flame
      const fr = BOOST_FR[Math.floor(performance.now() / 50) % BOOST_FR.length];
      if (fr && fr.complete) { ctx.imageSmoothingEnabled = false; ctx.drawImage(fr, Math.round(m.x - 5), Math.round(m.y + 12), 18, 18); }
      // body
      ctx.fillStyle = '#d83a3a'; ctx.fillRect(m.x, m.y + 4, 8, 12);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(m.x + 4, m.y - 4); ctx.lineTo(m.x + 8, m.y + 6); ctx.lineTo(m.x, m.y + 6); ctx.fill();
      ctx.fillStyle = '#d83a3a'; ctx.fillRect(m.x - 2, m.y + 12, 12, 3);
      ctx.restore();
    });
    const predMe = predictSelf(st);
    st.players.forEach(p => {
      if (p.disconnected) return;
      const isMe = p.id === myId;
      const dx = isMe && predMe ? predMe.x : p.x;
      const dy = isMe && predMe ? predMe.y : p.y;
      drawCar(dx, dy, p.color, { me: isMe, dead: !p.alive, shield: p.shield, invuln: p.invuln && p.alive, boosting: p.boosting, special: p.special, model: p.car });
      // name + lives
      ctx.fillStyle = p.color; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(p.name + ' ' + '❤'.repeat(Math.max(0, Math.min(p.lives, 5))), dx + CAR_W / 2, dy - 6);
    });

    // crash explosion animations (8 frames @ ~55ms)
    ctx.imageSmoothingEnabled = false;
    const now = performance.now();
    explosions = explosions.filter(e => now - e.start < EXPLOSION_FR.length * 55);
    explosions.forEach(e => {
      const fi = Math.floor((now - e.start) / 55);
      const img = EXPLOSION_FR[Math.min(fi, EXPLOSION_FR.length - 1)];
      if (img && img.complete) { const s = 56; ctx.drawImage(img, Math.round(e.x - s / 2), Math.round(e.y - s / 2), s, s); }
    });

    drawHUD(st);
    drawCountdown(st);
    drawSpectator(st);
    // engine sound tracks my car's boost
    const me = st.players.find(p => p.id === myId);
    Audio.engine(me && input.boost ? 1 : 0.4, st.phase === 'racing' && me && me.alive);
  }
}

function drawHUD(st) {
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, W, 54);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px system-ui';
  if (mode === 'race') {
    ctx.fillText('🏁 RACE', 10, 14);
  } else {
    ctx.fillText('⏱ ' + (st.elapsed || 0) + 's', 10, 14);
  }
  ctx.fillText('★ ' + st.highScore, 10, 40);
  if (st.slowmo) { ctx.fillStyle = '#7ee0ff'; ctx.fillText('⏱ SLOW-MO', 110, 14); }

  // per-player chips on the right
  const me = st.players.find(p => p.id === myId);
  let ty = 14; ctx.textAlign = 'right';
  st.players.filter(p => !p.disconnected).forEach(p => {
    ctx.fillStyle = p.alive ? p.color : '#555';
    ctx.fillText(`${p.name} ${p.score}${p.alive ? '' : ' 💥'}`, W - 10, ty); ty += 18;
  });
  ctx.textAlign = 'left';

  if (me) {
    // boost bar
    ctx.fillStyle = '#222'; ctx.fillRect(10, H - 20, 120, 10);
    ctx.fillStyle = me.boost > 25 ? '#54e36b' : '#ff4d4d'; ctx.fillRect(10, H - 20, 120 * (me.boost / 100), 10);
    ctx.fillStyle = '#fff'; ctx.font = '9px system-ui'; ctx.fillText('BOOST', 12, H - 26);
    if (me.oil > 0) { ctx.fillText('🛢️x' + me.oil + ' (E)', 140, H - 14); }
    if (me.missiles > 0) { ctx.fillText('🚀x' + me.missiles + ' (Q)', 230, H - 14); }

    if (mode === 'race') {
      // distance progress with checkpoints
      const barW = W - 40, x0 = 20, y0 = H - 40;
      ctx.fillStyle = '#222'; ctx.fillRect(x0, y0, barW, 8);
      for (let c = 1; c < 6; c++) { ctx.fillStyle = '#555'; ctx.fillRect(x0 + barW * c / 6, y0 - 2, 2, 12); }
      st.players.forEach(p => { ctx.fillStyle = p.color; const px = x0 + barW * Math.min(1, p.distance / st.raceTarget); ctx.fillRect(px - 2, y0 - 3, 4, 14); });
    }
  }
}

function drawCountdown(st) {
  if (st.phase !== 'countdown' || !st.count) return;
  ctx.save();
  ctx.fillStyle = 'rgba(5,7,12,.55)'; ctx.fillRect(0, 0, W, H);
  const t = (performance.now() % 1000) / 1000;
  const scale = st.count === 'GO!' ? 1.4 : 1.6 - t * 0.6;
  ctx.globalAlpha = st.count === 'GO!' ? 1 : Math.max(.2, 1 - t * .7);
  ctx.translate(W / 2, H / 2); ctx.scale(scale, scale);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 90px "Press Start 2P", monospace'; ctx.lineWidth = 8; ctx.strokeStyle = '#05070c';
  ctx.fillStyle = st.count === 'GO!' ? '#54e36b' : '#ffd24d';
  ctx.strokeText(st.count, 0, 0); ctx.fillText(st.count, 0, 0);
  ctx.restore();
}

function drawSpectator(st) {
  const me = st.players.find(p => p.id === myId);
  if (st.phase === 'racing' && me && !me.alive) {
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(0, H / 2 - 26, W, 52);
    ctx.fillStyle = '#ff4d4d'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px "Press Start 2P", monospace'; ctx.fillText('SPECTATING', W / 2, H / 2);
    ctx.restore();
  }
}

render();

// try auto-reconnect token from a previous session
myToken = null; // start fresh each load; server holds slot only ~20s

// Road Survivors - client
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

let ws = null, myId = null, myToken = null, pendingRoom = null;
let W = 480, H = 640;
let mode = 'lms';
let prev = null, curr = null, recvAt = 0; // snapshots for interpolation
let particles = [];
let scroll = 0;
let soundOn = true;

const input = { left: false, right: false, up: false, down: false, boost: false, brake: false, drop: false };
let lastSent = '';

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
$('startBtn').onclick = () => { Audio.resume(); ws.send(JSON.stringify({ t: 'start' })); };

// ===================== NETWORK =====================
function connect() {
  if (location.protocol === 'file:') return showError('Open at http://localhost:3000 — not the file directly.');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onerror = () => showError('Could not reach the server. Is "node server.js" running?');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: $('name').value.trim() || 'Player', room: pendingRoom || 'lobby', mode, token: myToken }));
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
    setModeUI();
    show('lobby');
  } else if (msg.t === 'lobby') {
    mode = msg.mode || mode; setModeUI();
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
        for (let k = 0; k < 22; k++) particles.push(mkParticle(p.x + 17, p.y + 28, p.color));
      }
      if (p.pickup && !old.pickup) Audio.pickup();
    }
    prevPlayers[p.id] = { lives: p.lives, alive: p.alive, pickup: p.pickup };
  });
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
const keymap = { ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right', ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', Shift: 'boost', ' ': 'brake', e: 'drop' };
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
holdBtn('boostBtn', 'boost'); holdBtn('brakeBtn', 'brake'); holdBtn('oilBtn', 'drop');

// ===================== RENDER =====================
const ROAD_X0 = 114, ROAD_X1 = 366, CAR_W = 34, CAR_H = 56; // 3-lane defaults (84px lanes, centered)
let roadL = ROAD_X0, roadR = ROAD_X1; // animated road edges
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function mkParticle(x, y, c) { return { x, y, vx: (Math.random() - .5) * 8, vy: (Math.random() - .5) * 8 - 2, life: 1, c }; }

function drawCar(x, y, color, opts = {}) {
  ctx.save();
  if (opts.dead) ctx.globalAlpha = 0.3;
  if (opts.invuln && !opts.dead) ctx.globalAlpha = 0.4 + 0.4 * Math.sin(performance.now() / 60);
  // boost flames out the back
  if (opts.boosting && !opts.dead) {
    const f = 14 + Math.random() * 14;
    const grad = ctx.createLinearGradient(0, y + CAR_H, 0, y + CAR_H + f);
    grad.addColorStop(0, '#fff3b0'); grad.addColorStop(.5, '#ff9d3a'); grad.addColorStop(1, 'rgba(255,77,77,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.moveTo(x + 7, y + CAR_H); ctx.lineTo(x + CAR_W / 2, y + CAR_H + f); ctx.lineTo(x + CAR_W - 7, y + CAR_H); ctx.fill();
  }
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,.35)'; roundRect(x + 3, y + 5, CAR_W, CAR_H, 7); ctx.fill();

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

  // body with gradient
  const g = ctx.createLinearGradient(x, y, x + CAR_W, y);
  g.addColorStop(0, color); g.addColorStop(.5, '#fff'); g.addColorStop(.5, color); g.addColorStop(1, shade(color, -30));
  ctx.fillStyle = color; roundRect(x, y, CAR_W, CAR_H, 7); ctx.fill();
  ctx.fillStyle = shade(color, -25); roundRect(x, y, CAR_W, 8, 7); ctx.fill();           // hood stripe
  ctx.fillStyle = 'rgba(255,255,255,.85)'; roundRect(x + 6, y + 10, CAR_W - 12, 13, 3); ctx.fill(); // windshield
  ctx.fillStyle = 'rgba(255,255,255,.5)'; roundRect(x + 6, y + CAR_H - 17, CAR_W - 12, 10, 3); ctx.fill();
  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(x - 2, y + 8, 4, 12); ctx.fillRect(x + CAR_W - 2, y + 8, 4, 12); // wheels
  ctx.fillRect(x - 2, y + CAR_H - 22, 4, 12); ctx.fillRect(x + CAR_W - 2, y + CAR_H - 22, 4, 12);
  if (opts.shield) { ctx.globalAlpha = 1; ctx.strokeStyle = '#7ee0ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x + CAR_W / 2, y + CAR_H / 2, CAR_W, 0, 7); ctx.stroke(); }
  if (opts.me) { ctx.globalAlpha = 1; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; roundRect(x - 3, y - 3, CAR_W + 6, CAR_H + 6, 9); ctx.stroke(); }
  ctx.restore();
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, gg = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r)); gg = Math.max(0, Math.min(255, gg)); b = Math.max(0, Math.min(255, b));
  return '#' + ((1 << 24) + (r << 16) + (gg << 8) + b).toString(16).slice(1);
}
function drawTraffic(x, y, c, w = CAR_W, h = CAR_H, type = 'car') {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.35)'; roundRect(x + 3, y + 5, w, h, 7); ctx.fill();
  if (type === 'bike') {
    ctx.fillStyle = c; roundRect(x, y, w, h, 6); ctx.fill();
    ctx.fillStyle = '#cdd3db'; ctx.beginPath(); ctx.arc(x + w / 2, y + 12, 6, 0, 7); ctx.fill(); // rider helmet
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(x + 1, y + 4, 3, 10); ctx.fillRect(x + w - 4, y + 4, 3, 10);
    ctx.fillStyle = '#fff7c2'; ctx.fillRect(x + w / 2 - 3, y + h - 3, 6, 3);
    ctx.restore(); return;
  }
  // body
  ctx.fillStyle = c; roundRect(x, y, w, h, 7); ctx.fill();
  ctx.fillStyle = shade(c, -22); roundRect(x, y, w, 8, 7); ctx.fill(); // front
  if (type === 'truck' || type === 'bus') {
    // cab window near front + long cargo body separated by a line
    ctx.fillStyle = 'rgba(20,25,33,.85)'; roundRect(x + 6, y + 8, w - 12, 12, 3); ctx.fill();
    ctx.strokeStyle = shade(c, -40); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 2, y + 26); ctx.lineTo(x + w - 2, y + 26); ctx.stroke();
    if (type === 'bus') {
      // row of windows down the side
      ctx.fillStyle = 'rgba(20,25,33,.7)';
      for (let wy = y + 32; wy < y + h - 12; wy += 16) { roundRect(x + 5, wy, w - 10, 10, 2); ctx.fill(); }
    } else {
      ctx.fillStyle = shade(c, -12); roundRect(x + 4, y + 30, w - 8, h - 40, 4); ctx.fill(); // cargo box
    }
  } else {
    ctx.fillStyle = 'rgba(20,25,33,.85)'; roundRect(x + 6, y + 10, w - 12, 13, 3); ctx.fill();
    ctx.fillStyle = 'rgba(20,25,33,.55)'; roundRect(x + 6, y + h - 17, w - 12, 10, 3); ctx.fill();
  }
  ctx.fillStyle = '#fff7c2'; ctx.fillRect(x + 5, y + h - 4, 6, 3); ctx.fillRect(x + w - 11, y + h - 4, 6, 3);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(x - 2, y + 8, 4, 12); ctx.fillRect(x + w - 2, y + 8, 4, 12);
  ctx.fillRect(x - 2, y + h - 22, 4, 12); ctx.fillRect(x + w - 2, y + h - 22, 4, 12);
  ctx.restore();
}
const ITEM_ICON = { shield: '🛡️', slowmo: '⏱️', life: '❤️', oil: '🛢️' };
function drawItem(x, y, type) {
  ctx.save();
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
    players: map(curr.players, prev && prev.players, 'id'),
  };
}

const TICK = 1000 / 30;
function render() {
  requestAnimationFrame(render);
  ctx.clearRect(0, 0, W, H);
  const st = interpEntities();
  const lanes = (st && st.lanes) || 3;
  const meNow = st && st.players.find(p => p.id === myId);
  // road rushes faster when boosting, crawls when braking — sells the sense of speed
  let roadSpeed = 6;
  if (meNow && meNow.alive) { if (meNow.boosting) roadSpeed = 17; else if (input.brake) roadSpeed = 2.5; }
  // smoothly animate the road edges toward the server's current width
  const tgt0 = st ? st.roadX0 : ROAD_X0, tgt1 = st ? st.roadX1 : ROAD_X1;
  roadL += (tgt0 - roadL) * 0.08;
  roadR += (tgt1 - roadR) * 0.08;
  // grass + road
  ctx.fillStyle = '#11301b'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2a2f3a'; ctx.fillRect(roadL, 0, roadR - roadL, H);
  ctx.fillStyle = '#e6edf3'; ctx.fillRect(roadL - 4, 0, 4, H); ctx.fillRect(roadR, 0, 4, H);
  scroll = (scroll + roadSpeed) % 60;
  ctx.fillStyle = '#ffd24d';
  for (let l = 1; l < lanes; l++) { const lx = roadL + (roadR - roadL) * l / lanes - 2; for (let y = -60 + scroll; y < H; y += 60) ctx.fillRect(lx, y, 4, 32); }

  if (st) {
    st.slicks.forEach(s => { ctx.save(); ctx.fillStyle = 'rgba(20,20,30,.75)'; ctx.beginPath(); ctx.ellipse(s.x + 15, s.y + 15, 18, 14, 0, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(120,90,160,.4)'; ctx.beginPath(); ctx.ellipse(s.x + 11, s.y + 11, 6, 4, 0, 0, 7); ctx.fill(); ctx.restore(); });
    st.items.forEach(it => drawItem(it.x, it.y, it.type));
    st.traffic.forEach(t => drawTraffic(t.x, t.y, t.c, t.w, t.h, t.vt));
    st.players.forEach(p => {
      if (p.disconnected) return;
      const isMe = p.id === myId;
      drawCar(p.x, p.y, p.color, { me: isMe, dead: !p.alive, shield: p.shield, invuln: p.invuln && p.alive, boosting: p.boosting, special: p.special });
      // name + lives
      ctx.fillStyle = p.color; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(p.name + ' ' + '❤'.repeat(Math.max(0, Math.min(p.lives, 5))), p.x + CAR_W / 2, p.y - 6);
    });

    // particles
    particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.vy += 0.3; p.life -= 0.04; });
    particles = particles.filter(p => p.life > 0);
    particles.forEach(p => { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, 4, 4); });
    ctx.globalAlpha = 1;

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

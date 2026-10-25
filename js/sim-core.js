/* ============================================================
 * RC4WD 4WD 模擬核心 (無 DOM / 無 three.js，可在 Node 直接測試)
 *
 *  1. PicoCar  : 把 rc4wd/pico/main.py 的控制邏輯逐行移植成 JS
 *                (差速混控、4 輪 PI + 前饋、Coast/Brake 保護、堵轉保護、
 *                 超音波分區減速、失控保護、遙測封包)
 *  2. Chassis  : 四輪滑移轉向 (skid-steer) 物理：直流馬達反電動勢 + 輪胎滑移 + 側向摩擦
 *  3. World    : 場地、障礙物、超音波射線、碰撞
 *  4. Sim      : 把以上三個用固定 1ms 步長串起來
 *
 *  座標: 2D，x 向右、y 向上(俯視)，heading θ 逆時針為正，車頭 = (cosθ, sinθ)；單位公尺。
 *  對應 three.js: three.x = x, three.z = -y, rotation.y = θ
 * ============================================================ */
(function (root) {
'use strict';

/* ---------- 對應 pico/config.py ---------- */
const CFG = {
  GEAR: 9.6, ENC_PPR: 11, ENC_EDGES: 2, FREE_RPM: 620, MAX_RPM: 500,
  KP: 0.0010, KI: 0.0060, I_MAX: 0.25, MIN_DUTY: 0.08, RPM_ALPHA: 0.4,
  ACCEL_RPM_S: 1500, MIN_TARGET_RPM: 15, BRAKE_BELOW_RPM: 120,
  STALL_DUTY: 0.5, STALL_RPM: 5, STALL_MS: 600, STALL_COOL_MS: 1500,
  TURN_MAX: 30, STEER_GAIN: 0.25, REAR_SCALE: 1.0,
  MODE_MIN_INNER: [0.55, 0.40, 0.20], ST_ALPHA: 0.25, ARC_LIN: 30,
  STOP_CM: 20, CREEP_CM: 40, FREE_CM: 150, CREEP_SCALE: 0.2,
  SONAR_PHASE_MS: 25, FAILSAFE_MS: 300, TEL_MS: 100, CTRL_MS: 20,
};
CFG.CPR = CFG.ENC_PPR * CFG.GEAR * CFG.ENC_EDGES;   // 211.2

const NAMES = ['FL', 'FR', 'RL', 'RR'];
const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

function zoneScale(near) {
  if (near <= CFG.STOP_CM) return [0.0, true];
  if (near <= CFG.CREEP_CM) return [CFG.CREEP_SCALE, false];
  if (near < CFG.FREE_CM) {
    const k = (near - CFG.CREEP_CM) / (CFG.FREE_CM - CFG.CREEP_CM);
    return [CFG.CREEP_SCALE + (1 - CFG.CREEP_SCALE) * k, false];
  }
  return [1.0, false];
}

/* ============ 1. Pico 控制邏輯 ============ */
class Wheel {
  constructor(name) {
    this.name = name;
    this.lastCnt = 0; this.rpm = 0; this.tgtCmd = 0; this.tgt = 0;
    this.enabled = true; this.integ = 0; this.dir = 0;
    this.mode = 'coast'; this.duty = 0;
    this.stallMs = 0; this.stalled = false; this.stalledUntil = 0;
  }
  coast() { this.mode = 'coast'; this.duty = 0; }
  brake() { this.mode = 'brake'; this.duty = 0; }
  drive(d) { this.mode = 'drive'; this.duty = d; }

  update(dt, nowMs, cnt) {
    const d = cnt - this.lastCnt; this.lastCnt = cnt;
    const raw = d / CFG.CPR / dt * 60.0;
    this.rpm += CFG.RPM_ALPHA * (raw - this.rpm);

    let t = this.tgtCmd;
    if (Math.abs(t) < CFG.MIN_TARGET_RPM) { t = 0.0; this.tgt = 0.0; }
    else {
      const step = CFG.ACCEL_RPM_S * dt;
      if (this.tgt < t) this.tgt = Math.min(this.tgt + step, t);
      else if (this.tgt > t) this.tgt = Math.max(this.tgt - 3 * step, t);
    }
    const tgt = this.tgt;

    if (!this.enabled) { this.integ = 0; this.coast(); return; }
    if (this.stalled) {
      if (nowMs - this.stalledUntil < 0) { this.coast(); return; }
      this.stalled = false;
    }
    if (Math.abs(tgt) < CFG.MIN_TARGET_RPM) {          // 放開油門
      this.integ = 0;
      if (this.rpm > CFG.BRAKE_BELOW_RPM) this.coast(); else this.brake();
      return;
    }
    const sgn = tgt > 0 ? 1 : -1;
    if (this.dir && sgn !== this.dir && this.rpm > CFG.BRAKE_BELOW_RPM) {
      this.integ = 0; this.coast(); return;            // 高速反向: 先滑行降速
    }
    const m = Math.abs(tgt), err = m - this.rpm;
    this.integ = clamp(this.integ + CFG.KI * err * dt, -CFG.I_MAX, CFG.I_MAX);
    let duty = CFG.MIN_DUTY + (1 - CFG.MIN_DUTY) * m / CFG.FREE_RPM + CFG.KP * err + this.integ;
    duty = clamp(duty, 0.0, 1.0);
    this.dir = sgn;
    this.drive(sgn * duty);

    if (duty > CFG.STALL_DUTY && this.rpm < CFG.STALL_RPM) {
      this.stallMs += Math.trunc(dt * 1000);
      if (this.stallMs > CFG.STALL_MS) {
        this.stalled = true; this.stalledUntil = nowMs + CFG.STALL_COOL_MS;
        this.stallMs = 0; this.coast();
      }
    } else this.stallMs = 0;
  }
  signedRpm() { return Math.trunc(this.rpm * (this.dir ? this.dir : 1)); }
  code() { return this.stalled ? 3 : (this.mode === 'drive' ? 0 : (this.mode === 'brake' ? 2 : 1)); }
}

/* 4 顆超音波: 兩組輪流 (FL+RR / FR+LR)，每顆 20Hz，3 取中值。measure(i)=該顆目前真實距離 cm */
class Sonar {
  constructor(measure) {
    this.measure = measure;
    this.hist = [0, 1, 2, 3].map(() => [400, 400, 400]);
    this.dist = [400, 400, 400, 400];
    this.PHASES = [[0, 3], [1, 2]];
    this.phase = 0; this.armed = false; this.t0 = 0;
  }
  _collect(i) {
    let d = this.measure(i);
    if (!(d >= 2 && d < 400)) d = 400;
    const h = this.hist[i]; h[2] = h[1]; h[1] = h[0]; h[0] = d;
    const [a, b, c] = h;
    this.dist[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  tick(nowMs) {
    if (nowMs - this.t0 < CFG.SONAR_PHASE_MS) return;
    if (this.armed) { for (const i of this.PHASES[this.phase]) this._collect(i); this.phase ^= 1; }
    this.armed = true; this.t0 = nowMs;
  }
}

class PicoCar {
  constructor(measure) {
    this.w = {}; NAMES.forEach(n => { this.w[n] = new Wheel(n); });
    this.sonar = new Sonar(measure);
    this.thr = 0; this.st = 0; this.bal = 0; this.drv = 0; this.lim = 60; this.sens = 100;
    this.ao = 1; this.mode = 1; this.mi = null; this.seq = 0;
    this.stF = 0; this.linOut = 0; this.lastCmd = -1e9; this.flags = 0;
  }
  /* arr = [thr, st, bal, drv, lim, sens, mode, mi] (與網頁 cmd() 相同) */
  onCmd(arr, nowMs) {
    const n = i => Math.trunc(Number(arr[i]));
    if (arr.length < 6 || [0, 1, 2, 3, 4, 5].some(i => !isFinite(n(i)))) return;
    this.thr = clamp(n(0), -100, 100); this.st = clamp(n(1), -100, 100);
    this.bal = clamp(n(2), -40, 40);
    const drv = n(3); this.drv = (drv === 0 || drv === 1 || drv === 2) ? drv : 0;
    this.lim = clamp(n(4), 10, 100); this.sens = clamp(n(5), 10, 200);
    const mode = arr.length > 6 ? n(6) : 1; this.mode = (mode === 0 || mode === 1 || mode === 2) ? mode : 1;
    this.mi = arr.length > 7 && isFinite(n(7)) ? clamp(n(7), 0, 90) : null;
    this.seq = (this.seq + 1) & 0xFFFF;                 // 模擬 ESP32 附上的指令序號
    this.lastCmd = nowMs;
  }
  compute(nowMs) {
    const failsafe = nowMs - this.lastCmd > CFG.FAILSAFE_MS;
    const thr = failsafe ? 0 : this.thr, st = failsafe ? 0 : this.st;
    let flags = failsafe ? 4 : 0;
    let lin = thr * this.lim / 100.0;
    if (this.ao && lin !== 0) {
      const d = this.sonar.dist;
      const near = lin > 0 ? Math.min(d[0], d[1]) : Math.min(d[2], d[3]);
      const [s, blocked] = zoneScale(near);
      if (blocked) flags |= lin > 0 ? 1 : 2;
      lin *= s;
    }
    this.linOut = lin;
    this.stF += CFG.ST_ALPHA * (st - this.stF);
    const spin = (CFG.TURN_MAX + CFG.STEER_GAIN * Math.abs(lin)) * this.sens / 100.0;
    let rot = this.stF / 100.0 * spin;
    const al = Math.abs(lin), k0 = Math.min(1.0, al / CFG.ARC_LIN);
    const mn = this.mi !== null ? this.mi / 100.0 : CFG.MODE_MIN_INNER[this.mode];
    const cap = Math.max(al * (1 - mn) / (1 + mn), spin * (1 - k0));
    rot = clamp(rot, -cap, cap);
    let left = lin + rot, right = lin - rot;
    const m = Math.max(Math.abs(left), Math.abs(right));
    const lw = Math.max(this.lim, CFG.TURN_MAX);
    if (m > lw) { left *= lw / m; right *= lw / m; }
    left = clamp(left, -100, 100); right = clamp(right, -100, 100);
    if (this.bal > 0) right *= (100 - this.bal) / 100.0;
    else if (this.bal < 0) left *= (100 + this.bal) / 100.0;
    const k = CFG.MAX_RPM / 100.0, w = this.w;
    w.FL.tgtCmd = left * k; w.RL.tgtCmd = left * k * CFG.REAR_SCALE;
    w.FR.tgtCmd = right * k; w.RR.tgtCmd = right * k * CFG.REAR_SCALE;
    w.FL.enabled = w.FR.enabled = (this.drv === 0 || this.drv === 1);
    w.RL.enabled = w.RR.enabled = (this.drv === 0 || this.drv === 2);
    return flags;
  }
  control(dt, nowMs, enc) {
    let flags = this.compute(nowMs);
    NAMES.forEach((n, i) => { const wh = this.w[n]; wh.update(dt, nowMs, enc[i]); if (wh.stalled) flags |= 8; });
    this.flags = flags;
  }
  telemetry(nowMs) {
    const w = this.w, d = this.sonar.dist;
    return 'T,' + [w.FL.signedRpm(), w.FR.signedRpm(), w.RL.signedRpm(), w.RR.signedRpm(),
      Math.trunc(d[0]), Math.trunc(d[1]), Math.trunc(d[2]), Math.trunc(d[3]),
      this.flags, Math.trunc(this.linOut)].join(',') + ',' + NAMES.map(n => w[n].code()).join('') +
      ',' + this.seq + ',' + CFG.CTRL_MS + ',' + Math.min(999, Math.max(0, Math.round((nowMs || 0) - this.lastCmd)));   // seq, lp(控制週期ms), ca(指令年齡ms)
  }
}

/* ============ 2. 底盤物理 (四輪滑移轉向) ============ */
const BODY = {
  m: 2.8, I: 0.050,          // 質量 kg、偏航慣量 kg·m²
  r: 0.04,                   // 輪半徑 (WHEEL_D = 0.08)
  ax: 0.11, hy: 0.125,       // 前後軸距的一半、左右輪距的一半
  Ts: 0.45,                  // 馬達(減速後)堵轉扭矩 N·m @ 滿 duty
  Jw: 6e-4,                  // 輪+馬達轉子折算慣量
  Tg: 0.008,                 // 齒輪箱摩擦 N·m
  muL: 0.8, muT: 0.65,       // 縱向 / 側向 摩擦係數 (滑移轉向靠側向打滑)
  crr: 0.02,                 // 滾動阻力
  Istall: 3.0, Ibase: 0.35,  // 單顆馬達堵轉電流 A @12V、其他電子零件基礎電流 A
};
BODY.Wfree = CFG.FREE_RPM * 2 * Math.PI / 60;
const WPOS = [[+1, +1], [+1, -1], [-1, +1], [-1, -1]];   // FL FR RL RR (x 前正, y 左正)

class Chassis {
  constructor() { this.reset(0, 0, 0); }
  reset(x, y, th) {
    this.x = x; this.y = y; this.th = th;
    this.vx = 0; this.vy = 0; this.w = 0;                 // 車身座標速度、偏航角速度
    this.ww = [0, 0, 0, 0];                               // 輪角速度 rad/s (前進為正)
    this.ang = [0, 0, 0, 0];                              // 輪角度累計 (視覺用)
    this.enc = [0, 0, 0, 0];                              // 編碼器累計計數 (A 相，不分方向)
    this.ax = 0; this.ay = 0;                             // 車身加速度 (視覺用: 俯仰/側傾)
    this.slip = [0, 0, 0, 0];                             // 各輪打滑量 (痕跡用)
    this.cur = 0;                                         // 目前總電流 A
  }
  speed() { return this.vx; }
  step(dt, cmds, vr) {
    const B = BODY, N = B.m * 9.81 / 4;
    let Fx = 0, Fy = 0, Mz = 0, I = B.Ibase; vr = vr || 1;
    for (let i = 0; i < 4; i++) {
      const xi = WPOS[i][0] * B.ax, yi = WPOS[i][1] * B.hy;
      const vl = this.vx - this.w * yi, vt = this.vy + this.w * xi;
      const slipL = this.ww[i] * B.r - vl;
      let Fl = B.muL * N * Math.tanh(slipL / 0.05);
      let Ft = -B.muT * N * Math.tanh(vt / 0.04);
      const kk = Math.hypot(Fl / (B.muL * N), Ft / (B.muT * N));
      if (kk > 1) { Fl /= kk; Ft /= kk; }
      const Fres = B.crr * N * Math.tanh(vl / 0.03);      // 滾動阻力只作用在車身
      const c = cmds[i], e = this.ww[i] / B.Wfree;
      let Tm = c.mode === 'drive' ? B.Ts * (c.duty * vr - e) : (c.mode === 'brake' ? B.Ts * (-e) : 0);   // 電壓下垂 → 驅動力與空載轉速一起降
      I += B.Istall * Math.abs(Tm) / B.Ts;
      Tm -= B.Tg * Math.tanh(this.ww[i] / 1.0);
      this.ww[i] += dt * (Tm - B.r * Fl) / B.Jw;
      this.ang[i] += this.ww[i] * dt;
      this.enc[i] += Math.abs(this.ww[i]) * dt / (2 * Math.PI) * CFG.CPR;
      this.slip[i] = Math.hypot(slipL, vt);
      Fl -= Fres;
      Fx += Fl; Fy += Ft; Mz += xi * Ft - yi * Fl;
    }
    const ax = Fx / B.m + this.vy * this.w, ay = Fy / B.m - this.vx * this.w, aw = Mz / B.I;
    this.vx += ax * dt; this.vy += ay * dt; this.w += aw * dt;
    this.cur = I;
    this.ax += (ax - this.ax) * Math.min(1, dt * 12); this.ay += (ay - this.ay) * Math.min(1, dt * 12);
    const c = Math.cos(this.th), s = Math.sin(this.th);
    this.x += (this.vx * c - this.vy * s) * dt;
    this.y += (this.vx * s + this.vy * c) * dt;
    this.th += this.w * dt;
  }
}

/* ============ 3. 場地 / 射線 / 碰撞 ============ */
function rayRect(ox, oy, dx, dy, x0, y0, x1, y1) {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-12) { if (ox < x0 || ox > x1) return Infinity; }
  else { let a = (x0 - ox) / dx, b = (x1 - ox) / dx; if (a > b) { const t = a; a = b; b = t; } tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  if (Math.abs(dy) < 1e-12) { if (oy < y0 || oy > y1) return Infinity; }
  else { let a = (y0 - oy) / dy, b = (y1 - oy) / dy; if (a > b) { const t = a; a = b; b = t; } tmin = Math.max(tmin, a); tmax = Math.min(tmax, b); }
  if (tmax < 0 || tmin > tmax) return Infinity;
  return tmin > 0 ? tmin : 0;
}
function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx, fy = oy - cy, b = fx * dx + fy * dy, c = fx * fx + fy * fy - r * r, disc = b * b - c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc), t = -b - s;
  if (t >= 0) return t;
  return (-b + s) >= 0 ? 0 : Infinity;
}

const CAR_CIRCLES = [[-0.10, 0], [0, 0], [0.10, 0]], CAR_R = 0.14;
/* 超音波安裝位置(車身座標)與朝向(rad)。前 2 顆各向外偏 15° */
const SONAR_MOUNT = [
  { x: 0.16, y: 0.09, a: +15 * Math.PI / 180 },
  { x: 0.16, y: -0.09, a: -15 * Math.PI / 180 },
  { x: -0.16, y: 0.09, a: Math.PI - 15 * Math.PI / 180 },
  { x: -0.16, y: -0.09, a: Math.PI + 15 * Math.PI / 180 },
];

class World {
  constructor(layout) {
    this.layout = layout; this.W = layout.w; this.H = layout.h;
    const t = 0.2, w = layout.w, h = layout.h;
    this.obs = layout.obstacles.slice();
    [[0, h / 2 + t / 2, w + 2 * t, t], [0, -h / 2 - t / 2, w + 2 * t, t],
     [w / 2 + t / 2, 0, t, h], [-w / 2 - t / 2, 0, t, h]]
      .forEach(([x, y, ww, hh]) => this.obs.push({ t: 'r', x, y, w: ww, h: hh, wall: true, height: 1 }));
    this.hit = 0;
  }
  ray(ox, oy, dx, dy, maxD) {
    let best = maxD;
    for (const o of this.obs) {
      if (o.height !== undefined && o.height < 0.06) continue;
      const t = o.t === 'c' ? rayCircle(ox, oy, dx, dy, o.x, o.y, o.r)
        : rayRect(ox, oy, dx, dy, o.x - o.w / 2, o.y - o.h / 2, o.x + o.w / 2, o.y + o.h / 2);
      if (t < best) best = t;
    }
    return best;
  }
  /* 第 i 顆超音波目前量到的距離 (cm)；7 條射線 (±15°) 取最近，模擬 HC-SR04 波束寬度 */
  sonarCm(ch, i) {
    const m = SONAR_MOUNT[i], c = Math.cos(ch.th), s = Math.sin(ch.th);
    const ox = ch.x + m.x * c - m.y * s, oy = ch.y + m.x * s + m.y * c;
    let best = 4.0;
    for (let k = -3; k <= 3; k++) {
      const a = ch.th + m.a + k * 5 * Math.PI / 180;
      best = Math.min(best, this.ray(ox, oy, Math.cos(a), Math.sin(a), best));
    }
    let cm = best * 100;
    if (cm >= 400) return 400;
    cm += (Math.random() - 0.5) * 0.8;                    // ±0.4 cm 雜訊
    if (Math.random() < 0.004) return 400;                // 偶發漏回波 (中值濾波會濾掉)
    return cm;
  }
  collide(ch) {
    const B = BODY;
    for (let pass = 0; pass < 2; pass++) {
      const c = Math.cos(ch.th), s = Math.sin(ch.th);
      for (const [bx, by] of CAR_CIRCLES) {
        const cx = ch.x + bx * c - by * s, cy = ch.y + bx * s + by * c;
        for (const o of this.obs) {
          let nx, ny, pen, px, py;
          if (o.t === 'c') {
            const dx = cx - o.x, dy = cy - o.y, d = Math.hypot(dx, dy), rr = CAR_R + o.r;
            if (d >= rr || d < 1e-9) continue;
            nx = dx / d; ny = dy / d; pen = rr - d; px = o.x + nx * o.r; py = o.y + ny * o.r;
          } else {
            const hx = o.w / 2, hy = o.h / 2;
            const qx = clamp(cx, o.x - hx, o.x + hx), qy = clamp(cy, o.y - hy, o.y + hy);
            const dx = cx - qx, dy = cy - qy, d = Math.hypot(dx, dy);
            if (d >= CAR_R) continue;
            if (d < 1e-9) {
              const ex = hx - Math.abs(cx - o.x), ey = hy - Math.abs(cy - o.y);
              if (ex < ey) { nx = Math.sign(cx - o.x) || 1; ny = 0; pen = ex + CAR_R; }
              else { nx = 0; ny = Math.sign(cy - o.y) || 1; pen = ey + CAR_R; }
              px = cx; py = cy;
            } else { nx = dx / d; ny = dy / d; pen = CAR_R - d; px = qx; py = qy; }
          }
          ch.x += nx * pen; ch.y += ny * pen;
          const rx = px - ch.x, ry = py - ch.y;
          const cc = Math.cos(ch.th), ss = Math.sin(ch.th);
          let vwx = ch.vx * cc - ch.vy * ss, vwy = ch.vx * ss + ch.vy * cc;
          const vcx = vwx - ch.w * ry, vcy = vwy + ch.w * rx;
          const vn = vcx * nx + vcy * ny;
          if (vn < 0) {
            const rn = rx * ny - ry * nx, jden = 1 / B.m + rn * rn / B.I, j = -(1 + 0.15) * vn / jden;
            vwx += j * nx / B.m; vwy += j * ny / B.m;
            ch.w += (rx * (j * ny) - ry * (j * nx)) / B.I;
            ch.vx = vwx * cc + vwy * ss; ch.vy = -vwx * ss + vwy * cc;
            if (-vn > this.hit) this.hit = -vn;
          }
        }
      }
    }
  }
}

/* ---------- 場地配置 ---------- */
const cone = (x, y) => ({ t: 'c', x, y, r: 0.07, height: 0.22, kind: 'cone' });
const barrel = (x, y, r) => ({ t: 'c', x, y, r: r || 0.25, height: 0.55, kind: 'barrel' });
const box = (x, y, w, h, color) => ({ t: 'r', x, y, w, h, height: 0.5, color: color || '#c28a4a' });
const LAYOUTS = {
  course: {
    name: '障礙場', w: 16, h: 10, start: { x: -6.5, y: -3.6, th: 0 },
    obstacles: [
      cone(-4.5, -3.3), cone(-3.0, -4.0), cone(-1.5, -3.3), cone(0.0, -4.0), cone(1.5, -3.3), cone(3.0, -4.0),
      box(2.2, 1.0, 1.2, 0.9), box(-2.8, 1.8, 0.7, 1.6, '#5b8bd0'), box(5.2, -0.8, 0.25, 3.2, '#d9d9d9'),
      barrel(0.6, 3.3), barrel(6.2, 3.4), barrel(-5.8, 0.4),
      box(-6.3, 3.4, 0.2, 2.2, '#d9d9d9'), box(-5.1, 4.4, 2.4, 0.2, '#d9d9d9'), box(-3.9, 3.4, 0.2, 2.2, '#d9d9d9'),
      box(6.6, -3.6, 1.6, 1.2, '#7aa56a'),
    ],
  },
  open: {
    name: '空曠場', w: 16, h: 10, start: { x: -6.0, y: 0, th: 0 },
    obstacles: [cone(-3, 1.0), barrel(0, 0, 0.2), cone(3, -1.0), cone(4.5, 1.6), barrel(6, 2.5), barrel(6, -2.5)],
  },
};

/* ---- 3S 電池 (2200mAh)：開路電壓曲線 + 內阻壓降 ---- */
const CELL_CURVE = [[0, 3.27], [5, 3.61], [10, 3.69], [15, 3.71], [20, 3.73], [25, 3.75], [30, 3.77], [35, 3.79], [40, 3.80], [45, 3.82], [50, 3.84],
  [55, 3.85], [60, 3.87], [65, 3.91], [70, 3.95], [75, 3.98], [80, 4.02], [85, 4.08], [90, 4.11], [95, 4.15], [100, 4.20]];
function cellV(soc) {                   // soc 0~1 → 每顆電芯開路電壓
  const p = clamp(soc, 0, 1) * 100;
  for (let i = 1; i < CELL_CURVE.length; i++) if (p <= CELL_CURVE[i][0]) { const a = CELL_CURVE[i - 1], b = CELL_CURVE[i]; return a[1] + (b[1] - a[1]) * (p - a[0]) / (b[0] - a[0]); }
  return 4.2;
}

/* ============ 4. 整合 ============ */
class Sim {
  constructor(layoutKey) {
    this.t = 0; this.acc = 0; this.tCtrl = 0; this.tTel = 0; this.nSub = 0;
    this.chassis = new Chassis();
    this.setLayout(layoutKey || 'course');
    this.pico = new PicoCar(i => this.world.sonarCm(this.chassis, i));
    this.pico.lastCmd = -1e9;
    this.onTel = null; this.onBump = null;
    this.lastBump = -1e9;
    this.battery = { soc: 1, V: 12.6, I: 0, capAh: 2.2, R: 0.09 };
  }
  setBattery(pct) { this.battery.soc = clamp(pct / 100, 0, 1); }
  setLayout(key) {
    this.layoutKey = LAYOUTS[key] ? key : 'course';
    this.world = new World(LAYOUTS[this.layoutKey]);
    this.resetCar();
  }
  resetCar() {
    const s = this.world.layout.start;
    this.chassis.reset(s.x, s.y, s.th);
    if (this.pico) {
      this.pico.stF = 0;
      NAMES.forEach(n => { const w = this.pico.w[n]; w.lastCnt = 0; w.rpm = 0; w.tgt = 0; w.integ = 0; w.dir = 0; w.stalled = false; w.coast(); });
    }
  }
  onCmd(arr) { this.pico.onCmd(arr, this.t); }
  /* 前進 dt 秒 (真實時間)，內部固定 1ms 步長 */
  step(dt) {
    this.acc += Math.min(dt, 0.08);
    const H = 0.001, P = this.pico, ch = this.chassis;
    let guard = 0;
    while (this.acc >= H && guard < 90) {
      this.acc -= H; guard++; this.t += H * 1000; this.nSub++;
      if (this.t - this.tCtrl >= CFG.CTRL_MS - 1e-6) {
        this.tCtrl = this.t;
        P.control(CFG.CTRL_MS / 1000, this.t, ch.enc.map(Math.floor));
      }
      if (this.nSub % 5 === 0) P.sonar.tick(this.t);
      const B = this.battery;
      ch.step(H, [P.w.FL, P.w.FR, P.w.RL, P.w.RR], B.V / 12.0);
      B.I = ch.cur; B.soc = Math.max(0, B.soc - B.I * H / 3600 / B.capAh); B.V = 3 * cellV(B.soc) - B.I * B.R;
      this.world.collide(ch);
      if (this.t - this.tTel >= CFG.TEL_MS) {
        this.tTel = this.t;
        if (this.onTel) this.onTel(P.telemetry(this.t));
      }
    }
    if (this.world.hit > 0) {
      if (this.world.hit > 0.2 && this.t - this.lastBump > 250 && this.onBump) { this.lastBump = this.t; this.onBump(this.world.hit); }
      this.world.hit = 0;
    }
  }
}

root.RC = { cellV, CFG, BODY, NAMES, Sim, PicoCar, Chassis, World, LAYOUTS, SONAR_MOUNT, CAR_R, CAR_CIRCLES, zoneScale, clamp };
if (typeof module !== 'undefined' && module.exports) module.exports = root.RC;
})(typeof window !== 'undefined' ? window : globalThis);

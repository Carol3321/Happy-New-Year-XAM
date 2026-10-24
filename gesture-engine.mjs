/**
 * 手势识别引擎（纯逻辑，不依赖 three.js / DOM，可直接在 Node 里跑单测）
 *
 * 相对旧版的改进：
 *  1. 所有距离都用「掌心尺寸」(手腕0 → 中指根9) 归一化，
 *     因此手掌离摄像头远近、手大手小都不影响判定（旧版用绝对像素距离 0.09/0.25/0.4）。
 *  2. 手指是否伸直不再只看"指尖离手腕多远"，而是关节弯曲度 chord/segment + 到达半径双重判定。
 *  3. 每个手势都有独立的进入/退出阈值（滞回），避免在临界点上疯狂抖动。
 *  4. 最近 N 帧一致才真正切换模式，并带冷却时间，防止误触。
 *  5. 无法识别的姿势（剪刀手、单指、半握）不会改变当前状态，只保持不动。
 */

// 21 个关键点里，每根手指的关节链（MediaPipe Hands 标准索引）
export const FINGER_DEFS = [
  { key: 'thumb',  chain: [1, 2, 3, 4],      tip: 4,  reach: 1.00, label: '拇指' },
  { key: 'index',  chain: [5, 6, 7, 8],      tip: 8,  reach: 1.42, label: '食指' },
  { key: 'middle', chain: [9, 10, 11, 12],   tip: 12, reach: 1.55, label: '中指' },
  { key: 'ring',   chain: [13, 14, 15, 16],  tip: 16, reach: 1.40, label: '无名' },
  { key: 'pinky',  chain: [17, 18, 19, 20],  tip: 20, reach: 1.14, label: '小指' },
];

export const DEFAULT_CONFIG = {
  // 捏合：|拇指尖4 - 食指尖8| / 掌心。阈值放宽，指尖没完全贴上也能触发；
  // indexReach 仍要求食指是伸出去的（攥拳时约 1.05），避免握拳被当成捏合
  pinch:  {
    enter: 0.48, exit: 0.66, indexReach: 1.12, indexCurl: 0.60,
    pulseCooldown: 0.45,      // 两次"翻页"之间至少隔这么久
    rearmDistance: 0.85,      // 必须张开到这种程度才算松手，避免临界抖动被算成多次
    rearmTime: 0.22,          // 并且要保持这么久
  },
  // 张开：食指~小指至少 4 根伸直，且掌心张开度大于阈值
  open:   { minExtended: 4, spreadEnter: 1.02, spreadExit: 0.94 },
  // 握拳：伸直数 <= 1 + 张开度小 + 指尖都收在掌心附近（防止"放松的手"被误判成握拳）
  fist:   { maxExtended: 1, spreadEnter: 0.88, spreadExit: 1.00, maxReach: 1.24, reachExit: 1.32, clusterEnter: 0.82, clusterExit: 0.95 },
  // 手指伸直判定
  finger: { curlEnter: 0.90, curlExit: 0.84, reachSlack: 0.90 },
  // 时间维度
  vote:   { frames: 5, cooldown: 0.30 },
  smooth: { pos: 14.0, dead: 0.03, gain: 1.2, yaw: Math.PI, pitch: 0.42 },
  // 左右滑动：0.32 秒内横向位移超过 0.35（画面宽度的 17%）才算一次滑动
  swipe:  { window: 0.32, minDx: 0.35, ratio: 1.5, cooldown: 0.50 },
  lost:   { offAfter: 1.20 },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 3D 距离；MediaPipe 的 z 与 x 大致同尺度但更抖，权重 0.6 削弱其影响 */
export function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z - b.z) * 0.6);
}

/** 把 21 个关键点换算成与手掌大小无关的度量 */
export function computeMetrics(lm, cfg = DEFAULT_CONFIG) {
  const palm = Math.max(dist3(lm[0], lm[9]), 1e-4); // 手腕 → 中指根，作为"手掌尺寸"
  const cx = (lm[0].x + lm[9].x) / 2;
  const cy = (lm[0].y + lm[9].y) / 2;
  const cz = (lm[0].z + lm[9].z) / 2;

  const fingers = FINGER_DEFS.map((def) => {
    let seg = 0;
    for (let i = 0; i < def.chain.length - 1; i++) {
      seg += dist3(lm[def.chain[i]], lm[def.chain[i + 1]]);
    }
    const chord = dist3(lm[def.chain[0]], lm[def.chain[def.chain.length - 1]]);
    return {
      key: def.key,
      label: def.label,
      // 1 = 完全伸直，越小越弯 → 与手掌大小无关，所以比"指尖到手腕距离"更稳定
      curl: seg > 1e-5 ? chord / seg : 0,
      // 指尖到手腕的距离（掌心单位），用来排除透视压缩造成的误判
      reach: dist3(lm[def.tip], lm[0]) / palm,
      def,
    };
  });

  // 拇指尖 ↔ 食指尖（掌心单位）= 捏合程度。
  // 这里几乎只用画面 2D 距离：z 的噪声会把手“斜着伸过来”的捏合算远，导致不灵敏。
  const pinch = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y, (lm[4].z - lm[8].z) * 0.25) / palm;

  // 掌心张开度：四指指尖到掌心的平均距离（掌心单位）
  const palmCenter = { x: cx, y: cy, z: cz };
  let spread = 0;
  for (let i = 1; i <= 4; i++) spread += dist3(lm[fingers[i].def.tip], palmCenter) / palm;
  spread /= 4;

  // 指尖收得最远的那一根离手腕多远（握拳时四指都收回来，这个值会很小）
  const maxReach = Math.max(...fingers.slice(1).map((f) => f.reach));

  // 四指指尖之间的平均两两距离：握拳时指尖挤在一起，放松张开时张得很开
  const tips = [8, 12, 16, 20];
  let cluster = 0;
  let pairs = 0;
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      cluster += dist3(lm[tips[i]], lm[tips[j]]) / palm;
      pairs++;
    }
  }
  cluster /= pairs;

  return {
    palm, pinch, spread, cluster, maxReach, fingers,
    indexCurl: fingers[1].curl,
    indexReach: fingers[1].reach,
  };
}

export class GestureEngine {
  constructor(config = {}) {
    this.cfg = {
      ...DEFAULT_CONFIG,
      ...config,
      pinch: { ...DEFAULT_CONFIG.pinch, ...(config.pinch || {}) },
      open: { ...DEFAULT_CONFIG.open, ...(config.open || {}) },
      fist: { ...DEFAULT_CONFIG.fist, ...(config.fist || {}) },
      finger: { ...DEFAULT_CONFIG.finger, ...(config.finger || {}) },
      vote: { ...DEFAULT_CONFIG.vote, ...(config.vote || {}) },
      smooth: { ...DEFAULT_CONFIG.smooth, ...(config.smooth || {}) },
      swipe: { ...DEFAULT_CONFIG.swipe, ...(config.swipe || {}) },
      lost: { ...DEFAULT_CONFIG.lost, ...(config.lost || {}) },
    };
    this.reset();
  }

  reset() {
    this.time = 0;
    this.visible = false;
    this.lastSeen = -Infinity;
    this.label = 'NONE';            // 本帧原始判定（用于滞回）
    this.mode = 'TREE';             // 已提交的手势（应用层真正执行的）
    this.votes = [];
    this.lastSwitch = -Infinity;
    this.metrics = null;
    this.extended = [false, false, false, false, false];
    this.confidence = 0;
    this.x = 0; this.y = 0;         // 平滑后的位置，[-1,1]，已镜像
    this._hasPos = false;
    this._trail = [];               // 最近的手掌位置轨迹（判定滑动用）
    this._lastSwipe = -Infinity;
    this.swipe = null;
    // 捏合"脉冲"：每次重新捏合只报一次，用于"看一次换一张"
    this._pinchOn = false;
    this._pinchSeen = 0;
    this._releaseSince = 0;         // 开始"真正张开"的时间点
    this._lastPinch = -Infinity;
  }

  /** 每帧调用；landmarks 为 null 表示这一帧没检测到手 */
  update(landmarks, dt) {
    const step = clamp(dt || 0, 0, 0.1);
    this.time += step;

    const out = {
      visible: this.visible,
      label: this.label,
      mode: this.mode,
      changed: false,
      confidence: 0,
      metrics: this.metrics,
      extended: this.extended,
      x: this.x,
      y: this.y,
      swipe: null,          // 'left' | 'right' | null
      pinchStart: false,    // 本次是否"新捏合了一下"（用于翻下一张）
    };

    if (!landmarks || landmarks.length < 21) {
      this.visible = this.time - this.lastSeen < this.cfg.lost.offAfter;
      this.votes.length = 0;
      this.label = 'NONE';
      this.confidence = 0;
      this._trail.length = 0;
      out.visible = this.visible;
      out.label = this.label;
      out.confidence = 0;
      return out;
    }

    this.visible = true;
    this.lastSeen = this.time;

    const m = computeMetrics(landmarks, this.cfg);
    this.metrics = m;
    this.extended = this._latchExtended(m);
    this.label = this._classify(m);
    this.confidence = this._confidence(this.label, m);
    const pinchStart = this._updatePinchPulse();

    // ---- 位置：以中指根(9)为锚点，镜像后平滑，避免画面左右反直觉 ----
    const nx = (0.5 - landmarks[9].x) * 2;
    const ny = (landmarks[9].y - 0.5) * 2;
    if (!this._hasPos) {
      this.x = nx; this.y = ny; this._hasPos = true;
    } else {
      const a = 1 - Math.exp(-this.cfg.smooth.pos * step);
      this.x += (nx - this.x) * a;
      this.y += (ny - this.y) * a;
    }

    // ---- 左右滑动：用原始（未平滑）横向位移，平滑会削掉峰值速度 ----
    this.swipe = this._detectSwipe(nx, ny);

    // ---- 多帧投票 + 冷却，决定是否真的切换模式 ----
    this.votes.push(this.label);
    if (this.votes.length > this.cfg.vote.frames) this.votes.shift();
    const unanimous =
      this.votes.length === this.cfg.vote.frames &&
      this.votes.every((v) => v === this.votes[0]);

    if (
      unanimous &&
      this.label !== 'NONE' &&
      this.label !== this.mode &&
      this.time - this.lastSwitch >= this.cfg.vote.cooldown
    ) {
      this.mode = this.label;
      this.lastSwitch = this.time;
      this.votes.length = 0;
      out.changed = true;
    }

    out.visible = true;
    out.label = this.label;
    out.mode = this.mode;
    out.confidence = this.confidence;
    out.metrics = m;
    out.extended = this.extended;
    out.x = this.x;
    out.y = this.y;
    out.swipe = this.swipe;
    out.pinchStart = pinchStart;
    return out;
  }

  /**
   * 捏合上升沿：一次捏合只报一次。
   * 关键是要“真正张开手”才算松开（见 pinch.rearmDistance / rearmTime）：
   * 之前只要 2 帧不在 FOCUS 就允许下一次，手指在临界点一松一紧会被算成好几下，
   * 表现就是“捏一次翻好多张”。
   */
  _updatePinchPulse() {
    const c = this.cfg.pinch;
    const isPinch = this.label === 'FOCUS';
    if (isPinch) {
      this._pinchSeen++;
      this._releaseSince = 0;
      // 连续 2 帧确认，且距离上一次捏合超过冷却时间
      if (!this._pinchOn && this._pinchSeen >= 2 && this.time - this._lastPinch >= c.pulseCooldown) {
        this._pinchOn = true;
        this._lastPinch = this.time;
        return true;
      }
      return false;
    }

    this._pinchSeen = 0;
    // 只有拇指和食指确实分得够开（远大于退出阈值），并保持一小会儿，才算松开
    const far = this.metrics && this.metrics.pinch > c.rearmDistance;
    if (!far) { this._releaseSince = 0; return false; }
    if (!this._releaseSince) this._releaseSince = this.time;
    if (this._pinchOn && this.time - this._releaseSince >= c.rearmTime) this._pinchOn = false;
    return false;
  }

  /**
   * 左右滑动判定：在 window 秒内横向位移超过 minDx，且横向位移明显大于纵向，
   * 算一次滑动。判定后清空轨迹并进入冷却，避免一次动作被连续算成好几下。
   */
  _detectSwipe(nx, ny) {
    const c = this.cfg.swipe;
    this._trail.push({ t: this.time, x: nx, y: ny });
    // 只保留最近 1.2 秒的采样点（约 36 帧 @30fps）
    while (this._trail.length > 48 || (this._trail.length > 1 && this.time - this._trail[0].t > 1.2)) {
      this._trail.shift();
    }

    if (this.time - this._lastSwipe < c.cooldown) return null;

    // 取窗口内最早的一个采样点作为起点
    let start = null;
    for (const p of this._trail) {
      if (this.time - p.t <= c.window) { start = p; break; }
    }
    if (!start || start === this._trail[this._trail.length - 1]) return null;

    const dx = nx - start.x;
    const dy = ny - start.y;
    if (Math.abs(dx) < c.minDx) return null;
    if (Math.abs(dx) < Math.abs(dy) * c.ratio) return null;

    this._lastSwipe = this.time;
    this._trail.length = 0;
    return dx > 0 ? 'right' : 'left';
  }

  /** 手指伸直状态（带滞回，上一帧伸直的手指更不容易被判成弯曲） */
  _latchExtended(m) {
    const c = this.cfg.finger;
    return m.fingers.map((f, i) => {
      const was = this.extended[i];
      const hi = was ? c.curlExit : c.curlEnter;
      const reachLimit = f.def.reach * (was ? c.reachSlack : 1);
      return f.curl > hi && f.reach > reachLimit;
    });
  }

  /** 手势分类：顺序有意义——捏合优先于张开/握拳 */
  _classify(m) {
    const c = this.cfg;
    const four = this.extended.slice(1).filter(Boolean).length;
    const prev = this.label;

    // 1) 捏合（拇指+食指）：要求食指没有蜷进掌心，否则握拳时两指尖也会靠近
    if (
      m.pinch < (prev === 'FOCUS' ? c.pinch.exit : c.pinch.enter) &&
      m.indexReach > c.pinch.indexReach &&
      m.indexCurl > c.pinch.indexCurl
    ) {
      return 'FOCUS';
    }
    // 2) 张开手掌
    if (
      four >= c.open.minExtended &&
      m.spread > (prev === 'SCATTER' ? c.open.spreadExit : c.open.spreadEnter)
    ) {
      return 'SCATTER';
    }
    // 3) 握拳：伸直数少 + 掌心收拢 + 指尖聚拢 + 四指都没伸出去
    const inTree = prev === 'TREE';
    if (
      four <= c.fist.maxExtended &&
      m.spread < (inTree ? c.fist.spreadExit : c.fist.spreadEnter) &&
      m.cluster < (inTree ? c.fist.clusterExit : c.fist.clusterEnter) &&
      m.maxReach < (inTree ? c.fist.reachExit : c.fist.maxReach)
    ) {
      return 'TREE';
    }
    // 4) 其它姿势（剪刀手、单指、半握……）→ 保持当前状态不变
    return 'NONE';
  }

  _confidence(label, m) {
    const c = this.cfg;
    if (label === 'FOCUS') return clamp((c.pinch.exit - m.pinch) / (c.pinch.exit - 0.12), 0, 1);
    if (label === 'SCATTER') return clamp((m.spread - c.open.spreadExit * 0.9) / 0.55, 0, 1);
    if (label === 'TREE') return clamp((c.fist.clusterExit - m.cluster) / 0.7, 0, 1);
    return 0;
  }
}

/** 死区：手停在画面中间时不乱转 */
export function deadZone(v, dz = 0.06) {
  if (Math.abs(v) < dz) return 0;
  return (v - Math.sign(v) * dz) / (1 - dz);
}

/** 两个角度之间的最短差值（结果落在 [-π, π]），避免 +179° → -179° 时整圈乱甩 */
export function shortestAngle(from, to) {
  const TAU = Math.PI * 2;
  return (((to - from + Math.PI) % TAU) + TAU) % TAU - Math.PI;
}

/**
 * 手掌位置 → 场景朝向的平滑跟随（纯函数，方便单测）。
 * pos.x / pos.y 是 [-1,1] 的镜像手掌坐标；cfg 用 DEFAULT_CONFIG.smooth。
 * 返回新的 { x: 俯仰, y: 偏航 }。
 */
export function followRotation(current, pos, cfg = DEFAULT_CONFIG.smooth, dt = 1 / 60) {
  const gain = cfg.gain || 1;
  const nx = Math.max(-1, Math.min(1, pos.x));
  const ny = Math.max(-1, Math.min(1, pos.y));
  // 增益 1.2：手到画面约 84% 处就转满一圈，不用把手推到取景框边缘
  const yawTarget = Math.max(-1, Math.min(1, deadZone(nx, cfg.dead) * gain)) * cfg.yaw;
  const pitchTarget = Math.max(-1, Math.min(1, deadZone(ny, cfg.dead * 2) * gain)) * cfg.pitch;
  const k = 1 - Math.exp(-(cfg.follow || 16) * dt);
  return {
    y: current.y + shortestAngle(current.y, yawTarget) * k,
    x: current.x + (pitchTarget - current.x) * k,
  };
}

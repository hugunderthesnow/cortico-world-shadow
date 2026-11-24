/* ---------- 影子分身（扩展 cortico-world-shadow 的渲染端） ----------
 * 影子是主 Coo 之外的第二只身体，参数与指令全部来自本机扩展
 * http://127.0.0.1:8897（它由 Coo 扩展页里的「影子分身」提供）：
 *   - 每 2 秒问一次 /shadow/hello：问不到就把影子收走，所以关掉扩展影子会消失；
 *   - 每 400 毫秒取一次 /shadow/orders：Coo 的 pet_shadow 工具就在这里下单；
 *   - 执行完动作后 POST /shadow/done 回报动作名，扩展拿它写回执。
 * 鼠标戳影子、跟随、坐睡同步、音效全在本地完成：不联网、不发消息、不花 token。
 */
const SHADOW_BASE = 'http://127.0.0.1:8897';
// 加载即向扩展报到：日志转发不可靠，直接让扩展记一笔，排查时看 /shadow/hello 的 loadedAt
shadowCall('/shadow/loaded');
const SHADOW_HELLO_MS = 2000;   // 探活/同步参数的间隔
const SHADOW_POLL_MS = 400;     // 取令间隔
const SHADOW_ABSENT_MS = 8000;  // 连续探不到这么久就收回影子
const SHADOW_ACTS = ['happy', 'wink', 'love', 'surprised', 'angry', 'shy', 'confused', 'excited', 'sad',
  'hop', 'jump', 'dance', 'spin', 'wiggle', 'stretch', 'yawn', 'nod', 'shake', 'turn', 'wave', 'bow', 'shiver', 'flap'];

let shadow = null, shadowCfg = null, shadowLoading = false, shadowChecking = false, shadowPulling = false;
let shadowWalkAt = 0, shadowActAt = 0, shadowSeq = 0, shadowMainMode = '';
let pressingOn = 'body', shadowNextTry = 0, shadowCheckAt = 0, shadowPollAt = 0;
let shadowSeenAt = 0, shadowOrderSeq = -1;

/** 问扩展一件事；1.5 秒没回、或扩展没开，都当「没有」。 */
async function shadowCall(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(SHADOW_BASE + path, { cache: 'no-store', ...(init ?? {}), signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 把影子从屏幕上收走（扩展关了、参数换了、或者窗口要重载）。 */
function dropShadow() {
  if (!shadow) return;
  try { shadow.dispose?.(); } catch { /* 已经没了 */ }
  shadow = null;
  shadowCfg = null;
  shadowMainMode = '';
  shadowOrderSeq = -1;
}

/** 按扩展给的参数造一只影子。 */
async function createShadow(cfg, now) {
  const pack = (await (await fetch('/api/figures')).json()).find((p) => p.id === cfg.figure);
  if (!pack) {
    console.warn('[shadow] 没有这个形象包:', cfg.figure);
    shadowNextTry = now + 10000;
    return;
  }
  const main = at();
  const next = await loadBody({
    layer: $('#figureLayer'), pack, theme: prefs.theme, bounds: bounds(),
    size: cfg.scale, touches: ['poke'], vertical: true, speed: cfg.speed,
    start: { x: (main?.x ?? innerWidth * .7) - 70, facing: 1, enter: 'drop', skin, scheme: skin?.scheme },
    onEvent: () => {},
    onSound: (name, kind, ...args) => sfx.play(name, kind, ...args, { gain: shadowCfg?.volume ?? cfg.volume }),
    onError: (err) => console.warn('[shadow]', err?.message ?? err),
  });
  next.set({ roam: 'off' });
  shadow = next;
  shadowCfg = cfg;
  shadowOrderSeq = -1;
  // 报一笔「建好了」：改大小/形象包后，能从这里看出影子真的重建了
  shadowCall('/shadow/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scale: cfg.scale, figure: cfg.figure }),
  });
}

/** 每 2 秒一趟：扩展还在不在、参数变了没有。问不到超过 8 秒就把影子收走。 */
async function stepShadowLink(now) {
  if (shadowChecking) return;
  shadowChecking = true;
  try {
    const hello = await shadowCall('/shadow/hello');
    if (!hello?.ok || !hello.cfg) {
      if (shadow && now - shadowSeenAt > SHADOW_ABSENT_MS) dropShadow();
      return;
    }
    shadowSeenAt = now;
    if (!shadow) {
      if (now < shadowNextTry) return;
      try {
        await createShadow(hello.cfg, now);
      } catch (err) {
        shadowNextTry = now + 10000;
        console.warn('[shadow] 没起来:', err?.message ?? err);
      }
      return;
    }
    // 大小或形象包变了才重建；距离/速度/音量每次直接用新的，不打断它
    if (shadowCfg && (shadowCfg.scale !== hello.cfg.scale || shadowCfg.figure !== hello.cfg.figure)) {
      dropShadow();
      try { await createShadow(hello.cfg, now); } catch { shadowNextTry = now + 10000; }
      return;
    }
    shadowCfg = hello.cfg;
  } finally {
    shadowChecking = false;
  }
}

/** 取一次指令：Coo 点了 pet_shadow，就会有一条；执行完回报动作名。 */
async function pullShadowOrders() {
  if (shadowPulling || !shadow) return;
  shadowPulling = true;
  try {
    const data = await shadowCall('/shadow/orders?since=' + shadowOrderSeq);
    if (!data?.ok) return;
    if (shadowOrderSeq < 0) { shadowOrderSeq = typeof data.seq === 'number' ? data.seq : 0; return; }
    shadowOrderSeq = typeof data.seq === 'number' ? data.seq : shadowOrderSeq;
    for (const order of Array.isArray(data.orders) ? data.orders : []) {
      if (order?.id) doShadowPoke(String(order.id));
    }
  } finally {
    shadowPulling = false;
  }
}

/** 主 Coo 的状态 → 影子要复制的动作词。走路/跑不映射，影子自己在跟。 */
const SHADOW_MODE_WORD = { sit: 'sit', sleep: 'sleep', dance: 'dance', dizzy: 'dizzy' };

/** 一拍：跟随 + 复制主 Coo 的动作。全本地，不碰模型。 */
function stepShadow(dt) {
  const now = performance.now();
  if (now >= shadowCheckAt) { shadowCheckAt = now + SHADOW_HELLO_MS; stepShadowLink(now); }
  if (!shadow) return;
  shadow.tick(dt);
  const main = at(), sh = shadow.layout;
  if (!main || !sh) return;
  const cfg = shadowCfg ?? { gap: 130, gapSideX: 160, reachGap: 40, runGap: 200 };
  const clampX = (x) => Math.max(30, Math.min(innerWidth - 30, x));
  const floor = bounds().floorY;

  // 目标：站在主 Coo 旁边 gap 像素；x 与 y 合成一次移动。
  // 主 Coo 是普通身体时没有 y，y 就用地面线；它被放到高处时按脚底高度追。
  const off = main.x < (cfg.gapSideX ?? 160) ? cfg.gap : -cfg.gap;
  const targetX = clampX(main.x + off);
  const mainY = typeof main.y === 'number' ? main.y : (main.box ? main.box.y + main.box.h : null);
  const targetY = mainY != null ? mainY : floor;
  const shY = typeof sh.y === 'number' ? sh.y : floor;
  const dx = targetX - sh.x, dy = targetY - shY;
  const dist = Math.hypot(dx, dy);
  const seated = main.mode === 'sit' || main.mode === 'sleep';
  // 主 Coo 坐着、影子也坐着时，不再下 walk（否则会把 sit 打断）
  const seatedBeside = seated && (sh.mode === 'sit' || sh.mode === 'sleep');
  // 影子正在走/跑/滑时不打断；它停下且还差得远时，立刻再给一个新目标，这样是连续追
  const moving = sh.mode === 'walk' || sh.mode === 'run' || sh.mode === 'glide';
  if (!moving && !seatedBeside && dist > (cfg.reachGap ?? 40) && now - shadowWalkAt > 120) {
    const run = dist > (cfg.runGap ?? 200);
    if (Math.abs(dy) < 40) shadow.walk(targetX, run, `shadow${++shadowSeq}`);
    else shadow.moveTo(targetX, targetY, run, `shadow${++shadowSeq}`);
    shadowWalkAt = now;
  }

  // 状态变化时复制主 Coo 的动作：坐、睡、跳舞、晕；被拎起/飞出去时惊讶。
  if (main.mode !== shadowMainMode) {
    const was = shadowMainMode;
    shadowMainMode = main.mode;
    if (SHADOW_MODE_WORD[main.mode]) shadow.do(SHADOW_MODE_WORD[main.mode]);
    else if (was === 'sit' || was === 'sleep') shadow.do('stand');
    if ((main.mode === 'drag' || main.mode === 'air') && was !== 'drag' && was !== 'air') shadow.do('surprised');
  }

  // 主 Coo 坐着/睡着、影子没在移动却还没坐时，补一次坐
  if (seated && !moving && sh.mode !== 'sit' && sh.mode !== 'sleep' && now - shadowActAt > 600) {
    shadowActAt = now;
    shadow.do(main.mode === 'sleep' ? 'sleep' : 'sit');
  }

  // 取令：Coo 的 pet_shadow 指令
  if (now >= shadowPollAt) { shadowPollAt = now + SHADOW_POLL_MS; pullShadowOrders(); }
}

/** 扩展下单的「戳影子」：随机做一个动作，把动作名回报给扩展。 */
function doShadowPoke(id) {
  if (!shadow) return;
  const acts = Array.isArray(shadowCfg?.acts) && shadowCfg.acts.length ? shadowCfg.acts : SHADOW_ACTS;
  const word = acts[Math.floor(Math.random() * acts.length)];
  shadow.do(word);
  shadowCall('/shadow/done', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, word }),
  });
}


/**
 * cortico-world-shadow —— Coo 的影子分身（扩展）。
 *
 * 职责边界：
 *   1. 本扩展只做三件事：提供 `pet_shadow` 工具、给出环境提示词、在 127.0.0.1:8897
 *      开一个只给本机桌宠窗口用的命令接口。
 *   2. 「屏幕上那只小身体」由 `install.mjs` 打进 Coo 桌宠 web 层的补丁负责渲染；
 *      补丁每 2 秒问一次 `/shadow/hello`，问不到就把影子收走——所以扩展开/关
 *      直接决定影子在不在。
 *   3. 位置、动作、表情、音效全在本机；只有 `pet_shadow` 这一次调用会进模型。
 *
 * 接口（全部只监听 127.0.0.1，带 CORS 只读头，不对公网开放）：
 *   GET  /shadow/hello            探活 + 影子参数（大小/距离/速度/音量/形象包/动作词表）
 *   GET  /shadow/orders?since=N   取游标 N 之后的戳影子指令
 *   POST /shadow/done             { id, word } 桌宠回报「影子做了哪个动作」
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPT_PATH = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

/**
 * 补丁里写的就是这个端口：改这里必须同时重打补丁，所以不做成配置项。
 * `CORTICO_SHADOW_PORT` 只给自检用（Coo 跑着的时候它占着 8897，自检要换个口）。
 */
const PORT = Number(process.env.CORTICO_SHADOW_PORT) || 8897;
const HOST = '127.0.0.1';
const VERSION = '1.0.0';

/** 队列最多留这么多条，防止某个窗口卡死时无限涨。 */
const MAX_ORDERS = 32;

const DEFAULTS = {
  enabled: true,
  /** 影子相对主 Coo 的大小。 */
  scale: 0.45,
  /** 跟在旁边多少像素。 */
  gap: 130,
  /** 主 Coo 的 x 小于它时站右边，否则站左边（与补丁里的判断同值）。 */
  gapSideX: 160,
  /** 停下后差这么多像素就再追一次。 */
  reachGap: 40,
  /** 差这么多像素就改用跑的。 */
  runGap: 200,
  /** 移动速度系数（1 = 主 Coo 同速）。 */
  speed: 0.6,
  /** 影子音效相对主 Coo 的音量。 */
  volume: 0.2,
  /** 影子固定用这个形象包（主 Coo 换形象它不跟）。 */
  figure: 'whale',
  /** 等桌宠回报动作名的最长时间（毫秒）。 */
  replyTimeoutMs: 2500,
};

/**
 * 形象包下拉的数据源：直接问桌宠页要（和装扮页同一份），用户装了新包这里就有。
 * 桌宠页没开时留上一份；一次都没拿到就退回内置的两个。
 */
const figuresState = { list: [], at: 0 };
let petPort = 7797;
let figuresTimer = null;

async function refreshFigures() {
  try {
    const res = await fetch(`http://127.0.0.1:${petPort}/api/figures`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data?.figures ?? []);
    if (!Array.isArray(list) || !list.length) return;
    figuresState.list = list.map((f) => ({
      id: String(f.id ?? ''),
      title: typeof f.title === 'string' ? f.title : '',
    })).filter((f) => f.id);
    figuresState.at = Date.now();
  } catch {
    /* 桌宠页没开：先留着旧列表，下次再试 */
  }
}

/** 影子会做的动作词 → 回执里的中文说法。改词表时与补丁里的 SHADOW_ACTS 一起改。 */const WORD_ZH = {
  happy: '开心', wink: '眨眼', love: '喜欢', surprised: '惊讶', angry: '生气', shy: '害羞',
  confused: '疑惑', excited: '期待', sad: '难过', hop: '跳一下', jump: '蹦高', dance: '跳舞',
  spin: '转圈', wiggle: '扭一扭', stretch: '伸懒腰', yawn: '打哈欠', nod: '点头', shake: '摇头',
  turn: '转身', wave: '挥手', bow: '鞠躬', shiver: '发抖', flap: '扑腾',
};

/** 与补丁里的 SHADOW_ACTS 同序同集合；桌宠按这个表随机挑一个。 */
const ACTS = [
  'happy', 'wink', 'love', 'surprised', 'angry', 'shy', 'confused', 'excited', 'sad',
  'hop', 'jump', 'dance', 'spin', 'wiggle', 'stretch', 'yawn', 'nod', 'shake', 'turn',
  'wave', 'bow', 'shiver', 'flap',
];

const TOOL_DECL = {
  name: 'pet_shadow',
  tags: ['act'],
  description: 'Poke the small shadow that follows you. It plays one random expression or motion and the receipt names it. The person poking the shadow themselves never reaches you and costs no turn.',
  parameters: { type: 'object', properties: {}, required: [] },
};

class ShadowWorld {
  id = 'shadow';

  constructor(context) {
    this.context = context;
    this.host = null;
    this.server = null;
    this.listening = false;
    this.lastError = null;
    this.seq = 0;
    this.orders = [];
    this.waiters = new Map();
    this.pokeSeq = 0;
    /** 最近一次桌宠回报的动作，用来判断「影子到底在不在」；`--probe` 与自检靠它。 */
    this.lastDone = null;
    this.doneCount = 0;
    /** 桌宠窗口来问过多少次：为 0 说明补丁没跑（页面没加载到新代码或请求被拦）。 */
    this.helloCount = 0;
    this.lastHelloAt = null;
    /** pet 窗口里的补丁报到记录：没有值 = 那段代码从没被执行。 */
    this.loadedAt = null;
    this.loadedCount = 0;
    /** 最近一次「影子建好了」的上报：改大小/形象包后能从这里看出真的重建了。 */
    this.lastBuilt = null;
  }

  /**
   * 配置：默认值 + 内存段 + **磁盘上的 `worlds.shadow`**。
   * 为什么要读盘：Coo 的 `POST /api/config` 会把值写进 config.json 的**顶层**（`raw.scale`），
   * 而不是 `worlds.shadow.scale`，内存里的活引用也不会跟着变；只信内存的话，
   * 设置页改完等于没改。以磁盘为准后，手改 `worlds.shadow` 也能立刻生效。
   */
  get cfg() {
    const merged = { ...DEFAULTS, ...(this.context?.cfg ?? {}) };
    try {
      const file = join(this.context.botDir, 'config.json');
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      // Coo 的设置页把本扩展的值写到了 config.json 顶层：搬进 worlds.shadow，删掉散键。
      // 不搬的话，设置页上改多少都不会生效（内存活引用也不变）。
      const stray = {};
      for (const key of Object.keys(DEFAULTS)) {
        if (key !== 'enabled' && raw && Object.hasOwn(raw, key)) stray[key] = raw[key];
      }
      if (Object.keys(stray).length) {
        raw.worlds = raw.worlds ?? {};
        raw.worlds.shadow = { ...(raw.worlds.shadow ?? {}), ...stray };
        for (const key of Object.keys(stray)) delete raw[key];
        try { writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8'); } catch { /* 只读部署 */ }
        Object.assign(merged, stray);
      }
      const disk = raw?.worlds?.shadow;
      if (disk && typeof disk === 'object') Object.assign(merged, disk);
    } catch { /* 读不到就只用内存与默认值 */ }
    return merged;
  }

  label(language) {
    return language === 'en' ? 'Shadow' : '影子分身';
  }

  async start(host) {
    this.host = host;
    try {
      // 桌宠页的端口（装扮页、形象包列表都从那儿拿）
      const raw = JSON.parse(readFileSync(join(this.context.botDir, 'config.json'), 'utf8'));
      const port = Number(raw?.worlds?.['desktop-pet']?.port);
      if (Number.isFinite(port) && port > 0) petPort = port;
    } catch { /* 读不到就用默认 7797 */ }
    void refreshFigures();
    if (!figuresTimer) {
      figuresTimer = setInterval(() => { void refreshFigures(); }, 60000);
      figuresTimer.unref?.();
    }
    try {
      await this.listen();
      this.lastError = null;
      host?.log?.debug?.('shadow: 命令接口在 127.0.0.1:' + PORT + ' 就绪；形象包 ' + figuresState.list.length + ' 个');
    } catch (error) {
      // 端口被占不该把整个 World 拖垮：记下来，工具会如实说「没在运行」。
      this.lastError = error?.message ?? String(error);
      this.listening = false;
      host?.log?.warn?.('shadow: 启动失败 ' + this.lastError);
    }
  }

  async stop() {
    for (const done of this.waiters.values()) done(null);
    this.waiters.clear();
    this.orders = [];
    this.listening = false;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    this.host = null;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.route(req, res));
      server.once('error', (error) => reject(error));
      server.listen(PORT, HOST, () => {
        server.removeListener('error', reject);
        server.on('error', (error) => {
          this.lastError = error?.message ?? String(error);
        });
        this.server = server;
        this.listening = true;
        resolve();
      });
    });
  }

  /** 统一的响应头：只给本机桌宠窗口读，不缓存。 */
  send(res, code, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      // Chrome 的私有网络访问预检：桌宠页若是 file:// 或别的源，没有这个头会被拦
      'access-control-allow-private-network': 'true',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  route(req, res) {
    const url = new URL(req.url ?? '/', 'http://' + HOST + ':' + PORT);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
      });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/shadow/hello') {
      const cfg = this.cfg;
      this.helloCount += 1;
      this.lastHelloAt = new Date().toISOString();
      return this.send(res, 200, {
        ok: true,
        v: VERSION,
        state: {
          helloCount: this.helloCount,
          lastHelloAt: this.lastHelloAt,
          loadedAt: this.loadedAt,
          loadedCount: this.loadedCount,
          lastBuilt: this.lastBuilt,
          pending: this.orders.length,
          doneCount: this.doneCount,
          lastDone: this.lastDone,
        },
        cfg: {
          scale: Number(cfg.scale),
          gap: Number(cfg.gap),
          gapSideX: Number(cfg.gapSideX),
          reachGap: Number(cfg.reachGap),
          runGap: Number(cfg.runGap),
          speed: Number(cfg.speed),
          volume: Number(cfg.volume),
          figure: String(cfg.figure || 'whale'),
          acts: ACTS,
        },
      });
    }
    // 验收用：不等模型，自己下一单，看桌宠窗口会不会回报
    if (req.method === 'GET' && url.pathname === '/shadow/loaded') {
      this.loadedAt = new Date().toISOString();
      this.loadedCount += 1;
      return this.send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/shadow/probe') {
      const id = 'probe' + (++this.pokeSeq);
      this.orders.push({ id, seq: ++this.seq, ts: Date.now() });
      if (this.orders.length > MAX_ORDERS) this.orders.splice(0, this.orders.length - MAX_ORDERS);
      return this.send(res, 200, { ok: true, id, hint: '1 秒后看 /shadow/hello 的 state.lastDone' });
    }
    if (req.method === 'GET' && url.pathname === '/shadow/orders') {
      const since = Number(url.searchParams.get('since') ?? '-1');
      const orders = Number.isFinite(since)
        ? this.orders.filter((o) => o.seq > since).map((o) => ({ id: o.id, seq: o.seq }))
        : [];
      return this.send(res, 200, { ok: true, seq: this.seq, orders });
    }
    if (req.method === 'POST' && url.pathname === '/shadow/state') {
      return this.readJson(req, (payload) => {
        if (payload && typeof payload === 'object') {
          this.lastBuilt = {
            scale: Number(payload.scale),
            figure: String(payload.figure ?? ''),
            at: new Date().toISOString(),
          };
        }
        this.send(res, 200, { ok: true });
      });
    }
    if (req.method === 'POST' && url.pathname === '/shadow/done') {
      return this.readJson(req, (payload) => {
        const id = String(payload?.id ?? '');
        const word = typeof payload?.word === 'string' ? payload.word : null;
        const done = this.waiters.get(id);
        if (done) {
          this.waiters.delete(id);
          done(word);
        }
        if (word) {
          this.lastDone = { id, word, at: new Date().toISOString() };
          this.doneCount += 1;
        }
        this.orders = this.orders.filter((o) => o.id !== id);
        this.send(res, 200, { ok: true, known: Boolean(done) });
      });
    }
    return this.send(res, 404, { ok: false, error: 'not found' });
  }

  readJson(req, then) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) raw = raw.slice(0, 64 * 1024);
    });
    req.on('end', () => {
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
      then(payload);
    });
    req.on('error', () => then(null));
  }

  /** 等桌宠回报动作名；超时或扩展被停掉都返回 null。 */
  waitForWord(id, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve(null);
      }, Math.max(500, Number(timeoutMs) || DEFAULTS.replyTimeoutMs));
      timer.unref?.();
      this.waiters.set(id, (word) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(word);
      });
    });
  }

  async poke() {
    if (!this.listening) {
      const why = this.lastError ? '：' + this.lastError : '（扩展未启用？）';
      return { text: '影子分身没有在运行' + why, failed: true };
    }
    const id = 'sh' + (++this.pokeSeq);
    this.orders.push({ id, seq: ++this.seq, ts: Date.now() });
    if (this.orders.length > MAX_ORDERS) this.orders.splice(0, this.orders.length - MAX_ORDERS);

    const word = await this.waitForWord(id, this.cfg.replyTimeoutMs);
    // 指令已经过时：从队列里撤掉，免得桌宠窗口晚开时补做一次
    this.orders = this.orders.filter((o) => o.id !== id);
    if (!word) return { text: '影子没有回应：桌宠窗口没开，或影子补丁没装。', failed: true };
    return { text: '影子做了：' + (WORD_ZH[word] ?? word) };
  }

  tools() {
    return [{
      ...TOOL_DECL,
      handler: async () => {
        try {
          return await this.poke();
        } catch (error) {
          return { text: '影子分身出错：' + (error?.message ?? String(error)), failed: true };
        }
      },
    }];
  }

  envPromptVars() {
    return {};
  }

  webUi(language) {
    const cfg = this.cfg;
    const zh = language !== 'en';
    return {
      label: this.label(language),
      lamps: [{
        label: zh ? '影子命令接口' : 'Shadow link',
        state: this.listening ? 'online' : (this.lastError ? 'error' : 'offline'),
        hint: this.listening
          ? (zh ? `127.0.0.1:${PORT} 就绪` : `ready on 127.0.0.1:${PORT}`)
          : (this.lastError ?? (zh ? '未启动' : 'not started')),
      }],
      badges: [
        { label: zh ? '形象包' : 'Figure', value: String(cfg.figure), tone: 'plain' },
        { label: zh ? '大小' : 'Scale', value: Number(cfg.scale) + '×', tone: 'plain' },
      ],
      config: [{
        id: 'world:shadow',
        owner: 'world:shadow',
        schema: {
          type: 'object',
          title: zh ? '影子分身' : 'Shadow',
          description: zh
            ? '影子是 Coo 桌宠窗口里的第二只身体，由本扩展驱动：关掉本扩展，影子会在几秒内自己消失。改大小/形象包后影子会重建（约 2 秒）。'
            : 'The shadow is a second body inside the pet window, driven by this extension. Turning the extension off makes it vanish within seconds. Changing size or figure rebuilds it in about 2 seconds.',
          properties: {
            scale: {
              type: 'number', minimum: 0.2, maximum: 1, multipleOf: 0.05,
              title: zh ? '大小（相对主 Coo）：0.2–1，默认 0.45' : 'Size: 0.2–1, default 0.45',
            },
            gap: {
              type: 'integer', minimum: 40, maximum: 400,
              title: zh ? '跟随距离：40–400 像素，默认 130' : 'Follow gap: 40–400 px, default 130',
            },
            speed: {
              type: 'number', minimum: 0.3, maximum: 2, multipleOf: 0.05,
              title: zh ? '移动速度系数：0.3–2，默认 0.6' : 'Speed factor: 0.3–2, default 0.6',
            },
            volume: {
              type: 'number', minimum: 0, maximum: 1, multipleOf: 0.05,
              title: zh ? '影子音量（相对主 Coo）：0–1，默认 0.2' : 'Volume: 0–1, default 0.2',
            },
            figure: {
              type: 'string', 'x-options': 'figures',
              title: zh ? '形象包（下拉；装扮页已有的都在里面）' : 'Figure pack (dropdown of installed packs)',
            },
            replyTimeoutMs: {
              type: 'integer', minimum: 500, maximum: 8000, multipleOf: 100,
              title: zh ? '等回执上限：500–8000 毫秒，默认 2500' : 'Reply timeout: 500–8000 ms, default 2500',
            },
          },
        },
        data: {
          scale: Number(cfg.scale),
          gap: Number(cfg.gap),
          speed: Number(cfg.speed),
          volume: Number(cfg.volume),
          figure: String(cfg.figure || 'whale'),
          replyTimeoutMs: Number(cfg.replyTimeoutMs),
          lastError: this.lastError,
        },
      }],
      promptDocs: [{
        key: 'worlds.shadow.envPrompt',
        title: zh ? '影子分身' : 'Shadow',
        description: zh ? '影子里你是谁、它能做什么、什么时候戳它。' : 'What the shadow is and when to poke it.',
        role: 'envPrompt',
        path: PROMPT_PATH,
      }],
    };
  }
}

export default {
  id: 'shadow',
  label: '影子分身',
  defaults: () => ({ ...DEFAULTS }),
  /**
   * 设置页的值是从运行配置按 schema 的键读的：段里缺哪个键，界面就显示 0 / 空。
   * 所以构造时把缺的键补进 `worlds.shadow`（只补不覆盖）。
   */
  create: (context) => {
    const world = new ShadowWorld(context);
    const patch = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (key === 'enabled') continue;
      if (context?.cfg?.[key] === undefined) patch[key] = value;
    }
    if (Object.keys(patch).length) {
      try { context.persist(patch); } catch { /* 只读部署下不致命 */ }
    }
    return world;
  },
  /** `x-options: 'figures'` 的下拉数据源。 */
  configOptions(kind, language) {
    if (kind !== 'figures') return [];
    const list = figuresState.list;
    if (!list.length) {
      return [
        { value: 'whale', label: 'whale' },
        { value: 'coo', label: 'coo' },
      ];
    }
    return list.map((f) => ({ value: f.id, label: f.title ? `${f.id} · ${f.title}` : f.id }));
  },
  describe: {
    tools: [TOOL_DECL],
    events: [],
  },
};

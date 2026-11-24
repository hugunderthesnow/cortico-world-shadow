#!/usr/bin/env node
/**
 * 影子分身：把 cortico-world-shadow 扩展装进 Coo，并给桌宠 web 层打渲染补丁。
 *
 * 用法（默认只检查，不写任何文件）：
 *   node install.mjs                  先看：每个锚点能不能命中、扩展目录能不能写
 *   node install.mjs --apply          真装：备份 → 打补丁 → link 扩展 → 改 package.json
 *   node install.mjs --status         看现在装了什么（补丁/扩展/版本对不对）
 *   node install.mjs --revert         全撤：web 层还原 → 摘掉扩展
 *   node install.mjs --pet-dir <路径>  覆盖桌宠包目录
 *   node install.mjs --ext-dir <路径>  覆盖扩展目录
 *
 * 为什么分两半：
 *   Coo 的扩展（kind: world）拿不到桌宠窗口，没法在窗口里长出第二只身体；
 *   所以「工具 + 提示词 + 参数」由扩展提供，「那只小身体」由这里的补丁渲染。
 *   补丁每 2 秒问一次扩展 /shadow/hello，问不到就把影子收走——关掉扩展影子会消失。
 *
 * 只做锚点替换，不整文件覆盖；每份文件第一次改前备份成 <文件>.bak-shadow。
 */
import {
  readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync, symlinkSync, lstatSync, unlinkSync, cpSync, realpathSync, rmdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCH = HERE;
const PKG_NAME = 'cortico-world-shadow';
const PKG_ROOT = resolve(HERE, '..');
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const DEFAULT_PET = '';
const DEFAULT_EXT = '';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const MODE = flag('--apply') ? 'apply' : flag('--revert') ? 'revert' : flag('--status') ? 'status' : 'dry-run';
const petArg = opt('--pet-dir') || process.env.DESKTOP_PET_DIR || DEFAULT_PET;
const extArg = opt('--ext-dir') || process.env.COOPANION_EXT_DIR || DEFAULT_EXT;
if (!petArg || !extArg) {
  console.error('\n需要指定 Coo 的目录：\n'
    + '  --pet-dir "<Coo>\\resources\\app\\node_modules\\cortico-world-desktop-pet"\n'
    + '  --ext-dir "<Coo>\\data\\extensions"\n');
  process.exit(2);
}
const PET = resolve(petArg);
const EXT = resolve(extArg);
const LOCAL_PKG = join(EXT, '_local', `${PKG_NAME}-${PKG.version}`);

const shadowApp = readFileSync(join(PATCH, 'shadow-app.js'), 'utf8').replace(/\s+$/, '') + '\n';

/** 每条：file 相对桌宠包；from 在原文里出现 count 次（缺省 1）；to 是替换结果。 */
const EDITS = [
  /* ---------------- web/kit/body.js：触摸白名单、速度系数、垂直 ---------------- */
  {
    file: 'web/kit/body.js',
    what: '加触摸白名单与速度系数',
    from: '  let custom = opts.figure;',
    to: '  let custom = opts.figure;\n'
      + '  // 补丁 shadow：触摸白名单（默认全开；影子只传 [\'poke\']）\n'
      + "  const touchSet = new Set(opts.touches ?? ['poke', 'pet', 'grab', 'drop', 'throw']);\n"
      + '  const allow = (k) => touchSet.has(k);\n'
      + '  // 补丁 shadow：移动速度系数（1 为原速；影子传 0.6）\n'
      + '  const moveSpeed = Number(opts.speed) > 0 ? Number(opts.speed) : 1;',
  },
  {
    file: 'web/kit/body.js',
    what: '滑行时长按速度系数缩放',
    from: '    const dur = clamp(dist / (run ? 260 : 90), .5, 9);',
    to: '    const dur = clamp(dist / (run ? 260 : 90), .5, 9) / moveSpeed;',
  },
  {
    file: 'web/kit/body.js',
    what: '落下时抓取看白名单',
    from: "    if (pet.mode === 'air') grab();",
    to: "    if (pet.mode === 'air' && allow('grab')) grab();",
  },
  {
    file: 'web/kit/body.js',
    what: '拖动阈值抓取看白名单',
    from: "    if (press && pet.mode !== 'drag' && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();",
    to: "    if (press && pet.mode !== 'drag' && allow('grab') && Math.hypot(p.x - press.x, p.y - press.y) > 6) grab();",
  },
  {
    file: 'web/kit/body.js',
    what: '摸头判定看白名单',
    from: "    if (over && ['idle', 'look', 'sit', 'sleep'].includes(pet.mode)) {",
    to: "    if (allow('pet') && over && ['idle', 'look', 'sit', 'sleep'].includes(pet.mode)) {",
  },
  {
    file: 'web/kit/body.js',
    what: '戳判定看白名单',
    from: '    } else if (now(p) - press.t < 400) {',
    to: "    } else if (allow('poke') && now(p) - press.t < 400) {",
  },
  {
    file: 'web/kit/body.js',
    what: '光标只在能抓时显示 grab',
    from: "    return (pet.cursor = over ? 'grab' : '');",
    to: "    return (pet.cursor = over && allow('grab') ? 'grab' : '');",
  },
  {
    file: 'web/kit/body.js',
    what: 'createBody 接受 vertical / speed',
    from: '    onEvent: host.emit,',
    to: '    onEvent: host.emit,\n'
      + '    // 补丁 shadow：影子要能停在任意高度、并且比主 Coo 慢\n'
      + '    vertical: opts.vertical === true || host.vertical === true,\n'
      + '    speed: opts.speed ?? host.speed ?? 1,',
  },

  /* ---------------- web/body-host.js：透传 size / touches / zIndex / vertical / speed ---------------- */
  {
    file: 'web/body-host.js',
    what: 'loadBody 接 size / touches / zIndex / vertical / speed',
    from: 'export function loadBody({ layer, pack, start, theme, bounds, onEvent, onSound, onError }) {',
    to: 'export function loadBody({ layer, pack, start, theme, bounds, onEvent, onSound, onError, size: viewSize = 1, touches: touchKinds = null, zIndex = 0, vertical = false, speed = 1 }) {',
  },
  {
    file: 'web/body-host.js',
    what: 'clip 的层叠',
    from: "    const clip = document.createElement('div');\n    clip.className = 'figure-clip';",
    to: "    const clip = document.createElement('div');\n    clip.className = 'figure-clip';\n    if (zIndex) clip.style.zIndex = String(zIndex);",
  },
  {
    file: 'web/body-host.js',
    what: '透出 moveTo',
    from: "      walk: (x, run, id) => post({ t: 'walk', x, run, id }),",
    to: "      walk: (x, run, id) => post({ t: 'walk', x, run, id }),\n      moveTo: (x, y, run, id) => post({ t: 'move-to', x, y, run, id }),",
  },
  {
    file: 'web/body-host.js',
    what: 'init 带上 size / touches / vertical / speed',
    from: "            base: new URL(pack.base, location.href).href, model, scheme: knownScheme(pack, start.scheme), start: { x: start.x, facing: start.facing, enter: start.enter, skin: start.skin }, theme, bounds: size,",
    to: "            base: new URL(pack.base, location.href).href, model, scheme: knownScheme(pack, start.scheme), start: { x: start.x, facing: start.facing, enter: start.enter, skin: start.skin }, theme, bounds: size, size: viewSize, touches: touchKinds, vertical, speed,",
  },

  /* ---------------- web/figure-frame.js：缩放、move-to、vertical / speed ---------------- */
  {
    file: 'web/figure-frame.js',
    what: '加 bodyScale 并乘进 S',
    from: 'const setBounds = (b) => { bounds = desk ? { ...b, ...desk } : { ...b }; };',
    to: 'let bodyScale = 1;\nconst setBounds = (b) => { bounds = { ...(desk ? { ...b, ...desk } : { ...b }), S: b.S * bodyScale }; };',
  },
  {
    file: 'web/figure-frame.js',
    what: 'init 读 size',
    from: "    } else if (m.t === 'init') {\n      setBounds(m.bounds);",
    to: "    } else if (m.t === 'init') {\n      if (typeof m.size === 'number' && m.size > 0) bodyScale = m.size;\n      setBounds(m.bounds);",
  },
  {
    file: 'web/figure-frame.js',
    what: '交给形象包 vertical / speed',
    from: '      body = await make(base, { model: m.model ?? undefined, scheme: m.scheme, kit, loadImage, asset: (p) => new URL(p, base), host: { ...host, start: m.start } });',
    to: '      body = await make(base, { model: m.model ?? undefined, scheme: m.scheme, kit, loadImage, asset: (p) => new URL(p, base), host: { ...host, start: m.start, vertical: m.vertical === true, speed: m.speed } });',
  },
  {
    file: 'web/figure-frame.js',
    what: '转发 move-to',
    from: "    else if (m.t === 'walk') {",
    to: "    else if (m.t === 'move-to') { if (!body.moveTo?.(m.x, m.y, m.run, m.id)) events.push({ kind: 'interrupted', detail: { walkId: m.id, by: 'busy' } }); }\n    else if (m.t === 'walk') {",
  },

  /* ---------------- web/sound.js：单次播放的音量系数 ---------------- */
  {
    file: 'web/sound.js',
    what: '加 playGain 变量',
    from: '  let muted = new Set(), snoreSeconds = 0;',
    to: '  let muted = new Set(), snoreSeconds = 0;\n  // 补丁 shadow：单次播放的音量系数（影子传 0.2，主 Coo 不传）\n  let playGain = 1;',
  },
  {
    file: 'web/sound.js',
    what: '合成音按 playGain 缩音量（两处）',
    from: '    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);',
    to: '    g.gain.exponentialRampToValueAtTime(vol * playGain, t0 + attack);',
    count: 2,
  },
  {
    file: 'web/sound.js',
    what: '形象包自带音效按 playGain 缩音量',
    from: '    src.buffer = o.buffer; g.gain.value = o.volume;',
    to: '    src.buffer = o.buffer; g.gain.value = o.volume * playGain;',
  },
  {
    file: 'web/sound.js',
    what: 'play() 接受最后一个参数 { gain }',
    from: '    play(name, kind, ...args) {\n'
      + '      const o = own.get(name);\n'
      + '      const k = o ? o.kind : BODY_SOUND_KINDS.includes(kind) ? kind : KIND_OF[name];\n'
      + '      if (muted.has(k)) return;\n'
      + '      if (k === \'snore\' && snoreSeconds > 0 && args[0] > snoreSeconds) return;\n'
      + '      if (o) playOwn(o);\n'
      + '      else if (Object.hasOwn(tones, name)) tones[name](...args);\n'
      + '    },',
    to: '    play(name, kind, ...args) {\n'
      + '      // 补丁 shadow：最后一个参数可以是 { gain }，只在这一次播放里缩放音量\n'
      + '      let gain = 1;\n'
      + '      const last = args[args.length - 1];\n'
      + "      if (last && typeof last === 'object' && 'gain' in last) { gain = Number(last.gain); args.pop(); }\n"
      + '      const o = own.get(name);\n'
      + '      const k = o ? o.kind : BODY_SOUND_KINDS.includes(kind) ? kind : KIND_OF[name];\n'
      + '      if (muted.has(k)) return;\n'
      + '      if (k === \'snore\' && snoreSeconds > 0 && args[0] > snoreSeconds) return;\n'
      + '      playGain = Number.isFinite(gain) && gain >= 0 ? gain : 1;\n'
      + '      try {\n'
      + '        if (o) playOwn(o);\n'
      + '        else if (Object.hasOwn(tones, name)) tones[name](...args);\n'
      + '      } finally {\n'
      + '        playGain = 1;\n'
      + '      }\n'
      + '    },',
  },

  /* ---------------- src/server.ts：CSP 只放开影子端口 ---------------- */
  {
    file: 'src/server.ts',
    what: "CSP connect-src 放开 8897（否则桌宠页连不到影子接口）",
    from: "connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src",
    to: "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:8897; img-src",
  },

  /* ---------------- web/pet-app.js：影子本体与指针分发 ---------------- */
  {
    file: 'web/pet-app.js',
    what: '插入影子模块',
    from: '/* ---------- body events → World ---------- */',
    to: shadowApp + '/* ---------- body events → World ---------- */',
  },
  {
    file: 'web/pet-app.js',
    what: 'pet_act / pet_say 的动作同步给影子',
    from: '  body.do(a);\n  actWord = a;',
    to: '  body.do(a);\n  shadow?.do(a);\n  actWord = a;',
  },
  {
    file: 'web/pet-app.js',
    what: '指针移动与命中并集',
    from: "  if (!shifting) body?.pointer('move', { ...p, t: e.timeStamp });\n  const hit = !!body?.hit(p), ui = !!overUi(e);",
    to: "  if (!shifting) (pressingOn === 'shadow' ? shadow : body)?.pointer('move', { ...p, t: e.timeStamp });\n  const hit = !!body?.hit(p) || !!shadow?.hit(p), ui = !!overUi(e);",
  },
  {
    file: 'web/pet-app.js',
    what: '轮询命中并集',
    from: "  const hit = !!body?.hit(p), ui = !!el?.closest?.(UI_SELECTOR);",
    to: "  const hit = !!body?.hit(p) || !!shadow?.hit(p), ui = !!el?.closest?.(UI_SELECTOR);",
  },
  {
    file: 'web/pet-app.js',
    what: '按下时分派给影子',
    from: "  body?.pointer('down', p);\n  if (body?.hit(p)) { pressing = true; stage.setPointerCapture(e.pointerId); e.preventDefault(); }",
    to: "  pressingOn = shadow?.hit(p) && !body?.hit(p) ? 'shadow' : 'body';\n  (pressingOn === 'shadow' ? shadow : body)?.pointer('down', p);\n  if (body?.hit(p) || shadow?.hit(p)) { pressing = true; stage.setPointerCapture(e.pointerId); e.preventDefault(); }",
  },
  {
    file: 'web/pet-app.js',
    what: '松开还给按下的那一只',
    from: "const up = (e) => { pressing = false; body?.pointer('up', { x: e?.clientX ?? lastPointer.x, y: e?.clientY ?? lastPointer.y, t: e?.timeStamp ?? performance.now() }); stage.style.cursor = ''; };",
    to: "const up = (e) => { pressing = false; (pressingOn === 'shadow' ? shadow : body)?.pointer('up', { x: e?.clientX ?? lastPointer.x, y: e?.clientY ?? lastPointer.y, t: e?.timeStamp ?? performance.now() }); pressingOn = 'body'; stage.style.cursor = ''; };",
  },
  {
    file: 'web/pet-app.js',
    what: '每帧驱动影子',
    from: '    body?.tick(dt);',
    to: '    body?.tick(dt);\n    stepShadow(dt);',
  },
];

const FILES = [...new Set(EDITS.map((e) => e.file))];

/**
 * 0.2.9 的旧影子补丁已经做过的那几处，新补丁的改动与它**完全相同**。
 * 所以判断「装没装」不能只看 `to`：旧版写进去的片段一样算已完成。
 */
const ALREADY = {
  'web/pet-app.js|pet_act / pet_say 的动作同步给影子': 'shadow?.do(a)',
  'web/pet-app.js|指针移动与命中并集': "pressingOn === 'shadow' ? shadow : body)?.pointer('move'",
  'web/pet-app.js|按下时分派给影子': 'pressingOn = shadow?.hit(p)',
  'web/pet-app.js|每帧驱动影子': 'stepShadow(dt)',
};
for (const edit of EDITS) {
  const hit = ALREADY[edit.file + '|' + edit.what];
  if (hit) edit.already = hit;
}

/** 0.2.21 原生就有的能力：这些补丁不用打。 */
const NATIVE = {
  'web/kit/body.js': (t) => t.includes('touchSet') && t.includes('opts.speed'),
  'web/body-host.js': (t) => t.includes('size: viewSize') && t.includes('moveTo:'),
  'web/figure-frame.js': (t) => t.includes('bodyScale'),
  'web/sound.js': (t) => t.includes('playGain'),
};

/* ------------------------- 剥离 v1 手工补丁 ------------------------- */

const V1 = join(PATCH, 'v1'); // 公开版没有这个目录，剥离逻辑会自动跳过
const V1_READ = (name) => {
  const p = join(V1, name);
  return existsSync(p) ? readFileSync(p, 'utf8').replace(/\s+$/, '') : '';
};

/** v1 往哪些文件塞了片段：片段从 patch\v1\ 读，直接按原样删掉。 */
const V1_FRAGMENTS = [
  { file: 'src/tools.ts', frag: 'shadow-tool.ts' },
  { file: 'src/world.ts', frag: 'shadow-world-words.ts' },
  { file: 'src/world.ts', frag: 'shadow-world-field.ts' },
  { file: 'src/world.ts', frag: 'shadow-world-method.ts' },
  { file: 'src/world.ts', frag: 'shadow-world-case.ts' },
  { file: 'src/ENV_PROMPT.md', frag: 'shadow-env.md' },
  // 旧 apply.mjs 里内联的那行 handler，不在片段文件里
  { file: 'src/world.ts', inline: '      pet_shadow: () => this.shadowPoke(),\n' },
];

/** v1 在 pet-app.js 里插的整块模块，从标记到 `body events` 注释之前。 */
const V1_MODULE_START = '/* ---------- 影子分身';
const V1_MODULE_END = '/* ---------- body events → World ---------- */';

/** 从文本里摘掉 v1 的影子模块（没有就原样返回）。 */
function stripShadowModule(text) {
  const i = text.indexOf(V1_MODULE_START);
  if (i < 0) return text;
  const j = text.indexOf(V1_MODULE_END, i);
  if (j < i) return text;
  return text.slice(0, i) + text.slice(j);
}

/** 把 v1 塞进 src/ 的片段全删掉；返回改了几处。 */
function stripV1Sources(verbose = true) {
  let n = 0;
  for (const { file, frag, inline } of V1_FRAGMENTS) {
    const path = join(PET, file);
    if (!existsSync(path)) continue;
    let text = readFileSync(path, 'utf8');
    const piece = (frag ? V1_READ(frag) : (inline ?? '')).replace(/\s+$/, '');
    if (!piece) continue;
    if (!text.includes(piece)) continue;
    text = text.split(piece).join('');
    writeFileSync(path, text, 'utf8');
    n += 1;
    if (verbose) info(`${file}：已摘掉 v1 片段 ${frag ?? 'handler'}`);
  }
  return n;
}

/** 0.2.21 这类装过 v1 但又没有备份的文件：先剥干净，把剥完的结果存成 .bak-shadow。 */
function adoptWithoutBackup() {
  let n = 0;
  const stripAppPath = join(PET, 'web/pet-app.js');
  if (existsSync(stripAppPath)) {
    const text = readFileSync(stripAppPath, 'utf8');
    const clean = stripShadowModule(text);
    if (clean !== text) {
      writeFileSync(stripAppPath, clean, 'utf8');
      ok('web/pet-app.js：已摘掉 v1 的影子模块');
      n += 1;
    }
  }
  n += stripV1Sources();
  return n;
}

/**
 * 旧版（0.45 手工补丁）除 web 层外，还往 `src/` 里塞了工具、等待表和提示词。
 * 新版这些由扩展提供；不撤掉就会和扩展**抢 `pet_shadow` 工具名**，
 * 扩展的 World 会被框架以「工具重名」拒挂载（现象：扩展 loaded 但 World 不在启动列表里）。
 */
const LEGACY_SRC = [
  { file: 'src/tools.ts', mark: "name: 'pet_shadow'" },
  { file: 'src/world.ts', mark: 'shadow-did' },
  { file: 'src/ENV_PROMPT.md', mark: '影子分身' },
];

/** 旧版遗留在 src/ 里的部分，有就还原；返回撤掉的条数。 */
function revertLegacySrc(verbose = true) {
  let done = 0;
  for (const { file, mark } of LEGACY_SRC) {
    const path = join(PET, file);
    if (!existsSync(path)) continue;
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    if (!text.includes(mark)) continue;
    const bak = bakOf(file);
    if (!existsSync(bak)) { bad(`${file} 有旧版补丁但没有 .bak-shadow，无法安全撤销`); continue; }
    if (!verbose) continue;
    copyFileSync(bak, path);
    info(`${file}：已撤掉旧版改动（工具/提示词改由扩展提供）`);
    done += 1;
  }
  return done;
}
const MARK = '补丁 shadow';
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (text, eol) => text.replace(/\n/g, eol);
const bakOf = (rel) => join(PET, rel + '.bak-shadow');

let failures = 0;
function bad(msg) { failures += 1; console.error('  ✗ ' + msg); }
function ok(msg) { console.log('  ✓ ' + msg); }
function info(msg) { console.log('  · ' + msg); }

/** 某个文件当前算哪种状态：没装 / 新补丁已装 / 旧补丁（0.45 手工版）/ 锚点不认识。 */
function stateOf(rel) {
  if (!existsSync(join(PET, rel))) return 'missing-file';
  const text = readFileSync(join(PET, rel), 'utf8');
  const eol = eolOf(text);
  // 这个文件的所有改动都在 = 新版装齐了
  const mine = EDITS.filter((e) => e.file === rel);
  if (mine.length && mine.every((e) => text.includes(withEol(e.to, eol)))) return 'current';
  // 文件与备份不一样、却又没装齐 = 有旧补丁（0.45 手工版没有标记注释，只能这样认）
  const bak = bakOf(rel);
  if (existsSync(bak) && readFileSync(bak, 'utf8') !== text) return 'legacy';
  return 'none';
}

/**
 * 检查锚点用的文本：有 .bak-shadow 就是原文（`--apply` 会先还原再打）。
 * 没备份但装过 v1 的（0.2.21），按「剥掉 v1 之后」的样子检查，和 --apply 的起点一致。
 */
function sourceOf(rel) {
  const bak = bakOf(rel);
  if (existsSync(bak)) return readFileSync(bak, 'utf8');
  let text = readFileSync(join(PET, rel), 'utf8');
  if (rel === 'web/pet-app.js') text = stripShadowModule(text);
  for (const { file, frag, inline } of V1_FRAGMENTS) {
    if (file !== rel) continue;
    const piece = (frag ? V1_READ(frag) : (inline ?? '')).replace(/\s+$/, '');
    if (piece && text.includes(piece)) text = text.split(piece).join('');
  }
  return text;
}

/* ------------------------------ dry-run ------------------------------ */
function dryRun() {
  console.log(`\n影子分身 v${PKG.version} · 只检查，不写文件`);
  console.log(`桌宠包：${PET}`);
  console.log(`扩展目录：${EXT}\n`);

  if (!existsSync(PET)) { bad('桌宠包目录不存在：' + PET + '（用 --pet-dir 指定）'); return; }
  ok('桌宠包目录存在');

  const states = new Map(FILES.map((rel) => [rel, stateOf(rel)]));
  const legacy = [...states].filter(([, s]) => s === 'legacy').map(([rel]) => rel);
  if (legacy.length) {
    console.log('\n发现旧版影子补丁（0.45 手工版，含 shadow-did 通道）：');
    for (const rel of legacy) info(rel);
    info('`--apply` 会先从 .bak-shadow 还原再打新版；没有 .bak-shadow 的文件会停下报错，不会硬改。');
  }

  console.log('\n锚点检查（旧补丁的文件按 .bak-shadow 原文判断，与 --apply 的还原顺序一致）：');
  const nativeNow = new Set();
  for (const [file, test] of Object.entries(NATIVE)) {
    const path = join(PET, file);
    if (!existsSync(path)) continue;
    try { if (test(readFileSync(path, 'utf8'))) nativeNow.add(file); } catch { /* 忽略 */ }
  }
  for (const edit of EDITS) {
    const path = join(PET, edit.file);
    if (!existsSync(path)) { bad(`${edit.file} 不存在`); continue; }
    const text = sourceOf(edit.file);
    if (nativeNow.has(edit.file)) { info(`${edit.file} · ${edit.what}：本机 Coo 原生已支持，不需要`); continue; }
    if (text.includes(edit.to) || (edit.already && text.includes(edit.already))) { info(`${edit.file} · ${edit.what}：已具备`); continue; }
    const eol = eolOf(text);
    const from = withEol(edit.from, eol);
    const want = edit.count ?? 1;
    const got = text.split(from).length - 1;
    if (got === want) ok(`${edit.file} · ${edit.what}（命中 ${got}）`);
    else bad(`${edit.file} · ${edit.what}：应命中 ${want} 次，实际 ${got} 次（Coo 版本变了吗？）`);
  }

  const stale = LEGACY_SRC.filter(({ file, mark }) => {
    const path = join(PET, file);
    try { return existsSync(path) && readFileSync(path, 'utf8').includes(mark); } catch { return false; }
  });
  if (stale.length) {
    console.log('\n旧版还留在 src/ 里的改动（会和扩展抢 pet_shadow，--apply 会撤掉）：');
    for (const s of stale) info(s.file);
  }

  console.log('\n扩展侧：');
  if (!existsSync(EXT)) bad('扩展目录不存在：' + EXT);
  else ok('扩展目录存在');  if (existsSync(join(EXT, 'package.json'))) ok('extensions/package.json 存在');
  else bad('extensions/package.json 缺失');

  const link = join(EXT, 'node_modules', PKG_NAME);
  if (isLink(link)) info('已有 link：' + link);
  else if (existsSync(link)) info('node_modules 里已有同名目录（不是 link）：' + link);
  else info('尚未安装（--apply 会复制到 _local 并建 junction）');

  console.log(`\n结论：${failures ? failures + ' 处需要注意' : '可以 --apply'}`);
  if (failures) process.exitCode = 1;
}

function isLink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return true;
    // 有的环境（含本工作区沙箱）读不到 reparse point，但 realpath 会解析过去
    const real = realpathSync(path).toLowerCase();
    return real !== resolve(path).toLowerCase();
  } catch { return false; }
}

/** 删一个链接只删链接本身；真目录副本才递归删。避免把 _local 里的源码一起删掉。 */
function removeLink(path) {
  try { rmdirSync(path); return; } catch { /* 不是空目录或不是链接 */ }
  rmSync(path, { recursive: true, force: true });
}

/**
 * 建真正的 junction。Node 的 symlinkSync 在部分环境（含本工作区的沙箱）会被降级成
 * 「复制一份目录」，那样扩展也能加载、但升级时不同步；优先用 cmd 的 mklink /J。
 */
function makeJunction(link, target) {
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link) || isLink(link)) removeLink(link);
  try {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    if (existsSync(join(link, 'package.json'))) return 'junction';
  } catch { /* 下面用 Node 再试一次 */ }
  if (existsSync(link)) removeLink(link);
  try {
    symlinkSync(target, link, 'junction');
  } catch {
    mkdirSync(link, { recursive: true });
  }
  // 有的环境会把 symlink 静默降级成空目录：那不是装好了，整份复制兜底
  if (!existsSync(join(link, 'package.json'))) {
    removeLink(link);
    cpSync(target, link, { recursive: true });
    return 'copy';
  }
  return 'junction';
}

/* ------------------------------ apply ------------------------------ */
function apply() {
  console.log(`\n影子分身 v${PKG.version} · 开始安装`);
  if (!existsSync(PET)) { console.error('桌宠包目录不存在：' + PET); process.exitCode = 1; return; }

  // 1) 起点：有备份就还原；没备份但装过 v1，就地把 v1 剥干净（打补丁时会把这个干净版存成备份）
  console.log('\n准备起点：');
  let restored = 0;
  for (const rel of [...FILES, ...LEGACY_SRC.map((s) => s.file)]) {
    const bak = bakOf(rel);
    if (!existsSync(bak)) continue;
    copyFileSync(bak, join(PET, rel));
    restored += 1;
  }
  if (restored) ok(`已按 .bak-shadow 还原 ${restored} 个文件`);
  else {
    const stripped = adoptWithoutBackup();
    if (stripped) info(`没有备份：先从 v1 手工补丁里剥离 ${stripped} 处，再按干净起点打`);
    else info('没有 .bak-shadow：首次安装，按当前文件打');
  }

  // 2) 打补丁
  console.log('\n补丁：');
  const native = new Set();
  for (const [file, test] of Object.entries(NATIVE)) {
    const path = join(PET, file);
    if (!existsSync(path)) continue;
    try { if (test(readFileSync(path, 'utf8'))) native.add(file); } catch { /* 读不到就不算原生 */ }
  }
  for (const edit of EDITS) {
    const path = join(PET, edit.file);
    const text = readFileSync(path, 'utf8');
    if (native.has(edit.file)) { info(`${edit.file} · ${edit.what}：本机 Coo 原生已支持，跳过`); continue; }
    if (text.includes(edit.to) || (edit.already && text.includes(edit.already))) { info(`${edit.file} · ${edit.what}：已具备`); continue; }
    const eol = eolOf(text);
    const from = withEol(edit.from, eol);
    const to = withEol(edit.to, eol);
    const want = edit.count ?? 1;
    const got = text.split(from).length - 1;
    if (got !== want) { bad(`${edit.file} · ${edit.what}：应命中 ${want} 次，实际 ${got} 次`); continue; }
    const bak = bakOf(edit.file);
    if (!existsSync(bak)) copyFileSync(path, bak);
    writeFileSync(path, text.split(from).join(to), 'utf8');
    ok(`${edit.file} · ${edit.what}`);
  }

  // 3) 装扩展：复制到 _local，建 junction，登记依赖
  console.log('\n扩展安装：');
  try {
    rmSync(LOCAL_PKG, { recursive: true, force: true });
    mkdirSync(LOCAL_PKG, { recursive: true });
    // package.json 必带（Coo 靠它读 manifest），其余按 files 列表
    const keep = [...new Set(['package.json', ...(PKG.files ?? [])])];
    for (const rel of keep) {
      const src = join(PKG_ROOT, rel);
      if (!existsSync(src)) continue;
      cpSync(src, join(LOCAL_PKG, rel), { recursive: true });
    }
    ok('已复制到 ' + LOCAL_PKG);

    const link = join(EXT, 'node_modules', PKG_NAME);
    const how = makeJunction(link, LOCAL_PKG);
    if (how === 'junction') ok('已建 junction：' + link);
    else {
      info('已建目录副本（这台机器不让建 junction）：' + link);
      info('功能一样能加载；改了扩展源码要重跑 --apply 才会同步。');
    }

    const pkgPath = join(EXT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
    pkg.dependencies = pkg.dependencies ?? {};
    const spec = 'link:' + LOCAL_PKG.replace(/\\/g, '/');
    if (pkg.dependencies[PKG_NAME] !== spec) {
      const bak = pkgPath + '.bak-shadow';
      if (!existsSync(bak)) copyFileSync(pkgPath, bak);
      pkg.dependencies[PKG_NAME] = spec;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      ok('已在 extensions/package.json 登记依赖');
    } else info('extensions/package.json 依赖已存在');
  } catch (error) {
    bad('装扩展失败：' + (error?.message ?? error));
  }

  console.log('\n完成。下一步：');
  console.log('  1) 重启 Coo（扩展和补丁都要重启才生效）；');
  console.log('  2) 设置 → 世界/扩展里把「影子分身」打开（默认关）；');
  console.log('  3) 屏幕上应出现小一号的大肥鱼；关掉扩展，几秒内影子消失。');
  if (failures) { console.log(`\n有 ${failures} 处失败，见上面的 ✗。`); process.exitCode = 1; }
}

/* ------------------------------ revert ------------------------------ */
function revert() {
  console.log(`\n影子分身 · 撤销\n`);
  for (const rel of FILES) {
    const bak = bakOf(rel);
    if (!existsSync(bak)) { info(`${rel}：没有 .bak-shadow，跳过`); continue; }
    copyFileSync(bak, join(PET, rel));
    ok(`${rel}：已还原`);
  }
  // 旧版留在 src/ 的也一并还原（新版根本没改过它们，等于恢复原样）
  for (const { file, mark } of LEGACY_SRC) {
    const path = join(PET, file);
    if (!existsSync(path) || !existsSync(bakOf(file))) continue;
    if (!readFileSync(path, 'utf8').includes(mark)) continue;
    copyFileSync(bakOf(file), path);
    ok(`${file}：已还原旧版改动`);
  }
  try {
    const link = join(EXT, 'node_modules', PKG_NAME);
    if (isLink(link)) { removeLink(link); ok('已摘掉 junction'); }
    else if (existsSync(link)) { removeLink(link); ok('已删掉同名目录'); }
    const pkgPath = join(EXT, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
      if (pkg.dependencies?.[PKG_NAME]) {
        delete pkg.dependencies[PKG_NAME];
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        ok('已从 extensions/package.json 去掉依赖');
      }
    }
    if (existsSync(LOCAL_PKG)) { rmSync(LOCAL_PKG, { recursive: true, force: true }); ok('已删掉 _local 里的副本'); }
  } catch (error) {
    bad('撤扩展失败：' + (error?.message ?? error));
  }
  console.log('\n重启 Coo 后影子就没了。');
}

/* ------------------------------ status ------------------------------ */
function status() {
  console.log(`\n影子分身 v${PKG.version} · 现状\n`);
  console.log('web 层补丁：');
  if (!existsSync(PET)) bad('桌宠包目录不存在：' + PET);
  else {
    for (const rel of FILES) {
      const s = stateOf(rel);
      const label = { current: '已装（新版）', legacy: '旧版补丁（0.45 手工版）', none: '未装', 'missing-file': '文件不存在' }[s] ?? s;
      (s === 'current' ? ok : info)(`${rel}：${label}`);
    }
  }
  console.log('\n扩展：');
  const link = join(EXT, 'node_modules', PKG_NAME);
  const mounted = existsSync(join(link, 'package.json'));
  if (mounted) info('已挂到 node_modules（能读到 package.json）：' + link);
  else if (existsSync(link)) bad('node_modules 里有目录但读不到 package.json（装坏了，重跑 --apply）');
  else info('未挂到 node_modules');
  try {
    const pkg = JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    info(pkg.dependencies?.[PKG_NAME] ? '依赖登记：' + pkg.dependencies[PKG_NAME] : '依赖未登记');
  } catch { bad('读不到 extensions/package.json'); }
  info(existsSync(LOCAL_PKG) ? '副本在：' + LOCAL_PKG : '副本不在（未装过）');
  console.log('\n运行时是否在线要另看：Coo 设置 → 世界/扩展 → 影子分身（状态灯）。');
}

if (MODE === 'dry-run') dryRun();
else if (MODE === 'apply') apply();
else if (MODE === 'revert') revert();
else status();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

// Load DarkWebCore directly from web/index.html so tests verify the exact shipped script.
function loadDarkWebCoreFromHtml() {
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Inline <script> block must exist in web/index.html');

  const sandbox = {
    window: {
      location: { search: '' },
      matchMedia: () => ({ matches: false })
    },
    document: {
      readyState: 'loading',
      addEventListener: () => {}
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    console,
    Uint8Array,
    DataView,
    TextDecoder,
    Blob,
    Response,
    DecompressionStream: globalThis.DecompressionStream
  };
  vm.runInNewContext(scriptMatch[1], sandbox);
  assert.ok(sandbox.window.DarkWebCore, 'DarkWebCore must be exposed on window');
  return sandbox.window.DarkWebCore;
}

// Helper to construct a real, valid ZIP buffer (method 0 = stored, method 8 = deflate-raw)
function buildTestZip(entries) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.from(entry.content, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const compBuf = entry.deflate ? zlib.deflateRawSync(rawBuf) : rawBuf;

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0, 6);
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt32LE(compBuf.length, 18);
    localHdr.writeUInt32LE(rawBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    const cdHdr = Buffer.alloc(46);
    cdHdr.writeUInt32LE(0x02014b50, 0);
    cdHdr.writeUInt16LE(20, 4);
    cdHdr.writeUInt16LE(20, 6);
    cdHdr.writeUInt16LE(0, 8);
    cdHdr.writeUInt16LE(method, 10);
    cdHdr.writeUInt32LE(compBuf.length, 20);
    cdHdr.writeUInt32LE(rawBuf.length, 24);
    cdHdr.writeUInt16LE(nameBuf.length, 28);
    cdHdr.writeUInt32LE(offset, 42);

    localChunks.push(localHdr, nameBuf, compBuf);
    cdChunks.push(cdHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const full = Buffer.concat([...localChunks, cdBuf, eocd]);
  return full.buffer.slice(full.byteOffset, full.byteOffset + full.byteLength);
}

const Core = loadDarkWebCoreFromHtml();

test('resolveGraphicsBackend safely falls back from WebGPU to WebGL 2.0 when unsupported', () => {
  const fallback = Core.resolveGraphicsBackend('webgpu', { webgpu: false, webgl2: true });
  assert.equal(fallback.active, 'webgl2');
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.tone, 'warn');

  const nativeGpu = Core.resolveGraphicsBackend('webgpu', { webgpu: true, webgl2: true });
  assert.equal(nativeGpu.active, 'webgpu');
  assert.equal(nativeGpu.fallback, false);

  const webgl = Core.resolveGraphicsBackend('webgl2', { webgpu: false, webgl2: true });
  assert.equal(webgl.active, 'webgl2');
  assert.equal(webgl.fallback, false);
});

test('evaluateLaunchReadiness activates launch button reliably once WASM and files are ready', () => {
  const ready = Core.evaluateLaunchReadiness({
    wasmState: 'ready',
    cachedFiles: 42,
    cachedBytes: 512 * 1024 * 1024,
    edition: 'Thief II: The Metal Age',
    extracting: false
  });
  assert.equal(ready.canLaunch, true);
  assert.equal(ready.gemState, 'ready');

  const waitingForFiles = Core.evaluateLaunchReadiness({
    wasmState: 'ready',
    cachedFiles: 0,
    cachedBytes: 0,
    edition: '',
    extracting: false
  });
  assert.equal(waitingForFiles.canLaunch, false);
  assert.equal(waitingForFiles.gemState, 'shadow');

  const extracting = Core.evaluateLaunchReadiness({
    wasmState: 'ready',
    cachedFiles: 10,
    cachedBytes: 1024,
    edition: 'Thief Gold',
    extracting: true
  });
  assert.equal(extracting.canLaunch, false);
  assert.equal(extracting.gemState, 'loading');
});

test('ZIP parser unpacks Stored and Deflate entries and strips single common root folder', async () => {
  const zipBuf = buildTestZip([
    { name: 'Thief2/cam.cfg', content: 'game dark\n', deflate: false },
    { name: 'Thief2/MISS15.MIS', content: 'Thief II mission payload '.repeat(20), deflate: true }
  ]);

  const entries = Core.parseZipCentralDirectory(zipBuf);
  assert.equal(entries.length, 2);

  const prefix = Core.detectCommonRootPrefix(entries.map((e) => e.name));
  assert.equal(prefix, 'Thief2');
  assert.equal(Core.normalizeGamePath(entries[0].name, prefix), 'cam.cfg');
  assert.equal(Core.normalizeGamePath(entries[1].name, prefix), 'MISS15.MIS');
  assert.equal(Core.detectThiefEdition(entries.map((e) => e.name)), 'Thief II: The Metal Age');

  const raw = new Uint8Array(zipBuf);
  const inflated = await Core.inflateRawBytes(raw.subarray(entries[1].dataOffset, entries[1].dataOffset + entries[1].compSize));
  assert.equal(Buffer.from(inflated).toString('utf8'), 'Thief II mission payload '.repeat(20));
});

test('mapJoystickToInput maps 3 Thief stealth bands (creep, walk, run) accurately', () => {
  const idle = Core.mapJoystickToInput(2, 2, 54);
  assert.equal(idle.speedMode, 'idle');
  assert.equal(idle.keys.KeyW, false);

  const creep = Core.mapJoystickToInput(0, -14, 54);
  assert.equal(creep.speedMode, 'creep');
  assert.equal(creep.keys.KeyW, true);
  assert.equal(creep.keys.ControlLeft, true);
  assert.equal(creep.keys.ShiftLeft, false);

  const walk = Core.mapJoystickToInput(0, -32, 54);
  assert.equal(walk.speedMode, 'walk');
  assert.equal(walk.keys.KeyW, true);
  assert.equal(walk.keys.ControlLeft, false);
  assert.equal(walk.keys.ShiftLeft, false);

  const run = Core.mapJoystickToInput(0, -52, 54);
  assert.equal(run.speedMode, 'run');
  assert.equal(run.keys.KeyW, true);
  assert.equal(run.keys.ShiftLeft, true);
});

test('computeCanvasResolution scales cleanly for mobile ultralow/low presets vs PC high preset', () => {
  const ultraLowMobile = Core.computeCanvasResolution(844, 390, 3, 'ultralow');
  assert.equal(ultraLowMobile.width, 422);
  assert.equal(ultraLowMobile.height, 200);

  const lowMobile = Core.computeCanvasResolution(844, 390, 3, 'low');
  assert.equal(lowMobile.width, 549);
  assert.equal(lowMobile.height, 254);

  const highDesktop = Core.computeCanvasResolution(1280, 720, 2, 'high');
  assert.equal(highDesktop.width, 2560);
  assert.equal(highDesktop.height, 1440);
});

test('normalizeTargetFps and buildWebGLContextOptions enforce mobile-fast defaults', () => {
  assert.equal(Core.normalizeTargetFps(30), 30);
  assert.equal(Core.normalizeTargetFps('60'), 60);
  assert.equal(Core.normalizeTargetFps(0), 0);
  assert.equal(Core.normalizeTargetFps(144), 0);

  const glOpts = Core.buildWebGLContextOptions({ depth: true, antialias: true, alpha: true });
  assert.equal(glOpts.depth, true);
  assert.equal(glOpts.antialias, false);
  assert.equal(glOpts.alpha, false);
  assert.equal(glOpts.desynchronized, true);
  assert.equal(glOpts.preserveDrawingBuffer, false);
  assert.equal(glOpts.powerPreference, 'high-performance');
});

test('build-web.yml includes Clang Full LTO -O3, WASM 2.0, Binaryen wasm-opt, and IDBFS flags', () => {
  const yml = fs.readFileSync(new URL('./.github/workflows/build-web.yml', import.meta.url), 'utf8');
  for (const flag of [
    '-O3',
    '-flto',
    '-Wl,--lto-O3',
    'emar',
    'emranlib',
    '-msimd128',
    '-mbulk-memory',
    '-mnontrapping-fptoint',
    '-ffast-math',
    '-sASSERTIONS=0',
    '-sGL_TRACK_ERRORS=0',
    '-sWASM_BIGINT=1',
    '-sEVAL_CTORS=1',
    '-sINITIAL_MEMORY=134217728',
    '-sALLOW_MEMORY_GROWTH=1',
    '-lidbfs.js',
    'IDBFS',
    'wasm-opt'
  ]) {
    assert.ok(yml.includes(flag), `Expected build-web.yml to include ${flag}`);
  }
});

test('gameshell.cpp and main.cpp wire leak-free rAF pacing, target FPS cap, and PC/gamepad input hooks cleanly', () => {
  const gameshell = fs.readFileSync(new URL('./unixsrc/gameshel/gameshell.cpp', import.meta.url), 'utf8');
  const mainCpp = fs.readFileSync(new URL('./unixsrc/entry/main.cpp', import.meta.url), 'utf8');
  assert.ok(gameshell.includes('dark_web_yield_animation_frame(g_darkWebTargetFps)'), 'EndFrame must pass g_darkWebTargetFps');
  assert.ok(gameshell.includes('clearTimeout(timerId)'), 'Fallback timer must be cleared to prevent timer leaks');
  assert.ok(gameshell.includes('void DarkGameShellSetTargetFps(int targetFps)'), 'gameshell.cpp must export DarkGameShellSetTargetFps');
  assert.ok(gameshell.includes('void DarkGameShellConfigureInput(float mouseSensitivity, int invertY)'), 'gameshell.cpp must export DarkGameShellConfigureInput');
  assert.ok(mainCpp.includes('dark_web_set_target_fps'), 'main.cpp must export dark_web_set_target_fps');
  assert.ok(mainCpp.includes('dark_web_set_input_profile'), 'main.cpp must export dark_web_set_input_profile');
  assert.ok(mainCpp.includes('SDL_HINT_MOUSE_RELATIVE_MODE_WARP'), 'main.cpp must configure raw relative mouse mode');
  assert.ok(mainCpp.includes('SDL_HINT_RENDER_BATCHING'), 'main.cpp must enable SDL render batching hint');
});

test('resolveTouchLayout switches cleanly between buttons, button-free gestures, and PC/gamepad off modes', () => {
  assert.deepEqual({ ...Core.resolveTouchLayout('gestures', false, false) }, {
    mode: 'gestures',
    layout: 'gestures',
    showButtons: false,
    showGestures: true
  });
  assert.deepEqual({ ...Core.resolveTouchLayout('on', false, false) }, {
    mode: 'buttons',
    layout: 'buttons',
    showButtons: true,
    showGestures: false
  });
  assert.deepEqual({ ...Core.resolveTouchLayout('off', true, true) }, {
    mode: 'off',
    layout: 'off',
    showButtons: false,
    showGestures: false
  });
  assert.equal(Core.resolveTouchLayout('auto', true, false).layout, 'buttons');
  assert.equal(Core.resolveTouchLayout('auto', false, false).layout, 'off');
});

test('classifyTouchGesture recognizes all button-free smartphone Thief gestures accurately', () => {
  assert.equal(Core.classifyTouchGesture({ zone: 'left', fingers: 1, dx: 2, dy: 3, durationMs: 90, isDoubleTap: false }).key, 'KeyF');
  assert.equal(Core.classifyTouchGesture({ zone: 'left', fingers: 1, dx: 1, dy: 2, durationMs: 85, isDoubleTap: true }).key, 'KeyX');
  assert.equal(Core.classifyTouchGesture({ zone: 'right', fingers: 1, dx: 0, dy: 4, durationMs: 100, isDoubleTap: false }).mouseButton, 0);
  assert.equal(Core.classifyTouchGesture({ zone: 'right', fingers: 1, dx: 3, dy: 1, durationMs: 90, isDoubleTap: true }).key, 'Space');

  // 2-finger gestures: lean left/right, weapon cycle, map, block/item tap
  assert.equal(Core.classifyTouchGesture({ fingers: 2, dx: -75, dy: 8, durationMs: 180 }).key, 'KeyQ');
  assert.equal(Core.classifyTouchGesture({ fingers: 2, dx: 82, dy: -10, durationMs: 180 }).key, 'KeyE');
  assert.equal(Core.classifyTouchGesture({ fingers: 2, dx: 6, dy: -70, durationMs: 180 }).key, 'BracketLeft');
  assert.equal(Core.classifyTouchGesture({ fingers: 2, dx: -4, dy: 74, durationMs: 180 }).key, 'KeyM');
  assert.equal(Core.classifyTouchGesture({ fingers: 2, dx: 4, dy: 5, durationMs: 140 }).mouseButton, 2);
});

test('mapGamepadState enforces radial deadzone, stealth left-stick bands, right-stick curve + invertY, and Thief bindings', () => {
  // Inside deadzone -> zero drift
  const neutral = Core.mapGamepadState([0.08, -0.09, 0.1, -0.05], [], { deadzone: 0.15, sensitivity: 1.2, invertY: false, dtSec: 1 / 60 });
  assert.equal(neutral.moveMode, 'idle');
  assert.equal(neutral.lookDx, 0);
  assert.equal(neutral.lookDy, 0);

  // Stealth creep + right stick look with Invert Y + triggers + face buttons
  const btns = new Array(16).fill({ pressed: false, value: 0 });
  btns[0] = { pressed: true, value: 1 };  // A -> Space (Jump)
  btns[4] = { pressed: true, value: 1 };  // LB -> KeyQ (Lean L)
  btns[7] = { pressed: true, value: 0.9 }; // RT -> LMB (Attack)
  btns[12] = { pressed: true, value: 1 }; // D-Pad Up -> F5 (Quick Save)

  const active = Core.mapGamepadState([0, -0.35, 0.8, 0.6], btns, { deadzone: 0.15, sensitivity: 1.5, invertY: true, dtSec: 1 / 60 });
  assert.equal(active.moveMode, 'creep');
  assert.equal(active.keys.KeyW, true);
  assert.equal(active.keys.ControlLeft, true);
  assert.equal(active.keys.Space, true);
  assert.equal(active.keys.KeyQ, true);
  assert.equal(active.keys.F5, true);
  assert.equal(active.mouseLeft, true);
  assert.ok(active.lookDx > 0, 'Right stick +X should pan right');
  assert.ok(active.lookDy < 0, 'Invert Y should negate positive right-stick Y');
});



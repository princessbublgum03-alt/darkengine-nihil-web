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
    URLSearchParams,
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

test('normalizeTargetFps and buildWebGLContextOptions enforce black-screen-safe fast WebGL 2 defaults', () => {
  assert.equal(Core.normalizeTargetFps(30), 30);
  assert.equal(Core.normalizeTargetFps('60'), 60);
  assert.equal(Core.normalizeTargetFps(0), 0);
  assert.equal(Core.normalizeTargetFps(144), 0);

  const glOpts = Core.buildWebGLContextOptions({ antialias: true, alpha: true });
  assert.equal(glOpts.depth, true);
  assert.equal(glOpts.stencil, true);
  assert.equal(glOpts.antialias, false);
  assert.equal(glOpts.alpha, false);
  assert.equal(glOpts.desynchronized, false);
  assert.equal(glOpts.preserveDrawingBuffer, false);
  assert.equal(glOpts.powerPreference, 'high-performance');
});

test('computeProgressMetrics calculates speed (MB/s), percentage, and Russian ETA cleanly', () => {
  const half = Core.computeProgressMetrics(50 * 1024 * 1024, 100 * 1024 * 1024, 2000);
  assert.equal(half.pct, 50);
  assert.equal(half.loadedMB, '50.0');
  assert.equal(half.totalMB, '100.0');
  assert.equal(half.speedMBs, 25);
  assert.equal(half.etaSec, 2);
  assert.equal(half.speedLabel, '25.0 МБ/с');
  assert.equal(half.etaLabel, 'Осталось ~2 сек');

  const slowLong = Core.computeProgressMetrics(10 * 1024 * 1024, 200 * 1024 * 1024, 5000);
  assert.equal(slowLong.etaSec, 95);
  assert.equal(slowLong.etaLabel, 'Осталось ~1 мин 35 сек');

  const done = Core.computeProgressMetrics(100 * 1024 * 1024, 100 * 1024 * 1024, 4000);
  assert.equal(done.pct, 100);
  assert.equal(done.etaLabel, 'Готово');
});

test('parseZipFromFile and readZipEntryFromFile stream ZIP slices without reading full archive at once', async () => {
  const zipBuf = buildTestZip([
    { name: 'ThiefGold/dark.cfg', content: 'cd_path .\n', deflate: false },
    { name: 'ThiefGold/RES/snd.crf', content: 'Garrett stealth audio '.repeat(40), deflate: true }
  ]);
  const blob = new Blob([zipBuf]);
  const entries = await Core.parseZipFromFile(blob);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'ThiefGold/dark.cfg');
  assert.equal(entries[1].name, 'ThiefGold/RES/snd.crf');

  const stored = await Core.readZipEntryFromFile(blob, entries[0]);
  assert.equal(Buffer.from(stored).toString('utf8'), 'cd_path .\n');

  const inflated = await Core.readZipEntryFromFile(blob, entries[1]);
  assert.equal(Buffer.from(inflated).toString('utf8'), 'Garrett stealth audio '.repeat(40));
});

test('splitFileForIndexedDB chunks large files into independent ArrayBuffers below Chromium 127 MB IPC limit', () => {
  assert.equal(Core.IDB_CHUNK_BYTES, 16 * 1024 * 1024);

  // Subarray view into a larger backing buffer must be trimmed so IndexedDB does not clone the parent buffer
  const bigParent = new Uint8Array(10000);
  const smallView = bigParent.subarray(100, 356);
  const single = Core.splitFileForIndexedDB('cam.cfg', smallView, 4096);
  assert.equal(single.length, 1);
  assert.equal(single[0].path, 'cam.cfg');
  assert.equal(single[0].data.byteLength, 256);
  assert.equal(single[0].data.buffer.byteLength, 256);

  // Oversized file splits into lexicographically sorted chunks with independent backing ArrayBuffers
  const payload = new Uint8Array(1024 * 10 + 333);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;

  const chunks = Core.splitFileForIndexedDB('res/snd.crf', payload, 4096);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    Array.from(chunks, (c) => c.path),
    ['res/snd.crf#__chunk__0000', 'res/snd.crf#__chunk__0001', 'res/snd.crf#__chunk__0002']
  );

  // Verify every chunk owns a trimmed ArrayBuffer <= chunkSize and reassembles bit-for-bit
  const reassembled = new Uint8Array(payload.length);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i].basePath, 'res/snd.crf');
    assert.equal(chunks[i].chunkIndex, i);
    assert.equal(chunks[i].chunkCount, 3);
    assert.equal(chunks[i].totalSize, payload.length);
    assert.equal(chunks[i].data.buffer.byteLength, chunks[i].data.byteLength);
    assert.ok(chunks[i].data.buffer.byteLength <= 4096);
    reassembled.set(chunks[i].data, offset);
    offset += chunks[i].data.byteLength;
  }
  assert.deepEqual(Buffer.from(reassembled), Buffer.from(payload));
});

test('build-web.yml uses LTO-free -O3 WASM 2.0 flags to avoid Clang C/C++ bool (i8/i1) unreachable traps and keeps ASYNCIFY-safe EVAL_CTORS=0', () => {
  const yml = fs.readFileSync(new URL('./.github/workflows/build-web.yml', import.meta.url), 'utf8');
  for (const flag of [
    '-O3',
    '-fno-strict-aliasing',
    'emar',
    'emranlib',
    '-msimd128',
    '-mbulk-memory',
    '-mnontrapping-fptoint',
    '-fno-math-errno',
    '-fno-trapping-math',
    '-sASSERTIONS=0',
    '-sGL_TRACK_ERRORS=0',
    '-sASYNCIFY',
    '-sASYNCIFY_STACK_SIZE=1048576',
    '-sEVAL_CTORS=0',
    '-sINITIAL_MEMORY=134217728',
    '-sALLOW_MEMORY_GROWTH=1',
    '-lidbfs.js',
    'IDBFS'
  ]) {
    assert.ok(yml.includes(flag), `Expected build-web.yml to include ${flag}`);
  }
  assert.ok(!yml.includes('-flto'), 'Clang -flto causes LLVM IR unreachable traps on C unsigned-char bool vs C++ bool calls');
  assert.ok(!yml.includes('--lto-O3'), '--lto-O3 must not be enabled without LTO');
  assert.ok(!yml.includes('-ffast-math'), '-ffast-math breaks finite/NaN checks in legacy engine physics and scripting');
  assert.ok(!yml.includes('EMULATE_FUNCTION_POINTER_CASTS'), 'EMULATE_FUNCTION_POINTER_CASTS crashes Binaryen wasm-opt (mixed_arena.h SIGABRT) with -O3 + ASYNCIFY');
  assert.ok(!yml.includes('-sEVAL_CTORS=1'), 'EVAL_CTORS=1 conflicts with ASYNCIFY and must not be present');
  assert.ok(!yml.includes('WASM_BIGINT'), 'Deprecated WASM_BIGINT flag must be removed');
});

test('gameshell.cpp, main.cpp, config.c, bmftype.h, fl8dtab.c, and web/index.html prevent black screen, unreachable traps, and function signature mismatches', () => {
  const gameshell = fs.readFileSync(new URL('./unixsrc/gameshel/gameshell.cpp', import.meta.url), 'utf8');
  const mainCpp = fs.readFileSync(new URL('./unixsrc/entry/main.cpp', import.meta.url), 'utf8');
  const configC = fs.readFileSync(new URL('./libsrc/config/config.c', import.meta.url), 'utf8');
  const bmfTypeH = fs.readFileSync(new URL('./libsrc/dev2d/bmftype.h', import.meta.url), 'utf8');
  const fl8DtabC = fs.readFileSync(new URL('./libsrc/dev2d/fl8dtab.c', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');

  assert.ok(gameshell.includes('dark_web_yield_animation_frame(g_darkWebTargetFps)'), 'EndFrame must pass g_darkWebTargetFps');
  assert.ok(gameshell.includes('clearTimeout(timerId)'), 'Fallback timer must be cleared to prevent timer leaks');
  assert.ok(gameshell.includes('__darkFirstFrameRendered'), 'gameshell.cpp must notify JS on first rendered frame');
  assert.ok(gameshell.includes('void DarkGameShellSetTargetFps(int targetFps)'), 'gameshell.cpp must export DarkGameShellSetTargetFps');
  assert.ok(gameshell.includes('void DarkGameShellConfigureInput(float mouseSensitivity, int invertY)'), 'gameshell.cpp must export DarkGameShellConfigureInput');
  assert.ok(mainCpp.includes('dark_web_set_target_fps'), 'main.cpp must export dark_web_set_target_fps');
  assert.ok(mainCpp.includes('dark_web_set_input_profile'), 'main.cpp must export dark_web_set_input_profile');
  assert.ok(mainCpp.includes('SDL_HINT_MOUSE_RELATIVE_MODE_WARP'), 'main.cpp must configure raw relative mouse mode');
  assert.ok(mainCpp.includes('SDL_HINT_RENDER_BATCHING'), 'main.cpp must enable SDL render batching hint');
  assert.ok(mainCpp.includes('DARK_ASSERT_ACTION'), 'main.cpp must set DARK_ASSERT_ACTION=ignore to prevent WASM assert traps');
  assert.ok(mainCpp.includes('std::fflush(stderr)'), 'main.cpp must flush stderr after verbose diagnostics');

  // Guard against UB in config.c and dev2d signature mismatches
  assert.ok(configC.includes('if (buf != NULL && bufsize > 0)'), 'config_get_raw must guard NULL buf before strncpy');
  assert.ok(configC.includes('bool config_get_raw_all_iter(void* elem, void* data)'), 'config_get_raw_all_iter must match HashIterFunc');
  assert.ok(configC.includes('bool config_write_iter(void* elem, void* data)'), 'config_write_iter must match HashIterFunc');
  assert.ok(bmfTypeH.includes('typedef void (gdbm_func)'), 'gdbm_func must return void to match gen_*_bitmap implementations');
  assert.ok(fl8DtabC.includes('flat8_device_table[GDC_INIT_DEVICE] = null_device;'), 'fl8dtab.c must use null_device matching int(grs_sys_info*)');

  // Separate 2D preview canvas so #canvas is never locked out of WebGL 2.0
  assert.ok(html.includes('id="preview-canvas"'), 'Dedicated #preview-canvas must exist');
  assert.ok(!html.includes("canvas.getContext('2d')"), 'Main WebGL #canvas must NEVER be polluted with a 2D context');
  assert.ok(html.includes('FS.chdir(GAMEDATA_DIR)'), 'launchGame must chdir into /gamedata before callMain');
  assert.ok(html.includes("'+skip_starting_checks'"), 'launchGame must pass +skip_starting_checks to callMain');
  assert.ok(html.includes('darkengine-diagnostics.log'), 'launchGame must capture darkengine-diagnostics.log on failure/timeout');
  assert.ok(html.includes('id="bootOverlay"'), 'In-stage boot overlay must exist');
  assert.ok(!html.includes('.getAll()'), 'Blocking IndexedDB getAll() on 1 GB cache must not be used');
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

test('createLogBuffer maintains bounded ring buffer, filters by category/severity, and exports full diagnostic report', () => {
  const buf = Core.createLogBuffer(10);
  for (let i = 0; i < 12; i++) {
    buf.push('debug', 'SYS', 'tick-' + i);
  }
  assert.equal(buf.getEntries('all').length, 10, 'Ring buffer must evict oldest entries beyond capacity');
  assert.equal(buf.getEntries('all')[0].message, 'tick-2');

  buf.clear();
  assert.equal(buf.getEntries('all').length, 0);

  buf.push('info', 'GPU', 'WebGL2 OK', { maxTextureSize: 8192 });
  buf.push('warn', 'WASM', 'thief-runner.js 404');
  buf.push('error', 'ZIP', 'Archive corrupt', new Error('Bad EOCD'));
  buf.push('info', 'FS', 'MEMFS mounted', { files: 42 });

  const counts = { ...buf.countByLevel() };
  assert.deepEqual(counts, { total: 4, errors: 1, warns: 1 });

  assert.deepEqual(Array.from(buf.getEntries('errors'), (e) => e.tag), ['WASM', 'ZIP']);
  assert.deepEqual(Array.from(buf.getEntries('engine'), (e) => e.tag), ['GPU', 'WASM']);
  assert.deepEqual(Array.from(buf.getEntries('fs'), (e) => e.tag), ['ZIP', 'FS']);

  const formatted = buf.formatLine(buf.getEntries('all')[0]);
  assert.match(formatted, /^\[\+\d{2}:\d{2}\.\d{3}\] \[INFO \] \[GPU   \] WebGL2 OK \| \{"maxTextureSize":8192\}$/);

  const report = buf.exportReport({
    url: 'https://example.org/dark/',
    gpu: 'ANGLE / WebGL2',
    cache: '42 файлов · 512.0 МБ'
  });
  assert.ok(report.includes('=== DARK ENGINE WEB DIAGNOSTIC REPORT ==='));
  assert.ok(report.includes('GPU: ANGLE / WebGL2'));
  assert.ok(report.includes('Entries: 4 (errors=1, warns=1)'));
  assert.ok(report.includes('Archive corrupt'));

  const mainCpp = fs.readFileSync(new URL('./unixsrc/entry/main.cpp', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
  assert.ok(mainCpp.includes('dark_web_set_verbose_logging'), 'main.cpp must export dark_web_set_verbose_logging');
  assert.ok(html.includes('id="loggingToggleBtn"'), 'web/index.html must include logging ON/OFF toggle');
  assert.ok(html.includes('id="diagPanel"'), 'web/index.html must include collapsible diagnostic panel');
  assert.ok(html.includes('id="bootCopyLogsBtn"'), 'web/index.html must include copy logs button in boot overlay');
});

test('scaleHiDpiViewportRect scales CSS-space SDL2 viewports to Retina drawingBuffer without double-scaling or mutating FBOs', () => {
  // Android portrait 432x872 @ 2.5x (drawingBuffer 1080x2180): centered 4:3 menu (0, 274, 432, 324)
  assert.deepEqual(
    [...Core.scaleHiDpiViewportRect(0, 274, 432, 324, 432, 872, 1080, 2180, false)],
    [0, 685, 1080, 810]
  );

  // Fullscreen clear in CSS space scales cleanly to full drawingBuffer
  assert.deepEqual(
    [...Core.scaleHiDpiViewportRect(0, 0, 432, 872, 432, 872, 1080, 2180, false)],
    [0, 0, 1080, 2180]
  );

  // Downscaled mobile quality preset (0.5x -> 216x436) scales CSS viewport down cleanly
  assert.deepEqual(
    [...Core.scaleHiDpiViewportRect(0, 274, 432, 324, 432, 872, 216, 436, false)],
    [0, 137, 216, 162]
  );

  // Offscreen FBO rendering must NEVER be scaled
  assert.deepEqual(
    [...Core.scaleHiDpiViewportRect(0, 0, 256, 256, 432, 872, 1080, 2180, true)],
    [0, 0, 256, 256]
  );

  // Already-physical coordinates (> cssW) must NOT be double-scaled
  assert.deepEqual(
    [...Core.scaleHiDpiViewportRect(0, 0, 1080, 2180, 432, 872, 1080, 2180, false)],
    [0, 0, 1080, 2180]
  );

  // 1:1 DPR desktop display passes through untouched
  assert.deepEqual(
    [...Core.scaleHiDpiViewportRect(120, 0, 1200, 900, 1440, 900, 1440, 900, false)],
    [120, 0, 1200, 900]
  );
});

test('input routing, viewport sync, and OpenAL Web Audio runtime are wired end-to-end across C++, CI, and web/index.html', () => {
  const gameshell = fs.readFileSync(new URL('./unixsrc/gameshel/gameshell.cpp', import.meta.url), 'utf8');
  const mainCpp = fs.readFileSync(new URL('./unixsrc/entry/main.cpp', import.meta.url), 'utf8');
  const openalLoader = fs.readFileSync(new URL('./unixsrc/sound/openal_loader.cpp', import.meta.url), 'utf8');
  const yml = fs.readFileSync(new URL('./.github/workflows/build-web.yml', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');

  // 1. Input & viewport sync in gameshell.cpp
  assert.ok(gameshell.includes('#include "../render/runtime.h"'), 'gameshell.cpp must include ../render/runtime.h');
  assert.ok(gameshell.includes('DarkRenderPumpEvents()'), 'DrainSdlEvents must delegate to DarkRenderPumpEvents() so clicks/keys/resize reach Thief');
  assert.ok(gameshell.includes('DarkRenderBeginApplicationFrame()'), 'BeginFrame must call DarkRenderBeginApplicationFrame()');
  assert.ok(gameshell.includes('DarkRenderEndApplicationFrame()'), 'EndFrame must call DarkRenderEndApplicationFrame()');
  assert.ok(gameshell.includes('emscripten_get_element_css_size("#canvas"'), 'gameshell.cpp must sync #canvas CSS dimensions');
  assert.ok(gameshell.includes('SDL_SetWindowSize(win, w, h)'), 'gameshell.cpp must resize SDL window to match CSS viewport');
  assert.ok(gameshell.includes('DarkInputRelativeMouseActive()'), 'gameshell.cpp must publish relative-mouse state to JS');
  assert.ok(mainCpp.includes('SDL_SetHint(SDL_HINT_TOUCH_MOUSE_EVENTS, "0")'), 'main.cpp must disable shifted SDL touch-to-mouse conversion in favor of direct normalized pointer injection');

  // 2. OpenAL Web Audio runtime in openal_loader.cpp + build-web.yml
  assert.ok(yml.includes('-lopenal'), 'build-web.yml must link Emscripten built-in Web Audio OpenAL (-lopenal)');
  assert.ok(openalLoader.includes('#if defined(__EMSCRIPTEN__)'), 'openal_loader.cpp must provide static Emscripten OpenAL bindings');
  assert.ok(openalLoader.includes('EmscriptenAlcCloseDevice'), 'openal_loader.cpp must wrap char ALCboolean cleanly without pointer casts');
  assert.ok(openalLoader.includes('EmscriptenAlcGetProcAddress') && openalLoader.includes('EmscriptenAlGetProcAddress'), 'openal_loader.cpp must stub missing *GetProcAddress symbols');
  assert.ok(openalLoader.includes('dlopen("libopenal.so.1"'), 'openal_loader.cpp must preserve Linux/Android dlopen path');

  // 3. Web launcher HiDPI scaling, Menu cursor mode, and AudioContext unlock
  assert.ok(html.includes('scaleHiDpiViewportRect'), 'web/index.html must scale WebGL2 CSS-space viewport/scissor to drawingBuffer');
  assert.ok(html.includes('id="hudInputModeBtn"'), 'web/index.html must provide a 1-tap Cursor/Gameplay HUD toggle');
  assert.ok(html.includes('window.__onDarkInputModeChange'), 'web/index.html must auto-switch between Menu cursor and Gameplay controls');
  assert.ok(html.includes('unlockDarkAudio'), 'web/index.html must resume suspended Web Audio AudioContexts on user gestures');
});

test('WASM 3D gameplay fixes eliminate uiHandlerProc, MotCompRotCallback, FindVhotLocation, and automap signature mismatches', () => {
  const genBind = fs.readFileSync(new URL('./src/framewrk/gen_bind.cpp', import.meta.url), 'utf8');
  const mvrUtils = fs.readFileSync(new URL('./src/motion/mvrutils.cpp', import.meta.url), 'utf8');
  const corona = fs.readFileSync(new URL('./src/render/corona.cpp', import.meta.url), 'utf8');
  const drkAmap = fs.readFileSync(new URL('./src/dark/drkamap.cpp', import.meta.url), 'utf8');

  assert.ok(
    genBind.includes('static BOOL input_binder_ui_handler(uiEvent *event, Region *region, void *state)'),
    'gen_bind.cpp must wrap 1-arg tBindHandler in a 3-arg uiHandlerProc trampoline'
  );
  assert.ok(
    !genBind.includes('reinterpret_cast<uiHandlerProc>'),
    'gen_bind.cpp must never reinterpret_cast 1-arg tBindHandler to 3-arg uiHandlerProc (traps in WASM call_indirect)'
  );
  assert.ok(
    genBind.includes('uiInstallRegionHandler (g_root, events, input_binder_ui_handler, NULL, &g_cookie);'),
    'InstallIBHandler must register input_binder_ui_handler'
  );
  assert.ok(
    mvrUtils.includes('EXTERN void MotCompRotCallback(mps_motion_info *mi,mps_comp_motion *cm,float frame, quat *data);'),
    'mvrutils.cpp must declare MotCompRotCallback with float frame matching motset.cpp'
  );
  assert.ok(
    corona.includes('extern "C" BOOL FindVhotLocation(mxs_vector *offset, ObjID obj, int vhot);'),
    'corona.cpp must declare FindVhotLocation returning BOOL matching litprop.cpp'
  );
  assert.ok(
    drkAmap.includes('{ "automap", FUNC_VOID, do_automap,'),
    'drkamap.cpp must register 0-arg do_automap as FUNC_VOID instead of FUNC_STRING'
  );
});

test('single-threaded Emscripten sound mixer avoids std::thread abort() in SndStartPeriodicTimer and cMixerThread::Create', () => {
  const sndPlatform = fs.readFileSync(new URL('./unixsrc/sound/platform.cpp', import.meta.url), 'utf8');
  const sndMixer = fs.readFileSync(new URL('./libsrc/sound/mixer.cpp', import.meta.url), 'utf8');

  assert.ok(
    sndPlatform.includes('#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)'),
    'unixsrc/sound/platform.cpp must guard std::thread behind !defined(__EMSCRIPTEN_PTHREADS__)'
  );
  assert.ok(
    /SndStartPeriodicTimer[\s\S]*?#if defined\(__EMSCRIPTEN__\) && !defined\(__EMSCRIPTEN_PTHREADS__\)[\s\S]*?return 0;/.test(sndPlatform),
    'SndStartPeriodicTimer must return 0 in single-threaded Emscripten so cSndMixer::Update runs fades on main thread'
  );
  assert.ok(
    /cMixerThread::Create\(void\)[\s\S]*?#if defined\(__EMSCRIPTEN__\) && !defined\(__EMSCRIPTEN_PTHREADS__\)[\s\S]*?return false;/.test(sndMixer),
    'cMixerThread::Create must return false without calling std::thread under single-threaded Emscripten'
  );
});

test('adaptive native-aspect 3D, direct touch look injection, and safe re-launch/IDBFS gating work across phones, tablets, and PCs', () => {
  // 1. Adaptive display mode defaults and viewport math
  assert.equal(Core.normalizeDisplayFit(undefined), 'adaptive');
  assert.equal(Core.normalizeDisplayFit('adaptive'), 'adaptive');
  assert.equal(Core.normalizeDisplayFit('stretch'), 'stretch');
  assert.equal(Core.normalizeDisplayFit('fit'), 'fit');
  assert.equal(Core.normalizeDisplayFit('unknown'), 'adaptive');

  // Native-aspect 3D logical resolution preserves exact proportions across all devices
  assert.deepEqual({ ...Core.computeAdaptiveLogicalSize(432, 872) }, { width: 480, height: 968 });
  assert.deepEqual({ ...Core.computeAdaptiveLogicalSize(872, 432) }, { width: 872, height: 432 });
  assert.deepEqual({ ...Core.computeAdaptiveLogicalSize(1024, 768) }, { width: 1024, height: 768 });
  assert.deepEqual({ ...Core.computeAdaptiveLogicalSize(1920, 1080) }, { width: 1600, height: 900 });
  assert.deepEqual({ ...Core.computeAdaptiveLogicalSize(2560, 1080) }, { width: 1600, height: 674 });

  // Adaptive mode fills 100% in 3D without black bars AND keeps 2D menus undistorted
  assert.deepEqual({ ...Core.computeDisplayViewportRect(1920, 1080, 1600, 900, 'adaptive', true) }, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual({ ...Core.computeDisplayViewportRect(432, 872, 480, 968, 'adaptive', true) }, { x: 0, y: 0, width: 432, height: 872 });
  assert.deepEqual({ ...Core.computeDisplayViewportRect(1920, 1080, 640, 480, 'adaptive', false) }, { x: 240, y: 0, width: 1440, height: 1080 });

  // Stretch mode fills 100% even for 2D menus; classic 4:3 preserves 4:3
  assert.deepEqual({ ...Core.computeDisplayViewportRect(432, 872, 640, 480, 'stretch', false) }, { x: 0, y: 0, width: 432, height: 872 });
  assert.deepEqual({ ...Core.computeDisplayViewportRect(1920, 1080, 640, 480, 'fit', true) }, { x: 240, y: 0, width: 1440, height: 1080 });

  // 2. Touch camera look gain & flick acceleration
  assert.deepEqual({ ...Core.computeTouchLookDelta(0, 0, 1.2, false) }, { dx: 0, dy: 0 });
  const slowLook = Core.computeTouchLookDelta(10, 0, 1.2, false);
  assert.ok(slowLook.dx > 30, 'Touch camera turn must scale smoothly for mobile Dark Engine counts');
  const fastLook = Core.computeTouchLookDelta(40, -10, 1.2, true);
  assert.ok(fastLook.dx > slowLook.dx * 4, 'Fast thumb flick should accelerate smoothly for 180-degree turns');
  assert.ok(fastLook.dy > 0, 'invertY must negate vertical touch drag');

  // 3. Safe re-launch state machine (never calls Emscripten callMain twice)
  assert.deepEqual({ ...Core.resolveLaunchButtonState({ wasmState: 'ready', cachedFiles: 10, wasmLaunched: false, wasmTerminated: false }) }, {
    label: 'Запустить Thief',
    action: 'launch',
    showRestart: false
  });
  assert.deepEqual({ ...Core.resolveLaunchButtonState({ wasmState: 'ready', cachedFiles: 10, wasmLaunched: true, wasmTerminated: false }) }, {
    label: 'Продолжить Thief',
    action: 'resume',
    showRestart: true
  });
  assert.deepEqual({ ...Core.resolveLaunchButtonState({ wasmState: 'ready', cachedFiles: 10, wasmLaunched: true, wasmTerminated: true }) }, {
    label: 'Запустить Thief',
    action: 'reload-launch',
    showRestart: false
  });

  // 4. End-to-end C/C++ + HTML contract verification
  const gamemodeC = fs.readFileSync(new URL('./src/framewrk/gamemode.c', import.meta.url), 'utf8');
  const openglCpp = fs.readFileSync(new URL('./unixsrc/render/opengl.cpp', import.meta.url), 'utf8');
  const mainCpp = fs.readFileSync(new URL('./unixsrc/entry/main.cpp', import.meta.url), 'utf8');
  const gameshellCpp = fs.readFileSync(new URL('./unixsrc/gameshel/gameshell.cpp', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');

  assert.ok(gamemodeC.includes('RenderBackendAdaptiveAspect()'), 'gamemode.c must enable adaptive native-aspect 3D resolution on Emscripten');
  assert.ok(openglCpp.includes('bool g_adaptiveAspect = true;'), 'opengl.cpp must default g_adaptiveAspect to true under Emscripten');
  assert.ok(openglCpp.includes('void RenderBackendInjectRelativeLook(int dx, int dy)'), 'opengl.cpp must export RenderBackendInjectRelativeLook');
  assert.ok(openglCpp.includes('DarkInputMouseRelative(dx, dy, g_buttons);'), 'RenderBackendInjectRelativeLook must feed DarkInputMouseRelative directly without Pointer Lock');
  assert.ok(mainCpp.includes('dark_web_inject_look'), 'main.cpp must export dark_web_inject_look');
  assert.ok(mainCpp.includes('dark_web_set_adaptive_aspect'), 'main.cpp must export dark_web_set_adaptive_aspect');
  assert.ok(mainCpp.includes('__onDarkEngineExited'), 'main.cpp must notify JS when main() exits');
  assert.ok(gameshellCpp.includes('window.__darkEnginePaused'), 'gameshell.cpp must pause cleanly while user is in launcher');
  assert.ok(html.includes("if (appState.wasmState !== 'ready') return;"), 'mountSavesIdbfsIfAvailable must wait for WASM runtime initialization before IDBFS syncfs');
  assert.ok(html.includes('window.__darkWebInputQueue'), 'dispatchMouseLook must enqueue relative camera turns onto Asyncify-safe __darkWebInputQueue');
  assert.ok(html.includes('id="relaunchBtn"'), 'web/index.html must include clean restart button when paused in launcher');
  assert.ok(html.includes('data-display-fit="adaptive"'), 'web/index.html must expose Adaptive / Stretch / 4:3 display selector');
});

test('mobile controls align with zero offset, enqueue Asyncify-safe input into C++, and fullscreen toggles #game-stage cleanly', () => {
  // 1. Normalized canvas pointer math stays 100% invariant to HiDPI DPR & quality scale
  const rect = { left: 10, top: 20, width: 432, height: 872 };
  const center = Core.computeNormalizedCanvasPoint(10 + 216, 20 + 436, rect);
  assert.deepEqual({ ...center }, { normX: 0.5, normY: 0.5, inside: true });
  const clamped = Core.computeNormalizedCanvasPoint(-50, 1200, rect);
  assert.deepEqual({ ...clamped }, { normX: 0, normY: 1, inside: false });

  // 2. Floating joystick visual center ALWAYS equals its touch input origin (0px shift)
  const narrowZone = { left: 0, top: 270, width: 179, height: 574 };
  const edgeTouch = Core.computeJoystickOrigin(18, 790, narrowZone, 128);
  assert.equal(edgeTouch.originX, narrowZone.left + edgeTouch.baseLeft + 64);
  assert.equal(edgeTouch.originY, narrowZone.top + narrowZone.height - edgeTouch.baseBottom - 64);

  const landscapeZone = { left: 0, top: 96, width: 354, height: 294 };
  const landTouch = Core.computeJoystickOrigin(140, 260, landscapeZone, 104);
  assert.equal(landTouch.originX, landscapeZone.left + landTouch.baseLeft + 52);
  assert.equal(landTouch.originY, landscapeZone.top + landscapeZone.height - landTouch.baseBottom - 52);

  // 3. C++ + HTML contracts for fullscreen ownership & Asyncify-safe direct input
  const openglCpp = fs.readFileSync(new URL('./unixsrc/render/opengl.cpp', import.meta.url), 'utf8');
  const gameshellCpp = fs.readFileSync(new URL('./unixsrc/gameshel/gameshell.cpp', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');

  assert.ok(openglCpp.includes('#if !defined(__EMSCRIPTEN__)\n   windowFlags |= SDL_WINDOW_ALLOW_HIGHDPI;'), 'opengl.cpp must omit SDL_WINDOW_ALLOW_HIGHDPI on Emscripten to prevent DPR mouse drift');
  assert.ok(openglCpp.includes('Never call SDL_SetWindowFullscreen() here'), 'DarkRenderSetFullscreen must not hijack #canvas-only browser fullscreen');
  assert.ok(openglCpp.includes('void RenderBackendInjectKey(int sdlScancode, int down)'), 'opengl.cpp must export RenderBackendInjectKey');
  assert.ok(openglCpp.includes('void RenderBackendInjectMouseButton(int button, int down)'), 'opengl.cpp must export RenderBackendInjectMouseButton');
  assert.ok(openglCpp.includes('void RenderBackendInjectPointer(float normX, float normY, int action, int button)'), 'opengl.cpp must export RenderBackendInjectPointer');
  assert.ok(openglCpp.includes('window.__darkWebInputQueue'), 'DarkRenderPumpMovieEvents must check __darkWebInputQueue so mobile taps skip intro movies');
  assert.ok(gameshellCpp.includes('void cUnixGameShell::DrainWebInputQueue()'), 'gameshell.cpp must drain __darkWebInputQueue synchronously on the active C++ stack');
  assert.ok(gameshellCpp.includes('void cUnixGameShell::SyncWebConfigFromJs()'), 'gameshell.cpp must pull __darkWebConfig synchronously without runtime ccall');
  assert.ok(html.includes('id="hudFullscreenBtn"') && html.includes('id="drawerFullscreenBtn"'), 'web/index.html must expose fullscreen enter/exit controls in HUD and drawer');
  assert.ok(html.includes('exitBrowserFullscreen();'), 'exitToLauncher must exit browser fullscreen cleanly');
});

test('Asyncify-safe JS->C++ input queue maps scancodes, coalesces high-rate events, and forbids runtime Module.ccall after callMain', () => {
  // 1. Standard USB HID SDL_Scancode mapping
  assert.equal(Core.mapKeyCodeToSdlScancode('KeyW'), 26);
  assert.equal(Core.mapKeyCodeToSdlScancode('KeyA'), 4);
  assert.equal(Core.mapKeyCodeToSdlScancode('KeyS'), 22);
  assert.equal(Core.mapKeyCodeToSdlScancode('KeyD'), 7);
  assert.equal(Core.mapKeyCodeToSdlScancode('Space'), 44);
  assert.equal(Core.mapKeyCodeToSdlScancode('Escape'), 41);
  assert.equal(Core.mapKeyCodeToSdlScancode('ShiftLeft'), 225);
  assert.equal(Core.mapKeyCodeToSdlScancode('ControlLeft'), 224);
  assert.equal(Core.mapKeyCodeToSdlScancode('F5'), 62);
  assert.equal(Core.mapKeyCodeToSdlScancode('F9'), 66);
  assert.equal(Core.mapKeyCodeToSdlScancode('UnknownKey'), 0);

  // 2. Coalescing consecutive look deltas and pointer moves while preserving click edges
  const q = [];
  Core.enqueueWebInputEvent(q, [4, 0, 0, 12.5, -3.25]);
  Core.enqueueWebInputEvent(q, [4, 0, 0, 7.5, 1.25]);
  assert.equal(q.length, 1);
  assert.deepEqual([...q[0]], [4, 0, 0, 20, -2]);

  Core.enqueueWebInputEvent(q, [3, 1, 0, 0.25, 0.5]); // pointerdown
  Core.enqueueWebInputEvent(q, [3, 0, 0, 0.30, 0.52]); // pointermove 1
  Core.enqueueWebInputEvent(q, [3, 0, 0, 0.40, 0.60]); // pointermove 2 (coalesced)
  Core.enqueueWebInputEvent(q, [3, 2, 0, 0.40, 0.60]); // pointerup
  assert.equal(q.length, 4);
  assert.deepEqual([...q[1]], [3, 1, 0, 0.25, 0.5]);
  assert.deepEqual([...q[2]], [3, 0, 0, 0.40, 0.60]);
  assert.deepEqual([...q[3]], [3, 2, 0, 0.40, 0.60]);

  // 3. Bounded capacity prevents unbounded growth
  const smallQ = [];
  for (let i = 0; i < 30; i++) {
    Core.enqueueWebInputEvent(smallQ, [1, 26, i % 2, 0, 0], 16);
  }
  assert.equal(smallQ.length, 16);

  // 4. Hard regression guard: web/index.html must NEVER call runtime ccall('dark_web_inject_*') or ccall('dark_web_sync_saves')
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes("ccall('dark_web_inject_"), 'web/index.html must NEVER call Module.ccall(dark_web_inject_*) while Asyncify is suspended');
  assert.ok(!html.includes("'dark_web_inject_pointer'"), 'web/index.html must NEVER call dark_web_inject_pointer via ccall (causes doRewind memory access out of bounds)');
  assert.ok(!html.includes("ccall('dark_web_sync_saves'"), 'web/index.html must use direct Module.FS.syncfs(false) instead of runtime ccall(dark_web_sync_saves)');
  assert.ok(html.includes('window.Module.FS.syncfs(false'), 'syncSavesDirectToIdbfs must call Module.FS.syncfs(false) directly');
  assert.ok(html.includes('if (!appState.wasmLaunched && window.Module && typeof window.Module.ccall'), 'Config ccall hooks must be gated on !appState.wasmLaunched');
});

test('3D mobile camera look turns cleanly both left and right without absolute-cursor right-half leakage or repeated-delta drops', () => {
  // 1. Touch look delta math must be strictly symmetric with opposite signs for left vs right drags
  const leftSlow = Core.computeTouchLookDelta(-10, 0, 1.2, false);
  const rightSlow = Core.computeTouchLookDelta(10, 0, 1.2, false);
  assert.ok(leftSlow.dx < -30, 'Dragging left on right lookZone must produce strongly negative dx');
  assert.ok(rightSlow.dx > 30, 'Dragging right on right lookZone must produce strongly positive dx');
  assert.equal(leftSlow.dx, -rightSlow.dx, 'Left and right turn speeds must be exact mirror opposites');

  const leftFast = Core.computeTouchLookDelta(-40, 12, 1.2, false);
  const rightFast = Core.computeTouchLookDelta(40, -12, 1.2, false);
  assert.equal(leftFast.dx, -rightFast.dx, 'Fast left and right flicks must accelerate symmetrically');
  assert.equal(leftFast.dy, -rightFast.dy, 'Vertical look deltas must preserve opposite signs');

  // 2. Coalescing left swipes in __darkWebInputQueue preserves exact negative sum
  const q = [];
  Core.enqueueWebInputEvent(q, [4, 0, 0, leftSlow.dx, 0]);
  Core.enqueueWebInputEvent(q, [4, 0, 0, leftSlow.dx, 0]);
  assert.equal(q.length, 1);
  assert.ok(q[0][3] < -60, 'Coalesced left swipes must stay negative');
  assert.equal(q[0][3], leftSlow.dx * 2);

  // 3. C++ + HTML regression guards preventing right-half absolute mouse fallback and right-edge cursor clamping
  const openglCpp = fs.readFileSync(new URL('./unixsrc/render/opengl.cpp', import.meta.url), 'utf8');
  const ibmapperCpp = fs.readFileSync(new URL('./libsrc/inputbnd/ibmapper.cpp', import.meta.url), 'utf8');
  const ibvarmanCpp = fs.readFileSync(new URL('./libsrc/inputbnd/ibvarman.cpp', import.meta.url), 'utf8');
  const gamemodeC = fs.readFileSync(new URL('./src/framewrk/gamemode.c', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');

  assert.ok(openglCpp.includes('SDL_SetHint("SDL_TOUCH_MOUSE_EVENTS", "0");'), 'opengl.cpp must disable SDL2 touch->mouse synthesis under Emscripten');
  assert.ok(openglCpp.includes('else if (!g_relativeMouse)'), 'opengl.cpp must ignore absolute SDL_MOUSEMOTION while g_relativeMouse is active under Emscripten');
  assert.ok(/RenderBackendInjectPointer[\s\S]*?#if defined\(__EMSCRIPTEN__\)[\s\S]*?if \(g_relativeMouse\)[\s\S]*?return;/.test(openglCpp), 'RenderBackendInjectPointer must refuse absolute pointer events during 3D gameplay');
  assert.ok(/DarkRenderSetMousePosition[\s\S]*?\|\| g_relativeMouse/.test(openglCpp), 'DarkRenderSetMousePosition must skip SDL_WarpMouseInWindow during 3D gameplay on Emscripten');
  assert.ok(/if \(DarkInputRelativeMouseActive\(\)\)[\s\S]*?mouse_put_xy\(res_x >> 1, res_y >> 1\);[\s\S]*?return 1;/.test(ibmapperCpp), 'ibmapper.cpp must recenter and never fall back to absolute (x - res_x/2) offset during Emscripten 3D gameplay');
  assert.ok(/else if \(DarkInputRelativeMouseActive\(\)\)[\s\S]*?mouse_put_xy\(res_x >> 1, res_y >> 1\);/.test(ibmapperCpp), 'ibmapper.cpp must recenter internal cursor after consuming relative motion so right-edge clamping cannot block +dx turns');
  assert.ok(/mouse_set_relative_mode\(TRUE\);[\s\S]*?#ifdef __EMSCRIPTEN__[\s\S]*?mouse_put_xy\(grd_canvas->bm\.w >> 1, grd_canvas->bm\.h >> 1\);/.test(gamemodeC), 'gamemode.c must recenter internal cursor on entering 3D mode after 2D menu taps or portrait resize');
  assert.ok(ibvarmanCpp.includes('const bool repeat_relative_axis ='), 'ibvarman.cpp must not deduplicate repeated non-zero mturn/mlook deltas under Emscripten');
  assert.ok(html.includes("if (effectiveMode !== 'menu')"), 'onCanvasPointerDown must gate injectDirectCanvasPointer strictly to 2D menu mode');
  assert.ok(html.includes("lookZone.addEventListener('touchstart', blockNativeTouchLeak, { passive: false })"), 'lookZone must block native touch leakage to Emscripten SDL2');
  assert.ok(html.includes("lookZone.addEventListener('lostpointercapture', endLook);"), 'lookZone must release lookPointerId cleanly if browser steals capture at screen edge');
  assert.ok(/\.touch-zone-right\s*\{[\s\S]*?width:\s*auto;[\s\S]*?z-index:\s*60;[\s\S]*?overscroll-behavior:\s*none;/.test(html), 'lookZone must span full non-joystick width with overscroll-behavior: none for unobstructed right/left swipes');
});

test('separate Input Controls Log buffer tracks Touch, Gestures, HUD, PC, Gamepad, and Engine independently from system logs, and README describes DarkEngine Nihil Web', () => {
  const inputBuf = Core.createInputLogBuffer(12);
  inputBuf.push('TOUCH', 'Обзор старт', { x: 220, y: 310 });
  inputBuf.push('GESTURE', 'Жест: ПРЫЖОК', { key: 'Space' });
  inputBuf.push('HUD', 'Кнопка «Удар» нажата', { mouse: 0 });
  inputBuf.push('PC', 'Клавиша KeyW нажата', { key: 'w' });
  inputBuf.push('GAMEPAD', 'Геймпад подключён', { id: 'Xbox Wireless' });
  inputBuf.push('ENGINE', '[web][look] rel count=4 sum=(+40,0)');

  const counts = inputBuf.countBySource();
  assert.deepEqual({ ...counts }, { total: 6, touch: 3, pc: 1, gamepad: 1, engine: 1 });
  assert.equal(inputBuf.getEntries('all').length, 6);
  assert.equal(inputBuf.getEntries('touch').length, 3);
  assert.equal(inputBuf.getEntries('pc').length, 1);
  assert.equal(inputBuf.getEntries('gamepad').length, 1);
  assert.equal(inputBuf.getEntries('engine').length, 1);

  const report = inputBuf.exportReport({
    viewport: '432x872 @2.50x',
    inputMode: 'gameplay',
    touchLayout: 'buttons',
    sensitivity: '1.2x',
    deadzone: '15%',
    invertY: 'off',
    rawMouse: 'on',
    pointerLocked: 'no',
    gamepad: 'Xbox Wireless'
  });
  assert.ok(report.includes('=== DARK ENGINE WEB INPUT LOG REPORT ==='));
  assert.ok(report.includes('Entries: 6 (touch=3, pc=1, gamepad=1, engine=1)'));
  assert.ok(report.includes('[TOUCH  ] Обзор старт'));
  assert.ok(report.includes('[PC     ] Клавиша KeyW нажата'));
  assert.ok(report.includes('[GAMEPAD] Геймпад подключён'));

  // Ring-buffer cap enforcement
  for (let i = 0; i < 20; i++) inputBuf.push('PC', 'evt-' + i);
  assert.equal(inputBuf.getEntries('all').length, 12);
  inputBuf.clear();
  assert.equal(inputBuf.getEntries('all').length, 0);

  // Strict UI & runtime separation in web/index.html
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
  assert.ok(html.includes('id="inputLoggingToggleBtn"'), 'Launcher must have separate Input Logs toggle');
  assert.ok(html.includes('id="inputLogPanel"'), 'Launcher must have separate Input Logs panel');
  assert.ok(html.includes('id="hudInputLoggingBtn"'), 'In-game HUD drawer must have separate Input Logs toggle');
  assert.ok(html.includes('id="hudCopyInputLogsBtn"'), 'In-game HUD drawer must allow copying Input Logs directly');
  assert.ok(html.includes('id="hudDownloadInputLogsBtn"'), 'In-game HUD drawer must allow downloading Input Logs directly');
  assert.ok(html.includes("dark-engine-input-"), 'Input Logs download must use distinct filename prefix');
  assert.ok(!html.includes('logEvent('), 'Must not contain undefined logEvent() calls');

  // Minimalist centered README.md check
  const readme = fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('<div align="center">'), 'README must be centered');
  assert.ok(readme.includes('# DarkEngine Nihil Web'), 'README must name DarkEngine Nihil Web');
  assert.ok(readme.includes('Логи управления'), 'README must mention separate input logs');
});

test('WASM -mnontrapping-fptoint negative float->unsigned angle saturation is prevented across mxangs.h, fix.h, MTurnProc, and build-web.yml', async () => {
  const { execFileSync } = await import('node:child_process');

  // 1. mxangs.h must route EVERY float->mxs_ang cast through signed (int)
  const mxangs = fs.readFileSync(new URL('./libsrc/matrix/mxangs.h', import.meta.url), 'utf8');
  const unpatchedMxAngs = mxangs.match(/\(mxs_ang\)\s*(?!\(int\))\(/g);
  assert.equal(unpatchedMxAngs, null, 'mxangs.h must have zero direct (mxs_ang)(...) casts without (int)');
  assert.ok(mxangs.includes('tz=(mxs_ang)(int)(_r.z*(MX_ANG_PI/180.0f));'), 'sMxAngVec::SetDeg must wrap through (int)');
  assert.ok(mxangs.includes('tz=(mxs_ang)(int)(_r.z*(MX_ANG_PI/(float)MX_REAL_PI));'), 'sMxAngVec(sMxRadVec) and Set(sMxRadVec) must wrap through (int)');
  assert.ok(mxangs.includes('(mxs_ang)(int)(tz*s)'), 'sMxAngVec scalar multiply must wrap through (int)');
  assert.ok(mxangs.includes('(mxs_ang)(int)(tz/s)'), 'sMxAngVec scalar divide must wrap through (int)');

  // 2. fix.h degrees_to_fixang must cast through signed (int)
  const fixH = fs.readFileSync(new URL('./libsrc/fix/fix.h', import.meta.url), 'utf8');
  assert.ok(
    fixH.includes('#define degrees_to_fixang(d)    ((fixang)(int)(((d)*FIXANG_PI)/180))'),
    'degrees_to_fixang must cast through (int) before (fixang)'
  );

  // 3. MTurnProc verbose telemetry + Input Controls Log routing
  const genBind = fs.readFileSync(new URL('./src/framewrk/gen_bind.cpp', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
  assert.ok(genBind.includes('[web][mturn] count=%d'), 'MTurnProc must emit throttled [web][mturn] telemetry under __EMSCRIPTEN__');
  assert.ok(html.includes('/^\\[web\\]\\[(look|input|mturn)\\]/i'), 'web/index.html must route [web][mturn] into Input Controls Log');

  // 4. Extract and test the actual Python patch_line() from build-web.yml on tricky C/C++ cases
  const yml = fs.readFileSync(new URL('./.github/workflows/build-web.yml', import.meta.url), 'utf8');
  const pyMatch = yml.match(/python3 - <<'PY'\n([\s\S]*?)\n\s+PY\b/);
  assert.ok(pyMatch, 'build-web.yml must include the Python WASM angle-wrap portability step');
  const rawPy = pyMatch[1];
  const indent = rawPy.match(/^(\s*)/)[1].length;
  const dedentedPy = rawPy
    .split('\n')
    .map((line) => line.slice(Math.min(indent, line.match(/^(\s*)/)[1].length)))
    .join('\n');
  const defsOnly = dedentedPy.split('total_files = 0')[0];

  const pyTestHarness = `${defsOnly}
assert patch_line('   ang = (mxs_ang)(-dx * 10.0f);\\n', False, False, set()) == '   ang = (mxs_ang)(int)(-dx * 10.0f);\\n'
assert patch_line('   return (fixang)(-deg);\\n', False, False, set()) == '   return (fixang)(int)(-deg);\\n'
assert patch_line('   a = static_cast<mxs_ang>(-delta * 100.0f); // yaw\\n', False, False, set()) == '   a = static_cast<mxs_ang>(static_cast<int>(-delta * 100.0f)); // yaw\\n'
assert patch_line('   fac.tz -= delta_f;\\n', True, True, set()) == '   fac.tz = (unsigned short)((int)(fac.tz) - (int)(delta_f));\\n'
assert patch_line('   cam->fac.tz += -delta_f; // right turn\\n', True, True, set()) == '   cam->fac.tz = (unsigned short)((int)(cam->fac.tz) + (int)(-delta_f)); // right turn\\n'
assert patch_line('   mxs_ang d = -rel_x * scale;\\n', True, True, {'d'}) == '   mxs_ang d = (mxs_ang)(int)(-rel_x * scale);\\n'
assert patch_line('   d -= rel_x * scale;\\n', True, True, {'d'}) == '   d = (unsigned short)((int)(d) - (int)(rel_x * scale));\\n'
assert patch_line('   size_t n = sizeof(mxs_ang);\\n', True, True, set()) == '   size_t n = sizeof(mxs_ang);\\n'
assert patch_line('   mxs_ang *p = (mxs_ang *)buf;\\n', True, True, set()) == '   mxs_ang *p = (mxs_ang *)buf;\\n'
assert patch_line('   void foo (mxs_ang) const;\\n', True, True, set()) == '   void foo (mxs_ang) const;\\n'
assert patch_line('   tz = (mxs_ang)(int)(-x);\\n', True, True, set()) == '   tz = (mxs_ang)(int)(-x);\\n'
assert patch_line('   // (mxs_ang)(-dx)\\n', True, True, set()) == '   // (mxs_ang)(-dx)\\n'
assert patch_line('   tx = (ushort)(-dx);\\n', True, True, set()) == '   tx = (ushort)(int)(-dx);\\n'
print('PY_OK')
`;
  const pyOut = execFileSync('python3', ['-c', pyTestHarness], { encoding: 'utf8' });
  assert.equal(pyOut.trim(), 'PY_OK');
});









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
    '-sEMULATE_FUNCTION_POINTER_CASTS=1',
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
  assert.ok(!yml.includes('-sEVAL_CTORS=1'), 'EVAL_CTORS=1 conflicts with ASYNCIFY and must not be present');
  assert.ok(!yml.includes('WASM_BIGINT'), 'Deprecated WASM_BIGINT flag must be removed');
});

test('gameshell.cpp, main.cpp, config.c, bmftype.h, and web/index.html prevent black screen, unreachable traps, and function signature mismatches', () => {
  const gameshell = fs.readFileSync(new URL('./unixsrc/gameshel/gameshell.cpp', import.meta.url), 'utf8');
  const mainCpp = fs.readFileSync(new URL('./unixsrc/entry/main.cpp', import.meta.url), 'utf8');
  const configC = fs.readFileSync(new URL('./libsrc/config/config.c', import.meta.url), 'utf8');
  const bmfTypeH = fs.readFileSync(new URL('./libsrc/dev2d/bmftype.h', import.meta.url), 'utf8');
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

  // Guard against UB in config.c and dev2d/bmftype.h
  assert.ok(configC.includes('if (buf != NULL && bufsize > 0)'), 'config_get_raw must guard NULL buf before strncpy');
  assert.ok(configC.includes('bool config_get_raw_all_iter(void* elem, void* data)'), 'config_get_raw_all_iter must match HashIterFunc');
  assert.ok(configC.includes('bool config_write_iter(void* elem, void* data)'), 'config_write_iter must match HashIterFunc');
  assert.ok(bmfTypeH.includes('typedef void (gdbm_func)'), 'gdbm_func must return void to match gen_*_bitmap implementations');

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

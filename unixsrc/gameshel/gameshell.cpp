// Dark Engine Unix / SDL2 / Emscripten Game Shell implementation.
// Implements IGameShell with VSync-aligned frame yielding under Emscripten to
// eliminate Asyncify micro-stutters and maintain smooth 60 FPS on mobile & PC.

#include <lg.h>
#include <comtools.h>
#include <aggmemb.h>
#include <appagg.h>
#include <appapi.h>
#include <dispapi.h>
#include <gshelapi.h>
#include <pumpenum.h>
#include <prikind.h>
#include <platform_services.h>
#include <render_backend.h>
#include <gamepad.h>
#include <kb.h>
#include <mouse.h>
#include "../render/runtime.h"

#include <stdlib.h>
#include <string.h>

extern "C" int DarkInputRelativeMouseActive(void);

#if defined(__has_include)
#if __has_include(<SDL2/SDL.h>)
#include <SDL2/SDL.h>
#else
#include <SDL.h>
#endif
#else
#include <SDL.h>
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/html5.h>

extern "C" {
void RenderBackendSetAdaptiveAspect(int enabled);
void RenderBackendSetStretchToFill(int enabled);
void RenderBackendInjectRelativeLook(int dx, int dy);
void RenderBackendInjectKey(int sdlScancode, int down);
void RenderBackendInjectMouseButton(int button, int down);
void RenderBackendInjectPointer(float normX, float normY, int action, int button);
void DarkWebDispatchGameAction(int actionId, int down);

static int g_darkWebTargetFps = 0; // 0 = native VSync (60/120Hz), 30 or 60 = paced cap
static float g_darkWebMouseSens = 1.0f;
static int g_darkWebInvertY = 0;

void DarkGameShellSetTargetFps(int targetFps)
{
    if (targetFps == 30 || targetFps == 60)
        g_darkWebTargetFps = targetFps;
    else
        g_darkWebTargetFps = 0;
}

void DarkGameShellConfigureInput(float mouseSensitivity, int invertY)
{
    if (mouseSensitivity < 0.25f)
        mouseSensitivity = 0.25f;
    if (mouseSensitivity > 4.0f)
        mouseSensitivity = 4.0f;
    g_darkWebMouseSens = mouseSensitivity;
    g_darkWebInvertY = invertY ? 1 : 0;
}
}

// Notify JS whenever Dark Engine toggles between 2D Menu cursor mode (0) and
// 3D First-Person relative mouse mode (1) so the launcher switches touch HUDs.
EM_JS(void, dark_web_publish_input_mode, (int relativeActive), {
    var active = relativeActive !== 0;
    if (window.__darkRelativeMouseActive !== active) {
        window.__darkRelativeMouseActive = active;
        if (typeof window.__onDarkInputModeChange === 'function') {
            try { window.__onDarkInputModeChange(active); } catch (_) {}
        }
    }
});

// Notify JS after SDL_SetWindowSize resets the canvas drawingBuffer size so the
// launcher immediately re-applies the active HiDPI / quality resolution scale.
EM_JS(void, dark_web_notify_canvas_resized, (int cssW, int cssH), {
    if (typeof window.__onDarkCanvasResized === 'function') {
        try { window.__onDarkCanvasResized(cssW, cssH); } catch (_) {}
    }
});

// Asyncify-safe scalar-only JS->C++ pull helpers.
// Calling Module.ccall() from DOM/touch/HUD handlers while Asyncify is
// suspended inside dark_web_yield_animation_frame corrupts the Asyncify
// rewind stack (memory access out of bounds in Object.doRewind). Instead, JS
// appends events to window.__darkWebInputQueue and updates
// window.__darkWebConfig, and C++ pulls them synchronously here on its own
// active stack inside cUnixGameShell::DrainSdlEvents().
EM_JS(int, dark_web_pop_input_event_type, (), {
    var q = window.__darkWebInputQueue;
    if (!q || q.length === 0) {
        window.__darkWebInputHead = 0;
        window.__darkWebCurEvent = null;
        return 0;
    }
    var head = window.__darkWebInputHead | 0;
    if (head < 0 || head >= q.length) {
        q.length = 0;
        window.__darkWebInputHead = 0;
        window.__darkWebCurEvent = null;
        return 0;
    }
    var ev = q[head];
    q[head] = null;
    head += 1;
    if (head >= q.length) {
        q.length = 0;
        window.__darkWebInputHead = 0;
    } else {
        window.__darkWebInputHead = head;
    }
    window.__darkWebCurEvent = ev;
    return (ev && ev.length > 0) ? (ev[0] | 0) : 0;
});

EM_JS(int, dark_web_canvas_size_rev, (), {
    var s = window.__darkCanvasCssSize;
    return s ? (s.rev | 0) : 0;
});

EM_JS(int, dark_web_canvas_css_w, (), {
    var s = window.__darkCanvasCssSize;
    return s ? (s.w | 0) : 0;
});

EM_JS(int, dark_web_canvas_css_h, (), {
    var s = window.__darkCanvasCssSize;
    return s ? (s.h | 0) : 0;
});

EM_JS(int, dark_web_event_i1, (), {
    var ev = window.__darkWebCurEvent;
    return ev ? (ev[1] | 0) : 0;
});

EM_JS(int, dark_web_event_i2, (), {
    var ev = window.__darkWebCurEvent;
    return ev ? (ev[2] | 0) : 0;
});

EM_JS(double, dark_web_event_f1, (), {
    var ev = window.__darkWebCurEvent;
    return (ev && typeof ev[3] === 'number' && isFinite(ev[3])) ? ev[3] : 0.0;
});

EM_JS(double, dark_web_event_f2, (), {
    var ev = window.__darkWebCurEvent;
    return (ev && typeof ev[4] === 'number' && isFinite(ev[4])) ? ev[4] : 0.0;
});

EM_JS(int, dark_web_config_rev, (), {
    var c = window.__darkWebConfig;
    return c ? (c.rev | 0) : 0;
});

EM_JS(int, dark_web_config_target_fps, (), {
    var c = window.__darkWebConfig;
    return c ? (c.targetFps | 0) : 0;
});

EM_JS(int, dark_web_config_flags, (), {
    var c = window.__darkWebConfig;
    if (!c) return 1;
    return (c.adaptiveAspect ? 1 : 0) | (c.stretchFill ? 2 : 0) | (c.invertY ? 4 : 0);
});

EM_JS(double, dark_web_config_sens, (), {
    var c = window.__darkWebConfig;
    return (c && typeof c.sens === 'number' && isFinite(c.sens)) ? c.sens : 1.0;
});

// VSync-aligned frame yield with clean fallback timer cancellation (zero timer
// leaks / GC churn), optional mobile FPS cap (30/60 FPS thermal saver), and
// lightweight 2Hz FPS telemetry exposed on window.__darkEngineFps.
EM_ASYNC_JS(void, dark_web_yield_animation_frame, (int targetFps), {
    if (document.visibilityState === 'hidden' || window.__darkEnginePaused) {
        await new Promise(function(resolve) { setTimeout(resolve, 64); });
        return;
    }

    var now = performance.now();
    if (!window.__darkFrameState) {
        window.__darkFrameState = {
            lastPresent: now,
            fpsWindowStart: now,
            fpsFrames: 0
        };
    }
    var st = window.__darkFrameState;
    if (!window.__darkFirstFrameRendered) {
        window.__darkFirstFrameRendered = true;
        if (typeof window.__onDarkFirstFrame === 'function') {
            try { window.__onDarkFirstFrame(); } catch (_) {}
        }
    }
    st.fpsFrames += 1;
    var fpsElapsed = now - st.fpsWindowStart;
    if (fpsElapsed >= 500) {
        window.__darkEngineFps = Math.round((st.fpsFrames * 1000) / fpsElapsed);
        st.fpsFrames = 0;
        st.fpsWindowStart = now;
    }

    var minFrameMs = targetFps > 0 ? (1000.0 / targetFps) : 0.0;
    await new Promise(function(resolve) {
        var settled = false;
        var timerId = 0;
        var done = function() {
            if (settled) return;
            settled = true;
            if (timerId) clearTimeout(timerId);
            st.lastPresent = performance.now();
            resolve();
        };
        var onRaf = function(ts) {
            if (minFrameMs > 0 && (ts - st.lastPresent) < (minFrameMs - 1.5)) {
                requestAnimationFrame(onRaf);
                return;
            }
            done();
        };
        requestAnimationFrame(onRaf);
        // Safety fallback if browser suspends rAF; always cleared on normal frame.
        timerId = setTimeout(done, 100);
    });
});

// Lightweight cooperative yield used only during long synchronous loading
// work when EndFrame() has not run for > 32ms, keeping the tab responsive.
EM_ASYNC_JS(void, dark_web_yield_loading_slice, (), {
    await new Promise(function(resolve) {
        if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
            var settled = false;
            var timerId = setTimeout(function() {
                if (!settled) { settled = true; resolve(); }
            }, 40);
            requestAnimationFrame(function() {
                if (!settled) { settled = true; clearTimeout(timerId); resolve(); }
            });
        } else {
            setTimeout(resolve, 0);
        }
    });
});
#endif

namespace
{

#ifdef __EMSCRIPTEN__
// Minimum interval (ms) before PumpEvents() performs an emergency Asyncify
// yield during long synchronous loading. During active 30/60 FPS gameplay,
// EndFrame() resets this timestamp every frame so PumpEvents() incurs ZERO
// Asyncify unwind/rewind overhead.
constexpr double kLoadingYieldThresholdMs = 32.0;
#endif

class cUnixGameShell : public IGameShell
{
public:
    cUnixGameShell(IUnknown *pOuterUnknown, int fFlags, int msecBlockSignal);
    virtual ~cUnixGameShell();

    DECLARE_COMPLEX_AGGREGATION(cUnixGameShell);

    // IAggregateMemberControl callbacks
    HRESULT Connect();
    HRESULT PostConnect();
    HRESULT Init();
    HRESULT End();
    HRESULT Disconnect();

    // IGameShell methods
    STDMETHOD_(void, BeginFrame)();
    STDMETHOD_(void, EndFrame)();
    STDMETHOD(BringToFront)();
    STDMETHOD(Obsolete1)();
    STDMETHOD_(void, PumpEvents)(int fPumpFlags);

    STDMETHOD_(int, DisplayLock)();
    STDMETHOD_(int, DisplayUnlock)();
    STDMETHOD_(void, DisplayFlush)();

    STDMETHOD_(unsigned long, GetTimerTick)();
    STDMETHOD_(void, SetTimer)(unsigned long ulTime);

    STDMETHOD_(BOOL, ShowHelp)(const char *pszHelpFile, uint command, ulong dwData);
    STDMETHOD_(BOOL, SetOSCursor)(sGrBitmap *pCursorBitmap, const Point *pHotSpot);
    STDMETHOD_(BOOL, ShowOSCursor)(BOOL bShow);
    STDMETHOD_(void, SetCursorCallback)(tGSCursorCallbackFunc pfnCallback);
    STDMETHOD_(BOOL, Exec)(const char *pszCommandLine);
    STDMETHOD_(BOOL, SetFlags)(int fFlags);
    STDMETHOD_(BOOL, GetFlags)(int *pfFlags);

private:
    void DrainSdlEvents(int fPumpFlags);
    void HandleQuitRequested();
#ifdef __EMSCRIPTEN__
    void SyncEmscriptenCanvasSize(bool forceSync);
    void SyncWebConfigFromJs();
    void DrainWebInputQueue();
#endif

    int m_fFlags;
    int m_msecBlockSignal;
    int m_frameLockDepth;
    BOOL m_bInFrame;
    BOOL m_bCursorVisible;
    BOOL m_bQuitHandled;
    unsigned long m_timerOffset;
    tGSCursorCallbackFunc m_pfnCursorCallback;
    IDisplayDevice *m_pDisplayDevice;
    IApplication *m_pApplication;

#ifdef __EMSCRIPTEN__
    double m_lastYieldTimeMs;
    uint32_t m_frameCounter;
    SDL_Window *m_lastSyncedWindow;
    int m_lastCssWidth;
    int m_lastCssHeight;
    int m_lastCanvasSizeRev;
    int m_lastRelativeMouse;
    int m_lastWebConfigRev;
    float m_lookAccumX;
    float m_lookAccumY;
#endif
};

IMPLEMENT_COMPLEX_AGGREGATION_SELF_DELETE(cUnixGameShell);

cUnixGameShell::cUnixGameShell(IUnknown *pOuterUnknown, int fFlags, int msecBlockSignal)
    : m_fFlags(fFlags),
      m_msecBlockSignal(msecBlockSignal),
      m_frameLockDepth(0),
      m_bInFrame(FALSE),
      m_bCursorVisible((fFlags & kShowNativeCursor) ? TRUE : FALSE),
      m_bQuitHandled(FALSE),
      m_timerOffset(0),
      m_pfnCursorCallback(NULL),
      m_pDisplayDevice(NULL),
      m_pApplication(NULL)
#ifdef __EMSCRIPTEN__
      ,
      m_lastYieldTimeMs(0.0),
      m_frameCounter(0),
      m_lastSyncedWindow(NULL),
      m_lastCssWidth(0),
      m_lastCssHeight(0),
      m_lastCanvasSizeRev(0),
      m_lastRelativeMouse(-1),
      m_lastWebConfigRev(0),
      m_lookAccumX(0.0f),
      m_lookAccumY(0.0f)
#endif
{
    INIT_AGGREGATION_1(pOuterUnknown, IID_IGameShell, this, kPriorityLibrary, NULL);
}

cUnixGameShell::~cUnixGameShell()
{
    SafeRelease(m_pDisplayDevice);
    SafeRelease(m_pApplication);
}

HRESULT cUnixGameShell::Connect()
{
    m_pDisplayDevice = AppGetObj(IDisplayDevice);
    m_pApplication = AppGetObj(IApplication);
    return S_OK;
}

HRESULT cUnixGameShell::PostConnect()
{
    return S_OK;
}

HRESULT cUnixGameShell::Init()
{
    m_timerOffset = PlatformMilliseconds();
    m_bQuitHandled = FALSE;
#ifdef __EMSCRIPTEN__
    m_lastYieldTimeMs = emscripten_get_now();
    m_frameCounter = 0;
    m_lastSyncedWindow = NULL;
    m_lastCssWidth = 0;
    m_lastCssHeight = 0;
    m_lastCanvasSizeRev = 0;
    m_lastRelativeMouse = -1;
    m_lastWebConfigRev = 0;
    m_lookAccumX = 0.0f;
    m_lookAccumY = 0.0f;
#endif
    SDL_ShowCursor(m_bCursorVisible ? SDL_ENABLE : SDL_DISABLE);
    return S_OK;
}

HRESULT cUnixGameShell::End()
{
    while (m_frameLockDepth > 0)
    {
        DisplayUnlock();
        --m_frameLockDepth;
    }
    m_bInFrame = FALSE;
    return S_OK;
}

HRESULT cUnixGameShell::Disconnect()
{
    SafeRelease(m_pDisplayDevice);
    SafeRelease(m_pApplication);
    return S_OK;
}

void cUnixGameShell::HandleQuitRequested()
{
    if (m_bQuitHandled)
        return;
    m_bQuitHandled = TRUE;

    if (m_pApplication)
    {
        if (m_pApplication->QueryQuit() == S_OK)
        {
            m_pApplication->Quit();
            return;
        }
        m_bQuitHandled = FALSE;
        return;
    }

    if (m_fFlags & kExitOnQuitEvent)
        PlatformExitProcess(0);
}

#ifdef __EMSCRIPTEN__
void cUnixGameShell::SyncEmscriptenCanvasSize(bool forceSync)
{
    SDL_Window *win = SDL_GL_GetCurrentWindow();
    if (!win)
        return;

    // Fast path: check cached ResizeObserver revision published by web/index.html
    // so we NEVER trigger a synchronous DOM getBoundingClientRect() layout reflow
    // on every frame during gameplay.
    const int sizeRev = dark_web_canvas_size_rev();
    if (!forceSync && sizeRev > 0 && sizeRev == m_lastCanvasSizeRev &&
        win == m_lastSyncedWindow && m_lastCssWidth > 0 && m_lastCssHeight > 0)
    {
        return;
    }

    int w = 0;
    int h = 0;
    if (sizeRev > 0)
    {
        w = dark_web_canvas_css_w();
        h = dark_web_canvas_css_h();
    }
    if (w <= 0 || h <= 0)
    {
        double cssW = 0.0;
        double cssH = 0.0;
        if (emscripten_get_element_css_size("#canvas", &cssW, &cssH) != EMSCRIPTEN_RESULT_SUCCESS)
            return;
        w = static_cast<int>(cssW + 0.5);
        h = static_cast<int>(cssH + 0.5);
    }
    if (w <= 0 || h <= 0)
        return;

    int sdlW = 0;
    int sdlH = 0;
    SDL_GetWindowSize(win, &sdlW, &sdlH);

    m_lastCanvasSizeRev = sizeRev;
    if (!forceSync && win == m_lastSyncedWindow &&
        w == m_lastCssWidth && h == m_lastCssHeight &&
        sdlW == w && sdlH == h)
    {
        return;
    }

    m_lastSyncedWindow = win;
    m_lastCssWidth = w;
    m_lastCssHeight = h;

    // Keep SDL2's logical window dimensions locked to the CSS viewport so
    // Emscripten_HandleMouseMove / Emscripten_HandleTouch map 1:1 to
    // opengl.cpp's g_clientWidth / g_clientHeight and logical_point().
    if (sdlW != w || sdlH != h)
    {
        SDL_SetWindowSize(win, w, h);
        dark_web_notify_canvas_resized(w, h);
    }

    SDL_Event sizeEv;
    memset(&sizeEv, 0, sizeof(sizeEv));
    sizeEv.type = SDL_WINDOWEVENT;
    sizeEv.window.event = SDL_WINDOWEVENT_SIZE_CHANGED;
    sizeEv.window.data1 = w;
    sizeEv.window.data2 = h;
    SDL_PushEvent(&sizeEv);

    // Ask DarkRenderPumpEvents() to redraw the retained 2D menu surface at
    // the new centered viewport immediately.
    SDL_Event focusEv;
    memset(&focusEv, 0, sizeof(focusEv));
    focusEv.type = SDL_WINDOWEVENT;
    focusEv.window.event = SDL_WINDOWEVENT_FOCUS_GAINED;
    SDL_PushEvent(&focusEv);
}

void cUnixGameShell::SyncWebConfigFromJs()
{
    const int rev = dark_web_config_rev();
    if (rev == 0 || rev == m_lastWebConfigRev)
        return;
    m_lastWebConfigRev = rev;

    DarkGameShellSetTargetFps(dark_web_config_target_fps());
    const int flags = dark_web_config_flags();
    RenderBackendSetAdaptiveAspect((flags & 1) ? 1 : 0);
    RenderBackendSetStretchToFill((flags & 2) ? 1 : 0);
    DarkGameShellConfigureInput(static_cast<float>(dark_web_config_sens()), (flags & 4) ? 1 : 0);
}

void cUnixGameShell::DrainWebInputQueue()
{
    int processed = 0;
    while (processed < 128)
    {
        const int type = dark_web_pop_input_event_type();
        if (type == 0)
            break;
        ++processed;

        if (type == 1)
        {
            const int scancode = dark_web_event_i1();
            const int down = dark_web_event_i2();
            RenderBackendInjectKey(scancode, down);
        }
        else if (type == 2)
        {
            const int button = dark_web_event_i1();
            const int down = dark_web_event_i2();
            RenderBackendInjectMouseButton(button, down);
        }
        else if (type == 3)
        {
            const int action = dark_web_event_i1();
            const int button = dark_web_event_i2();
            const float normX = static_cast<float>(dark_web_event_f1());
            const float normY = static_cast<float>(dark_web_event_f2());
            RenderBackendInjectPointer(normX, normY, action, button);
        }
        else if (type == 4)
        {
            m_lookAccumX += static_cast<float>(dark_web_event_f1());
            m_lookAccumY += static_cast<float>(dark_web_event_f2());
        }
        else if (type == 5)
        {
            const int actionId = dark_web_event_i1();
            const int down = dark_web_event_i2();
            DarkWebDispatchGameAction(actionId, down);
        }
    }

    const int ix = static_cast<int>(m_lookAccumX);
    const int iy = static_cast<int>(m_lookAccumY);
    if (ix != 0 || iy != 0)
    {
        m_lookAccumX -= static_cast<float>(ix);
        m_lookAccumY -= static_cast<float>(iy);
        RenderBackendInjectRelativeLook(ix, iy);
    }
}
#endif

void cUnixGameShell::DrainSdlEvents(int /*fPumpFlags*/)
{
#ifdef __EMSCRIPTEN__
    SyncWebConfigFromJs();
    const int relActive = DarkInputRelativeMouseActive() ? 1 : 0;
    const bool modeChanged = (relActive != m_lastRelativeMouse);
    if (modeChanged)
    {
        m_lastRelativeMouse = relActive;
        dark_web_publish_input_mode(relActive);
    }
    SyncEmscriptenCanvasSize(modeChanged);
#endif

    // Delegate SDL event polling to DarkRenderPumpEvents() so keyboard, mouse
    // buttons, mouse motion, wheel, window resize, and focus redraw events are
    // properly translated into DarkInputKey / DarkInputMouse / DarkInputMouseRelative.
    if (DarkRenderPumpEvents())
        HandleQuitRequested();

#ifdef __EMSCRIPTEN__
    // Drain queued touch/HUD/gamepad input AFTER DarkRenderPumpEvents() so
    // g_clientWidth/g_clientHeight already reflect any resize in this frame.
    DrainWebInputQueue();
#endif

    GamepadUpdate();
}

STDMETHODIMP_(void) cUnixGameShell::BeginFrame()
{
    m_bInFrame = TRUE;
    DarkRenderBeginApplicationFrame();
    PumpEvents(kPumpAll);

    if ((m_fFlags & kLockFrame) && m_pDisplayDevice)
    {
        m_pDisplayDevice->Lock();
        ++m_frameLockDepth;
    }
}

STDMETHODIMP_(void) cUnixGameShell::EndFrame()
{
    if (m_pDisplayDevice)
    {
        if ((m_fFlags & kLockFrame) && m_frameLockDepth > 0)
        {
            m_pDisplayDevice->Unlock();
            --m_frameLockDepth;
        }

        if (m_fFlags & kFlushOnEndFrame)
            m_pDisplayDevice->Flush();

        if (m_fFlags & kFlipOnEndFrame)
            m_pDisplayDevice->PageFlip();
    }

    DarkRenderEndApplicationFrame();
    m_bInFrame = FALSE;

#ifdef __EMSCRIPTEN__
    // Single, VSync-aligned frame yield per rendered frame. This avoids
    // Asyncify stack unwinds inside PumpEvents() and locks pacing to the
    // browser's native 60Hz/120Hz display refresh without setTimeout(0) jitter.
    ++m_frameCounter;
    dark_web_yield_animation_frame(g_darkWebTargetFps);
    m_lastYieldTimeMs = emscripten_get_now();
#endif
}

STDMETHODIMP cUnixGameShell::BringToFront()
{
    return S_OK;
}

STDMETHODIMP cUnixGameShell::Obsolete1()
{
    return E_NOTIMPL;
}

STDMETHODIMP_(void) cUnixGameShell::PumpEvents(int fPumpFlags)
{
    int savedLocks = 0;
    if (m_pDisplayDevice && m_pDisplayDevice->IsLocked())
        savedLocks = m_pDisplayDevice->BreakLock();

    DrainSdlEvents(fPumpFlags);

    if (savedLocks > 0 && m_pDisplayDevice)
        m_pDisplayDevice->RestoreLock(savedLocks);

#ifdef __EMSCRIPTEN__
    // Only yield inside PumpEvents() when the engine is executing a long
    // synchronous section (e.g. mission loading or menu transition) where
    // EndFrame() has not yielded recently. During normal 60 FPS gameplay,
    // this check is false and incurs zero Asyncify overhead.
    const double nowMs = emscripten_get_now();
    if (!m_bInFrame && (nowMs - m_lastYieldTimeMs) >= kLoadingYieldThresholdMs)
    {
        dark_web_yield_loading_slice();
        m_lastYieldTimeMs = emscripten_get_now();
    }
#endif
}

STDMETHODIMP_(int) cUnixGameShell::DisplayLock()
{
    return m_pDisplayDevice ? m_pDisplayDevice->Lock() : 0;
}

STDMETHODIMP_(int) cUnixGameShell::DisplayUnlock()
{
    return m_pDisplayDevice ? m_pDisplayDevice->Unlock() : 0;
}

STDMETHODIMP_(void) cUnixGameShell::DisplayFlush()
{
    if (m_pDisplayDevice)
        m_pDisplayDevice->Flush();
}

STDMETHODIMP_(unsigned long) cUnixGameShell::GetTimerTick()
{
    return static_cast<unsigned long>(PlatformMilliseconds() - m_timerOffset);
}

STDMETHODIMP_(void) cUnixGameShell::SetTimer(unsigned long ulTime)
{
    m_timerOffset = PlatformMilliseconds() - static_cast<uint32>(ulTime);
}

STDMETHODIMP_(BOOL) cUnixGameShell::ShowHelp(const char * /*pszHelpFile*/,
                                             uint /*command*/,
                                             ulong /*dwData*/)
{
    return FALSE;
}

STDMETHODIMP_(BOOL) cUnixGameShell::SetOSCursor(sGrBitmap * /*pCursorBitmap*/,
                                                const Point * /*pHotSpot*/)
{
    return TRUE;
}

STDMETHODIMP_(BOOL) cUnixGameShell::ShowOSCursor(BOOL bShow)
{
    const BOOL prev = m_bCursorVisible;
    m_bCursorVisible = bShow ? TRUE : FALSE;
    DarkRenderShowCursor(m_bCursorVisible != FALSE);
    if (m_pfnCursorCallback)
        m_pfnCursorCallback(m_bCursorVisible ? kGSShowCursor : kGSHideCursor);
    return prev;
}

STDMETHODIMP_(void) cUnixGameShell::SetCursorCallback(tGSCursorCallbackFunc pfnCallback)
{
    m_pfnCursorCallback = pfnCallback;
}

STDMETHODIMP_(BOOL) cUnixGameShell::Exec(const char * /*pszCommandLine*/)
{
    return FALSE;
}

STDMETHODIMP_(BOOL) cUnixGameShell::SetFlags(int fFlags)
{
    m_fFlags = fFlags;
    return TRUE;
}

STDMETHODIMP_(BOOL) cUnixGameShell::GetFlags(int *pfFlags)
{
    if (!pfFlags)
        return FALSE;
    *pfFlags = m_fFlags;
    return TRUE;
}

} // namespace

EXTERN tResult LGAPI _GameShellCreate(REFIID,
                                      IGameShell **ppGameShell,
                                      IUnknown *pOuter,
                                      int fFlags,
                                      int msecBlockSignal)
{
    cUnixGameShell *pShell = new cUnixGameShell(pOuter, fFlags, msecBlockSignal);
    if (!pShell)
        return E_OUTOFMEMORY;

    if (ppGameShell)
    {
        *ppGameShell = pShell;
        pShell->AddRef();
    }
    return S_OK;
}

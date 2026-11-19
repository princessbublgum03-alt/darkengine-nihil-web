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

#include <stdlib.h>
#include <string.h>

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

// VSync-aligned frame yield with clean fallback timer cancellation (zero timer
// leaks / GC churn), optional mobile FPS cap (30/60 FPS thermal saver), and
// lightweight 2Hz FPS telemetry exposed on window.__darkEngineFps.
EM_ASYNC_JS(void, dark_web_yield_animation_frame, (int targetFps), {
    if (document.visibilityState === 'hidden') {
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
constexpr int kMaxEventsPerPump = 64;

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
      m_frameCounter(0)
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

void cUnixGameShell::DrainSdlEvents(int fPumpFlags)
{
    // Pump queued OS/browser events into SDL's queue once per call rather than
    // per event, minimizing JS<->WASM boundary crossings under Emscripten.
    SDL_PumpEvents();

    SDL_Event event;
    int processed = 0;
    int coalescedDx = 0;
    int coalescedDy = 0;
    bool haveMotion = false;
    int lastMouseX = 0;
    int lastMouseY = 0;
    Uint32 lastMouseButtons = 0;

    while (processed < kMaxEventsPerPump && SDL_PollEvent(&event))
    {
        ++processed;

        switch (event.type)
        {
            case SDL_QUIT:
                HandleQuitRequested();
                break;

            case SDL_APP_WILLENTERBACKGROUND:
                PlatformSuspendApplicationClock();
                break;

            case SDL_APP_DIDENTERFOREGROUND:
                PlatformResumeApplicationClock();
                break;

            case SDL_WINDOWEVENT:
                if (event.window.event == SDL_WINDOWEVENT_CLOSE)
                {
                    HandleQuitRequested();
                }
                else if (event.window.event == SDL_WINDOWEVENT_MINIMIZED ||
                         event.window.event == SDL_WINDOWEVENT_HIDDEN)
                {
                    PlatformSuspendApplicationClock();
                }
                else if (event.window.event == SDL_WINDOWEVENT_RESTORED ||
                         event.window.event == SDL_WINDOWEVENT_SHOWN)
                {
                    PlatformResumeApplicationClock();
                }
                else if (event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED ||
                         event.window.event == SDL_WINDOWEVENT_RESIZED)
                {
                    RenderBackendSetWindowedClientSizeHint(event.window.data1,
                                                           event.window.data2);
                }
                break;

            case SDL_MOUSEMOTION:
                // Coalesce high-frequency mouse / touch-look motion bursts into
                // a single engine event per pump to prevent input queue overflow
                // and frame pacing spikes on high-polling-rate devices.
                if (fPumpFlags == kPumpAll || fPumpFlags == kPumpMouse)
                {
                    coalescedDx += event.motion.xrel;
                    coalescedDy += event.motion.yrel;
                    lastMouseX = event.motion.x;
                    lastMouseY = event.motion.y;
                    lastMouseButtons = event.motion.state;
                    haveMotion = true;
                }
                break;

            case SDL_CONTROLLERDEVICEADDED:
            case SDL_JOYDEVICEADDED:
                GamepadSetActive(1);
                GamepadNotifyInput(static_cast<unsigned>(event.cdevice.which));
                break;

            case SDL_CONTROLLERBUTTONDOWN:
            case SDL_CONTROLLERAXISMOTION:
                GamepadNotifyInput(static_cast<unsigned>(event.cbutton.which));
                break;

            default:
                // Other SDL keyboard/mouse/controller events are consumed by
                // SDL state queries and the platform input/gamepad providers.
                break;
        }
    }

    if (haveMotion)
    {
        int logicalX = lastMouseX;
        int logicalY = lastMouseY;
        RenderBackendClientToLogicalPoint(&logicalX, &logicalY);

#ifdef __EMSCRIPTEN__
        // When Pointer Lock (relative mode) is active on PC, apply configured
        // sensitivity and Y-inversion cleanly to coalesced relative deltas.
        if (SDL_GetRelativeMouseMode() == SDL_TRUE)
        {
            const int scaledDx = static_cast<int>(coalescedDx * g_darkWebMouseSens);
            const int scaledDy = static_cast<int>(coalescedDy * g_darkWebMouseSens) *
                                 (g_darkWebInvertY ? -1 : 1);
            logicalX += scaledDx;
            logicalY += scaledDy;
        }
#endif

        lgMouseEvent me;
        memset(&me, 0, sizeof(me));
        me.x = static_cast<short>(logicalX);
        me.y = static_cast<short>(logicalY);
        me.type = MOUSE_MOTION;
        me.timestamp = PlatformMilliseconds();
        me.buttons = static_cast<uchar>(
            MouseMakeButtons((lastMouseButtons & SDL_BUTTON_LMASK) != 0,
                             (lastMouseButtons & SDL_BUTTON_MMASK) != 0,
                             (lastMouseButtons & SDL_BUTTON_RMASK) != 0));
        mouse_generate(me);
        (void)coalescedDx;
        (void)coalescedDy;
    }

    GamepadUpdate();
}

STDMETHODIMP_(void) cUnixGameShell::BeginFrame()
{
    m_bInFrame = TRUE;
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
    SDL_ShowCursor(m_bCursorVisible ? SDL_ENABLE : SDL_DISABLE);
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

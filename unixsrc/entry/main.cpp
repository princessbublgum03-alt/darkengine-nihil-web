// Dark Engine Unix / Android / Emscripten entry point.
// Configures SDL2 hints for low-latency WebGL2/WebAssembly execution,
// connects to the launcher's IndexedDB (/gamedata) virtual filesystem,
// and forwards execution to Dark Engine's _AppMain without startup stalls.

#include <lg.h>
#include <appagg.h>
#include <platform_services.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#if !defined(_WIN32)
#include <sys/stat.h>
#include <unistd.h>
#endif

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
#endif

extern "C" {
int _g_referenceEntryPoint = 0;
int LGAPI _AppMain(int argc, const char *argv[]);
}

#ifdef __EMSCRIPTEN__
extern "C" void DarkGameShellSetTargetFps(int targetFps);
extern "C" void DarkGameShellConfigureInput(float mouseSensitivity, int invertY);
#endif

namespace
{
#ifdef __EMSCRIPTEN__
char g_webGraphicsBackend[32] = "webgl2";
char g_webInputProfile[32] = "auto";
float g_webResolutionScale = 1.0f;
float g_webMouseSensitivity = 1.0f;
float g_webGamepadDeadzone = 0.15f;
int g_webInvertY = 0;
int g_webTargetFps = 0;
int g_webVerboseLogging = 0;

bool DirectoryExists(const char *path)
{
    if (!path || !path[0])
        return false;
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

void PersistIdbfsToBrowser()
{
    EM_ASM({
        if (typeof FS !== 'undefined' && typeof IDBFS !== 'undefined') {
            try {
                FS.syncfs(false, function(err) {
                    if (err) {
                        console.warn('[DarkEngine] IDBFS save sync warning:', err);
                    }
                });
            } catch (e) {
                console.warn('[DarkEngine] IDBFS sync skipped:', e);
            }
        }
    });
}

void ConfigureEmscriptenRuntime()
{
    // Scope SDL keyboard capture strictly to the WebGL canvas so launcher UI
    // controls and text inputs remain responsive before and during gameplay.
    SDL_SetHint(SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT, "#canvas");

    // Disable synthetic mouse events from touch input so mobile virtual sticks
    // and swipe-look controls never double-fire clicks into Thief menus.
    SDL_SetHint(SDL_HINT_TOUCH_MOUSE_EVENTS, "0");
    SDL_SetHint(SDL_HINT_MOUSE_TOUCH_EVENTS, "0");

    // Avoid polling mobile accelerometers as joysticks (reduces overhead and
    // prevents unwanted camera drift on phones).
    SDL_SetHint(SDL_HINT_ACCELEROMETER_AS_JOYSTICK, "0");

    // PC & Gamepad input precision: disable OS mouse warp/acceleration under
    // Pointer Lock and use positional Xbox/DualSense controller button mapping.
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_MODE_WARP, "0");
#ifdef SDL_HINT_MOUSE_RELATIVE_SCALING
    SDL_SetHint(SDL_HINT_MOUSE_RELATIVE_SCALING, "0");
#endif
    SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
#ifdef SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS
    SDL_SetHint(SDL_HINT_GAMECONTROLLER_USE_BUTTON_LABELS, "0");
#endif

    // Enable SDL2 2D render batching and VSync to reduce draw-call overhead
    // on mobile GPUs (Adreno/Mali/Apple GPU) and keep tear-free frame pacing.
    SDL_SetHint(SDL_HINT_RENDER_BATCHING, "1");
    SDL_SetHint(SDL_HINT_RENDER_VSYNC, "1");
    SDL_SetHint(SDL_HINT_VIDEO_DOUBLE_BUFFER, "1");
    SDL_SetHint(SDL_HINT_VIDEO_ALLOW_SCREENSAVER, "0");

    // Resolve the persistent IndexedDB-backed game data directory if present.
    const char *envDir = std::getenv("DARK_GAME_DIR");
    const char *candidateDir = (envDir && envDir[0]) ? envDir : "/gamedata";
    if (DirectoryExists(candidateDir))
    {
        if (chdir(candidateDir) != 0)
        {
            PlatformDebugOutput("[web] Warning: failed to chdir to game directory\n");
        }
    }
    else if (g_webVerboseLogging)
    {
        char msg[256];
        std::snprintf(msg, sizeof(msg),
                      "[web][diag] Game directory not found: %s\n", candidateDir);
        PlatformDebugOutput(msg);
    }

    if (g_webVerboseLogging)
    {
        char cwdBuf[256] = "";
        const char *cwd = getcwd(cwdBuf, sizeof(cwdBuf)) ? cwdBuf : "<unknown>";
        char diagBuf[512];
        std::snprintf(diagBuf, sizeof(diagBuf),
                      "[web][diag] Runtime ready: cwd=%s backend=%s scale=%.2f fps=%d input=%s sens=%.2f dz=%.2f invY=%d\n",
                      cwd, g_webGraphicsBackend, g_webResolutionScale, g_webTargetFps,
                      g_webInputProfile, g_webMouseSensitivity, g_webGamepadDeadzone, g_webInvertY);
        PlatformDebugOutput(diagBuf);
    }

    // Flush save games and modified cam.cfg back to IndexedDB on clean exit.
    std::atexit(PersistIdbfsToBrowser);
}
#endif
} // namespace

#ifdef __EMSCRIPTEN__
extern "C" {

EMSCRIPTEN_KEEPALIVE
void dark_web_set_graphics_backend(const char *backend)
{
    if (!backend || !backend[0])
        return;
    std::strncpy(g_webGraphicsBackend, backend, sizeof(g_webGraphicsBackend) - 1);
    g_webGraphicsBackend[sizeof(g_webGraphicsBackend) - 1] = '\0';
    setenv("DARK_WEB_RENDER_BACKEND", g_webGraphicsBackend, 1);
}

EMSCRIPTEN_KEEPALIVE
void dark_web_set_quality_preset(float resolutionScale)
{
    if (resolutionScale < 0.4f)
        resolutionScale = 0.4f;
    if (resolutionScale > 2.0f)
        resolutionScale = 2.0f;
    g_webResolutionScale = resolutionScale;

    char scaleBuf[32];
    std::snprintf(scaleBuf, sizeof(scaleBuf), "%.2f", g_webResolutionScale);
    setenv("DARK_WEB_RES_SCALE", scaleBuf, 1);
}

EMSCRIPTEN_KEEPALIVE
void dark_web_set_target_fps(int targetFps)
{
    g_webTargetFps = (targetFps == 30 || targetFps == 60) ? targetFps : 0;
    DarkGameShellSetTargetFps(g_webTargetFps);
}

EMSCRIPTEN_KEEPALIVE
void dark_web_set_input_profile(const char *profile,
                                float sensitivity,
                                float deadzone,
                                int invertY)
{
    if (profile && profile[0])
    {
        std::strncpy(g_webInputProfile, profile, sizeof(g_webInputProfile) - 1);
        g_webInputProfile[sizeof(g_webInputProfile) - 1] = '\0';
        setenv("DARK_WEB_INPUT_PROFILE", g_webInputProfile, 1);
    }

    if (sensitivity < 0.25f)
        sensitivity = 0.25f;
    if (sensitivity > 4.0f)
        sensitivity = 4.0f;
    g_webMouseSensitivity = sensitivity;

    if (deadzone < 0.05f)
        deadzone = 0.05f;
    if (deadzone > 0.40f)
        deadzone = 0.40f;
    g_webGamepadDeadzone = deadzone;

    g_webInvertY = invertY ? 1 : 0;

    char numBuf[32];
    std::snprintf(numBuf, sizeof(numBuf), "%.2f", g_webMouseSensitivity);
    setenv("DARK_WEB_LOOK_SENS", numBuf, 1);
    std::snprintf(numBuf, sizeof(numBuf), "%.2f", g_webGamepadDeadzone);
    setenv("DARK_WEB_GAMEPAD_DEADZONE", numBuf, 1);
    setenv("DARK_WEB_INVERT_Y", g_webInvertY ? "1" : "0", 1);

    DarkGameShellConfigureInput(g_webMouseSensitivity, g_webInvertY);
}

EMSCRIPTEN_KEEPALIVE
void dark_web_sync_saves(void)
{
    PersistIdbfsToBrowser();
}

EMSCRIPTEN_KEEPALIVE
void dark_web_set_verbose_logging(int enabled)
{
    g_webVerboseLogging = enabled ? 1 : 0;
    setenv("DARK_WEB_VERBOSE_LOG", g_webVerboseLogging ? "1" : "0", 1);
    if (g_webVerboseLogging)
    {
        char msg[256];
        std::snprintf(msg, sizeof(msg),
                      "[web][diag] Verbose engine logging enabled (backend=%s, scale=%.2f, fps=%d)\n",
                      g_webGraphicsBackend, g_webResolutionScale, g_webTargetFps);
        PlatformDebugOutput(msg);
    }
}

} // extern "C"
#endif

#if defined(__ANDROID__)
extern "C" int SDL_main(int argc, char *argv[])
#else
int main(int argc, char *argv[])
#endif
{
    _g_referenceEntryPoint = 1;

    const char *appName = (argc > 0 && argv && argv[0] && argv[0][0])
                              ? argv[0]
                              : "thief-runner";

#ifdef __EMSCRIPTEN__
    ConfigureEmscriptenRuntime();
#endif

    PlatformDiagnosticsStartSession(appName, argc,
                                    const_cast<const char *const *>(argv));

    const int exitCode = _AppMain(argc, const_cast<const char **>(argv));

#ifdef __EMSCRIPTEN__
    PersistIdbfsToBrowser();
#endif

    return exitCode;
}

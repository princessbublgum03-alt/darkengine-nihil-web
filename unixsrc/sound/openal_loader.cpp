#include <openal_api.h>

#pragma pack(push, 8)
#include <stdlib.h>
#include <string.h>
#if !defined(__EMSCRIPTEN__)
#include <dlfcn.h>
#endif
#pragma pack(pop)

#if defined(__EMSCRIPTEN__)

// Emscripten provides a built-in Web Audio OpenAL 1.1 runtime via `-lopenal`.
// Declare the Emscripten OpenAL C entry points directly (without including
// <AL/al.h> / <AL/alc.h>) to avoid colliding with openal_api.h's struct
// declarations and ALCboolean (unsigned char vs char) typedef.
extern "C" {
extern ALCdevice *alcOpenDevice(const ALCchar *devicename);
extern char alcCloseDevice(ALCdevice *device);
extern ALCcontext *alcCreateContext(ALCdevice *device, const ALCint *attrlist);
extern char alcMakeContextCurrent(ALCcontext *context);
extern void alcProcessContext(ALCcontext *context);
extern void alcSuspendContext(ALCcontext *context);
extern void alcDestroyContext(ALCcontext *context);
extern char alcIsExtensionPresent(ALCdevice *device, const ALCchar *extname);

extern ALenum alGetError(void);
extern void alGenSources(ALsizei n, ALuint *sources);
extern void alDeleteSources(ALsizei n, const ALuint *sources);
extern void alSourcePlay(ALuint source);
extern void alSourcePause(ALuint source);
extern void alSourceStop(ALuint source);
extern void alSourcei(ALuint source, ALenum param, ALint value);
extern void alSourcef(ALuint source, ALenum param, ALfloat value);
extern void alSource3f(ALuint source, ALenum param, ALfloat v1, ALfloat v2, ALfloat v3);
extern void alSource3i(ALuint source, ALenum param, ALint v1, ALint v2, ALint v3);
extern void alGetSourcei(ALuint source, ALenum param, ALint *value);
extern void alGetSourcef(ALuint source, ALenum param, ALfloat *value);
extern void alGenBuffers(ALsizei n, ALuint *buffers);
extern void alDeleteBuffers(ALsizei n, const ALuint *buffers);
extern void alBufferData(ALuint buffer, ALenum format, const ALvoid *data, ALsizei size, ALsizei freq);
extern void alSourceQueueBuffers(ALuint source, ALsizei nb, const ALuint *buffers);
extern void alSourceUnqueueBuffers(ALuint source, ALsizei nb, ALuint *buffers);
extern void alListener3f(ALenum param, ALfloat v1, ALfloat v2, ALfloat v3);
extern void alListenerfv(ALenum param, const ALfloat *values);
extern void alDopplerFactor(ALfloat value);
extern void alSpeedOfSound(ALfloat value);
extern void alDistanceModel(ALenum value);
}

namespace
{
// Type-exact trampolines converting Emscripten's `char` ALCboolean to
// openal_api.h's `unsigned char` ALCboolean without function-pointer casts.
ALCboolean EmscriptenAlcCloseDevice(ALCdevice *device)
{
    return alcCloseDevice(device) ? AL_TRUE : AL_FALSE;
}

ALCboolean EmscriptenAlcMakeContextCurrent(ALCcontext *context)
{
    return alcMakeContextCurrent(context) ? AL_TRUE : AL_FALSE;
}

ALCboolean EmscriptenAlcIsExtensionPresent(ALCdevice *device, const ALCchar *extname)
{
    return alcIsExtensionPresent(device, extname) ? AL_TRUE : AL_FALSE;
}

// Emscripten's Web Audio OpenAL runtime does not export alcGetProcAddress /
// alGetProcAddress (EFX reverb extensions are optional in openal.cpp).
void *EmscriptenAlcGetProcAddress(ALCdevice *, const ALCchar *)
{
    return nullptr;
}

void *EmscriptenAlGetProcAddress(const ALchar *)
{
    return nullptr;
}
} // namespace

bool OpenALLoad(sOpenALApi *api)
{
    if (!api)
        return false;
    memset(api, 0, sizeof(*api));

    api->alcOpenDevice = &alcOpenDevice;
    api->alcCloseDevice = &EmscriptenAlcCloseDevice;
    api->alcCreateContext = &alcCreateContext;
    api->alcMakeContextCurrent = &EmscriptenAlcMakeContextCurrent;
    api->alcProcessContext = &alcProcessContext;
    api->alcSuspendContext = &alcSuspendContext;
    api->alcDestroyContext = &alcDestroyContext;
    api->alcIsExtensionPresent = &EmscriptenAlcIsExtensionPresent;
    api->alcGetProcAddress = &EmscriptenAlcGetProcAddress;

    api->alGetError = &alGetError;
    api->alGetProcAddress = &EmscriptenAlGetProcAddress;
    api->alGenSources = &alGenSources;
    api->alDeleteSources = &alDeleteSources;
    api->alSourcePlay = &alSourcePlay;
    api->alSourcePause = &alSourcePause;
    api->alSourceStop = &alSourceStop;
    api->alSourcei = &alSourcei;
    api->alSourcef = &alSourcef;
    api->alSource3f = &alSource3f;
    api->alSource3i = &alSource3i;
    api->alGetSourcei = &alGetSourcei;
    api->alGetSourcef = &alGetSourcef;
    api->alGenBuffers = &alGenBuffers;
    api->alDeleteBuffers = &alDeleteBuffers;
    api->alBufferData = &alBufferData;
    api->alSourceQueueBuffers = &alSourceQueueBuffers;
    api->alSourceUnqueueBuffers = &alSourceUnqueueBuffers;
    api->alListener3f = &alListener3f;
    api->alListenerfv = &alListenerfv;
    api->alDopplerFactor = &alDopplerFactor;
    api->alSpeedOfSound = &alSpeedOfSound;
    api->alDistanceModel = &alDistanceModel;
    return true;
}

void OpenALUnload()
{
}

#else

static void *g_openal;

template <class T>
static bool LoadProc(T &target, const char *name)
{
    target = reinterpret_cast<T>(dlsym(g_openal, name));
    return target != nullptr;
}

bool OpenALLoad(sOpenALApi *api)
{
    if (!api)
        return false;
    memset(api, 0, sizeof(*api));

    // WSLg exports audio through PulseAudio. Its ALSA probe can only emit
    // misleading no-card diagnostics after a Pulse failure.
    if (getenv("WSL2_GUI_APPS_ENABLED") && !getenv("ALSOFT_DRIVERS"))
        setenv("ALSOFT_DRIVERS", "pulse", 0);

    if (!g_openal)
    {
#if defined(__ANDROID__)
        // OpenAL Soft is built and packaged with the APK. Android shared
        // libraries are unversioned, unlike the usual Linux SONAME.
        g_openal = dlopen("libopenal.so", RTLD_NOW | RTLD_LOCAL);
#endif
        if (!g_openal)
            g_openal = dlopen("libopenal.so.1", RTLD_NOW | RTLD_LOCAL);
    }
    if (!g_openal)
        return false;

#define LOAD(name) if (!LoadProc(api->name, #name)) { OpenALUnload(); return false; }
    LOAD(alcOpenDevice) LOAD(alcCloseDevice) LOAD(alcCreateContext)
    LOAD(alcMakeContextCurrent) LOAD(alcProcessContext) LOAD(alcSuspendContext)
    LOAD(alcDestroyContext) LOAD(alcIsExtensionPresent) LOAD(alcGetProcAddress)
    LOAD(alGetError) LOAD(alGetProcAddress) LOAD(alGenSources)
    LOAD(alDeleteSources) LOAD(alSourcePlay) LOAD(alSourcePause)
    LOAD(alSourceStop) LOAD(alSourcei) LOAD(alSourcef) LOAD(alSource3f)
    LOAD(alSource3i) LOAD(alGetSourcei) LOAD(alGetSourcef) LOAD(alGenBuffers)
    LOAD(alDeleteBuffers) LOAD(alBufferData) LOAD(alSourceQueueBuffers)
    LOAD(alSourceUnqueueBuffers) LOAD(alListener3f) LOAD(alListenerfv)
    LOAD(alDopplerFactor) LOAD(alSpeedOfSound) LOAD(alDistanceModel)
#undef LOAD
    return true;
}

void OpenALUnload()
{
    // Causes crash because audio threads still active so we leave open for process lifetime
    // if (g_openal)
    //     dlclose(g_openal);
    // g_openal = nullptr;
}

#endif

/*
 * vst2_abi.h — Minimal VST2 plugin ABI definitions
 * Publicly documented interface, no SDK required.
 */
#ifndef VST2_ABI_H
#define VST2_ABI_H

#include <stdint.h>

#define kVstVersion 2400

/* ── Opcodes (host → plugin) ─────────────────────────────────────────── */
enum {
    effOpen = 0,
    effClose = 1,
    effSetProgram = 2,
    effGetProgram = 3,
    effGetProgramName = 5,
    effGetParamLabel = 6,
    effGetParamDisplay = 7,
    effGetParamName = 8,
    effSetSampleRate = 10,
    effSetBlockSize = 11,
    effMainsChanged = 12,
    effEditGetRect = 13,
    effEditOpen = 14,
    effEditClose = 15,
    effEditIdle = 19,
    effGetChunk = 23,
    effSetChunk = 24,
    effProcessEvents = 25,
    effCanBeAutomated = 26,
    effGetEffectName = 45,
    effGetVendorString = 47,
    effGetProductString = 48,
    effGetVendorVersion = 49,
    effCanDo = 51,
    effGetPlugCategory = 35,
    effGetVstVersion = 58,
};

/* ── Opcodes (plugin → host) ─────────────────────────────────────────── */
enum {
    audioMasterAutomate = 0,
    audioMasterVersion = 1,
    audioMasterCurrentId = 2,
    audioMasterIdle = 3,
};

/* ── Flags ────────────────────────────────────────────────────────────── */
enum {
    effFlagsHasEditor       = 1 << 0,
    effFlagsCanReplacing    = 1 << 4,
    effFlagsProgramChunks   = 1 << 5,
    effFlagsIsSynth         = 1 << 8,
    effFlagsNoSoundInStop   = 1 << 9,
    effFlagsCanDoubleReplacing = 1 << 12,
};

/* ── Categories ──────────────────────────────────────────────────────── */
enum {
    kPlugCategEffect = 1,
    kPlugCategAnalysis = 3,
    kPlugCategRestoration = 8,
};

/* ── Editor Rectangle ─────────────────────────────────────────────── */

typedef struct {
    int16_t top;
    int16_t left;
    int16_t bottom;
    int16_t right;
} ERect;

/* ── AEffect structure ───────────────────────────────────────────────── */

struct AEffect;

typedef intptr_t (*audioMasterCallback)(struct AEffect* effect,
    int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt);

typedef intptr_t (*AEffectDispatcherProc)(struct AEffect* effect,
    int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt);

typedef void (*AEffectProcessProc)(struct AEffect* effect,
    float** inputs, float** outputs, int32_t sampleFrames);

typedef void (*AEffectSetParameterProc)(struct AEffect* effect,
    int32_t index, float parameter);

typedef float (*AEffectGetParameterProc)(struct AEffect* effect,
    int32_t index);

struct AEffect {
    int32_t magic;              /* must be 'VstP' = 0x56737450 */

    AEffectDispatcherProc dispatcher;
    AEffectProcessProc    process_deprecated;
    AEffectSetParameterProc setParameter;
    AEffectGetParameterProc getParameter;

    int32_t numPrograms;
    int32_t numParams;
    int32_t numInputs;
    int32_t numOutputs;

    int32_t flags;

    intptr_t resvd1;
    intptr_t resvd2;

    int32_t initialDelay;       /* latency in samples */

    int32_t _pad1[2];

    float   _pad2;

    void*   object;             /* plugin state pointer */

    void*   user;

    int32_t uniqueID;
    int32_t version;

    AEffectProcessProc processReplacing;
    AEffectProcessProc processDoubleReplacing;

    char future[56];
};

/* Entry point */
#ifdef _WIN32
#define VST_EXPORT __declspec(dllexport)
#else
#define VST_EXPORT __attribute__((visibility("default")))
#endif

typedef struct AEffect* (*VstPluginMainProc)(audioMasterCallback audioMaster);

#endif /* VST2_ABI_H */

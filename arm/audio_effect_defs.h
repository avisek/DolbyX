/*
 * audio_effect_defs.h — Minimal Android AudioEffect HAL structures
 * Matches the ABI that libdseffect.so expects.
 * Derived from AOSP hardware/libhardware/include/hardware/audio_effect.h
 */
#ifndef AUDIO_EFFECT_DEFS_H
#define AUDIO_EFFECT_DEFS_H

#include <stdint.h>

typedef struct {
    uint32_t timeLow;
    uint16_t timeMid;
    uint16_t timeHiAndVersion;
    uint16_t clockSeq;
    uint8_t  node[6];
} effect_uuid_t;

typedef struct {
    uint32_t frameCount;       /* size_t on ARM32 = uint32_t */
    union {
        void*     raw;
        int32_t*  s32;
        int16_t*  s16;
        uint8_t*  u8;
    };
} audio_buffer_t;

#define AUDIO_CHANNEL_OUT_STEREO      0x3
#define AUDIO_FORMAT_PCM_16_BIT       0x1
/* effect_buffer_access_e — AOSP order. SET_CONFIG accepts WRITE/ACCUMULATE on
 * the output (not READ); process() obeys it — ACCUMULATE adds, WRITE overwrites. */
#define EFFECT_BUFFER_ACCESS_WRITE       0
#define EFFECT_BUFFER_ACCESS_READ        1
#define EFFECT_BUFFER_ACCESS_ACCUMULATE  2

/* Buffer provider callbacks (NULL for our use case). AOSP layout = 3 words. */
typedef struct buffer_provider_s {
    int32_t (*getBuffer)(void* cookie, audio_buffer_t* buffer);
    void    (*releaseBuffer)(void* cookie, audio_buffer_t* buffer);
    void*   cookie;
} buffer_provider_t;                   /* = 12 bytes */

/* Real AOSP buffer_config_t / effect_config_t — the exact on-wire layout the
 * engine's EFFECT_CMD_SET_CONFIG (cmd 1) handler reads; format/accessMode are
 * BYTES at +28/+29. See tools/ddp_probe/setconfig_probe.c and
 * docs/ddp/03-binary-protocol.md. */
typedef struct {
    audio_buffer_t    buffer;         /* @0  8 bytes: frameCount + data ptr      */
    uint32_t          samplingRate;   /* @8                                      */
    uint32_t          channels;       /* @12 AUDIO_CHANNEL mask: mono=1 stereo=3 */
    buffer_provider_t bufferProvider; /* @16 12 bytes: getBuffer/releaseBuffer/cookie */
    uint8_t           format;         /* @28 AUDIO_FORMAT_PCM_16_BIT = 1         */
    uint8_t           accessMode;     /* @29 output ∈ {0, 2 (ACCUMULATE)}        */
    uint16_t          mask;           /* @30                                     */
} buffer_config_t;                    /* = 32 bytes total */

typedef struct {
    buffer_config_t inputCfg;
    buffer_config_t outputCfg;
} effect_config_t;                    /* = 64 bytes total */

typedef struct {
    effect_uuid_t type;
    effect_uuid_t uuid;
    uint32_t      apiVersion;
    uint32_t      flags;
    uint16_t      cpuLoad;
    uint16_t      memoryUsage;
    char          name[64];
    char          implementor[64];
} effect_descriptor_t;

struct effect_interface_s;
typedef struct effect_interface_s** effect_handle_t;

typedef int32_t (*effect_process_t)(effect_handle_t self,
                                    audio_buffer_t* inBuffer,
                                    audio_buffer_t* outBuffer);
typedef int32_t (*effect_command_t)(effect_handle_t self,
                                    uint32_t cmdCode, uint32_t cmdSize,
                                    void* pCmdData, uint32_t* replySize,
                                    void* pReplyData);
typedef int32_t (*effect_get_descriptor_t)(effect_handle_t self,
                                           effect_descriptor_t* pDescriptor);

struct effect_interface_s {
    effect_process_t        process;
    effect_command_t        command;
    effect_get_descriptor_t get_descriptor;
    void* reserved[5];
};

typedef int32_t (*EffectQueryNumberEffects_t)(uint32_t* pNumEffects);
typedef int32_t (*EffectQueryEffect_t)(uint32_t index, effect_descriptor_t* pDescriptor);
typedef int32_t (*EffectCreate_t)(const effect_uuid_t* uuid,
                                  int32_t sessionId, int32_t ioId,
                                  effect_handle_t* pHandle);
typedef int32_t (*EffectRelease_t)(effect_handle_t handle);
typedef int32_t (*EffectGetDescriptor_t)(const effect_uuid_t* uuid,
                                         effect_descriptor_t* pDescriptor);

/* Effect command codes — must match AOSP audio_effect.h numbering.
 * Verified empirically against libdseffect.so (cmd_probe): codes 0..5,
 * 8, 9, 10, 11 are dispatched by the engine; 6, 7, 12, 13, 14 are
 * unhandled and fall through to "Unknown command code". */
#define EFFECT_CMD_INIT                0
#define EFFECT_CMD_SET_CONFIG          1
#define EFFECT_CMD_RESET               2
#define EFFECT_CMD_ENABLE              3
#define EFFECT_CMD_DISABLE             4
#define EFFECT_CMD_SET_PARAM           5
#define EFFECT_CMD_SET_PARAM_DEFERRED  6  /* not impl in our engine */
#define EFFECT_CMD_SET_PARAM_COMMIT    7  /* not impl in our engine */
#define EFFECT_CMD_GET_PARAM           8
#define EFFECT_CMD_SET_DEVICE          9
#define EFFECT_CMD_SET_VOLUME         10
#define EFFECT_CMD_SET_AUDIO_MODE     11
#define EFFECT_CMD_SET_CONFIG_REVERSE 12  /* not impl in our engine */
#define EFFECT_CMD_SET_INPUT_DEVICE   13  /* not impl in our engine */
#define EFFECT_CMD_GET_CONFIG         14  /* not impl in our engine */
#define EFFECT_CMD_GET_CONFIG_REVERSE 15
/* 16..19: feature/source/offload — not impl. 0x10000+ proprietary. */

typedef struct {
    int32_t  status;
    uint32_t psize;
    uint32_t vsize;
    /* followed by parameter data, then value data */
} effect_param_t;

#endif

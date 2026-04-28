/*
 * ddp_protocol.h — DolbyX pipe protocol definitions
 *
 * Shared between ddp_processor.c and the bridge/VST.
 * All values are little-endian uint32/int16.
 */
#ifndef DDP_PROTOCOL_H
#define DDP_PROTOCOL_H

#include <stdint.h>

/* ── Startup ──────────────────────────────────────────────────────── */

#define DDP_READY_MAGIC     0xDD901DAA

/* ── Audio Processing ─────────────────────────────────────────────── */

/*
 * Normal audio frame:
 *   Client → Processor: uint32 frame_count + int16[frames * 2]
 *   Processor → Client: int16[frames * 2]
 *
 * frame_count must be 1..65536.
 */

/* ── Control Commands (frame_count 0xFFFFFFF0–0xFFFFFFFF) ─────────── */

/*
 * CMD_SET_PARAM: Change a single DDP parameter.
 *   Client → Proc: uint32 0xFFFFFFF0 + uint16 param_index + int16 value
 *   Proc → Client: uint32 status (0 = success)
 */
#define DDP_CMD_SET_PARAM   0xFFFFFFF0

/*
 * CMD_SET_PROFILE: Switch to a different profile (0-5).
 *   Client → Proc: uint32 0xFFFFFFF1 + uint32 profile_id
 *   Proc → Client: uint32 status (0 = success)
 *
 *   Profile IDs: 0=Movie, 1=Music, 2=Game, 3=Voice, 4=Custom1, 5=Custom2
 */
#define DDP_CMD_SET_PROFILE 0xFFFFFFF1

/*
 * CMD_GET_VIS: Request visualizer band levels.
 *   Client → Proc: uint32 0xFFFFFFF2
 *   Proc → Client: int16[20] band_levels
 */
#define DDP_CMD_GET_VIS     0xFFFFFFF2

/*
 * CMD_SHUTDOWN: Terminate the processor.
 *   Client → Proc: uint32 0xFFFFFFFF
 */
#define DDP_CMD_SHUTDOWN    0xFFFFFFFF

/*
 * CMD_PING: Heartbeat check.
 *   Client → Proc: uint32 0xFFFFFFFD
 *   Proc → Client: uint32 0xFFFFFFFD
 */
#define DDP_CMD_PING        0xFFFFFFFD

/* ── Parameter Indices ────────────────────────────────────────────── */

/*
 * These indices match the order in the DS_PARAM_DEFINE_PARAMS call
 * inside ddp_processor.c setup_default_music_headphone().
 *
 * The processor defines parameters in this order and maps them 1:1
 * to settings indices, so param_index N sets the Nth parameter.
 */
enum {
    DDP_PARAM_ENDP = 0,   /* Endpoint (0=speaker, 2=headphone) */
    DDP_PARAM_VDHE,       /* Dolby Headphone enable (0/1/2=auto) */
    DDP_PARAM_DHSB,       /* Headphone surround boost (0-192) */
    DDP_PARAM_DSSB,       /* Speaker surround boost (0-192) */
    DDP_PARAM_DSSF,       /* Speaker start frequency */
    DDP_PARAM_NGON,       /* Next Gen Surround (0/1/2=auto) */
    DDP_PARAM_DVLA,       /* Volume Leveler amount (0-10) */
    DDP_PARAM_DVLE,       /* Volume Leveler enable (0/1) */
    DDP_PARAM_DVME,       /* Volume Modeler enable (0/1) */
    DDP_PARAM_IEON,       /* Intelligent EQ enable (0/1) */
    DDP_PARAM_IEA,        /* Intelligent EQ amount (0-16) */
    DDP_PARAM_DEON,       /* Dialog Enhancer enable (0/1) */
    DDP_PARAM_DEA,        /* Dialog Enhancement amount (0-16) */
    DDP_PARAM_DED,        /* Dialog Enhancement ducking (0-16) */
    DDP_PARAM_PLMD,       /* Peak Limiter mode (1-4, 4=auto) */
    DDP_PARAM_AOON,       /* Audio Optimizer (0/1/2=auto) */
    DDP_PARAM_VMB,        /* Volume Maximizer boost (0-192) */
    DDP_PARAM_VMON,       /* Volume Maximizer enable (0/1/2) */
    DDP_PARAM_GEON,       /* Graphic EQ enable (0/1) */
    DDP_PARAM_PLB,        /* Peak Limiter boost */
    DDP_PARAM_COUNT       /* Total number of parameters */
};

/* ── Profile Definitions ──────────────────────────────────────────── */

#define DDP_PROFILE_MOVIE   0
#define DDP_PROFILE_MUSIC   1
#define DDP_PROFILE_GAME    2
#define DDP_PROFILE_VOICE   3
#define DDP_PROFILE_USER1   4
#define DDP_PROFILE_USER2   5
#define DDP_PROFILE_COUNT   6

/* ── IEQ Presets ──────────────────────────────────────────────────── */

#define DDP_IEQ_OPEN     0
#define DDP_IEQ_RICH     1
#define DDP_IEQ_FOCUSED  2
#define DDP_IEQ_MANUAL   3

#endif /* DDP_PROTOCOL_H */

/*
 * CMD_SET_IEQ_PRESET: Switch IEQ target curve (open/rich/focused).
 *   Client → Proc: uint32 0xFFFFFFEF + uint32 preset_id (0-2)
 *   Proc → Client: uint32 status (0 = success)
 */
#define DDP_CMD_SET_IEQ_PRESET 0xFFFFFFEF


/*
 * CMD_SET_GAIN: Change pre/post gain.
 *   Client → Proc: uint32 0xFFFFFFEE + int16 pre_gain_x10 + int16 post_gain_x10
 *     (gain values in 0.1dB units: -60 = -6.0dB, 30 = +3.0dB)
 *   Proc → Client: uint32 status
 */
#define DDP_CMD_SET_GAIN 0xFFFFFFEE


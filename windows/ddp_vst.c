/*
 * ddp_vst.c — DolbyX VST2 (Named Pipe, Batch Protocol)
 *
 * Sends entire audio blocks to dolbyx-bridge.exe via \\.\pipe\DolbyX.
 * Bridge handles internal chunking and processor communication.
 *
 * Build: x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"

#define DDP_UNIQUE_ID       0x44445031
#define DDP_VERSION         160
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512
#define MAX_FRAMES          131072
#define READY_MAGIC         0xDD901DAA
#define CMD_SHUTDOWN        0xFFFFFFFF
#define PIPE_NAME           "\\\\.\\pipe\\DolbyX"

typedef struct {
    HANDLE hPipe;
    int16_t* pcm_buf;     /* single buffer for both in and out */
    int connected;
    int bypass;
    int block_count;
    float sample_rate;
    char dll_dir[512];
    FILE* logfp;
    audioMasterCallback master;
} DDPState;

static void open_log(DDPState* st) {
    char p[600];
    snprintf(p, sizeof(p), "%s\\DolbyDDP.log", st->dll_dir);
    st->logfp = fopen(p, "a");
    if (!st->logfp) st->logfp = fopen("C:\\Users\\Public\\DolbyDDP.log", "a");
    if (!st->logfp) { char t[MAX_PATH]; GetTempPathA(sizeof(t),t);
        snprintf(p,sizeof(p),"%sDolbyDDP.log",t); st->logfp=fopen(p,"a"); }
}

static void logf_(DDPState* st, const char* fmt, ...) {
    if (!st||!st->logfp) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(st->logfp,"[%02d:%02d:%02d.%03d PID:%lu] ",
        t.wHour,t.wMinute,t.wSecond,t.wMilliseconds,(unsigned long)GetCurrentProcessId());
    va_list a; va_start(a,fmt); vfprintf(st->logfp,fmt,a); va_end(a);
    fflush(st->logfp);
}

static BOOL p_read(HANDLE h, void* buf, DWORD n) {
    DWORD t=0; while(t<n){DWORD r=0;
    if(!ReadFile(h,(BYTE*)buf+t,n-t,&r,NULL)||r==0)return FALSE;t+=r;} return TRUE;
}
static BOOL p_write(HANDLE h, const void* buf, DWORD n) {
    DWORD t=0; while(t<n){DWORD w=0;
    if(!WriteFile(h,(const BYTE*)buf+t,n-t,&w,NULL)||w==0)return FALSE;t+=w;} return TRUE;
}

static void get_dll_dir(char* buf, size_t sz) {
    HMODULE hm=NULL;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,(LPCSTR)&get_dll_dir,&hm);
    GetModuleFileNameA(hm,buf,(DWORD)sz);
    char*p=strrchr(buf,'\\'); if(p)*p='\0';
}

/* ── Connect to bridge ───────────────────────────────────────────── */

static int connect_bridge(DDPState* st) {
    if (st->connected) return 0;
    st->hPipe = CreateFileA(PIPE_NAME, GENERIC_READ|GENERIC_WRITE,
                            0, NULL, OPEN_EXISTING, 0, NULL);
    if (st->hPipe == INVALID_HANDLE_VALUE) {
        logf_(st, "Pipe open FAILED: err=%lu\n", GetLastError());
        return -1;
    }
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(st->hPipe, &mode, NULL, NULL);

    DWORD magic = 0;
    if (!p_read(st->hPipe, &magic, 4) || magic != READY_MAGIC) {
        logf_(st, "Bad magic: 0x%08X\n", magic);
        CloseHandle(st->hPipe); st->hPipe = INVALID_HANDLE_VALUE;
        return -1;
    }
    logf_(st, "Connected!\n");
    st->connected = 1; st->bypass = 0; st->block_count = 0;
    return 0;
}

static void disconnect_bridge(DDPState* st) {
    if (!st->connected) return;
    DWORD cmd = CMD_SHUTDOWN;
    p_write(st->hPipe, &cmd, 4);
    CloseHandle(st->hPipe); st->hPipe = INVALID_HANDLE_VALUE;
    st->connected = 0;
    logf_(st, "Disconnected after %d blocks\n", st->block_count);
}

/* ── processReplacing (batch mode) ───────────────────────────────── */
/*
 * Send entire block in ONE pipe write, receive in ONE pipe read.
 * Bridge handles internal 256-frame chunking and processor pipelining.
 * Result: 2 IPC operations instead of 512 per EqualizerAPO block.
 */

static void ddp_processReplacing(struct AEffect* effect,
                                  float** inputs, float** outputs,
                                  int32_t sampleFrames) {
    DDPState* st = (DDPState*)effect->object;

    if (!st->connected && !st->bypass) {
        if (connect_bridge(st) != 0) { st->bypass = 1; }
    }

    if (!st->connected || st->bypass || sampleFrames <= 0) {
        if (inputs[0]!=outputs[0]) memcpy(outputs[0],inputs[0],sampleFrames*sizeof(float));
        if (inputs[1]!=outputs[1]) memcpy(outputs[1],inputs[1],sampleFrames*sizeof(float));
        return;
    }

    int frames = sampleFrames;
    if (frames > MAX_FRAMES) frames = MAX_FRAMES;

    /* Float → int16 interleaved (entire block at once) */
    for (int i = 0; i < frames; i++) {
        float l = inputs[0][i], r = inputs[1][i];
        if (l > 1.0f) l = 1.0f; if (l < -1.0f) l = -1.0f;
        if (r > 1.0f) r = 1.0f; if (r < -1.0f) r = -1.0f;
        st->pcm_buf[i*2]   = (int16_t)(l * 32767.0f);
        st->pcm_buf[i*2+1] = (int16_t)(r * 32767.0f);
    }

    /* Send: frame_count + entire PCM block */
    DWORD fc = (DWORD)frames;
    DWORD pcm_bytes = frames * 2 * sizeof(int16_t);

    if (!p_write(st->hPipe, &fc, 4) ||
        !p_write(st->hPipe, st->pcm_buf, pcm_bytes)) {
        logf_(st, "Write FAILED at block %d\n", st->block_count);
        st->connected = 0; st->bypass = 1;
        memcpy(outputs[0],inputs[0],sampleFrames*sizeof(float));
        memcpy(outputs[1],inputs[1],sampleFrames*sizeof(float));
        return;
    }

    /* Receive: entire processed PCM block */
    if (!p_read(st->hPipe, st->pcm_buf, pcm_bytes)) {
        logf_(st, "Read FAILED at block %d\n", st->block_count);
        st->connected = 0; st->bypass = 1;
        memcpy(outputs[0],inputs[0],sampleFrames*sizeof(float));
        memcpy(outputs[1],inputs[1],sampleFrames*sizeof(float));
        return;
    }

    /* Int16 → float (entire block at once) */
    const float scale = 1.0f / 32767.0f;
    for (int i = 0; i < frames; i++) {
        outputs[0][i] = (float)st->pcm_buf[i*2]   * scale;
        outputs[1][i] = (float)st->pcm_buf[i*2+1] * scale;
    }
    for (int i = frames; i < sampleFrames; i++) {
        outputs[0][i] = 0.0f; outputs[1][i] = 0.0f;
    }

    st->block_count++;
    if (st->block_count <= 3 || st->block_count % 5000 == 0)
        logf_(st, "Block %d: %d frames\n", st->block_count, frames);
}

/* ── Param/Dispatch (unchanged) ──────────────────────────────────── */

static float ddp_getParam(struct AEffect*e,int32_t i){
    DDPState*st=(DDPState*)e->object;return(i==0&&st)?st->bypass?1.f:0.f:0.f;}
static void ddp_setParam(struct AEffect*e,int32_t i,float v){
    DDPState*st=(DDPState*)e->object;if(i==0&&st){
    if(v>0.5f&&!st->bypass)disconnect_bridge(st);st->bypass=(v>0.5f)?1:0;}}

static intptr_t ddp_dispatch(struct AEffect* e,
    int32_t op,int32_t idx,intptr_t val,void*ptr,float opt){
    DDPState*st=(DDPState*)e->object;
    switch(op){
    case effOpen:{
        get_dll_dir(st->dll_dir,sizeof(st->dll_dir));
        open_log(st);
        char exe[MAX_PATH]={0}; GetModuleFileNameA(NULL,exe,sizeof(exe));
        logf_(st,"\n===== DolbyX VST opened (batch pipe) =====\n");
        logf_(st,"Host: %s\n",exe);
        st->pcm_buf=(int16_t*)malloc(MAX_FRAMES*2*sizeof(int16_t));
        if(connect_bridge(st)!=0)
            logf_(st,"effOpen: bridge not running\n");
        return 0;}
    case effClose:
        logf_(st,"effClose: %d blocks\n",st->block_count);
        disconnect_bridge(st);
        if(st->logfp)fclose(st->logfp);
        free(st->pcm_buf);free(st);e->object=NULL;return 0;
    case effSetSampleRate:
        if(st){st->sample_rate=opt;logf_(st,"Rate:%.0f\n",opt);}return 0;
    case effSetBlockSize:
        if(st)logf_(st,"BlockSize:%d\n",(int)val);return 0;
    case effMainsChanged:
        if(st){logf_(st,"Mains:%d\n",(int)val);
        if(val&&!st->connected&&!st->bypass)connect_bridge(st);}return 0;
    case effGetEffectName:strcpy((char*)ptr,"DolbyX DDP");return 1;
    case effGetVendorString:strcpy((char*)ptr,"DolbyX");return 1;
    case effGetProductString:strcpy((char*)ptr,"Dolby Digital Plus");return 1;
    case effGetVendorVersion:return DDP_VERSION;
    case effGetVstVersion:return kVstVersion;
    case effGetPlugCategory:return kPlugCategEffect;
    case effCanDo:
        if(ptr&&!strcmp((char*)ptr,"receiveVstEvents"))return-1;
        if(ptr&&!strcmp((char*)ptr,"receiveVstMidiEvent"))return-1;
        return 0;
    case effGetParamName:case effGetParamLabel:case effGetParamDisplay:
        if(idx==0&&ptr){strcpy((char*)ptr,op==effGetParamDisplay?
            (st->bypass?"ON":"OFF"):"Bypass");return 1;}return 0;
    default:return 0;}
}

#ifdef __cplusplus
extern "C" {
#endif
VST_EXPORT struct AEffect* VSTPluginMain(audioMasterCallback m){
    if(!m||!m(NULL,audioMasterVersion,0,0,NULL,0.f))return NULL;
    DDPState*st=(DDPState*)calloc(1,sizeof(DDPState));if(!st)return NULL;
    st->master=m;st->sample_rate=48000.f;st->hPipe=INVALID_HANDLE_VALUE;
    struct AEffect*e=(struct AEffect*)calloc(1,sizeof(struct AEffect));
    if(!e){free(st);return NULL;}
    e->magic=0x56737450;e->dispatcher=ddp_dispatch;
    e->setParameter=ddp_setParam;e->getParameter=ddp_getParam;
    e->numPrograms=1;e->numParams=1;
    e->numInputs=DDP_NUM_CHANNELS;e->numOutputs=DDP_NUM_CHANNELS;
    e->flags=effFlagsCanReplacing;e->initialDelay=DDP_LATENCY_SAMPLES;
    e->object=st;e->uniqueID=DDP_UNIQUE_ID;e->version=DDP_VERSION;
    e->processReplacing=ddp_processReplacing;return e;}
VST_EXPORT struct AEffect*main_entry(audioMasterCallback m){return VSTPluginMain(m);}
#ifdef __cplusplus
}
#endif
BOOL WINAPI DllMain(HINSTANCE h,DWORD r,LPVOID p){(void)h;(void)r;(void)p;return TRUE;}

/*
 * ddp_ui.c — DolbyX VST Editor UI
 *
 * Fixed 720x460. Per-profile persistence via DolbyX.ini.
 */

#include <windows.h>
#include <stdio.h>
#include <math.h>
#include "ddp_ui.h"

/* Layout */
#define LM  20
#define CW  (UI_WIDTH - 2*LM)
#define HEADER_H  48
#define PROF_Y    56
#define PROF_H    40
#define VIS_Y     108
#define VIS_H     100
#define TOG_Y     220
#define TOG_ROW   44
#define IEQ_LBL_Y 360
#define IEQ_Y     378
#define IEQ_H     38
#define SL_X      300
#define SL_W      220
#define TOG_X     640
#define TOG_W     50
#define TOG_SH    26

/* ── Control pipe ─────────────────────────────────────────────────── */

#define CTRL_PIPE "\\\\.\\pipe\\DolbyXCtrl"

static BOOL cpr(HANDLE h, void *b, DWORD n) {
    DWORD t=0; while(t<n){DWORD r=0;
    if(!ReadFile(h,(BYTE*)b+t,n-t,&r,NULL)||!r)return FALSE;t+=r;}return TRUE;}
static BOOL cpw(HANDLE h, const void *b, DWORD n) {
    DWORD t=0; while(t<n){DWORD w=0;
    if(!WriteFile(h,(const BYTE*)b+t,n-t,&w,NULL)||!w)return FALSE;t+=w;}return TRUE;}

static void cc(DDPUI *ui) {
    if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) return;
    for (int i=0;i<3;i++) {
        ui->ctrl_pipe = CreateFileA(CTRL_PIPE,GENERIC_READ|GENERIC_WRITE,0,NULL,OPEN_EXISTING,0,NULL);
        if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) break;
        if (GetLastError()==ERROR_PIPE_BUSY) WaitNamedPipeA(CTRL_PIPE,1000); else break;
    }
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) return;
    DWORD m=PIPE_READMODE_BYTE; SetNamedPipeHandleState(ui->ctrl_pipe,&m,NULL,NULL);
    DWORD mg=0;
    if (!cpr(ui->ctrl_pipe,&mg,4)||mg!=DDP_READY_MAGIC)
        {CloseHandle(ui->ctrl_pipe);ui->ctrl_pipe=INVALID_HANDLE_VALUE;}
}

static void cd(DDPUI *ui) {
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) return;
    DWORD c=DDP_CMD_SHUTDOWN; cpw(ui->ctrl_pipe,&c,4);
    CloseHandle(ui->ctrl_pipe); ui->ctrl_pipe=INVALID_HANDLE_VALUE;
}

static void sp(DDPUI *ui, int idx, int16_t val) {
    CUR_P(ui)[idx]=val;
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) cc(ui);
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) return;
    DWORD c=DDP_CMD_SET_PARAM; uint16_t pi=idx;
    cpw(ui->ctrl_pipe,&c,4); cpw(ui->ctrl_pipe,&pi,2); cpw(ui->ctrl_pipe,&val,2);
    DWORD s=0; cpr(ui->ctrl_pipe,&s,4);
}

static void spr(DDPUI *ui, int pid) {
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    ui->profile=pid;
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) cc(ui);
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) return;
    DWORD c=DDP_CMD_SET_PROFILE; DWORD id=pid;
    cpw(ui->ctrl_pipe,&c,4); cpw(ui->ctrl_pipe,&id,4);
    DWORD s=0; cpr(ui->ctrl_pipe,&s,4);
    /* Apply saved overrides */
    int16_t *p=CUR_P(ui);
    for (int i=1;i<DDP_PARAM_COUNT;i++) sp(ui,i,p[i]);
    int ieq=CUR_IEQ(ui);
    if (ieq!=DDP_IEQ_MANUAL&&ieq>=0&&ieq<=2) {
        sp(ui,DDP_PARAM_IEON,1); sp(ui,DDP_PARAM_IEA,10);
        DWORD ic=DDP_CMD_SET_IEQ_PRESET; DWORD ip=ieq;
        cpw(ui->ctrl_pipe,&ic,4); cpw(ui->ctrl_pipe,&ip,4);
        DWORD is=0; cpr(ui->ctrl_pipe,&is,4);
    }
}

static void siq(DDPUI *ui, int preset) {
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) cc(ui);
    if (ui->ctrl_pipe==INVALID_HANDLE_VALUE) return;
    DWORD c=DDP_CMD_SET_IEQ_PRESET; DWORD p=preset;
    cpw(ui->ctrl_pipe,&c,4); cpw(ui->ctrl_pipe,&p,4);
    DWORD s=0; cpr(ui->ctrl_pipe,&s,4);
}

/* ── Config persistence ───────────────────────────────────────────── */

static const char *g_secs[]={"Movie","Music","Game","Voice","Custom1","Custom2"};
static const char *g_keys[]={"endp","vdhe","dhsb","dssb","dssf","ngon","dvla",
    "dvle","dvme","ieon","iea","deon","dea","ded","plmd","aoon","vmb","vmon","geon","plb"};

static void save_cfg(DDPUI *ui) {
    if (!ui->config_path[0]) return;
    char v[32];
    snprintf(v,sizeof(v),"%d",ui->profile);
    WritePrivateProfileStringA("DolbyX","profile",v,ui->config_path);
    snprintf(v,sizeof(v),"%d",ui->power);
    WritePrivateProfileStringA("DolbyX","power",v,ui->config_path);
    for(int p=0;p<DDP_PROFILE_USER_COUNT;p++) {
        for (int i=0;i<DDP_PARAM_COUNT;i++) {
            snprintf(v,sizeof(v),"%d",ui->profiles[p].params[i]);
            WritePrivateProfileStringA(g_secs[p],g_keys[i],v,ui->config_path);
        }
        snprintf(v,sizeof(v),"%d",ui->profiles[p].ieq_mode);
        WritePrivateProfileStringA(g_secs[p],"ieq_mode",v,ui->config_path);
    }
}

static void load_cfg(DDPUI *ui) {
    if (!ui->config_path[0]) return;
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    ui->profile=GetPrivateProfileIntA("DolbyX","profile",DDP_PROFILE_MUSIC,ui->config_path);
    ui->power=GetPrivateProfileIntA("DolbyX","power",1,ui->config_path);
    if (ui->profile<0||ui->profile>=DDP_PROFILE_USER_COUNT) ui->profile=DDP_PROFILE_MUSIC;
    for(int p=0;p<DDP_PROFILE_USER_COUNT;p++) {
        for (int i=0;i<DDP_PARAM_COUNT;i++)
            ui->profiles[p].params[i]=(int16_t)GetPrivateProfileIntA(
                g_secs[p],g_keys[i],g_profiles[p][i],ui->config_path);
        ui->profiles[p].ieq_mode=GetPrivateProfileIntA(g_secs[p],"ieq_mode",
            DDP_IEQ_MANUAL,ui->config_path);
    }
}

/* ── Drawing ──────────────────────────────────────────────────────── */

static void fill(HDC d,int x,int y,int w,int h,COLORREF c){
    RECT r={x,y,x+w,y+h};HBRUSH b=CreateSolidBrush(c);FillRect(d,&r,b);DeleteObject(b);}
static void rrect(HDC d,int x,int y,int w,int h,int r,COLORREF f,COLORREF b){
    HBRUSH br=CreateSolidBrush(f);HPEN p=CreatePen(PS_SOLID,1,b);
    SelectObject(d,br);SelectObject(d,p);RoundRect(d,x,y,x+w,y+h,r,r);
    DeleteObject(br);DeleteObject(p);}
static void txt(HDC d,int x,int y,const char*s,HFONT f,COLORREF c){
    SelectObject(d,f);SetTextColor(d,c);SetBkMode(d,TRANSPARENT);
    TextOutA(d,x,y,s,(int)strlen(s));}
static void txtc(HDC d,int x,int y,int w,int h,const char*s,HFONT f,COLORREF c){
    RECT r={x,y,x+w,y+h};SelectObject(d,f);SetTextColor(d,c);SetBkMode(d,TRANSPARENT);
    DrawTextA(d,s,-1,&r,DT_CENTER|DT_VCENTER|DT_SINGLELINE);}

static void draw_slider(HDC d,int x,int y,int w,int v,int mn,int mx){
    int ty=y+10; float t=(mx>mn)?(float)(v-mn)/(float)(mx-mn):0;
    int fw=(int)(w*t);
    rrect(d,x,ty,w,6,3,COL_SLIDER_BG,COL_SLIDER_BG);
    if(fw>0)rrect(d,x,ty,fw,6,3,COL_ACCENT,COL_ACCENT);
    int tx=x+fw-7;if(tx<x)tx=x;
    HBRUSH b=CreateSolidBrush(COL_ACCENT_BR);HPEN p=CreatePen(PS_SOLID,1,COL_ACCENT_BR);
    SelectObject(d,b);SelectObject(d,p);Ellipse(d,tx,ty-5,tx+14,ty+11);
    DeleteObject(b);DeleteObject(p);}

static void draw_toggle(HDC d,int x,int y,int on){
    rrect(d,x,y,TOG_W,TOG_SH,TOG_SH,on?COL_GREEN:COL_BORDER,on?COL_GREEN:COL_BORDER);
    int kx=on?x+TOG_W-TOG_SH+3:x+3;
    HBRUSH b=CreateSolidBrush(RGB(255,255,255));HPEN p=CreatePen(PS_SOLID,1,RGB(255,255,255));
    SelectObject(d,b);SelectObject(d,p);Ellipse(d,kx,y+3,kx+TOG_SH-6,y+TOG_SH-3);
    DeleteObject(b);DeleteObject(p);}

static void paint(DDPUI *ui) {
    HDC d=ui->memdc; int16_t *P=CUR_P(ui);
    fill(d,0,0,UI_WIDTH,UI_HEIGHT,COL_BG);

    /* Header */
    fill(d,0,0,UI_WIDTH,HEADER_H,COL_PANEL);
    COLORREF pc=ui->power?COL_ACCENT:COL_BORDER;
    HBRUSH pb=CreateSolidBrush(COL_PANEL);HPEN pp=CreatePen(PS_SOLID,2,pc);
    SelectObject(d,pb);SelectObject(d,pp);Ellipse(d,14,10,42,38);
    DeleteObject(pb);DeleteObject(pp);
    pp=CreatePen(PS_SOLID,2,pc);SelectObject(d,pp);
    MoveToEx(d,28,14,NULL);LineTo(d,28,22);DeleteObject(pp);
    txt(d,52,12,"DOLBY",ui->font_title,COL_ACCENT);
    /* Reset Profile button — top right */
    rrect(d,UI_WIDTH-LM-90,12,86,24,6,COL_SURFACE,COL_BORDER);
    txtc(d,UI_WIDTH-LM-90,12,86,24,"Reset Profile",ui->font_small,COL_TEXT_DIM);

    /* Profiles */
    static const char*pn[]={"Movie","Music","Game","Voice","Custom 1","Custom 2"};
    int gap=6,bw=(CW-5*gap)/6;
    for(int i=0;i<6;i++){
        int x=LM+i*(bw+gap),a=(i==ui->profile);
        rrect(d,x,PROF_Y,bw,PROF_H,8,a?COL_ACCENT:COL_SURFACE,a?COL_ACCENT:COL_BORDER);
        txtc(d,x,PROF_Y,bw,PROF_H,pn[i],ui->font_normal,a?RGB(0,0,0):COL_TEXT);
    }

    /* Visualizer */
    fill(d,LM,VIS_Y,CW,VIS_H,COL_PANEL);
    for(int i=0;i<20;i++){
        int bw2=(CW-21*2)/20,x=LM+2+i*(bw2+2);
        float lv=0.15f+0.4f*(0.5f+0.5f*sinf(i*0.6f+ui->vis_phase));
        int bh=(int)(VIS_H*lv);
        for(int j=0;j<bh;j++){float t=(float)j/VIS_H;
            fill(d,x,VIS_Y+VIS_H-1-j,bw2,1,RGB(0,(int)(72+t*140),(int)(96+t*159)));}}

    /* Toggles */
    struct{const char*l;int en,amt,mn,mx;}rows[]={
        {"Volume Leveler",DDP_PARAM_DVLE,DDP_PARAM_DVLA,0,10},
        {"Dialogue Enhancer",DDP_PARAM_DEON,DDP_PARAM_DEA,0,16},
        {"Surround Virtualizer",DDP_PARAM_VDHE,DDP_PARAM_DHSB,0,192}};
    for(int i=0;i<3;i++){
        int y=TOG_Y+i*TOG_ROW;
        txt(d,LM,y+12,rows[i].l,ui->font_normal,COL_TEXT);
        draw_slider(d,LM+SL_X,y+8,SL_W,P[rows[i].amt],rows[i].mn,rows[i].mx);
        char vb[16];snprintf(vb,sizeof(vb),"%d",P[rows[i].amt]);
        txt(d,LM+SL_X+SL_W+10,y+12,vb,ui->font_small,COL_TEXT_DIM);
        draw_toggle(d,LM+TOG_X,y+9,P[rows[i].en]>0);
        if(i<2){HPEN s=CreatePen(PS_SOLID,1,RGB(20,28,40));SelectObject(d,s);
            MoveToEx(d,LM,y+TOG_ROW-1,NULL);LineTo(d,LM+CW,y+TOG_ROW-1);DeleteObject(s);}}

    /* IEQ */
    static const char*mn[]={"Open","Rich","Focused","Manual"};
    int ieq=CUR_IEQ(ui);
    const char*il=(ieq==DDP_IEQ_MANUAL)?"Graphic EQ":"Intelligent EQ";
    char lb[64];snprintf(lb,sizeof(lb),"%s:  %s",il,mn[ieq]);
    txt(d,LM,IEQ_LBL_Y,lb,ui->font_small,COL_TEXT_DIM);
    int igap=8,ibw=(CW-3*igap)/4;
    for(int i=0;i<4;i++){
        int x=LM+i*(ibw+igap),a=(i==ieq);
        rrect(d,x,IEQ_Y,ibw,IEQ_H,8,a?RGB(0,30,50):COL_SURFACE,a?COL_ACCENT:COL_BORDER);
        txtc(d,x,IEQ_Y,ibw,IEQ_H,mn[i],ui->font_normal,a?COL_ACCENT_BR:COL_TEXT);}

    ui->vis_phase+=0.1f;
}

/* Hit testing */
static int hp(int mx,int my){if(my<PROF_Y||my>=PROF_Y+PROF_H)return-1;
    int g=6,bw=(CW-5*g)/6,c=(mx-LM)/(bw+g);return(c>=0&&c<6)?c:-1;}
static int hr(int mx,int my){return mx>=UI_WIDTH-LM-90&&mx<=UI_WIDTH-LM&&
    my>=12&&my<=36;}
static int ht(int mx,int my){for(int i=0;i<3;i++){int y=TOG_Y+i*TOG_ROW;
    if(mx>=LM+TOG_X&&mx<=LM+TOG_X+TOG_W&&my>=y+6&&my<=y+6+TOG_SH)return i;}return-1;}
static int hs(int mx,int my){for(int i=0;i<3;i++){int y=TOG_Y+i*TOG_ROW;
    if(mx>=LM+SL_X&&mx<=LM+SL_X+SL_W&&my>=y+4&&my<=y+4+30)return i;}return-1;}
static int hi(int mx,int my){if(my<IEQ_Y||my>=IEQ_Y+IEQ_H)return-1;
    int g=8,bw=(CW-3*g)/4,c=(mx-LM)/(bw+g);return(c>=0&&c<4)?c:-1;}
static int sv(int mx,int sx,int sw,int mn,int mx2){
    float t=(float)(mx-sx)/(float)sw;if(t<0)t=0;if(t>1)t=1;
    return mn+(int)(t*(mx2-mn)+0.5f);}

static const int gen[]={DDP_PARAM_DVLE,DDP_PARAM_DEON,DDP_PARAM_VDHE};
static const int gam[]={DDP_PARAM_DVLA,DDP_PARAM_DEA,DDP_PARAM_DHSB};
static const int gmn[]={0,0,0},gmx[]={10,16,192},gov[]={1,1,2};

static LRESULT CALLBACK wndp(HWND hw,UINT msg,WPARAM wp,LPARAM lp){
    DDPUI*ui=(DDPUI*)GetWindowLongPtrA(hw,GWLP_USERDATA);
    switch(msg){
    case WM_PAINT:{if(!ui)break;PAINTSTRUCT ps;HDC hdc=BeginPaint(hw,&ps);
        paint(ui);BitBlt(hdc,0,0,UI_WIDTH,UI_HEIGHT,ui->memdc,0,0,SRCCOPY);
        EndPaint(hw,&ps);return 0;}
    case WM_TIMER:if(ui)InvalidateRect(hw,NULL,FALSE);return 0;
    case WM_LBUTTONDOWN:{if(!ui)break;int mx=LOWORD(lp),my=HIWORD(lp);
        /* Power */
        if(mx>=14&&mx<=42&&my>=10&&my<=38){
            ui->power=!ui->power;save_cfg(ui);
            if(ui->power){
                /* ON: restore previous profile */
                spr(ui,ui->profile);
            } else {
                /* OFF: switch to OFF profile (graceful fade) */
                if(ui->ctrl_pipe==INVALID_HANDLE_VALUE)cc(ui);
                if(ui->ctrl_pipe!=INVALID_HANDLE_VALUE){
                    DWORD c=DDP_CMD_SET_PROFILE,p=DDP_PROFILE_OFF;
                    cpw(ui->ctrl_pipe,&c,4);cpw(ui->ctrl_pipe,&p,4);
                    DWORD s=0;cpr(ui->ctrl_pipe,&s,4);}
            }
            InvalidateRect(hw,NULL,FALSE);return 0;}
        /* Reset */
        if(hr(mx,my)){extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
            memcpy(CUR_P(ui),g_profiles[ui->profile],sizeof(int16_t)*DDP_PARAM_COUNT);
            CUR_IEQ(ui)=DDP_IEQ_MANUAL;spr(ui,ui->profile);save_cfg(ui);
            InvalidateRect(hw,NULL,FALSE);return 0;}
        /* Profile */
        int p=hp(mx,my);
        if(p>=0&&p!=ui->profile){spr(ui,p);save_cfg(ui);
            InvalidateRect(hw,NULL,FALSE);return 0;}
        /* Toggle */
        int t=ht(mx,my);
        if(t>=0){int c=CUR_P(ui)[gen[t]];sp(ui,gen[t],(c>0)?0:gov[t]);save_cfg(ui);
            InvalidateRect(hw,NULL,FALSE);return 0;}
        /* Slider */
        int s=hs(mx,my);
        if(s>=0){ui->drag_slider=s;ui->drag_param=gam[s];
            ui->drag_x0=LM+SL_X;ui->drag_w=SL_W;ui->drag_min=gmn[s];ui->drag_max=gmx[s];
            SetCapture(hw);sp(ui,gam[s],(int16_t)sv(mx,LM+SL_X,SL_W,gmn[s],gmx[s]));
            InvalidateRect(hw,NULL,FALSE);return 0;}
        /* IEQ */
        int q=hi(mx,my);
        if(q>=0&&q!=CUR_IEQ(ui)){CUR_IEQ(ui)=q;
            if(q==DDP_IEQ_MANUAL){sp(ui,DDP_PARAM_IEON,0);sp(ui,DDP_PARAM_GEON,1);}
            else{sp(ui,DDP_PARAM_GEON,0);sp(ui,DDP_PARAM_IEON,1);
                sp(ui,DDP_PARAM_IEA,10);siq(ui,q);}
            save_cfg(ui);InvalidateRect(hw,NULL,FALSE);return 0;}
        break;}
    case WM_MOUSEMOVE:{if(!ui||ui->drag_slider<0)break;int mx=LOWORD(lp);
        sp(ui,ui->drag_param,(int16_t)sv(mx,ui->drag_x0,ui->drag_w,ui->drag_min,ui->drag_max));
        InvalidateRect(hw,NULL,FALSE);return 0;}
    case WM_LBUTTONUP:if(ui&&ui->drag_slider>=0){ui->drag_slider=-1;ReleaseCapture();
        save_cfg(ui);}return 0;
    case WM_ERASEBKGND:return 1;
    default:break;}
    return DefWindowProcA(hw,msg,wp,lp);}

static const char*UI_CLASS="DolbyXEditor";static int g_reg=0;
void ddpui_register_class(HINSTANCE h){if(g_reg)return;WNDCLASSA w={0};
    w.lpfnWndProc=wndp;w.hInstance=h;w.lpszClassName=UI_CLASS;
    w.hCursor=LoadCursor(NULL,IDC_ARROW);RegisterClassA(&w);g_reg=1;}

DDPUI *ddpui_create(HWND parent, const char *dll_dir) {
    DDPUI *ui=(DDPUI*)calloc(1,sizeof(DDPUI));if(!ui)return NULL;
    ui->ctrl_pipe=INVALID_HANDLE_VALUE;ui->power=1;
    ui->profile=DDP_PROFILE_MUSIC;ui->drag_slider=-1;
    if(dll_dir&&dll_dir[0])snprintf(ui->config_path,sizeof(ui->config_path),
        "%s\\DolbyX.ini",dll_dir);
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    for(int p=0;p<DDP_PROFILE_USER_COUNT;p++){
        memcpy(ui->profiles[p].params,g_profiles[p],sizeof(int16_t)*DDP_PARAM_COUNT);
        ui->profiles[p].ieq_mode=DDP_IEQ_MANUAL;}
    load_cfg(ui);
    ui->font_title=CreateFontA(22,0,0,0,FW_BOLD,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
    ui->font_normal=CreateFontA(15,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
    ui->font_small=CreateFontA(12,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
    ddpui_register_class(GetModuleHandle(NULL));
    ui->hwnd=CreateWindowExA(0,UI_CLASS,"DolbyX",WS_CHILD|WS_VISIBLE,
        0,0,UI_WIDTH,UI_HEIGHT,parent,NULL,GetModuleHandle(NULL),NULL);
    SetWindowLongPtrA(ui->hwnd,GWLP_USERDATA,(LONG_PTR)ui);
    HDC hdc=GetDC(ui->hwnd);
    ui->memdc=CreateCompatibleDC(hdc);
    ui->membmp=CreateCompatibleBitmap(hdc,UI_WIDTH,UI_HEIGHT);
    SelectObject(ui->memdc,ui->membmp);ReleaseDC(ui->hwnd,hdc);
    SetTimer(ui->hwnd,1,33,NULL);
    cc(ui);if(ui->ctrl_pipe!=INVALID_HANDLE_VALUE)spr(ui,ui->profile);
    InvalidateRect(ui->hwnd,NULL,FALSE);return ui;}

void ddpui_destroy(DDPUI *ui){if(!ui)return;save_cfg(ui);KillTimer(ui->hwnd,1);
    cd(ui);DeleteDC(ui->memdc);DeleteObject(ui->membmp);
    DeleteObject(ui->font_title);DeleteObject(ui->font_normal);
    DeleteObject(ui->font_small);DestroyWindow(ui->hwnd);free(ui);}

void ddpui_idle(DDPUI *ui){(void)ui;}

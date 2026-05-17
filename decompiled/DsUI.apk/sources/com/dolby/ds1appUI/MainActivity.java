package com.dolby.ds1appUI;

import android.app.Activity;
import android.app.Dialog;
import android.app.FragmentManager;
import android.app.FragmentTransaction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.AssetFileDescriptor;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.dolby.IDsClientEvents;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import com.dolby.ds1appCoreUI.Configuration;
import com.dolby.ds1appCoreUI.Constants;
import com.dolby.ds1appCoreUI.DS1Application;
import com.dolby.ds1appCoreUI.Tag;
import com.dolby.ds1appCoreUI.Tools;

/* JADX INFO: loaded from: classes.dex */
public class MainActivity extends Activity implements View.OnClickListener, IDsClientEvents, IDsFragSwitchesObserver, IDsFragPowerObserver, IDsFragGraphicVisualizerObserver, IDsFragObserver, IDsFragProfilePresetsObserver, IDsFragProfileEditorObserver, IDsFragEqualizerPresetsObserver, IDsActivityCommonTemp {
    public static final String ACTION_LAUNCH_DS1_INSTOREDEMO_APP = "com.dolby.LAUNCH_DS1_INSTOREDEMO_APP";
    private static final int INSTORE_MENU_ID = 1001;
    private static Configuration configuration;
    private static boolean mEditProfile = false;
    private static long mOnDestroyTimer;
    private ImageView mDSLogo;
    private LinearLayout mLinearLayout;
    private ViewGroup mNativeRootContainer;
    private int mOriginX;
    private int mOriginY;
    private ScrollView mScrollview;
    private Dialog mSplashScreenDialog;
    private final DsClient mDsClient = new DsClient();
    private boolean mDolbyClientConnected = false;
    private final int mSplashScreenDelayTime = 3000;
    private boolean mSplashTimerElapsed = false;
    private boolean mSplashClientBound = false;
    private Runnable mSplashScreenDelay = null;
    private boolean mUseDsApiOnUiEvent = true;
    private boolean mVisualizerRegistered = false;
    private FragProfilePresetEditor mFPPE = null;
    private FragProfilePresets mFPP = null;
    private FragSwitches mFS = null;
    private FragEqualizerPresets mFEP = null;
    private final int DYNAMIC_LINEAR_LAYOUT_ID = 8;
    private boolean mMobileLayout = false;
    private boolean mIsScreenOn = false;
    private boolean mIsActivityRunning = false;
    private boolean mIsMonoSpeaker = false;
    private final BroadcastReceiver mScreenReceiver = new BroadcastReceiver() { // from class: com.dolby.ds1appUI.MainActivity.1
        @Override // android.content.BroadcastReceiver
        public void onReceive(Context context, Intent intent) throws RemoteException {
            FragGraphicVisualizer gv = (FragGraphicVisualizer) MainActivity.this.getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
            if (intent.getAction().equals("android.intent.action.SCREEN_OFF")) {
                Log.d(Tag.MAIN, "ACTION_SCREEN_OFF");
                MainActivity.this.mIsScreenOn = false;
                MainActivity.this.registerVisualizer(MainActivity.this.mIsScreenOn);
                if (gv != null) {
                    gv.setEnabled(MainActivity.this.mIsScreenOn);
                    return;
                }
                return;
            }
            if (intent.getAction().equals("android.intent.action.SCREEN_ON")) {
                Log.d(Tag.MAIN, "ACTION_SCREEN_ON");
                MainActivity.this.mIsScreenOn = true;
                if (gv != null) {
                    gv.setEnabled(MainActivity.this.mIsScreenOn);
                }
                MainActivity.this.registerVisualizer(MainActivity.this.mIsScreenOn);
            }
        }
    };

    public boolean isMonoSpeaker() {
        return this.mIsMonoSpeaker;
    }

    @Override // android.app.Activity
    public void onCreate(Bundle savedInstanceState) {
        ((DS1Application) getApplication()).printScreenSpecs();
        Constants.STATUS_BAR_HEIGHT = getResources().getInteger(R.integer.statusbar_height);
        super.onCreate(savedInstanceState);
        changeScale();
        Assets.init(this);
        requestWindowFeature(1);
        IntentFilter filter = new IntentFilter("android.intent.action.SCREEN_ON");
        filter.addAction("android.intent.action.SCREEN_OFF");
        registerReceiver(this.mScreenReceiver, filter);
        PowerManager pm = (PowerManager) getSystemService("power");
        this.mIsScreenOn = pm.isScreenOn();
        Runnable showMainUi = new Runnable() { // from class: com.dolby.ds1appUI.MainActivity.2
            @Override // java.lang.Runnable
            public void run() {
                MainActivity.this.doInitMainUI();
            }
        };
        if (displaySplashScreen()) {
            DS1Application.HANDLER.postDelayed(showMainUi, 3000L);
        } else {
            showMainUi.run();
        }
    }

    public void changeScale() {
        android.content.res.Configuration sys = getBaseContext().getResources().getConfiguration();
        if (sys.smallestScreenWidthDp >= 480) {
            android.content.res.Configuration conf = new android.content.res.Configuration();
            conf.fontScale = sys.smallestScreenWidthDp / 800.0f;
            getBaseContext().getResources().updateConfiguration(conf, null);
        } else if (sys.smallestScreenWidthDp >= 360) {
            android.content.res.Configuration conf2 = new android.content.res.Configuration();
            conf2.fontScale = sys.smallestScreenWidthDp / 360.0f;
            getBaseContext().getResources().updateConfiguration(conf2, null);
        }
    }

    private boolean displaySplashScreen() {
        boolean isOrientationChange = mOnDestroyTimer > 0 && mOnDestroyTimer + 500 > SystemClock.elapsedRealtime();
        if (isOrientationChange) {
            return false;
        }
        this.mSplashScreenDialog = new Dialog(this, R.layout.splash_screen);
        this.mSplashScreenDialog.setContentView(R.layout.splash_screen);
        this.mSplashScreenDialog.setCancelable(false);
        this.mSplashScreenDialog.show();
        this.mSplashScreenDelay = new Runnable() { // from class: com.dolby.ds1appUI.MainActivity.3
            @Override // java.lang.Runnable
            public void run() {
                MainActivity.this.mSplashTimerElapsed = true;
                DS1Application.HANDLER.removeCallbacks(this);
                MainActivity.this.hideSplashScreen();
            }
        };
        DS1Application.HANDLER.postDelayed(this.mSplashScreenDelay, 3000L);
        return true;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void hideSplashScreen() {
        if (this.mSplashTimerElapsed && this.mSplashClientBound) {
            try {
                this.mSplashScreenDialog.dismiss();
            } catch (Exception e) {
            }
            this.mSplashScreenDialog = null;
            this.mSplashScreenDelay = null;
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void doInitMainUI() {
        try {
            setContentView(R.layout.main);
            this.mDSLogo = (ImageView) findViewById(R.id.dsLogo);
            this.mDSLogo.setOnClickListener(this);
            this.mDSLogo.setSoundEffectsEnabled(false);
            this.mNativeRootContainer = ViewTools.determineNativeViewContainer(this);
            this.mDsClient.setEventListener(this);
            DsClientCache.INSTANCE.reset();
            Log.d(Tag.MAIN, "doInitMainUI - mDsClient.bindDsService");
            this.mDsClient.bindDsService(this);
            if (configuration == null) {
                configuration = Configuration.getInstance(getApplicationContext());
                Log.i(Tag.MAIN, "doInitMainUI - NEW CONFIG:" + configuration.getMaxEditGain() + " : " + configuration.getMinEditGain());
            }
            this.mMobileLayout = getResources().getBoolean(R.bool.newLayout);
            if (this.mMobileLayout) {
                this.mFPP = new FragProfilePresets();
                getFragmentManager().beginTransaction().add(R.id.fragmentcontainer, this.mFPP).commit();
            }
            if (mEditProfile) {
                editProfile();
            }
        } catch (Exception e) {
        }
    }

    private void displayTooltip(View pointToView, CharSequence title, CharSequence text) {
        if (this.mNativeRootContainer != null && pointToView != null) {
            ViewTools.showTooltip(this, this.mNativeRootContainer, pointToView, title, text);
        }
    }

    @Override // android.app.Activity
    protected void onResume() throws RemoteException {
        super.onResume();
        this.mIsActivityRunning = true;
        onDsClientUseChanged(true);
    }

    public static Configuration getConfiguration() {
        return configuration;
    }

    @Override // android.app.Activity
    protected void onPause() throws RemoteException {
        onDsClientUseChanged(false);
        this.mIsActivityRunning = false;
        super.onPause();
    }

    @Override // android.app.Activity
    protected void onDestroy() {
        super.onDestroy();
        mOnDestroyTimer = SystemClock.elapsedRealtime();
        if (this.mSplashScreenDelay != null) {
            DS1Application.HANDLER.removeCallbacks(this.mSplashScreenDelay);
            hideSplashScreen();
        }
        unbindFromDsApi();
        configuration = null;
        unregisterReceiver(this.mScreenReceiver);
    }

    @Override // android.app.Activity
    public boolean onCreateOptionsMenu(Menu menu) {
        super.onCreateOptionsMenu(menu);
        AssetFileDescriptor demoAfd = getResources().openRawResourceFd(R.raw.instore_demo_media);
        AssetFileDescriptor loopAfd = getResources().openRawResourceFd(R.raw.instore_demo_loop);
        if (demoAfd != null && demoAfd.getLength() > 0 && loopAfd != null && loopAfd.getLength() > 0) {
            menu.add(0, INSTORE_MENU_ID, 0, R.string.instore_menu_text);
            return true;
        }
        return true;
    }

    @Override // android.app.Activity
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == INSTORE_MENU_ID) {
            startActivity(new Intent(ACTION_LAUNCH_DS1_INSTOREDEMO_APP));
        }
        return super.onOptionsItemSelected(item);
    }

    private void unbindFromDsApi() {
        if (this.mDolbyClientConnected) {
            this.mDolbyClientConnected = false;
            this.mDsClient.setEventListener((IDsClientEvents) null);
            Log.d(Tag.MAIN, "MainActivity.unBindDsService");
            this.mDsClient.unBindDsService(this);
            DsClientCache.INSTANCE.reset();
        }
    }

    @Override // android.app.Activity, android.view.Window.Callback
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        Window window = getWindow();
        window.setFormat(1);
    }

    @Override // android.app.Activity
    protected void onSaveInstanceState(Bundle outState) {
    }

    @Override // android.app.Activity
    protected void onRestoreInstanceState(Bundle savedInstanceState) {
    }

    @Override // com.dolby.ds1appUI.IDsFragPowerObserver, com.dolby.ds1appUI.IDsFragGraphicVisualizerObserver, com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void onDsClientUseChanged(boolean on) throws RemoteException {
        if (on) {
            if (this.mDolbyClientConnected) {
                FragGraphicVisualizer fgv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
                if (fgv != null) {
                    fgv.updateGraphicEqInUI();
                }
                if (this.mMobileLayout && this.mFEP != null) {
                    this.mFEP.updateGraphicEqInUI();
                }
                boolean dsOn = DsClientCache.INSTANCE.isDsOn();
                internalOnDsOn(dsOn);
                return;
            }
            return;
        }
        if (this.mDolbyClientConnected) {
            registerVisualizer(false);
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragGraphicVisualizerObserver, com.dolby.ds1appUI.IDsFragProfilePresetsObserver, com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void chooseProfile(int profile) throws RemoteException {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        try {
            if (DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient) != profile) {
                DsClientCache.INSTANCE.setSelectedProfile(this.mDsClient, profile);
            }
            if (this.mIsMonoSpeaker) {
                try {
                    this.mDsClient.getProfileSettings(profile).setSpeakerVirtualizerOn(false);
                } catch (Exception e) {
                    e.printStackTrace();
                    onDsApiError();
                    return;
                }
            }
            if (this.mMobileLayout) {
                pp = this.mFPP;
            } else {
                pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
            }
            if (pp != null) {
                String profileName = pp.getItemName(profile);
                pp.setSelection(profile);
                if (this.mMobileLayout) {
                    pe = this.mFPPE;
                } else {
                    pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
                }
                if (pe != null) {
                    pe.cancelPendingEdition();
                }
                onProfileNameChanged(profile, profileName);
            }
            this.mUseDsApiOnUiEvent = false;
            onProfileSettingsChanged(profile, null);
            this.mUseDsApiOnUiEvent = true;
        } catch (Exception e2) {
            e2.printStackTrace();
            onDsApiError();
        }
    }

    @Override // android.view.View.OnClickListener
    public void onClick(View view) {
        int id = view.getId();
        if (R.id.dsLogo == id) {
            FragGraphicVisualizer fgv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
            if (fgv != null) {
                fgv.hideEqualizer();
                return;
            }
            return;
        }
        onDolbyClientUseClick(view);
    }

    private void onDolbyClientUseClick(View view) {
        if (!this.mDolbyClientConnected || !this.mUseDsApiOnUiEvent) {
        }
    }

    public void powerOnOff(boolean on) throws RemoteException {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        FragSwitches swv;
        FragGraphicVisualizer gv;
        FragPower pwv = (FragPower) getFragmentManager().findFragmentById(R.id.fragpower);
        if (pwv != null) {
            pwv.setEnabled(on);
        }
        this.mDSLogo.setImageResource(on ? R.drawable.dslogo : R.drawable.dslogodis);
        if (this.mMobileLayout) {
            if (this.mFEP == null && this.mFPPE == null && this.mFS == null) {
                pp = this.mFPP;
            } else {
                pp = null;
            }
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            pp.setEnabled(on);
        }
        if (this.mMobileLayout) {
            pe = this.mFPPE;
        } else {
            pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
        }
        if (pe != null) {
            pe.setEnabled(on);
        }
        if (this.mMobileLayout) {
            swv = this.mFS;
        } else {
            swv = (FragSwitches) getFragmentManager().findFragmentById(R.id.fragswitches);
        }
        if (swv != null) {
            swv.setEnabled(on);
        }
        if (this.mIsScreenOn && (gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer)) != null) {
            gv.setEnabled(on);
        }
        if (this.mMobileLayout && this.mFEP != null) {
            this.mFEP.setEnabled(on);
        }
    }

    public void onDsOn(boolean on) throws RemoteException {
        boolean cacheOn = DsClientCache.INSTANCE.isDsOn();
        if (cacheOn != on) {
            DsClientCache.INSTANCE.cacheDsOn(on);
            this.mUseDsApiOnUiEvent = false;
            internalOnDsOn(on);
            this.mUseDsApiOnUiEvent = true;
        }
    }

    private void internalOnDsOn(boolean on) throws RemoteException {
        FragProfilePresets pp;
        powerOnOff(on);
        if (on) {
            try {
                int profile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                chooseProfile(profile);
                registerVisualizer(true);
            } catch (Exception e) {
                e.printStackTrace();
                onDsApiError();
                return;
            }
        } else {
            registerVisualizer(false);
        }
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            pp.scheduleNotifyDataSetChanged();
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void registerVisualizer(boolean on) {
        if (this.mDolbyClientConnected && this.mVisualizerRegistered != on && this.mIsScreenOn && this.mIsActivityRunning) {
            this.mVisualizerRegistered = on;
            FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
            if (gv != null) {
                gv.registerVisualizer(on);
            }
        }
    }

    public void onProfileSelected(int profile) throws RemoteException {
        if (this.mDolbyClientConnected) {
            DsClientCache.INSTANCE.cacheSelectedProfile(profile);
            boolean dsOn = DsClientCache.INSTANCE.isDsOn();
            internalOnDsOn(dsOn);
        }
    }

    public void onProfileSettingsChanged(int profile) throws RemoteException {
        this.mUseDsApiOnUiEvent = false;
        onProfileSettingsChanged(profile, null);
        this.mUseDsApiOnUiEvent = true;
    }

    @Override // com.dolby.ds1appUI.IDsFragObserver
    public DsClient getDsClient() {
        return this.mDsClient;
    }

    @Override // com.dolby.ds1appUI.IDsFragSwitchesObserver, com.dolby.ds1appUI.IDsFragGraphicVisualizerObserver, com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void onProfileSettingsChanged(int profile, DsClientSettings settings) throws RemoteException {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        FragSwitches swv;
        Log.d(Tag.MAIN, "onProfileSettingsChanged " + profile);
        if (settings == null) {
            try {
                settings = this.mDsClient.getProfileSettings(profile);
            } catch (Exception e) {
                e.printStackTrace();
                onDsApiError();
                return;
            }
        }
        try {
            DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, profile, settings);
            try {
                int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                if (profile == selectedProfile) {
                    if (this.mMobileLayout) {
                        pp = this.mFPP;
                    } else {
                        pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
                    }
                    if (pp != null) {
                        pp.scheduleNotifyDataSetChanged();
                    }
                    if (this.mMobileLayout) {
                        pe = this.mFPPE;
                    } else {
                        pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
                    }
                    if (pe != null) {
                        pe.setResetProfileVisibility();
                    }
                    if (this.mMobileLayout) {
                        swv = this.mFS;
                    } else {
                        swv = (FragSwitches) getFragmentManager().findFragmentById(R.id.fragswitches);
                    }
                    if (swv != null) {
                        swv.onProfileSettingsChanged(settings);
                    }
                    FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
                    if (gv != null) {
                        gv.setResetEqButtonVisibility();
                    }
                    try {
                        int iEqPreset = this.mDsClient.getIeqPreset(profile);
                        if (gv != null) {
                            gv.selectIEqPresetInUI(iEqPreset - 1);
                        }
                        if (this.mMobileLayout && this.mFEP != null) {
                            this.mFEP.setResetEqButtonVisibility();
                            this.mFEP.selectIEqPresetInUI(iEqPreset - 1);
                        }
                    } catch (Exception e2) {
                        e2.printStackTrace();
                        onDsApiError();
                    }
                }
            } catch (Exception e3) {
                e3.printStackTrace();
                onDsApiError();
            }
        } catch (Exception e4) {
            e4.printStackTrace();
            onDsApiError();
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragSwitchesObserver, com.dolby.ds1appUI.IDsFragGraphicVisualizerObserver, com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void setUserProfilePopulated() {
        FragProfilePresets pp;
        int profile;
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null && (profile = pp.getSelection()) >= 4) {
            try {
                String name = this.mDsClient.getProfileNames()[profile];
                if (name == null) {
                    this.mDsClient.setProfileName(profile, pp.getDefaultProfileName(profile));
                }
            } catch (Exception e) {
                e.printStackTrace();
                onDsApiError();
            }
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragSwitchesObserver, com.dolby.ds1appUI.IDsFragGraphicVisualizerObserver, com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void displayTooltip(View pointToView, int idTitle, int idText) {
        displayTooltip(pointToView, getString(idTitle), getString(idText));
    }

    @Override // com.dolby.ds1appUI.IDsFragObserver
    public void onDsApiError() {
        unbindFromDsApi();
        finish();
    }

    public void onProfileNameChanged(int profile, String name) {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
        if (gv != null) {
            gv.onProfileNameChanged(profile, name);
        }
        if (this.mMobileLayout && this.mFEP != null) {
            this.mFEP.onProfileNameChanged(profile, name);
        }
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            pp.onProfileNameChanged(profile, name);
        }
        if (this.mMobileLayout) {
            pe = this.mFPPE;
        } else {
            pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
        }
        if (pe != null) {
            pe.onProfileNameChanged(profile, name);
        }
    }

    public void onClientConnected() throws RemoteException {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        this.mDolbyClientConnected = true;
        this.mSplashClientBound = true;
        try {
            this.mIsMonoSpeaker = this.mDsClient.isMonoSpeaker();
            Log.d(Tag.MAIN, "mIsMonoSpeaker = " + this.mIsMonoSpeaker);
            hideSplashScreen();
            try {
                DsClientCache.INSTANCE.cacheDsOn(this.mDsClient.getDsOn());
                if (this.mMobileLayout) {
                    pp = this.mFPP;
                } else {
                    pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
                }
                if (pp != null) {
                    pp.onClientConnected();
                }
                if (this.mMobileLayout) {
                    pe = this.mFPPE;
                } else {
                    pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
                }
                if (pe != null) {
                    pe.onClientConnected();
                }
                FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
                if (gv != null) {
                    gv.onClientConnected();
                }
                if (this.mMobileLayout && this.mFEP != null) {
                    this.mFEP.onClientConnected();
                }
                this.mUseDsApiOnUiEvent = false;
                onDsClientUseChanged(true);
                this.mUseDsApiOnUiEvent = true;
            } catch (Exception e) {
                e.printStackTrace();
                onDsApiError();
            }
        } catch (Exception e2) {
            e2.printStackTrace();
            onDsApiError();
        }
    }

    public void onClientDisconnected() throws RemoteException {
        FragProfilePresetEditor pe;
        FragProfilePresets pp;
        FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
        if (gv != null) {
            gv.onClientDisconnected();
        }
        if (this.mMobileLayout && this.mFEP != null) {
            this.mFEP.onClientDisconnected();
        }
        if (this.mMobileLayout) {
            pe = this.mFPPE;
        } else {
            pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
        }
        if (pe != null) {
            pe.onClientDisconnected();
        }
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            pp.onClientDisconnected();
        }
        this.mDolbyClientConnected = false;
        onDsClientUseChanged(false);
    }

    @Override // com.dolby.ds1appUI.IDsFragObserver
    public void exitActivity() throws RemoteException {
        if (this.mDolbyClientConnected) {
            this.mDolbyClientConnected = false;
            onDsClientUseChanged(false);
            this.mDsClient.setEventListener((IDsClientEvents) null);
            Log.d(Tag.MAIN, "MainActivity.unBindDsService");
            this.mDsClient.unBindDsService(this);
        }
        finish();
    }

    @Override // com.dolby.ds1appUI.IDsFragObserver
    public boolean isDolbyClientConnected() {
        return this.mDolbyClientConnected;
    }

    @Override // com.dolby.ds1appUI.IDsFragObserver, com.dolby.ds1appUI.IDsActivityCommonTemp
    public boolean useDsApiOnUiEvent() {
        return this.mUseDsApiOnUiEvent;
    }

    @Override // com.dolby.ds1appUI.IDsFragProfilePresetsObserver, com.dolby.ds1appUI.IDsFragProfileEditorObserver
    public void profileReset(int profile) throws RemoteException {
        FragGraphicVisualizer fgv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
        if (fgv != null) {
            fgv.resetUserGains(profile);
        }
        chooseProfile(profile);
    }

    @Override // com.dolby.ds1appUI.IDsFragGraphicVisualizerObserver, com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void onEqualizerEditStart() {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        if (this.mMobileLayout && this.mFEP != null) {
            this.mFEP.setResetEqButtonVisibility();
        }
        setUserProfilePopulated();
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            pp.scheduleNotifyDataSetChanged();
        }
        if (this.mMobileLayout) {
            pe = this.mFPPE;
        } else {
            pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
        }
        if (pe != null) {
            pe.setResetProfileVisibility();
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragProfileEditorObserver
    public void onProfileNameEditStarted() {
        FragProfilePresets pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        if (pp != null) {
            pp.onProfileNameEditStarted();
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragProfileEditorObserver
    public void onProfileNameEditEnded() {
    }

    @Override // com.dolby.ds1appUI.IDsFragProfileEditorObserver
    public int getProfileSelected() {
        FragProfilePresets pp;
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            return pp.getSelection();
        }
        return -1;
    }

    public void onEqSettingsChanged(int profile, int preset) {
        FragProfilePresets pp;
        FragProfilePresetEditor pe;
        FragSwitches swv;
        Log.d(Tag.MAIN, "onEqSettingsChanged " + profile);
        FragGraphicVisualizer fgv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
        if (fgv != null) {
            fgv.onEqSettingsChanged(profile, preset);
        }
        if (this.mMobileLayout && this.mFEP != null) {
            this.mFEP.onEqSettingsChanged(profile, preset);
        }
        if (this.mMobileLayout) {
            pp = this.mFPP;
        } else {
            pp = (FragProfilePresets) getFragmentManager().findFragmentById(R.id.fragprofilepresets);
        }
        if (pp != null) {
            pp.onEqSettingsChanged(profile, preset);
        }
        if (this.mMobileLayout) {
            pe = this.mFPPE;
        } else {
            pe = (FragProfilePresetEditor) getFragmentManager().findFragmentById(R.id.fragprofileeditor);
        }
        if (pe != null) {
            pe.onEqSettingsChanged(profile, preset);
        }
        try {
            DsClientSettings settings = this.mDsClient.getProfileSettings(profile);
            DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, profile, settings);
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            if (profile == selectedProfile) {
                if (this.mMobileLayout) {
                    swv = this.mFS;
                } else {
                    swv = (FragSwitches) getFragmentManager().findFragmentById(R.id.fragswitches);
                }
                if (swv != null) {
                    swv.onProfileSettingsChanged(settings);
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
            onDsApiError();
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragProfilePresetsObserver
    public void editProfile() {
        if (this.mMobileLayout) {
            boolean cacheOn = DsClientCache.INSTANCE.isDsOn();
            if (cacheOn && this.mFS == null && this.mFPPE == null && this.mFEP == null) {
                mEditProfile = true;
                FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
                if (gv != null) {
                    gv.setEnableEditGraphic(true);
                }
                FragmentManager fragmentManager = getFragmentManager();
                FragmentTransaction fragmentTransaction = fragmentManager.beginTransaction();
                fragmentTransaction.setTransition(8194);
                fragmentTransaction.remove(this.mFPP);
                fragmentTransaction.commit();
                this.mFPPE = new FragProfilePresetEditor();
                this.mFS = new FragSwitches();
                this.mFEP = new FragEqualizerPresets();
                int fragmentContainerId = R.id.fragmentcontainer;
                if (Tools.isLandscapeScreenOrientation(this)) {
                    this.mLinearLayout = new LinearLayout(this);
                    this.mLinearLayout.setId(8);
                    this.mLinearLayout.setOrientation(1);
                    this.mScrollview = new ScrollView(this);
                    this.mScrollview.setId(R.id.thescrollview);
                    this.mScrollview.addView(this.mLinearLayout, new ViewGroup.LayoutParams(-1, -2));
                    ((LinearLayout) findViewById(R.id.fragmentcontainer)).addView(this.mScrollview, new ViewGroup.LayoutParams(-1, -2));
                    fragmentContainerId = 8;
                }
                FragmentTransaction fragmentTransaction2 = fragmentManager.beginTransaction();
                fragmentTransaction2.setTransition(4097);
                fragmentTransaction2.add(R.id.preseteditorcontainer, this.mFPPE);
                fragmentTransaction2.add(fragmentContainerId, this.mFS);
                fragmentTransaction2.add(fragmentContainerId, this.mFEP);
                fragmentTransaction2.commit();
                ScrollView theView = (ScrollView) findViewById(R.id.thescrollview);
                if (theView != null) {
                    if (!Tools.isLandscapeScreenOrientation(this)) {
                        this.mOriginX = theView.getScrollX();
                        this.mOriginY = theView.getScrollY();
                    }
                    theView.smoothScrollTo(0, 0);
                }
            }
        }
    }

    @Override // android.app.Activity
    public void onBackPressed() {
        if (this.mMobileLayout && this.mFS != null && this.mFPPE != null && this.mFEP != null) {
            mEditProfile = false;
            FragGraphicVisualizer gv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
            if (gv != null) {
                gv.hideEqualizer();
                gv.setEnableEditGraphic(false);
            }
            FragmentManager fragmentManager = getFragmentManager();
            FragmentTransaction fragmentTransaction = fragmentManager.beginTransaction();
            fragmentTransaction.setTransition(8194);
            fragmentTransaction.remove(this.mFEP);
            fragmentTransaction.remove(this.mFPPE);
            fragmentTransaction.remove(this.mFS);
            fragmentTransaction.commit();
            this.mFPPE = null;
            this.mFS = null;
            this.mFEP = null;
            if (Tools.isLandscapeScreenOrientation(this)) {
                ((LinearLayout) findViewById(R.id.fragmentcontainer)).removeView(this.mScrollview);
                this.mLinearLayout = null;
                this.mScrollview = null;
            } else {
                ScrollView theView = (ScrollView) findViewById(R.id.thescrollview);
                if (theView != null) {
                    theView.post(new Runnable() { // from class: com.dolby.ds1appUI.MainActivity.4
                        @Override // java.lang.Runnable
                        public void run() {
                            ScrollView theView2 = (ScrollView) MainActivity.this.findViewById(R.id.thescrollview);
                            if (theView2 != null) {
                                theView2.scrollTo(MainActivity.this.mOriginX, MainActivity.this.mOriginY);
                            }
                        }
                    });
                }
            }
            FragmentTransaction fragmentTransaction2 = fragmentManager.beginTransaction();
            fragmentTransaction2.setTransition(4097);
            fragmentTransaction2.add(R.id.fragmentcontainer, this.mFPP);
            fragmentTransaction2.commit();
            fragmentManager.executePendingTransactions();
            return;
        }
        super.onBackPressed();
    }

    @Override // com.dolby.ds1appUI.IDsFragProfileEditorObserver
    public void profileEditorIsAlive() {
        if (this.mMobileLayout) {
            boolean cacheOn = DsClientCache.INSTANCE.isDsOn();
            if (this.mDolbyClientConnected && cacheOn) {
                this.mFPPE.onClientConnected();
                this.mFPPE.setEnabled(true);
                try {
                    int profile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                    this.mFPPE.onProfileNameChanged(profile, this.mFPP.getItemName(profile));
                } catch (Exception e) {
                    e.printStackTrace();
                    onDsApiError();
                }
            }
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragSwitchesObserver
    public void switchesAreAlive() {
        FragSwitches swv;
        if (this.mMobileLayout) {
            boolean cacheOn = DsClientCache.INSTANCE.isDsOn();
            if (this.mDolbyClientConnected && cacheOn) {
                this.mFS.setEnabled(true);
                try {
                    int profile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                    DsClientSettings settings = this.mDsClient.getProfileSettings(profile);
                    DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, profile, settings);
                    if (this.mMobileLayout) {
                        swv = this.mFS;
                    } else {
                        swv = (FragSwitches) getFragmentManager().findFragmentById(R.id.fragswitches);
                    }
                    if (swv != null) {
                        swv.onProfileSettingsChanged(settings);
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                    onDsApiError();
                }
            }
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void equalizerPresetsAreAlive() throws RemoteException {
        if (this.mMobileLayout) {
            boolean cacheOn = DsClientCache.INSTANCE.isDsOn();
            if (this.mDolbyClientConnected && cacheOn) {
                this.mFEP.onClientConnected();
                this.mFEP.updateGraphicEqInUI();
                this.mFEP.setEnabled(true);
                try {
                    int profile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                    chooseProfile(profile);
                } catch (Exception e) {
                    e.printStackTrace();
                    onDsApiError();
                }
            }
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragProfilePresetsObserver
    public void profilePresetsAreAlive() throws RemoteException {
        if (this.mMobileLayout) {
            boolean cacheOn = DsClientCache.INSTANCE.isDsOn();
            this.mFPP.setEnabled(cacheOn);
            if (this.mDolbyClientConnected && cacheOn) {
                try {
                    final int profile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                    ListView lv = (ListView) findViewById(R.id.presetsListView);
                    if (lv != null) {
                        lv.setSelection(profile);
                    }
                    chooseProfile(profile);
                    ScrollView theView = (ScrollView) findViewById(R.id.thescrollview);
                    if (theView != null) {
                        theView.post(new Runnable() { // from class: com.dolby.ds1appUI.MainActivity.5
                            @Override // java.lang.Runnable
                            public void run() {
                                ScrollView theView2 = (ScrollView) MainActivity.this.findViewById(R.id.thescrollview);
                                if (theView2 != null) {
                                    theView2.scrollTo(0, (profile * theView2.getHeight()) / 6);
                                }
                            }
                        });
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                    onDsApiError();
                }
            }
        }
    }

    @Override // com.dolby.ds1appUI.IDsFragEqualizerPresetsObserver
    public void resetEqUserGains() {
        FragGraphicVisualizer fgv = (FragGraphicVisualizer) getFragmentManager().findFragmentById(R.id.fraggraphicvisualizer);
        if (fgv != null) {
            fgv.resetUserGains();
        }
    }
}

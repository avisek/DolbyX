package com.dolby.instoredemoapp;

import android.app.Activity;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Message;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.widget.ImageButton;
import android.widget.VideoView;
import com.dolby.ds1appUI.R;
import java.io.IOException;
import java.io.InputStream;

/* JADX INFO: loaded from: classes.dex */
public class DlbInStoreDemoPlayer extends Activity implements MediaPlayer.OnCompletionListener, MediaPlayer.OnPreparedListener, MediaPlayer.OnErrorListener {
    private static final String TAG = "DlbInStoreDemoPlayer";
    private ImageButton mExitBtn;
    private MediaPlayer mMediaPlayer;
    private ImageButton mReplayBtn;
    private ImageButton mStopBtn;
    private VideoView mVideoView;
    private DlbApController mApController = null;
    private Handler mHandler = null;
    private boolean mIsPrepared = false;
    private boolean mReplayEnabled = false;
    private boolean mIsPlayingLoopMedia = false;
    private boolean mIsManualStop = false;
    private boolean mIsResumed = false;
    private InputStream mAutoPilotDataStream = null;
    private AudioManager.OnAudioFocusChangeListener mAFChangeListener = new AudioManager.OnAudioFocusChangeListener() { // from class: com.dolby.instoredemoapp.DlbInStoreDemoPlayer.5
        @Override // android.media.AudioManager.OnAudioFocusChangeListener
        public void onAudioFocusChange(int focusChange) {
            Log.d(DlbInStoreDemoPlayer.TAG, "onAudioFocusChange, focusChange = " + focusChange);
            if (focusChange == -2) {
                DlbInStoreDemoPlayer.this.mHandler.sendEmptyMessage(ConstValue.DS1_INSTOREDEMO_QUIT);
            } else if (focusChange == -1) {
                DlbInStoreDemoPlayer.this.mHandler.sendEmptyMessage(ConstValue.DS1_INSTOREDEMO_QUIT);
            } else {
                Log.d(DlbInStoreDemoPlayer.TAG, "onAudioFocusChange, do nothing for value = " + focusChange);
            }
        }
    };

    @Override // android.app.Activity
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.d(TAG, "onCreate");
        setContentView(R.layout.videoplayer);
        this.mVideoView = (VideoView) findViewById(R.id.movie_view);
        this.mVideoView.setOnErrorListener(this);
        this.mVideoView.setOnCompletionListener(this);
        this.mVideoView.setOnPreparedListener(this);
        this.mHandler = new Handler() { // from class: com.dolby.instoredemoapp.DlbInStoreDemoPlayer.1
            @Override // android.os.Handler
            public void handleMessage(Message msg) {
                Log.d(DlbInStoreDemoPlayer.TAG, "handle message in handler, msg.what = " + msg.what);
                if (msg.what == 2012) {
                    boolean success = DlbInStoreDemoPlayer.this.mApController.processApMessage(msg);
                    if (!success && DlbInStoreDemoPlayer.this.mStopBtn != null) {
                        DlbInStoreDemoPlayer.this.mStopBtn.callOnClick();
                        return;
                    }
                    return;
                }
                if (msg.what != 2013) {
                    if (msg.what == 2014) {
                        Log.d(DlbInStoreDemoPlayer.TAG, "handle START_LOOP_MEDIA_PLAYBACK event");
                        DlbInStoreDemoPlayer.this.mVideoView.setVideoURI(DlbInStoreDemoPlayer.this.getLoopUri());
                        DlbInStoreDemoPlayer.this.mIsPlayingLoopMedia = true;
                        if (DlbInStoreDemoPlayer.this.mIsResumed) {
                            DlbInStoreDemoPlayer.this.mVideoView.start();
                            return;
                        }
                        return;
                    }
                    if (msg.what == 2015) {
                        Log.d(DlbInStoreDemoPlayer.TAG, "handle START_DEMO_MEDIA_PLAYBACK");
                        DlbInStoreDemoPlayer.this.mVideoView.setVideoURI(DlbInStoreDemoPlayer.this.getDemoUri());
                        DlbInStoreDemoPlayer.this.mApController.setApInfoFile(DlbInStoreDemoPlayer.this.getAutoPilotXmlFile());
                        DlbInStoreDemoPlayer.this.mIsManualStop = false;
                        DlbInStoreDemoPlayer.this.mIsPlayingLoopMedia = false;
                        return;
                    }
                    if (msg.what == 2016) {
                        if (DlbInStoreDemoPlayer.this.mApController.saveCurrentDs1Data()) {
                            DlbInStoreDemoPlayer.this.mVideoView.setVideoURI(DlbInStoreDemoPlayer.this.getDemoUri());
                            return;
                        } else {
                            DlbInStoreDemoPlayer.this.mHandler.sendEmptyMessage(ConstValue.DS1_INSTOREDEMO_QUIT);
                            return;
                        }
                    }
                    if (msg.what == 2017) {
                        DlbInStoreDemoPlayer.this.finish();
                    } else {
                        Log.e(DlbInStoreDemoPlayer.TAG, "DlbInstoreDemoPlayer.mHandler.handleMessage(), unknown message id = " + msg.what);
                    }
                }
            }
        };
        this.mStopBtn = (ImageButton) findViewById(R.id.stop_button);
        this.mStopBtn.setOnClickListener(new View.OnClickListener() { // from class: com.dolby.instoredemoapp.DlbInStoreDemoPlayer.2
            @Override // android.view.View.OnClickListener
            public void onClick(View v) {
                if (!DlbInStoreDemoPlayer.this.mIsPlayingLoopMedia) {
                    DlbInStoreDemoPlayer.this.mHandler.removeCallbacksAndMessages(null);
                    DlbInStoreDemoPlayer.this.mIsManualStop = true;
                    DlbInStoreDemoPlayer.this.mVideoView.stopPlayback();
                    DlbInStoreDemoPlayer.this.mHandler.sendEmptyMessage(ConstValue.START_LOOP_MEDIA_PLAYBACK);
                }
            }
        });
        this.mReplayBtn = (ImageButton) findViewById(R.id.replay_toggle_button);
        this.mReplayBtn.setOnClickListener(new View.OnClickListener() { // from class: com.dolby.instoredemoapp.DlbInStoreDemoPlayer.3
            @Override // android.view.View.OnClickListener
            public void onClick(View v) {
                DlbInStoreDemoPlayer.this.mReplayEnabled = !DlbInStoreDemoPlayer.this.mReplayEnabled;
                Log.d(DlbInStoreDemoPlayer.TAG, "mReplayEnabled = " + DlbInStoreDemoPlayer.this.mReplayEnabled);
                if (DlbInStoreDemoPlayer.this.mReplayEnabled) {
                    DlbInStoreDemoPlayer.this.mReplayBtn.setBackgroundResource(R.drawable.replay_on);
                } else {
                    DlbInStoreDemoPlayer.this.mReplayBtn.setBackgroundResource(R.drawable.replay_off);
                }
            }
        });
        this.mExitBtn = (ImageButton) findViewById(R.id.exit_button);
        this.mExitBtn.setOnClickListener(new View.OnClickListener() { // from class: com.dolby.instoredemoapp.DlbInStoreDemoPlayer.4
            @Override // android.view.View.OnClickListener
            public void onClick(View v) {
                DlbInStoreDemoPlayer.this.finish();
            }
        });
    }

    @Override // android.app.Activity
    protected void onStart() {
        super.onStart();
        Log.d(TAG, "onStart");
        if (this.mApController == null) {
            this.mApController = new DlbApController(this);
            this.mApController.setHandler(this.mHandler);
            this.mApController.setApInfoFile(getAutoPilotXmlFile());
        }
    }

    @Override // android.app.Activity
    protected void onResume() {
        Log.d(TAG, "onResume");
        this.mIsResumed = true;
        if (this.mIsPlayingLoopMedia) {
            this.mVideoView.start();
        }
        boolean ret = this.mApController.saveCurrentDs1Data();
        if (!ret) {
            Log.e(TAG, "DlbInstoreDemoPlayer.onResume(), failed to saveCurrentDs1Data");
        }
        super.onResume();
    }

    @Override // android.app.Activity
    protected void onPause() {
        Log.d(TAG, "onPause");
        this.mIsResumed = false;
        if (!this.mIsPlayingLoopMedia) {
            this.mIsManualStop = true;
            this.mVideoView.stopPlayback();
            this.mHandler.removeCallbacksAndMessages(null);
            this.mHandler.sendEmptyMessage(ConstValue.START_LOOP_MEDIA_PLAYBACK);
        } else {
            this.mVideoView.pause();
        }
        this.mApController.restoreAllDs1Data();
        super.onPause();
    }

    @Override // android.app.Activity
    protected void onDestroy() {
        Log.d(TAG, "onDestroy");
        this.mHandler.removeCallbacksAndMessages(null);
        this.mApController.onExit();
        AudioManager am = (AudioManager) getSystemService("audio");
        am.abandonAudioFocus(this.mAFChangeListener);
        super.onDestroy();
    }

    @Override // android.media.MediaPlayer.OnCompletionListener
    public void onCompletion(MediaPlayer arg0) {
        Log.d(TAG, "onCompletion called");
        this.mHandler.removeCallbacksAndMessages(null);
        this.mIsPrepared = false;
        if (this.mReplayEnabled && !this.mIsManualStop) {
            this.mHandler.sendEmptyMessage(ConstValue.START_DEMO_MEDIA_PLAYBACK);
        } else if (!this.mIsPlayingLoopMedia) {
            this.mHandler.sendEmptyMessage(ConstValue.START_LOOP_MEDIA_PLAYBACK);
        } else {
            this.mVideoView.start();
        }
    }

    @Override // android.media.MediaPlayer.OnPreparedListener
    public void onPrepared(MediaPlayer mediaplayer) {
        Log.d(TAG, "onPrepared called");
        this.mMediaPlayer = mediaplayer;
        this.mIsPrepared = true;
        if (this.mIsPrepared && !this.mIsPlayingLoopMedia) {
            getAudioFocus();
            this.mApController.setMediaPlayer(this.mMediaPlayer);
            this.mVideoView.requestFocus();
            this.mVideoView.start();
            this.mApController.sendApMessages();
        }
    }

    @Override // android.media.MediaPlayer.OnErrorListener
    public boolean onError(MediaPlayer mp, int what, int extra) {
        Log.d(TAG, "onError called, what = " + what + " extra = " + extra);
        return true;
    }

    @Override // android.app.Activity
    public boolean onTouchEvent(MotionEvent event) {
        Log.d(TAG, "onTouchEvent called action = " + event.getAction());
        if (event.getAction() == 0) {
            if (this.mIsPlayingLoopMedia) {
                this.mVideoView.stopPlayback();
                this.mHandler.sendEmptyMessage(ConstValue.START_DEMO_MEDIA_PLAYBACK);
            } else if (!this.mVideoView.isPlaying()) {
                this.mHandler.sendEmptyMessage(ConstValue.START_DEMO_MEDIA_PLAYBACK);
            }
        }
        return false;
    }

    private void updateDisplayText(Message msg) {
    }

    private int getColorByName(String color) {
        if (color.equalsIgnoreCase("White")) {
            return -1;
        }
        if (color.equalsIgnoreCase("Black")) {
            return ConstValue.TEXT_COLOR_BLACK;
        }
        if (color.equalsIgnoreCase("Red")) {
            return ConstValue.TEXT_COLOR_RED;
        }
        if (color.equalsIgnoreCase("Yellow")) {
            return ConstValue.TEXT_COLOR_YELLOW;
        }
        if (color.equalsIgnoreCase("Blue")) {
            return ConstValue.TEXT_COLOR_BLUE;
        }
        return -1;
    }

    private void getAudioFocus() {
        AudioManager am = (AudioManager) getSystemService("audio");
        int result = am.requestAudioFocus(this.mAFChangeListener, 3, 3);
        if (result == 1) {
            Log.d(TAG, "DlbInstoreDemoPlayer.getAudioFocus, succeeded");
        } else {
            Log.e(TAG, "DlbInstoreDemoPlayer.getAudioFocus failed, result = " + result);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public Uri getDemoUri() {
        Uri demoUri = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.instore_demo_media);
        Log.d(TAG, "demoUri = " + demoUri.toString());
        return demoUri;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public Uri getLoopUri() {
        Uri loopUri = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.instore_demo_loop);
        Log.d(TAG, "loopUri = " + loopUri.toString());
        return loopUri;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public InputStream getAutoPilotXmlFile() {
        if (this.mAutoPilotDataStream == null) {
            try {
                this.mAutoPilotDataStream = getResources().getAssets().open(ConstValue.APINFO_FILE_NAME);
            } catch (IOException ioe) {
                Log.e(TAG, "DlbInstoreDemoPlayer.getAutoPilotXmlFile, the file does not exist");
                ioe.printStackTrace();
                this.mHandler.sendEmptyMessage(ConstValue.DS1_INSTOREDEMO_QUIT);
            }
        }
        return this.mAutoPilotDataStream;
    }
}

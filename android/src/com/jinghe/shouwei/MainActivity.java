package com.jinghe.shouwei;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** 晶核守卫：全屏横屏 WebView，加载 assets/index.html（离线单机） */
public class MainActivity extends Activity {
  private WebView web;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    Window w = getWindow();
    w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
    if (Build.VERSION.SDK_INT >= 28) {
      WindowManager.LayoutParams lp = w.getAttributes();
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      w.setAttributes(lp);
    }
    web = new WebView(this);
    web.setBackgroundColor(0xFF05080C);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(true);
    s.setTextZoom(100);
    s.setSupportZoom(false);
    web.setWebViewClient(new WebViewClient());
    web.setWebChromeClient(new WebChromeClient());
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    setContentView(web);
    hideSystemUi();
    web.loadUrl("file:///android_asset/index.html");
  }

  private void hideSystemUi() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideSystemUi();
  }

  @Override
  protected void onPause() {
    super.onPause();
    if (web != null) web.onPause();
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (web != null) web.onResume();
    hideSystemUi();
  }

  @Override
  protected void onDestroy() {
    if (web != null) { web.destroy(); web = null; }
    super.onDestroy();
  }

  /** 返回键交给游戏处理（关闭面板 / 暂停）；游戏在主菜单时才退出应用 */
  @Override
  public void onBackPressed() {
    if (web == null) { finish(); return; }
    web.evaluateJavascript("(window.__back && window.__back()) ? 1 : 0", new BackHandler(this));
  }
}

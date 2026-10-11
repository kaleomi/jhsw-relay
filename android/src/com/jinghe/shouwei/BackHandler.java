package com.jinghe.shouwei;

import android.app.Activity;
import android.webkit.ValueCallback;

/** 返回键回调：游戏未处理（在主菜单）时关闭应用 */
@SuppressWarnings({"rawtypes", "unchecked"})
final class BackHandler implements ValueCallback {
  private final Activity activity;

  BackHandler(Activity activity) { this.activity = activity; }

  @Override
  public void onReceiveValue(Object v) {
    if (!"1".equals(v)) activity.finish();
  }
}

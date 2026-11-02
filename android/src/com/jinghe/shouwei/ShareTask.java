package com.jinghe.shouwei;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

/** 在主线程里弹出系统分享面板（分享战报图） */
final class ShareTask implements Runnable {
  private final Activity activity;
  private final Uri uri;

  ShareTask(Activity activity, Uri uri) { this.activity = activity; this.uri = uri; }

  @Override
  public void run() {
    Intent send = new Intent(Intent.ACTION_SEND);
    send.setType("image/png");
    send.putExtra(Intent.EXTRA_STREAM, uri);
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    activity.startActivity(Intent.createChooser(send, "分享战报"));
  }
}

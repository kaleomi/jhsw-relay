package com.jinghe.shouwei;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import java.io.OutputStream;

/** 给游戏页面用的小接口：把战报图保存到相册（Pictures/晶核守卫），或者调起系统分享 */
final class ApkBridge {
  private final Activity activity;

  ApkBridge(Activity activity) { this.activity = activity; }

  private Uri save(String b64, String name) throws Exception {
    if (Build.VERSION.SDK_INT < 29) throw new Exception("android<10");
    byte[] data = Base64.decode(b64, Base64.DEFAULT);
    ContentResolver r = activity.getContentResolver();
    ContentValues v = new ContentValues();
    v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
    v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
    v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/晶核守卫");
    Uri uri = r.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
    if (uri == null) throw new Exception("insert failed");
    OutputStream os = r.openOutputStream(uri);
    if (os == null) throw new Exception("open failed");
    try { os.write(data); } finally { os.close(); }
    return uri;
  }

  @JavascriptInterface
  public String saveImage(String b64, String name) {
    try { save(b64, name); return "ok"; } catch (Throwable e) { return "err:" + e.getMessage(); }
  }

  @JavascriptInterface
  public String shareImage(String b64, String name) {
    try {
      Uri uri = save(b64, name);
      activity.runOnUiThread(new ShareTask(activity, uri));
      return "ok";
    } catch (Throwable e) { return "err:" + e.getMessage(); }
  }
}

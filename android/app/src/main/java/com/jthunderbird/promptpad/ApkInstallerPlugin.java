package com.jthunderbird.promptpad;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** In-app update: download the release APK and hand it to Android's package installer (needs one confirm tap). */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

  @PluginMethod
  public void canInstall(PluginCall call) {
    JSObject r = new JSObject();
    r.put("allowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls());
    call.resolve(r);
  }

  /** Opens the system screen where the user allows promptpad to install apps (once). */
  @PluginMethod
  public void openPermissionSettings(PluginCall call) {
    Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(i);
    call.resolve();
  }

  @PluginMethod
  public void install(PluginCall call) {
    final String url = call.getString("url");
    if (url == null || !url.startsWith("https://")) { call.reject("bad url"); return; }
    new Thread(() -> {
      try {
        File dir = new File(getContext().getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "promptpad-update.apk");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        if (c.getResponseCode() != 200) { call.reject("download failed: HTTP " + c.getResponseCode()); return; }
        try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
          byte[] buf = new byte[65536];
          int n;
          while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
      } catch (Exception e) {
        call.reject("update failed: " + e.getMessage());
      }
    }).start();
  }
}

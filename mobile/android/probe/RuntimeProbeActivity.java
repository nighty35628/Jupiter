package dev.jupiter.mobile.qa;
import dev.jupiter.mobile.runtime.BoundedLines;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import java.net.InetAddress;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;
import org.json.JSONObject;
import android.system.Os;
import android.system.OsConstants;
import java.security.MessageDigest;

/** Runs the phase-zero chain as an ordinary, non-debuggable Android application. */
public final class RuntimeProbeActivity extends Activity {
  private static final AtomicBoolean running = new AtomicBoolean();
  private static final AtomicBoolean poisoned = new AtomicBoolean();
  private TextView output;
  private final String runId = UUID.randomUUID().toString();
  private boolean guestResult;
  private boolean engineResult;
  private int displayBytes;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    output = new TextView(this);
    output.setTextSize(14);
    output.setPadding(24, 24, 24, 24);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(output);
    setContentView(scroll);
    if (!running.compareAndSet(false, true)) { append("Probe already running"); return; }
    new Thread(() -> {
      try { probe(); }
      catch (Exception e) { append("JUPITER_PROBE_FAILED " + e); }
      finally { running.set(false); }
    }, "jupiter-runtime-probe").start();
  }

  private synchronized void append(String text) {
    boolean result = text.startsWith("JUPITER_GUEST_RESULT ") || text.startsWith("JUPITER_ENGINE_RESULT ") ||
      text.startsWith("JUPITER_PROBE_") || text.startsWith("JUPITER_ENGINE_EXIT ");
    if (!result && displayBytes >= 65536) return;
    if (text.length() > 8192) text = text.substring(0, 8192) + " [truncated]";
    displayBytes += text.length();
    final String shown = text;
    Log.i("JupiterLocalQA", "RUN " + runId + " " + text);
    runOnUiThread(() -> output.append(shown + "\n"));
  }

  private void copyAsset(String name, File target) throws Exception {
    target.getParentFile().mkdirs();
    try (InputStream in = getAssets().open(name); OutputStream out = new FileOutputStream(target)) {
      byte[] buffer = new byte[65536];
      int count;
      while ((count = in.read(buffer)) >= 0) out.write(buffer, 0, count);
    }
  }

  private int execute(ProcessBuilder builder, int timeoutSeconds) throws Exception {
    boolean tracer = builder.command().get(0).endsWith("libproot.so");
    AtomicInteger ownedPid = new AtomicInteger();
    if (tracer) {
      List<String> wrapped = new ArrayList<>(Arrays.asList("/system/bin/sh", "-c", "printf 'JUPITER_PROOT_PID %s\\n' \"$$\"; exec \"$@\"", "jupiter-proot"));
      wrapped.addAll(builder.command());
      builder.command(wrapped);
    }
    Process process = builder.redirectErrorStream(true).start();
    ExecutorService readerThread = Executors.newSingleThreadExecutor();
    Future<?> reader = readerThread.submit(() -> {
      try (Reader stream = new InputStreamReader(process.getInputStream())) {
        BoundedLines bounded = new BoundedLines(stream, 8192);
        BoundedLines.Line item;
        int lines = 0;
        while ((item = bounded.next()) != null) {
          String line = item.text;
          if (item.truncated) {
            if (line.startsWith("JUPITER_")) throw new IOException("Oversized probe control frame");
            if (lines++ < 80) append("Child output exceeded line limit [drained]");
            continue;
          }
          if (line.startsWith("JUPITER_WEB_READY ")) {
            JSONObject value = new JSONObject(line.substring("JUPITER_WEB_READY ".length()));
            if (!runId.equals(value.optString("runId"))) throw new IOException("Stale Web host run");
            showWorkbench(value.getString("url"));
            append("JUPITER_WEBVIEW_LOADING");
            continue;
          }
          if (tracer && lines == 0 && line.matches("JUPITER_PROOT_PID [0-9]+"))
            ownedPid.set(Integer.parseInt(line.substring("JUPITER_PROOT_PID ".length())));
          if (line.startsWith("JUPITER_GUEST_RESULT ")) {
            if (guestResult) throw new IOException("Duplicate guest result");
            JSONObject value = new JSONObject(line.substring("JUPITER_GUEST_RESULT ".length()));
            guestResult = runId.equals(value.optString("runId")) && "linux".equals(value.optString("platform")) &&
              "arm64".equals(value.optString("arch")) && "runtime".equals(value.optString("probeKind")) && value.optInt("schemaVersion") == 1 &&
              value.optBoolean("atomicRename") && value.optBoolean("symlink") && value.optBoolean("childExec") && value.optBoolean("workerWasm") && value.optBoolean("cleanup");
            if (!guestResult) throw new IOException("Invalid guest result");
            append(line); continue;
          }
          if (line.startsWith("JUPITER_ENGINE_RESULT ")) {
            if (engineResult) throw new IOException("Duplicate engine result");
            JSONObject value = new JSONObject(line.substring("JUPITER_ENGINE_RESULT ".length()));
            engineResult = runId.equals(value.optString("runId")) && "jupiter-engine".equals(value.optString("probeKind")) && value.optInt("schemaVersion") == 1 && value.optBoolean("pty") && value.optBoolean("imageWorker") &&
              value.optBoolean("chat") && value.optBoolean("tools") && value.optBoolean("git") && value.optBoolean("ripgrep") &&
              value.optBoolean("pythonCommand") && value.optBoolean("nodeCommand") && value.optBoolean("dns") && value.optBoolean("tls") &&
              value.optBoolean("cancel") && value.optBoolean("recovery");
            if (!engineResult) throw new IOException("Invalid engine result");
            append(line); continue;
          }
          if (lines++ < 80) append(line);
        }
      } catch (Exception error) { throw new RuntimeException(error); }
    });
    try {
      if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
        poisoned.set(true);
        try { new File(getFilesDir(), "runtime/.poisoned").createNewFile(); }
        catch (IOException error) { append("Cannot persist poisoned state: " + error); }
        try {
          int pid = ownedPid.get();
          if (tracer && pid > 0) {
            String status = new String(Files.readAllBytes(new File("/proc/" + pid + "/status").toPath()), "UTF-8");
            if (!status.contains("Uid:\t" + android.os.Process.myUid() + "\t")) throw new IOException("Cannot confirm owned tracer UID");
            Os.kill(pid, OsConstants.SIGQUIT);
          } else process.destroy();
        } catch (Exception error) { append("Graceful timeout cleanup failed: " + error); }
        finally {
          if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly();
          process.waitFor(3, TimeUnit.SECONDS);
        }
        throw new IOException("JUPITER_PROBE_TIMEOUT; reset owned test environment before retry");
      }
      reader.get(3, TimeUnit.SECONDS);
      return process.exitValue();
    } finally {
      process.getInputStream().close();
      reader.cancel(true);
      readerThread.shutdownNow();
    }
  }

  private void removeOwnedTree(File directory) throws Exception {
    if (!directory.exists()) return;
    try (Stream<Path> paths = Files.walk(directory.toPath())) {
      for (Path path : (Iterable<Path>)paths.sorted(Comparator.reverseOrder())::iterator) Files.delete(path);
    }
  }

  private void showWorkbench(String url) throws Exception {
    Uri uri = Uri.parse(url);
    if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1 || !"/".equals(uri.getPath()))
      throw new IOException("Invalid local host URL");
    final String origin = "http://127.0.0.1:" + uri.getPort();
    runOnUiThread(() -> {
      WebView view = new WebView(this);
      view.getSettings().setJavaScriptEnabled(true);
      view.getSettings().setDomStorageEnabled(true);
      view.getSettings().setAllowFileAccess(false);
      view.getSettings().setAllowContentAccess(false);
      view.setWebViewClient(new WebViewClient() {
        @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
          Uri target = request.getUrl();
          return !("http".equals(target.getScheme()) && "127.0.0.1".equals(target.getHost()) && target.getPort() == uri.getPort());
        }
        @Override public void onPageFinished(WebView web, String page) {
          if (page.startsWith(origin + "/")) append("JUPITER_WEBVIEW_PAGE_FINISHED");
        }
      });
      setContentView(view);
      view.loadUrl(url);
    });
  }

  private void probe() throws Exception {
    append("JUPITER_APP_UID " + android.os.Process.myUid());
    if (poisoned.get() || new File(getFilesDir(), "runtime/.poisoned").exists()) throw new IOException("Previous probe timed out; reset test environment first");
    JSONObject manifest;
    try (InputStream in = getAssets().open("runtime-manifest.json")) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192]; int count;
      while ((count = in.read(buffer)) >= 0) bytes.write(buffer, 0, count);
      manifest = new JSONObject(bytes.toString("UTF-8"));
    }
    String fingerprint = manifest.getJSONObject("rootfs").getString("sha256");
    append("JUPITER_RUNTIME " + fingerprint);
    File root = new File(getFilesDir(), "runtime/rootfs");
    File marker = new File(getFilesDir(), "runtime/.ready");
    if (!marker.exists() || !fingerprint.equals(new String(Files.readAllBytes(marker.toPath()), "UTF-8"))) {
      append("Preparing bundled runtime");
      File staging = new File(getFilesDir(), "runtime/rootfs.staging");
      removeOwnedTree(staging);
      staging.mkdirs();
      File archive = new File(getCacheDir(), "rootfs.tar.gz");
      copyAsset("rootfs.tar.gz", archive);
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      try (InputStream in = new FileInputStream(archive)) {
        byte[] buffer = new byte[65536]; int count;
        while ((count = in.read(buffer)) >= 0) digest.update(buffer, 0, count);
      }
      StringBuilder actual = new StringBuilder();
      for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
      if (!actual.toString().equals(manifest.getJSONObject("rootfs").getString("sha256"))) throw new IOException("Runtime archive checksum mismatch");
      int extracted = execute(new ProcessBuilder("/system/bin/toybox", "tar", "-xzf", archive.getAbsolutePath(), "-C", staging.getAbsolutePath()), 180);
      archive.delete();
      if (extracted != 0) throw new IOException("Runtime extraction exited " + extracted);
      removeOwnedTree(root);
      if (!staging.renameTo(root)) throw new IOException("Runtime activation failed");
      Files.write(marker.toPath(), fingerprint.getBytes("UTF-8"));
    }
    File engine = new File(getFilesDir(), "engine");
    JSONObject engineManifest;
    try (InputStream in = getAssets().open("engine-manifest.json")) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
      while ((count = in.read(buffer)) >= 0) bytes.write(buffer, 0, count);
      engineManifest = new JSONObject(bytes.toString("UTF-8"));
    }
    String engineHash = engineManifest.getString("sha256");
    File engineMarker = new File(getFilesDir(), "engine.ready");
    if (!engineMarker.exists() || !engineHash.equals(new String(Files.readAllBytes(engineMarker.toPath()), "UTF-8"))) {
      File staging = new File(getFilesDir(), "engine.staging"); removeOwnedTree(staging); staging.mkdirs();
      File archive = new File(getCacheDir(), "engine.tar.gz"); copyAsset("engine.tar.gz", archive);
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      try (InputStream in = new FileInputStream(archive)) { byte[] buffer = new byte[65536]; int count; while ((count = in.read(buffer)) >= 0) digest.update(buffer, 0, count); }
      StringBuilder actual = new StringBuilder(); for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
      if (!actual.toString().equals(engineHash)) throw new IOException("Engine archive checksum mismatch");
      int extracted = execute(new ProcessBuilder("/system/bin/toybox", "tar", "-xzf", archive.getAbsolutePath(), "-C", staging.getAbsolutePath()), 90);
      archive.delete(); if (extracted != 0) throw new IOException("Engine extraction failed: " + extracted);
      removeOwnedTree(engine); if (!staging.renameTo(engine)) throw new IOException("Engine activation failed");
      Files.write(engineMarker.toPath(), engineHash.getBytes("UTF-8"));
    }
    append("JUPITER_ENGINE " + engineHash);
    File program = new File(root, "tmp/runtime-probe.cjs");
    copyAsset("runtime-probe.cjs", program);
    ConnectivityManager connectivity = (ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
    LinkProperties link = connectivity.getLinkProperties(connectivity.getActiveNetwork());
    StringBuilder resolvers = new StringBuilder();
    if (link != null) for (InetAddress address : link.getDnsServers()) resolvers.append("nameserver ").append(address.getHostAddress()).append("\n");
    Files.write(new File(root, "etc/resolv.conf").toPath(), resolvers.toString().getBytes("UTF-8"));
    String nativeDir = getApplicationInfo().nativeLibraryDir;
    File temp = new File(getCacheDir(), "proot");
    temp.mkdirs();
    List<String> args = new ArrayList<>(Arrays.asList(
      nativeDir + "/libproot.so", "-0", "--link2symlink", "-r", root.getAbsolutePath(),
      "-b", "/dev", "-b", "/proc", "-b", engine.getAbsolutePath() + ":/opt/jupiter", "-w", "/tmp",
      "/usr/bin/env", "-i", "HOME=/root", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp",
      "/usr/local/bin/node", "/tmp/runtime-probe.cjs", runId));
    boolean timeoutProbe = "timeout".equals(getIntent().getStringExtra("probeMode"));
    if (timeoutProbe) args.add("timeout");
    ProcessBuilder builder = new ProcessBuilder(args);
    builder.directory(root);
    builder.environment().clear();
    builder.environment().put("LD_LIBRARY_PATH", nativeDir);
    builder.environment().put("PROOT_LOADER", nativeDir + "/libproot-loader.so");
    builder.environment().put("PROOT_TMP_DIR", temp.getAbsolutePath());
    builder.environment().put("PROOT_NO_SECCOMP", "1");
    int code = execute(builder, timeoutProbe ? 2 : 90);
    append("JUPITER_PROBE_EXIT " + code);
    if (code != 0 || !guestResult) throw new IOException("Guest did not complete the current probe");
    args.set(args.indexOf("/tmp/runtime-probe.cjs"), "/opt/jupiter/engine-probe.cjs");
    // execute() wraps its own builder, so preserve the original guest argv for the second run.
    ProcessBuilder engineBuilder = new ProcessBuilder(args);
    engineBuilder.directory(root); engineBuilder.environment().clear(); engineBuilder.environment().putAll(builder.environment());
    int engineCode = execute(engineBuilder, 240);
    append("JUPITER_ENGINE_EXIT " + engineCode);
    if (engineCode != 0 || !engineResult) throw new IOException("Complete Jupiter probe failed");
    append("JUPITER_PROBE_PASS");
  }
}

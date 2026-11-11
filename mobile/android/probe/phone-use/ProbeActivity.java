package dev.jupiter.phoneuse.probe;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.ActivityOptions;
import android.app.Presentation;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Display;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class ProbeActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private VirtualDisplay display;
    private ImageReader reader;
    private Presentation control;
    private TextView report;
    private Button run;
    private Intent calculator;
    private volatile Process input;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 88, 32, 24);
        run = new Button(this);
        run.setText("Run offline test");
        run.setOnClickListener(v -> start());
        layout.addView(run);
        report = new TextView(this);
        report.setText(getPreferences(0).getString("result", "Unplug USB, then run the test."));
        layout.addView(report);
        setContentView(layout);
    }

    private void start() {
        run.setEnabled(false);
        report.setText("");
        record("App UID: " + android.os.Process.myUid() + "; main display: " + getDisplay().getDisplayId());
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_APP_CALCULATOR);
        ResolveInfo target = getPackageManager().resolveActivity(query, 0);
        if (target == null || !target.activityInfo.exported) {
            record("No exported calculator target");
            finishProbe();
            return;
        }
        calculator = new Intent(Intent.ACTION_MAIN).setComponent(new ComponentName(
            target.activityInfo.packageName, target.activityInfo.name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        checkDisplay(false);
    }

    private void checkDisplay(boolean shared) {
        String mode = shared ? "Public" : "Private";
        DisplayManager manager = getSystemService(DisplayManager.class);
        try {
            reader = ImageReader.newInstance(320, 480, PixelFormat.RGBA_8888, 2);
            int flags = DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION;
            if (shared) flags |= DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC;
            display = manager.createVirtualDisplay("JupiterOrdinaryProbe", 320, 480, 160, reader.getSurface(), flags);
            if (display == null || display.getDisplay().getDisplayId() == Display.DEFAULT_DISPLAY) {
                throw new IllegalStateException("No independent display");
            }
            int id = display.getDisplay().getDisplayId();
            record(mode + " display created: " + id);
            boolean allowed = getSystemService(ActivityManager.class)
                .isActivityStartAllowedOnDisplay(this, id, calculator);
            record(mode + " calculator launch allowed: " + allowed);
            if (allowed) {
                startActivity(calculator, ActivityOptions.makeBasic().setLaunchDisplayId(id).toBundle());
            } else {
                control = new Presentation(this, display.getDisplay());
                TextView content = new TextView(control.getContext());
                content.setBackgroundColor(Color.RED);
                content.setText("Jupiter capture control");
                control.setContentView(content);
                control.show();
            }
            handler.postDelayed(() -> inspect(mode, shared, allowed, id), 1100);
        } catch (RuntimeException e) {
            record(mode + " failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            advance(shared);
        }
    }

    private void inspect(String mode, boolean shared, boolean allowed, int id) {
        try (Image image = reader.acquireLatestImage()) {
            record(mode + " frame: " + (image == null ? "none" : image.getWidth() + "x" + image.getHeight())
                + (allowed ? " (target not independently verified)" : " (own-app control)"));
        }
        if (!allowed || !hasWindowFocus()) {
            if (allowed) record("Main probe lost focus; input skipped.");
            advance(shared);
            return;
        }
        // Diagnostic only: starting this executable does not change the APK UID.
        new Thread(() -> {
            String result;
            try {
                Process proc = new ProcessBuilder("/system/bin/input", "-d", String.valueOf(id),
                    "tap", "60", "260").redirectErrorStream(true).start();
                input = proc;
                if (!proc.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) {
                    proc.destroyForcibly();
                    result = "timed out";
                } else {
                    byte[] output = new byte[2048];
                    int size = proc.getInputStream().read(output);
                    result = "exit " + proc.exitValue() + (size <= 0 ? "" :
                        ": " + new String(output, 0, size, java.nio.charset.StandardCharsets.UTF_8).trim());
                }
            } catch (Exception e) {
                result = e.toString();
            } finally {
                input = null;
            }
            String outcome = result;
            handler.post(() -> {
                if (isDestroyed()) return;
                record("Display-specific input attempt: " + outcome + " (exit alone is not proof of input)");
                advance(shared);
            });
        }).start();
    }

    private void advance(boolean shared) {
        release();
        if (shared) finishProbe();
        else checkDisplay(true);
    }

    private void finishProbe() {
        record("Probe finished; main focus: " + hasWindowFocus());
        run.setEnabled(true);
    }

    private void record(String line) {
        report.append(line + "\n");
        getPreferences(0).edit().putString("result", report.getText().toString()).apply();
        Log.i("JupiterPhoneUseProbe", line);
    }

    private void release() {
        if (control != null) { control.dismiss(); control = null; }
        if (display != null) {
            int id = display.getDisplay().getDisplayId();
            display.release();
            display = null;
            record("Released display " + id);
        }
        if (reader != null) { reader.close(); reader = null; }
    }

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        Process proc = input;
        if (proc != null) proc.destroyForcibly();
        release();
        super.onDestroy();
    }
}

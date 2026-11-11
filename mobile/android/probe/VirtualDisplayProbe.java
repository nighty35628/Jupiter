import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;

/** Standalone shell diagnostic, not part of the application or tool surface. */
public final class VirtualDisplayProbe {
    public static void main(String[] args) throws Exception {
        File dir = new File(args[0]);
        Class<?> thread = Class.forName("android.app.ActivityThread");
        android.os.Looper.prepareMainLooper();
        Object instance = thread.getMethod("systemMain").invoke(null);
        Context system = (Context) thread.getMethod("getSystemContext").invoke(instance);
        Context shell = system.createPackageContext("com.android.shell", 0);
        DisplayManager displays = shell.getSystemService(DisplayManager.class);
        try (ImageReader reader = ImageReader.newInstance(480, 800, PixelFormat.RGBA_8888, 3)) {
            VirtualDisplay display = displays.createVirtualDisplay(
                "JupiterPhoneUseProbe", 480, 800, 160, reader.getSurface(),
                DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY);
            if (display == null) throw new IllegalStateException("Virtual display unavailable");
            try {
                int id = display.getDisplay().getDisplayId();
                if (id <= 0) throw new IllegalStateException("Invalid virtual display ID");
                System.out.println("display=" + id);
                for (int i = 0; i < 60; i++) {
                    if (new File(dir, "stop").exists()) break;
                    File request = new File(dir, "capture");
                    try (Image frame = reader.acquireLatestImage()) {
                        if (frame != null && request.delete()) save(frame, dir);
                    }
                    Thread.sleep(250);
                }
            } finally {
                display.release();
            }
        }
        System.exit(0);
    }

    private static void save(Image image, File dir) throws Exception {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer pixels = plane.getBuffer();
        int width = image.getWidth(), height = image.getHeight();
        int[] colors = new int[width * height];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                int p = y * plane.getRowStride() + x * plane.getPixelStride();
                colors[y * width + x] = 0xff000000 | ((pixels.get(p) & 255) << 16)
                    | ((pixels.get(p + 1) & 255) << 8) | (pixels.get(p + 2) & 255);
            }
        }
        Bitmap bitmap = Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888);
        File pending = new File(dir, "frame.tmp");
        try (FileOutputStream out = new FileOutputStream(pending)) {
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                throw new IllegalStateException("PNG encoding failed");
            }
        } finally {
            bitmap.recycle();
        }
        if (!pending.renameTo(new File(dir, "frame.png"))) {
            throw new IllegalStateException("Could not publish frame");
        }
    }
}

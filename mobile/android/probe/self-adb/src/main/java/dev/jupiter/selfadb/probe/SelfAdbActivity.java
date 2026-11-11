package dev.jupiter.selfadb.probe;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import io.github.muntashirakon.adb.AbsAdbConnectionManager;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

public final class SelfAdbActivity extends Activity {
    private static final String HOST = "127.0.0.1";
    private static final String ALIAS = "jupiter-self-adb-probe";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private EditText pairPort, connectPort, code;
    private TextView report;
    private Button pair, connect;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setPadding(32, 100, 32, 24);
        pairPort = field(view, "Pairing port", false);
        code = field(view, "Six-digit pairing code", true);
        pair = button(view, "Pair with this phone", () -> submit(true));
        connectPort = field(view, "Wireless debugging connection port", false);
        connect = button(view, "Check local TLS connection", () -> submit(false));
        report = new TextView(this);
        view.addView(report);
        setContentView(view);
    }

    private EditText field(LinearLayout view, String hint, boolean secret) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setSingleLine(true);
        field.setSaveEnabled(false);
        field.setImportantForAutofill(EditText.IMPORTANT_FOR_AUTOFILL_NO);
        field.setInputType(InputType.TYPE_CLASS_NUMBER |
            (secret ? InputType.TYPE_NUMBER_VARIATION_PASSWORD : 0));
        view.addView(field);
        return field;
    }

    private Button button(LinearLayout view, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(v -> action.run());
        view.addView(button);
        return button;
    }

    private void submit(boolean pairing) {
        int port;
        try {
            port = Integer.parseInt((pairing ? pairPort : connectPort).getText().toString());
            if (port < 1 || port > 65535) throw new NumberFormatException();
        } catch (NumberFormatException e) {
            report.setText("Enter a valid port.");
            return;
        }
        String pin = pairing ? code.getText().toString() : "";
        code.getText().clear();
        if (pairing && !pin.matches("[0-9]{6}")) {
            report.setText("Enter the current six-digit pairing code.");
            return;
        }
        pair.setEnabled(false);
        connect.setEnabled(false);
        report.setText(pairing ? "Pairing..." : "Connecting...");
        worker.execute(() -> {
            String outcome;
            try (Manager manager = new Manager(loadIdentity())) {
                if (pairing) {
                    outcome = manager.pair(HOST, port, pin)
                        ? "Paired. Now enter the connection port." : "Pairing rejected.";
                } else {
                    if (!manager.connect(HOST, port)) throw new IllegalStateException("Connect failed");
                    // Probe-only check. Shipping requires a supported TLS-only library interface.
                    Object connection = manager.getAdbConnection();
                    java.lang.reflect.Field tls = connection.getClass().getDeclaredField("mIsTls");
                    tls.setAccessible(true);
                    if (!tls.getBoolean(connection)) throw new SecurityException("TLS required");
                    outcome = "Local TLS connected successfully. Connection closed.";
                }
            } catch (Exception e) {
                outcome = (pairing ? "Pairing failed: " : "Connection failed: ") + e.getClass().getSimpleName()
                    + (e.getCause() == null ? "" : " / " + e.getCause().getClass().getSimpleName());
            }
            String result = outcome;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                report.setText(result);
                pair.setEnabled(true);
                connect.setEnabled(true);
            });
        });
    }

    @Override protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    private KeyStore.PrivateKeyEntry loadIdentity() throws Exception {
        String alias = ALIAS + "-wrapping";
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(alias)) {
            javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        java.security.Key wrappingKey = store.getKey(alias, null);
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        android.util.AtomicFile file = new android.util.AtomicFile(
            new java.io.File(getNoBackupFilesDir(), "adb-identity"));
        KeyStore identity = KeyStore.getInstance("PKCS12");
        char[] password = new char[0]; // The entire container is encrypted by AndroidKeyStore.
        if (file.getBaseFile().exists()) {
            byte[] encoded = file.readFully();
            cipher.init(javax.crypto.Cipher.DECRYPT_MODE, wrappingKey,
                new javax.crypto.spec.GCMParameterSpec(128, encoded, 0, 12));
            identity.load(new java.io.ByteArrayInputStream(cipher.doFinal(encoded, 12, encoded.length - 12)), password);
        } else {
            KeyPairGenerator keys = KeyPairGenerator.getInstance("RSA");
            keys.initialize(2048);
            java.security.KeyPair key = keys.generateKeyPair();
            long now = System.currentTimeMillis();
            org.bouncycastle.asn1.x500.X500Name name =
                new org.bouncycastle.asn1.x500.X500Name("CN=Jupiter Self ADB Probe");
            org.bouncycastle.cert.X509CertificateHolder certificate =
                new org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder(name, java.math.BigInteger.valueOf(now),
                    new java.util.Date(now - 60000), new java.util.Date(now + 315360000000L), name, key.getPublic())
                    .build(new org.bouncycastle.operator.jcajce.JcaContentSignerBuilder("SHA256withRSA").build(key.getPrivate()));
            Certificate cert = java.security.cert.CertificateFactory.getInstance("X.509")
                .generateCertificate(new java.io.ByteArrayInputStream(certificate.getEncoded()));
            identity.load(null, password);
            identity.setKeyEntry(ALIAS, key.getPrivate(), password, new Certificate[]{cert});
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            identity.store(buffer, password);
            cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, wrappingKey);
            byte[] encrypted = cipher.doFinal(buffer.toByteArray());
            java.io.FileOutputStream out = file.startWrite();
            try {
                out.write(cipher.getIV());
                out.write(encrypted);
                file.finishWrite(out);
            } catch (Exception e) {
                file.failWrite(out);
                throw e;
            }
        }
        return (KeyStore.PrivateKeyEntry) identity.getEntry(ALIAS, new KeyStore.PasswordProtection(password));
    }

    private static final class Manager extends AbsAdbConnectionManager {
        private final KeyStore.PrivateKeyEntry identity;

        Manager(KeyStore.PrivateKeyEntry identity) {
            this.identity = identity;
            setApi(Build.VERSION.SDK_INT);
            setThrowOnUnauthorised(true);
            setTimeout(5, TimeUnit.SECONDS);
        }

        @Override protected PrivateKey getPrivateKey() { return identity.getPrivateKey(); }
        @Override protected Certificate getCertificate() { return identity.getCertificate(); }
        @Override protected String getDeviceName() { return "Jupiter Self ADB Probe"; }
    }
}

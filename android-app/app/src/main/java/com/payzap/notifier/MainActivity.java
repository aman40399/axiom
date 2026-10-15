package com.payzap.notifier;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;



public class MainActivity extends AppCompatActivity {

    private EditText urlInput;
    private Button saveBtn, testBtn, permissionBtn, clearBtn;
    private TextView statusText, logText;
    private ScrollView logScroll;
    private SharedPreferences prefs;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final StringBuilder logBuffer = new StringBuilder();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences("payzap_config", MODE_PRIVATE);

        urlInput = findViewById(R.id.urlInput);
        saveBtn = findViewById(R.id.saveBtn);
        testBtn = findViewById(R.id.testBtn);
        permissionBtn = findViewById(R.id.permissionBtn);
        clearBtn = findViewById(R.id.clearBtn);
        statusText = findViewById(R.id.statusText);
        logText = findViewById(R.id.logText);
        logScroll = findViewById(R.id.logScroll);

        // Load saved URL
        String savedUrl = prefs.getString("server_url", "https://80s2kpc5hi.execute-api.us-east-1.amazonaws.com");
        if (prefs.getString("server_url", "").isEmpty()) {
            prefs.edit().putString("server_url", savedUrl).apply();
        }
        urlInput.setText(savedUrl);

        // Save URL button
        saveBtn.setOnClickListener(v -> {
            String url = urlInput.getText().toString().trim();
            if (url.isEmpty()) {
                Toast.makeText(this, "Enter a server URL", Toast.LENGTH_SHORT).show();
                return;
            }
            // Remove trailing slash for consistency
            if (url.endsWith("/")) url = url.substring(0, url.length() - 1);
            prefs.edit().putString("server_url", url).apply();
            Toast.makeText(this, "Server URL saved!", Toast.LENGTH_SHORT).show();
            updateStatus();
        });

        // Test connection button
        testBtn.setOnClickListener(v -> testConnection());

        // Open notification permission settings
        permissionBtn.setOnClickListener(v -> {
            Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            startActivity(intent);
        });

        // Clear log
        clearBtn.setOnClickListener(v -> {
            logBuffer.setLength(0);
            logText.setText("Log cleared.\n");
        });

        // Set up log callback from the notification listener
        PaytmNotificationListener.setLogCallback(msg -> {
            mainHandler.post(() -> appendLog(msg));
        });

        updateStatus();
        appendLog("App started. Waiting for Paytm notifications...");
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
    }

    private void updateStatus() {
        String url = prefs.getString("server_url", "");
        boolean hasPermission = isNotificationListenerEnabled();

        StringBuilder sb = new StringBuilder();

        if (hasPermission) {
            sb.append("🟢 Notification access: GRANTED\n");
        } else {
            sb.append("🔴 Notification access: NOT GRANTED\n");
        }

        if (!url.isEmpty()) {
            sb.append("🟢 Server: ").append(url).append("\n");
        } else {
            sb.append("🔴 Server URL: Not configured\n");
        }

        if (hasPermission && !url.isEmpty()) {
            sb.append("\n✅ Ready! Paytm payment notifications will be forwarded automatically.");
        } else {
            sb.append("\n⚠️ Complete the setup above to start forwarding.");
        }

        statusText.setText(sb.toString());
    }

    private boolean isNotificationListenerEnabled() {
        String listeners = Settings.Secure.getString(
            getContentResolver(), "enabled_notification_listeners"
        );
        return listeners != null && listeners.contains(getPackageName());
    }

    private void testConnection() {
        String url = prefs.getString("server_url", "");
        if (url.isEmpty()) {
            Toast.makeText(this, "Save a server URL first", Toast.LENGTH_SHORT).show();
            return;
        }

        appendLog("🔄 Testing connection to " + url + "...");
        testBtn.setEnabled(false);

        executor.submit(() -> {
            HttpURLConnection conn = null;
            try {
                String endpoint = url + "/webhook/notification";
                URL urlObj = new URL(endpoint);
                conn = (HttpURLConnection) urlObj.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("X-PayZap-Source", "android-app-test");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                // Send a test payment notification
                String json = "{"
                    + "\"text\":\"[TEST] Rs. 1.00 received from 9999999999. UPI Ref No. 999999999999.\","
                    + "\"title\":\"Paytm Test\","
                    + "\"package\":\"com.one97.paytm\","
                    + "\"timestamp\":" + System.currentTimeMillis() + ","
                    + "\"isTest\":true"
                    + "}";

                byte[] payload = json.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload);
                }

                int code = conn.getResponseCode();
                mainHandler.post(() -> {
                    if (code == 200) {
                        appendLog("✅ Connection OK! Server responded 200.");
                        Toast.makeText(this, "Connection successful!", Toast.LENGTH_SHORT).show();
                    } else {
                        appendLog("⚠️ Server returned HTTP " + code);
                    }
                    testBtn.setEnabled(true);
                });

            } catch (Exception e) {
                mainHandler.post(() -> {
                    appendLog("❌ Connection failed: " + e.getMessage());
                    Toast.makeText(this, "Connection failed!", Toast.LENGTH_SHORT).show();
                    testBtn.setEnabled(true);
                });
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private void appendLog(String msg) {
        String timestamp = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());
        String line = "[" + timestamp + "] " + msg + "\n";
        logBuffer.append(line);

        // Keep only last 50 lines
        String[] lines = logBuffer.toString().split("\n");
        if (lines.length > 50) {
            logBuffer.setLength(0);
            for (int i = lines.length - 50; i < lines.length; i++) {
                logBuffer.append(lines[i]).append("\n");
            }
        }

        logText.setText(logBuffer.toString());
        logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdown();
    }
}

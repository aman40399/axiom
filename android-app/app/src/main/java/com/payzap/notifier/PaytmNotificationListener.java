package com.payzap.notifier;

import android.app.Notification;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;



public class PaytmNotificationListener extends NotificationListenerService {

    private static final String TAG = "PayZapListener";

    // Paytm package names to listen for
    private static final String[] PAYTM_PACKAGES = {
        "com.one97.paytm",           // Paytm consumer app
        "net.one97.paytm",           // Paytm Business (merchant)
        "com.paytm.business"         // Paytm Business alternate
    };

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    // Callback to update the UI log
    public interface LogCallback {
        void onLog(String message);
    }

    private static LogCallback logCallback;

    public static void setLogCallback(LogCallback callback) {
        logCallback = callback;
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        String packageName = sbn.getPackageName();

        // Only process Paytm notifications
        if (!isPaytmPackage(packageName)) {
            return;
        }

        Notification notification = sbn.getNotification();
        if (notification == null) return;

        Bundle extras = notification.extras;
        if (extras == null) return;

        // Extract notification text
        String title = extras.containsKey(Notification.EXTRA_TITLE)
            ? String.valueOf(extras.get(Notification.EXTRA_TITLE))
            : "";
        String text = extras.containsKey(Notification.EXTRA_TEXT)
            ? String.valueOf(extras.get(Notification.EXTRA_TEXT))
            : "";
        String bigText = extras.containsKey(Notification.EXTRA_BIG_TEXT)
            ? String.valueOf(extras.get(Notification.EXTRA_BIG_TEXT))
            : "";

        // Use the longest text available (bigText usually has the full notification)
        String notificationText = bigText.length() > text.length() ? bigText : text;

        if (notificationText.isEmpty() && title.isEmpty()) {
            return;
        }

        // Combine title + body for keyword check and sending
        String fullText = (title + " " + notificationText).trim();

        // Quick filter: only forward if it looks like a payment notification
        String lower = fullText.toLowerCase();
        boolean isPayment = lower.contains("received") || lower.contains("credited")
            || lower.contains("deposited") || lower.contains("debited")
            || lower.contains("payment") || lower.contains("rs.") || lower.contains("rs ")
            || lower.contains("₹") || lower.contains("upi") || lower.contains("sent")
            || lower.contains("paid");

        if (!isPayment) {
            logMessage("⏭ Skipped non-payment: " + fullText.substring(0, Math.min(50, fullText.length())));
            return;
        }

        logMessage("📱 Captured: " + fullText);

        // Get server URL from SharedPreferences
        SharedPreferences prefs = getSharedPreferences("payzap_config", MODE_PRIVATE);
        String serverUrl = prefs.getString("server_url", "");

        if (serverUrl.isEmpty()) {
            logMessage("⚠️ No server URL configured!");
            return;
        }

        // Forward to server in background thread — send combined title+body so parser gets full text
        executor.submit(() -> postToServer(serverUrl, fullText, title, packageName));
    }

    private boolean isPaytmPackage(String pkg) {
        for (String paytmPkg : PAYTM_PACKAGES) {
            if (paytmPkg.equals(pkg)) return true;
        }
        return false;
    }

    private void postToServer(String serverUrl, String text, String title, String packageName) {
        HttpURLConnection conn = null;
        try {
            String endpoint = serverUrl.endsWith("/")
                ? serverUrl + "webhook/notification"
                : serverUrl + "/webhook/notification";

            URL url = new URL(endpoint);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            conn.setRequestProperty("X-PayZap-Source", "android-app");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);

            // Build JSON payload — escape special chars properly
            String json = "{"
                + "\"text\":" + escapeJson(text) + ","
                + "\"title\":" + escapeJson(title) + ","
                + "\"package\":" + escapeJson(packageName) + ","
                + "\"timestamp\":" + System.currentTimeMillis()
                + "}";

            byte[] payload = json.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);

            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int responseCode = conn.getResponseCode();
            if (responseCode == 200) {
                logMessage("✅ Sent to server successfully");
            } else {
                logMessage("❌ Server returned " + responseCode);
            }

        } catch (Exception e) {
            logMessage("❌ Send failed: " + e.getMessage());
            Log.e(TAG, "POST failed", e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String escapeJson(String value) {
        if (value == null) return "null";
        return "\"" + value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
            + "\"";
    }

    private void logMessage(String msg) {
        String timestamp = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());
        String fullMsg = "[" + timestamp + "] " + msg;
        Log.d(TAG, fullMsg);
        if (logCallback != null) {
            logCallback.onLog(fullMsg);
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // Not needed
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        executor.shutdown();
    }
}

package com.teamlabstudios.puente;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.lang.reflect.Constructor;

/** Funciones de Android 8+ llamadas con reflexión: la app se compila contra la API 23. */
final class Compat {
  private Compat() {}
  static final String QUIET = "puente", LOUD = "puente-avisos";

  static Notification.Builder builder(Context c, boolean loud) {
    if (Build.VERSION.SDK_INT >= 26) {
      try {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        Class<?> ch = Class.forName("android.app.NotificationChannel");
        String id = loud ? LOUD : QUIET;
        Object channel = ch.getConstructor(String.class, CharSequence.class, int.class).newInstance(id, loud ? "Avisos (te piden enviar algo)" : "Puente en marcha", loud ? 4 /* HIGH */ : 2 /* LOW */);
        NotificationManager.class.getMethod("createNotificationChannel", ch).invoke(nm, channel);
        Constructor<Notification.Builder> k = Notification.Builder.class.getConstructor(Context.class, String.class);
        return k.newInstance(c, id);
      } catch (Exception ignored) {}
    }
    Notification.Builder b = new Notification.Builder(c);
    if (loud) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
    return b;
  }

  static void startForegroundService(Context c, Intent i) {
    if (Build.VERSION.SDK_INT >= 26) { try { Context.class.getMethod("startForegroundService", Intent.class).invoke(c, i); return; } catch (Exception ignored) {} }
    c.startService(i);
  }
}

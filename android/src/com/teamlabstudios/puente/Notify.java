package com.teamlabstudios.puente;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.text.format.Formatter;

import java.util.Map;

/** Notificaciones: alguien quiere enviarte algo (con Aceptar / Rechazar), progreso y «recibido». */
final class Notify {
  private Notify() {}
  static final int RUN = 1, PROG = 2;

  static NotificationManager nm(Context c) { return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE); }
  static PendingIntent open(Context c) {
    return PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }
  static int idOf(String s) { return 1000 + (s == null ? 0 : (s.hashCode() & 0xffff)); }
  static String n(Object o) { return o == null ? "" : o.toString(); }
  static long l(Object o) { return o instanceof Number ? ((Number) o).longValue() : 0; }

  static void ask(Context c, Map<String, Object> d) {
    String id = n(d.get("id"));
    long files = l(d.get("files"));
    Intent yes = new Intent(c, PuenteService.class).setAction(PuenteService.ACEPTAR).putExtra("id", id);
    Intent no = new Intent(c, PuenteService.class).setAction(PuenteService.RECHAZAR).putExtra("id", id);
    String title = n(d.get("name")) + " quiere enviarte " + files + (files == 1 ? " archivo" : " archivos");
    String text = Formatter.formatShortFileSize(c, l(d.get("size"))) + (Boolean.TRUE.equals(d.get("private")) ? " · sesión privada" : "");
    Notification nn = Compat.builder(c, true).setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text)
      .setContentIntent(open(c)).setAutoCancel(true).setCategory(Notification.CATEGORY_MESSAGE)
      .addAction(0, "Aceptar", PendingIntent.getService(c, idOf(id), yes, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
      .addAction(0, "Rechazar", PendingIntent.getService(c, idOf(id) + 1, no, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
      .build();
    nm(c).notify(idOf(id), nn);
  }
  static void cancelAsk(Context c, String id) { nm(c).cancel(idOf(id)); }

  /** «Ya está en el PC (comprobado). ¿Borrar del móvil?» — se contesta en la app (Android puede pedir permiso) */
  static void askDelete(Context c, Map<String, Object> d) {
    String id = n(d.get("id"));
    long files = l(d.get("files"));
    Intent yes = new Intent(c, MainActivity.class).setAction(MainActivity.BORRAR).putExtra("id", id).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    String text = files + (files == 1 ? " archivo" : " archivos") + " · " + Formatter.formatShortFileSize(c, l(d.get("size"))) + " · comprobado en " + n(d.get("name"));
    Notification nn = Compat.builder(c, false).setSmallIcon(R.drawable.ic_stat).setContentTitle("Enviado. ¿Borrar del móvil?").setContentText(text)
      .setContentIntent(open(c)).setAutoCancel(true)
      .addAction(0, "Borrar del móvil", PendingIntent.getActivity(c, idOf("borrar" + id), yes, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
      .build();
    nm(c).notify(idOf("borrar" + id), nn);
  }

  static long lastProg = 0;
  static void transfer(Context c, Map<String, Object> d) {
    String st = n(d.get("status"));
    if ("pregunta".equals(st) || "esperando".equals(st) || "conectando".equals(st)) return;
    if (!"enviando".equals(st) && !"recibiendo".equals(st)) { nm(c).cancel(PROG); if (!"hecho".equals(st)) cancelAsk(c, n(d.get("id"))); return; }
    long now = System.currentTimeMillis();
    if (now - lastProg < 900) return;
    lastProg = now;
    long size = l(d.get("size")), done = l(d.get("done"));
    boolean out = "out".equals(d.get("dir"));
    Notification nn = Compat.builder(c, false).setSmallIcon(R.drawable.ic_stat)
      .setContentTitle((out ? "Enviando a " : "Recibiendo de ") + n(d.get("name")))
      .setContentText(Formatter.formatShortFileSize(c, done) + " de " + Formatter.formatShortFileSize(c, size) + " · cifrado")
      .setProgress(1000, size > 0 ? (int) (done * 1000 / size) : 0, false).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open(c))
      .addAction(0, "Cancelar", PendingIntent.getService(c, 9, new Intent(c, PuenteService.class).setAction(PuenteService.CANCELAR).putExtra("id", n(d.get("id"))), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
    nm(c).notify(PROG, nn);
  }

  static void received(Context c, Map<String, Object> d, boolean background) {
    cancelAsk(c, n(d.get("id")));
    nm(c).cancel(PROG);
    if (!background) return;
    long files = l(d.get("files"));
    simple(c, idOf(n(d.get("id"))) + 2, "✓ Recibido", files + (files == 1 ? " archivo" : " archivos") + " de " + n(d.get("name")) + (Boolean.TRUE.equals(d.get("private")) ? " (sesión privada: se borrará solo)" : " · en Descargas/Puente"));
  }

  static void simple(Context c, int id, String title, String text) {
    nm(c).notify(id, Compat.builder(c, false).setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(open(c)).build());
  }
}

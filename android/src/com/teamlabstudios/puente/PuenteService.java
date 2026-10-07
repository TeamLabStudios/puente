package com.teamlabstudios.puente;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.IBinder;

import java.io.IOException;
import java.util.Map;

/**
 * Servicio en primer plano: mientras «Recibir» está encendido, Puente escucha en la red de casa y en el relé;
 * también termina los envíos aunque apagues la pantalla.
 */
public class PuenteService extends Service {
  static final String RECIBIR = "recibir", PARAR = "parar", TRABAJO = "trabajo", ACEPTAR = "aceptar", RECHAZAR = "rechazar", PANICO = "panico", CANCELAR = "cancelar";
  private volatile boolean listening = false;
  /** Encender y apagar la red, de uno en uno y en orden */
  static final java.util.concurrent.ExecutorService NET = java.util.concurrent.Executors.newSingleThreadExecutor();
  private volatile boolean working = false;
  private WifiManager.WifiLock wifi;

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    final Puente p = Puente.get(this);
    String a = intent == null ? (p.receiving() ? RECIBIR : PARAR) : intent.getAction();
    if (a == null) a = RECIBIR;
    startForeground(Notify.RUN, running());
    if (ACEPTAR.equals(a) || RECHAZAR.equals(a)) {
      String id = intent.getStringExtra("id");
      p.engine.answer(id, ACEPTAR.equals(a));
      Notify.cancelAsk(this, id);
    } else if (CANCELAR.equals(a)) {
      String id = intent.getStringExtra("id");
      if (id != null && id.matches("[0-9a-f]{8,32}")) p.engine.cancel(id);
      Notify.nm(this).cancel(Notify.PROG);
    } else if (PANICO.equals(a)) {
      new Thread(new Runnable() { public void run() { p.engine.panic(); } }).start();
      Notify.nm(this).cancelAll();
    } else if (RECIBIR.equals(a) && p.receiving()) {
      startListening(p);
    } else if (PARAR.equals(a)) {
      p.prefs.edit().putBoolean("recibir", false).apply();
      stopListening(p); // la pantalla sigue buscando tus PC en casa
      p.dispatch("recibir", Puente.ev("recibir", "on", false));
    } else if (TRABAJO.equals(a)) {
      if (!working) {
        working = true;
        new Thread(new Runnable() { public void run() { work(p); } }, "puente-enviar").start();
      }
    }
    if (p.receiving() && !listening) startListening(p);
    update();
    return p.receiving() ? START_STICKY : START_NOT_STICKY;
  }

  /** La red, fuera del hilo de la pantalla (Android no deja tocar la red desde ahí). */
  private synchronized void startListening(final Puente p) {
    if (listening) return;
    listening = true;
    NET.execute(new Runnable() { public void run() {
      try { p.engine.listen((int) p.engine.settingNum("port")); }
      catch (IOException e) { listening = false; Notify.simple(PuenteService.this, 41, "Puente no puede recibir", e.getMessage()); return; }
      p.network(true);
      p.engine.setRelayEnabled(true);
      p.dispatch("recibir", Puente.ev("recibir", "on", true));
    } });
    try { if (wifi == null) { wifi = ((WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE)).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "puente"); wifi.setReferenceCounted(false); } wifi.acquire(); } catch (RuntimeException ignored) {}
  }
  private synchronized void stopListening(final Puente p) {
    listening = false;
    NET.execute(new Runnable() { public void run() { p.engine.setRelayEnabled(false); p.engine.stop(); if (!p.uis.isEmpty()) p.network(true); } });
    if (wifi != null && wifi.isHeld()) wifi.release();
  }

  private void work(Puente p) {
    // el móvil se mantiene despierto solo mientras pasan datos (Puente.awake), no horas seguidas
    try {
      p.network(true);
      Puente.Job j;
      while ((j = p.jobs.poll()) != null) { update(); Map<String, Object> r = p.engine.send(j.fp, j.list, j.priv); p.afterSend(j, r); }
    } finally {
      working = false;
      update();
      if (!p.receiving() && p.jobs.isEmpty()) { stopForeground(true); stopSelf(); }
    }
  }

  private void update() {
    Puente p = Puente.get(this);
    if (!p.receiving() && !working) { stopForeground(true); stopSelf(); return; }
    Notify.nm(this).notify(Notify.RUN, running());
  }

  private Notification running() {
    Puente p = Puente.get(this);
    boolean rec = p.receiving();
    Notification.Builder b = Compat.builder(this, false).setSmallIcon(R.drawable.ic_stat).setOngoing(true).setShowWhen(false)
      .setContentTitle(working ? "Puente · enviando" : "Puente · listo para recibir")
      .setContentText(rec ? "Tus aparatos de confianza pueden enviarte archivos (cifrado de punta a punta)" : "Terminando el envío…")
      .setContentIntent(Notify.open(this));
    if (rec) b.addAction(0, "Dejar de recibir", PendingIntent.getService(this, 3, new Intent(this, PuenteService.class).setAction(PARAR).putExtra("off", true), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    b.addAction(0, "Pánico", PendingIntent.getService(this, 4, new Intent(this, PuenteService.class).setAction(PANICO), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    return b.build();
  }

  @Override public void onDestroy() {
    Puente p = Puente.get(this);
    if (listening) stopListening(p);
    super.onDestroy();
  }
}

package com.teamlabstudios.puente;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.webkit.MimeTypeMap;

import com.teamlabstudios.puente.core.Bytes;
import com.teamlabstudios.puente.core.Engine;
import com.teamlabstudios.puente.core.Json;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** El corazón de la app: un único motor para la pantalla y el servicio, guardado cifrado y dónde dejar lo recibido. */
public final class Puente {
  private static Puente I;
  public final Engine engine;
  final Context app;
  final SharedPreferences prefs;
  final List<Engine.Listener> uis = new CopyOnWriteArrayList<>();
  final LinkedBlockingQueue<Job> jobs = new LinkedBlockingQueue<>();
  private WifiManager.MulticastLock mlock;

  static final class Job { String fp; List<Engine.Source> list; boolean priv; Uri tree; }
  /** Lo enviado que espera tu respuesta a «¿borrar del móvil?» (id de la transferencia → lo enviado) */
  final Map<String, Job> sentAsk = new java.util.concurrent.ConcurrentHashMap<>();
  /** Lo que Android solo deja borrar con tu permiso (ventana del sistema) */
  final List<Uri> needConsent = new CopyOnWriteArrayList<>();
  private android.os.PowerManager.WakeLock wl;

  public static synchronized Puente get(Context c) {
    if (I == null) I = new Puente(c.getApplicationContext());
    return I;
  }

  private Puente(Context c) {
    app = c;
    prefs = c.getSharedPreferences("puente", Context.MODE_PRIVATE);
    Engine.Store store = new Engine.Store() {
      public String get(String k) { return prefs.getString(k, null); }
      public void put(String k, String v) { prefs.edit().putString(k, v).commit(); }
    };
    String name = Build.MANUFACTURER != null && Build.MODEL != null && !Build.MODEL.toLowerCase().startsWith(Build.MANUFACTURER.toLowerCase()) ? cap(Build.MANUFACTURER) + " " + Build.MODEL : (Build.MODEL == null ? "Móvil" : Build.MODEL);
    engine = new Engine(store, new KeystoreGuard(), new File(c.getFilesDir(), "puente"), new DownloadsSaver(c), name);
    engine.setRelayEnabled(receiving());
    engine.setListener(new Engine.Listener() { public void on(String type, Map<String, Object> d) { dispatch(type, d); } });
  }
  static String cap(String s) { return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1); }

  // ---------- avisos ----------
  void dispatch(String type, Map<String, Object> d) {
    if ("transfer".equals(type)) awake(d);
    for (Engine.Listener l : uis) l.on(type, d);
    try {
      if ("ask".equals(type)) Notify.ask(app, d);
      else if ("received".equals(type)) Notify.received(app, d, uis.isEmpty());
      else if ("transfer".equals(type)) Notify.transfer(app, d);
      else if ("intruder".equals(type) && uis.isEmpty()) Notify.simple(app, 40, "Alguien desconocido intentó entrar", "Puente lo ha rechazado. Tus archivos siguen a salvo.");
    } catch (RuntimeException ignored) {}
  }

  // Mantener el móvil despierto SOLO mientras pasan datos: 2 minutos que se renuevan con cada avance
  // y se sueltan al terminar, cancelar, cortarse o fallar.
  final Map<String, Long> activeT = new java.util.concurrent.ConcurrentHashMap<>();
  synchronized void awake(Map<String, Object> d) {
    String st = String.valueOf(d.get("status")), id = String.valueOf(d.get("id"));
    if ("enviando".equals(st) || "recibiendo".equals(st)) activeT.put(id, System.currentTimeMillis()); else activeT.remove(id);
    try {
      if (wl == null) { wl = ((android.os.PowerManager) app.getSystemService(Context.POWER_SERVICE)).newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "puente:datos"); wl.setReferenceCounted(false); }
      if (!activeT.isEmpty()) wl.acquire(2 * 60_000L); else if (wl.isHeld()) wl.release();
    } catch (RuntimeException ignored) {}
  }

  // ---------- borrar del móvil lo enviado (opcional) ----------
  /** «no» = conservar · «preguntar» · «si» = borrar siempre. Solo se aplica si el PC confirma que TODO llegó idéntico. */
  public String deleteMode() { String m = engine.setting("deleteAfter"); return m.isEmpty() ? "no" : m; }

  /** Después de un envío: según el ajuste, borra, pregunta o nada. Nunca en sesión privada (el otro lo borrará solo). */
  void afterSend(Job j, Map<String, Object> r) {
    cleanCopies(j);
    if (!"hecho".equals(r.get("status")) || j.priv || Boolean.TRUE.equals(r.get("private"))) return;
    String mode = deleteMode(), id = String.valueOf(r.get("id"));
    if ("si".equals(mode)) deleteNow(j, String.valueOf(r.get("name")));
    else if ("preguntar".equals(mode)) {
      sentAsk.put(id, j);
      Map<String, Object> ask = Json.o("id", id, "name", r.get("name"), "files", j.list.size(), "size", r.get("size"));
      dispatch("sent-ask-delete", ask);
      if (uis.isEmpty()) Notify.askDelete(app, ask);
    }
  }
  /** Respuesta a «¿borrar del móvil?» */
  public void answerDelete(String id, boolean yes) {
    Job j = sentAsk.remove(id);
    Notify.cancelAsk(app, "borrar" + id);
    if (j != null && yes) deleteNow(j, null);
  }
  void deleteNow(Job j, String to) {
    int[] r = deleteSources(j);
    Map<String, Object> d = Json.o("deleted", r[0], "failed", r[1], "consent", needConsent.size());
    dispatch("deleted", d);
    if (!needConsent.isEmpty() && uis.isEmpty()) Notify.simple(app, 43, "Falta un paso para liberar espacio", "Toca para que Android te deje borrar " + needConsent.size() + (needConsent.size() == 1 ? " archivo ya enviado" : " archivos ya enviados") + ".");
  }

  /** Borra lo enviado: [borrados, no se pueden]. Lo que necesita tu permiso queda en needConsent. */
  int[] deleteSources(Job j) {
    ContentResolver cr = app.getContentResolver();
    int ok = 0, bad = 0;
    for (Engine.Source s : j.list) {
      if (!(s instanceof UriSource)) continue;
      Uri u = ((UriSource) s).uri;
      try { if (DocumentsContract.isDocumentUri(app, u) && DocumentsContract.deleteDocument(cr, u)) { ok++; continue; } } catch (Exception ignored) {}
      Uri media = mediaUri(u);
      if (media != null) {
        try { if (cr.delete(media, null, null) > 0) { ok++; continue; } } catch (SecurityException e) { needConsent.add(media); continue; } catch (Exception ignored) {}
        if (Build.VERSION.SDK_INT >= 30) { needConsent.add(media); continue; }
      }
      bad++;
    }
    // carpeta enviada entera: si se ha quedado vacía, también se quita
    if (j.tree != null && bad == 0) {
      try {
        List<Engine.Source> left = folder(j.tree);
        if (left.isEmpty()) DocumentsContract.deleteDocument(cr, DocumentsContract.buildDocumentUriUsingTree(j.tree, DocumentsContract.getTreeDocumentId(j.tree)));
      } catch (Exception ignored) {}
    }
    return new int[] { ok, bad };
  }
  /** Una foto/vídeo de la galería → su dirección en MediaStore (para pedir permiso de borrado) */
  static Uri mediaUri(Uri u) {
    if ("media".equals(u.getAuthority())) return u;
    if ("com.android.providers.media.documents".equals(u.getAuthority())) {
      try {
        String id = DocumentsContract.getDocumentId(u); String[] p = id.split(":");
        if (p.length != 2 || !p[1].matches("\\d+")) return null;
        String table = "image".equals(p[0]) ? "images" : "video".equals(p[0]) ? "video" : "audio".equals(p[0]) ? "audio" : null;
        return table == null ? null : Uri.parse("content://media/external/" + table + "/media/" + p[1]);
      } catch (Exception e) { return null; }
    }
    return null;
  }
  void cleanCopies(Job j) { for (Engine.Source s : j.list) if (s instanceof UriSource && ((UriSource) s).copy != null) ((UriSource) s).copy.delete(); }

  // ---------- recibir ----------
  public boolean receiving() { return prefs.getBoolean("recibir", true); }
  public void setReceiving(boolean on) {
    prefs.edit().putBoolean("recibir", on).apply();
    Intent i = new Intent(app, PuenteService.class).setAction(on ? PuenteService.RECIBIR : PuenteService.PARAR);
    if (on) Compat.startForegroundService(app, i); else app.startService(i);
  }

  /** Escuchar los avisos de la red de casa (para encontrar tus PC). */
  public synchronized void network(boolean on) {
    try {
      if (on) {
        if (mlock == null) { mlock = ((WifiManager) app.getSystemService(Context.WIFI_SERVICE)).createMulticastLock("puente"); mlock.setReferenceCounted(false); }
        mlock.acquire();
        new Thread(new Runnable() { public void run() { engine.startUdp(); } }, "puente-udp").start();
      } else if (mlock != null && mlock.isHeld()) mlock.release();
    } catch (RuntimeException ignored) {}
  }

  // ---------- enviar ----------
  public void queueSend(String fp, List<Engine.Source> list, boolean priv) { queueSend(fp, list, priv, null); }
  public void queueSend(String fp, List<Engine.Source> list, boolean priv, Uri tree) {
    Job j = new Job(); j.fp = fp; j.list = list; j.priv = priv; j.tree = tree;
    jobs.add(j);
    Compat.startForegroundService(app, new Intent(app, PuenteService.class).setAction(PuenteService.TRABAJO));
  }

  /** Lo que el usuario elige (fotos, archivos, lo compartido desde otra app) */
  public static final class UriSource implements Engine.Source {
    final ContentResolver cr; final Uri uri; final String rel; long size, mtime; File copy;
    UriSource(ContentResolver cr, Uri uri, String rel, long size, long mtime) { this.cr = cr; this.uri = uri; this.rel = rel; this.size = size; this.mtime = mtime; }
    public String rel() { return rel; }
    public long size() { return size; }
    public long mtime() { return mtime; }
    public InputStream open() throws IOException {
      if (copy != null) return new FileInputStream(copy);
      InputStream in = cr.openInputStream(uri);
      if (in == null) throw new IOException("No puedo leer «" + rel + "»");
      return in;
    }
  }

  /** De una lista de direcciones content:// a cosas que mandar (con su nombre y tamaño). */
  public List<Engine.Source> sources(List<Uri> uris) throws IOException {
    List<Engine.Source> out = new ArrayList<>();
    ContentResolver cr = app.getContentResolver();
    for (Uri u : uris) {
      String name = null; long size = -1, mtime = 0;
      Cursor c = null;
      try {
        c = cr.query(u, null, null, null, null);
        if (c != null && c.moveToFirst()) {
          int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE), mi = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
          if (ni >= 0) name = c.getString(ni);
          if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
          if (mi >= 0 && !c.isNull(mi)) mtime = c.getLong(mi);
        }
      } catch (RuntimeException ignored) {} finally { if (c != null) c.close(); }
      if (name == null) { name = u.getLastPathSegment(); if (name == null) name = "archivo"; int s = name.lastIndexOf('/'); if (s >= 0) name = name.substring(s + 1); }
      UriSource src = new UriSource(cr, u, Engine.safePart(name), size, mtime);
      if (size < 0) { // sin tamaño conocido: se copia antes (el protocolo necesita saberlo)
        File tmp = new File(app.getCacheDir(), "enviar-" + System.nanoTime());
        InputStream in = cr.openInputStream(u); OutputStream o = new FileOutputStream(tmp);
        try { byte[] b = new byte[1 << 16]; int k; while ((k = in.read(b)) > 0) o.write(b, 0, k); } finally { if (in != null) in.close(); o.close(); }
        src.copy = tmp; src.size = tmp.length(); tmp.deleteOnExit();
      }
      out.add(src);
    }
    return out;
  }

  /** Una carpeta entera (elegida con el selector de carpetas) */
  public List<Engine.Source> folder(Uri tree) {
    List<Engine.Source> out = new ArrayList<>();
    ContentResolver cr = app.getContentResolver();
    String root = DocumentsContract.getTreeDocumentId(tree);
    String rootName = "Carpeta";
    Cursor c = null;
    try {
      c = cr.query(DocumentsContract.buildDocumentUriUsingTree(tree, root), new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null);
      if (c != null && c.moveToFirst()) rootName = c.getString(0);
    } catch (RuntimeException ignored) {} finally { if (c != null) c.close(); }
    walk(cr, tree, root, Engine.safePart(rootName), out);
    return out;
  }
  private void walk(ContentResolver cr, Uri tree, String docId, String rel, List<Engine.Source> out) {
    Cursor c = null;
    try {
      c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId), new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null);
      if (c == null) return;
      while (c.moveToNext()) {
        String id = c.getString(0), name = Engine.safePart(c.getString(1)), mime = c.getString(2);
        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) walk(cr, tree, id, rel + "/" + name, out);
        else out.add(new UriSource(cr, DocumentsContract.buildDocumentUriUsingTree(tree, id), rel + "/" + name, c.getLong(3), c.getLong(4)));
        if (out.size() > 100000) return;
      }
    } catch (RuntimeException ignored) {} finally { if (c != null) c.close(); }
  }

  // ---------- guardar cifrado: clave del almacén de claves de Android (no sale del móvil) ----------
  static final class KeystoreGuard implements Engine.Guard {
    static final String ALIAS = "puente-guarda";
    private SecretKey key() throws Exception {
      KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
      ks.load(null);
      if (!ks.containsAlias(ALIAS)) {
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        g.generateKey();
      }
      return (SecretKey) ks.getKey(ALIAS, null);
    }
    public String protect(String s) {
      try {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        return "ks:" + Bytes.b64(Bytes.cat(c.getIV(), c.doFinal(Bytes.utf8(s))));
      } catch (Exception e) {
        // nunca en claro: si no se puede cifrar, no se guarda (el motor avisa y sigue solo en memoria)
        throw new IllegalStateException("No se puede proteger con el almacén de claves de Android", e);
      }
    }
    public String unprotect(String v) {
      if (v == null) return null;
      if (v.startsWith("txt:")) return v.substring(4); // solo para leer lo que 0.2.0 dejó así; el motor lo vuelve a guardar cifrado
      if (!v.startsWith("ks:")) return v;
      try {
        byte[] b = Bytes.unb64(v.substring(3));
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, b, 0, 12));
        return Bytes.str(c.doFinal(b, 12, b.length - 12));
      } catch (Exception e) { throw new IllegalStateException("No se puede descifrar"); }
    }
  }

  // ---------- dónde queda lo recibido: Descargas/Puente ----------
  static String mime(String name) {
    int d = name.lastIndexOf('.');
    String m = d >= 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(d + 1).toLowerCase()) : null;
    return m == null ? "application/octet-stream" : m;
  }
  static final class DownloadsSaver implements Engine.Saver {
    final Context c;
    DownloadsSaver(Context c) { this.c = c; }
    public String save(File part, String rel) throws IOException {
      String name = rel.contains("/") ? rel.substring(rel.lastIndexOf('/') + 1) : rel;
      String sub = rel.contains("/") ? "/" + rel.substring(0, rel.lastIndexOf('/')) : "";
      if (Build.VERSION.SDK_INT >= 29) {
        ContentResolver cr = c.getContentResolver();
        ContentValues v = new ContentValues();
        v.put("_display_name", name);
        v.put("mime_type", mime(name));
        v.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/Puente" + sub);
        v.put("is_pending", 1);
        Uri u = cr.insert(Uri.parse("content://media/external_primary/downloads"), v);
        if (u == null) u = cr.insert(Uri.parse("content://media/external/downloads"), v);
        if (u == null) throw new IOException("Android no deja guardar en Descargas");
        OutputStream o = cr.openOutputStream(u);
        InputStream in = new FileInputStream(part);
        try { byte[] b = new byte[1 << 16]; int k; while ((k = in.read(b)) > 0) o.write(b, 0, k); }
        catch (IOException e) { try { cr.delete(u, null, null); } catch (RuntimeException ignored) {} throw e; }
        finally { in.close(); if (o != null) o.close(); }
        ContentValues done = new ContentValues(); done.put("is_pending", 0);
        cr.update(u, done, null, null);
        part.delete();
        return u.toString();
      }
      File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Puente");
      String path = Engine.folderSaver(dir).save(part, rel);
      android.media.MediaScannerConnection.scanFile(c, new String[] { path }, null, null);
      return path;
    }
  }

  static Map<String, Object> ev(String t, Object... kv) { Map<String, Object> m = Json.o(kv); m.put("t", t); return m; }
}

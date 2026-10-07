package com.teamlabstudios.puente;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import com.teamlabstudios.puente.core.Engine;
import com.teamlabstudios.puente.core.Json;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * La pantalla: una página local (assets/ui) con el mismo estilo que el Puente de PC, hablando con el motor por un puente JS.
 * La página no puede abrir webs ni cargar nada de fuera (CSP + bloqueo de navegación).
 */
public class MainActivity extends Activity {
  static final int PICK = 11, PICK_TREE = 12, PERMS = 13, REQ_DEL = 14;
  static final String BORRAR = "com.teamlabstudios.puente.BORRAR";
  WebView web;
  Puente p;
  final Handler ui = new Handler(Looper.getMainLooper());
  boolean ready = false;
  final List<String[]> queued = new ArrayList<>();
  List<Uri> shared = new ArrayList<>();
  String pickFp; boolean pickPriv;
  Engine.Listener listener;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    p = Puente.get(this);
    Window w = getWindow();
    w.setStatusBarColor(0xff0a0a0b); w.setNavigationBarColor(0xff0a0a0b);
    web = new WebView(this);
    web.setBackgroundColor(0xff0a0a0b);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setAllowFileAccess(false); s.setAllowContentAccess(false);
    s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
    s.setSaveFormData(false); s.setGeolocationEnabled(false); s.setDomStorageEnabled(false);
    s.setTextZoom(100);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return true; } // nada de navegar fuera
    });
    web.setWebChromeClient(new WebChromeClient());
    web.addJavascriptInterface(new Bridge(), "PuenteAndroid");
    web.loadUrl("file:///android_asset/ui/index.html");
    setContentView(web);
    listener = new Engine.Listener() { public void on(String t, Map<String, Object> d) { emit(t, d); } };
    p.uis.add(listener);
    askPermissions();
    if (p.receiving()) p.setReceiving(true);
    handle(getIntent());
  }

  void askPermissions() {
    List<String> need = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != 0) need.add("android.permission.POST_NOTIFICATIONS");
    if (Build.VERSION.SDK_INT < 29 && checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE") != 0) need.add("android.permission.WRITE_EXTERNAL_STORAGE");
    if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), PERMS);
  }

  @Override protected void onNewIntent(Intent i) { super.onNewIntent(i); setIntent(i); handle(i); }

  void handle(Intent i) {
    if (i == null) return;
    String a = i.getAction();
    if (Intent.ACTION_SEND.equals(a)) {
      Uri u = i.getParcelableExtra(Intent.EXTRA_STREAM);
      shared = new ArrayList<>(); if (u != null) shared.add(u);
      if (shared.isEmpty() && i.getStringExtra(Intent.EXTRA_TEXT) != null) { toast("Puente envía archivos, no textos sueltos"); return; }
      emit("shared", Json.o("count", shared.size()));
    } else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) {
      ArrayList<Uri> l = i.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      shared = l == null ? new ArrayList<Uri>() : new ArrayList<>(l);
      emit("shared", Json.o("count", shared.size()));
    } else if (Intent.ACTION_VIEW.equals(a) && i.getData() != null && "puente".equals(i.getData().getScheme())) {
      // enlace de emparejar (QR): todo lo que trae se comprueba; nunca empareja solo (hay que tocar y comparar las 6 cifras)
      Map<String, Object> d = deepLink(i.getData());
      if (d == null) toast("Ese código QR no es de Puente o está mal");
      else emit("deeplink", d);
    } else if (BORRAR.equals(a)) {
      String id = i.getStringExtra("id");
      if (id != null && id.matches("[0-9a-f]{8,32}")) bg(new Runnable() { public void run() { p.answerDelete(id, true); } });
    }
  }

  /** puente://emparejar?h=ip1,ip2&p=puerto&c=CODIGO&n=nombre — formato exacto o nada */
  static Map<String, Object> deepLink(Uri u) {
    try {
      if (!"emparejar".equals(u.getHost())) return null;
      String h = u.getQueryParameter("h"), pt = u.getQueryParameter("p"), c = u.getQueryParameter("c"), n = u.getQueryParameter("n");
      if (h == null || c == null || h.length() > 400) return null;
      List<Object> hosts = new ArrayList<>();
      for (String x : h.split(",")) { if (!Engine.isHost(x.trim())) return null; hosts.add(x.trim()); }
      if (hosts.isEmpty() || hosts.size() > 6) return null;
      int port = pt == null ? 47830 : Integer.parseInt(pt);
      if (port < 1 || port > 65535) return null;
      String code = c.toUpperCase().replace("-", "");
      if (!code.matches("[A-Z2-9]{8}")) return null;
      String name = n == null ? "tu PC" : n.replaceAll("[\\x00-\\x1f<>\"]", "").trim();
      if (name.isEmpty()) name = "tu PC";
      if (name.length() > 64) name = name.substring(0, 64);
      return Json.o("hosts", hosts, "port", port, "code", code.substring(0, 4) + "-" + code.substring(4), "name", name);
    } catch (RuntimeException e) { return null; }
  }

  @Override protected void onResume() {
    super.onResume(); p.network(true); emit("resume", null);
    if (!p.needConsent.isEmpty()) emit("delete-consent", Json.o("count", p.needConsent.size()));
  }

  /** Android 11+: la ventana del sistema «¿Permitir que Puente elimine N elementos?» */
  void requestConsent() {
    final List<Uri> uris = new ArrayList<>(p.needConsent);
    p.needConsent.clear();
    if (uris.isEmpty()) return;
    ui.post(new Runnable() { public void run() {
      try {
        if (Build.VERSION.SDK_INT >= 30) {
          java.lang.reflect.Method m = Class.forName("android.provider.MediaStore").getMethod("createDeleteRequest", android.content.ContentResolver.class, java.util.Collection.class);
          android.app.PendingIntent pi = (android.app.PendingIntent) m.invoke(null, getContentResolver(), uris);
          startIntentSenderForResult(pi.getIntentSender(), REQ_DEL, null, 0, 0, 0);
        } else toast("En esta versión de Android bórralos desde la galería");
      } catch (Exception e) { toast("Android no me deja borrarlos: hazlo desde la galería"); }
    } });
  }
  @Override protected void onPause() { super.onPause(); if (!p.receiving()) p.network(false); }
  @Override protected void onDestroy() { p.uis.remove(listener); web.destroy(); super.onDestroy(); }

  @Override public void onBackPressed() {
    web.evaluateJavascript("window.puente && window.puente.back ? String(window.puente.back()) : 'false'", new ValueCallback<String>() {
      public void onReceiveValue(String v) { if (!"\"true\"".equals(v) && !"true".equals(v)) moveTaskToBack(true); }
    });
  }

  void emit(final String type, Map<String, Object> d) {
    final String js = Json.str(d == null ? Json.o() : d);
    ui.post(new Runnable() { public void run() {
      if (!ready) { queued.add(new String[] { type, js }); return; }
      web.evaluateJavascript("window.puente && window.puente.ev(" + Json.str(type) + "," + js + ")", null);
    } });
  }
  void toast(final String s) { ui.post(new Runnable() { public void run() { Toast.makeText(MainActivity.this, s, Toast.LENGTH_LONG).show(); } }); }
  void bg(Runnable r) { Thread t = new Thread(r, "puente-ui"); t.setDaemon(true); t.start(); }

  @Override protected void onActivityResult(int req, int res, Intent data) {
    if (req == REQ_DEL) { emit("deleted", Json.o("deleted", res == RESULT_OK ? -1 : 0, "failed", 0, "consent", 0, "system", true, "ok", res == RESULT_OK)); return; }
    if (res != RESULT_OK || data == null) { emit("picked", Json.o("count", 0)); return; }
    final String fp = pickFp; final boolean priv = pickPriv;
    if (req == PICK) {
      final List<Uri> uris = new ArrayList<>();
      ClipData cd = data.getClipData();
      if (cd != null) for (int k = 0; k < cd.getItemCount(); k++) uris.add(cd.getItemAt(k).getUri());
      else if (data.getData() != null) uris.add(data.getData());
      bg(new Runnable() { public void run() {
        try { List<Engine.Source> l = p.sources(uris); emit("picked", Json.o("count", l.size())); if (!l.isEmpty()) p.queueSend(fp, l, priv); }
        catch (Exception e) { emit("picked", Json.o("count", 0, "error", e.getMessage())); }
      } });
    } else if (req == PICK_TREE) {
      final Uri tree = data.getData();
      bg(new Runnable() { public void run() {
        List<Engine.Source> l = p.folder(tree);
        emit("picked", Json.o("count", l.size()));
        if (!l.isEmpty()) p.queueSend(fp, l, priv, tree);
      } });
    }
  }

  void openUri(Uri u, boolean grant) {
    try {
      Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, getContentResolver().getType(u));
      if (grant) i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      startActivity(Intent.createChooser(i, "Abrir con"));
    } catch (Exception e) { toast("No hay ninguna app para abrir esto"); }
  }

  /**
   * Lo que la página puede pedir. La página se trata como NO de fiar: cada método comprueba tipo, largo y rango,
   * y los recursos se piden por id (nunca rutas). Todo devuelve texto JSON; lo que tarda llega luego como aviso.
   */
  final class Bridge {
    String err(Exception e) { return Json.str(Json.o("error", e.getMessage() == null ? "No se pudo" : e.getMessage())); }
    String fp(String v) { return Engine.checkFp(v); }
    String id(String v) { return Engine.checkId(v); }
    Map<String, Object> obj(String json) { if (json == null || json.length() > 4000) throw new IllegalArgumentException("Demasiado largo"); return Json.obj(json); }

    @JavascriptInterface public void ready() {
      ui.post(new Runnable() { public void run() {
        ready = true;
        for (String[] q : queued) web.evaluateJavascript("window.puente && window.puente.ev(" + Json.str(q[0]) + "," + q[1] + ")", null);
        queued.clear();
      } });
    }
    @JavascriptInterface public String state() {
      Engine E = p.engine;
      Map<String, Object> m = Json.o("fp", E.myFp, "port", E.port(), "addrs", Engine.lanAddrs(), "settings", E.settings(), "peers", E.peers(),
        "transfers", E.transfers(), "history", E.history(), "pairing", E.pairing(), "relay", E.relayStatus(), "lan", E.lanVisible(),
        "receiving", p.receiving(), "listening", E.listening(), "shared", shared.size(), "version", BuildConfig.VERSION, "android", Build.VERSION.SDK_INT,
        "storageBroken", E.storageBroken(), "pendingDelete", new ArrayList<Object>(p.sentAsk.keySet()));
      return Json.str(m);
    }
    @JavascriptInterface public String pairStart() {
      try { if (!p.engine.listening()) p.engine.listen((int) p.engine.settingNum("port")); } catch (Exception e) { return Json.str(Json.o("error", "No puedo abrir el puerto: " + e.getMessage())); }
      p.network(true);
      return Json.str(p.engine.startPairing());
    }
    @JavascriptInterface public void pairStop() { p.engine.stopPairing(); }
    @JavascriptInterface public String pairWith(final String hosts, final int port, final String code) {
      final List<String> hs = new ArrayList<>();
      for (String h : String.valueOf(hosts).split("[,\\s]+")) if (!h.trim().isEmpty()) { if (!Engine.isHost(h.trim()) || hs.size() >= 6) return Json.str(Json.o("error", "Dirección no válida")); hs.add(h.trim()); }
      final String c = String.valueOf(code).toUpperCase().replaceAll("[^A-Z0-9]", "");
      if (hs.isEmpty()) return Json.str(Json.o("error", "Escribe la dirección del PC"));
      if (port < 1 || port > 65535) return Json.str(Json.o("error", "Puerto no válido"));
      if (!c.matches("[A-Z2-9]{8}")) return Json.str(Json.o("error", "El código tiene 8 letras y números"));
      bg(new Runnable() { public void run() {
        String err = null;
        for (String h : hs) {
          try { Map<String, Object> r = p.engine.pairWith(h, port, c); r.put("ok", true); emit("pair-result", r); return; }
          catch (Exception e) { err = e.getMessage(); }
        }
        emit("pair-result", Json.o("ok", false, "error", err));
      } });
      return "{}";
    }
    @JavascriptInterface public void confirm(String i, boolean ok) { try { p.engine.confirmPair(id(i), ok); } catch (Exception ignored) {} }
    @JavascriptInterface public void answer(String i, boolean ok) { try { p.engine.answer(id(i), ok); Notify.cancelAsk(MainActivity.this, i); } catch (Exception ignored) {} }
    @JavascriptInterface public void cancel(String i) { try { p.engine.cancel(id(i)); } catch (Exception ignored) {} }
    @JavascriptInterface public String pick(final String kind, String f, boolean priv) {
      if (!"media".equals(kind) && !"files".equals(kind) && !"folder".equals(kind)) return err(new IllegalArgumentException("Tipo no válido"));
      try { pickFp = fp(f); } catch (Exception e) { return err(e); }
      pickPriv = priv;
      ui.post(new Runnable() { public void run() {
        try {
          if ("folder".equals(kind)) { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION), PICK_TREE); return; }
          Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); // escribir: para poder borrarlo luego si lo pides
          if ("media".equals(kind)) i.setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/*", "video/*" });
          else i.setType("*/*");
          startActivityForResult(i, PICK);
        } catch (Exception e) { toast("No hay selector de archivos en este móvil"); }
      } });
      return "{}";
    }
    @JavascriptInterface public String sendShared(String f, final boolean priv) {
      final String to;
      try { to = fp(f); } catch (Exception e) { return err(e); }
      final List<Uri> uris = shared; shared = new ArrayList<>();
      bg(new Runnable() { public void run() {
        try { p.queueSend(to, p.sources(uris), priv); emit("picked", Json.o("count", uris.size())); }
        catch (Exception e) { emit("picked", Json.o("count", 0, "error", e.getMessage())); }
      } });
      return "{}";
    }
    @JavascriptInterface public void clearShared() { shared = new ArrayList<>(); }
    @JavascriptInterface public String settings(String json) {
      try { p.engine.setSettingsUi(obj(json)); return Json.str(p.engine.settings()); } catch (Exception e) { return err(e); }
    }
    @JavascriptInterface public String setPeer(String f, String json) { try { p.engine.setPeerUi(fp(f), obj(json)); return "{}"; } catch (Exception e) { return err(e); } }
    @JavascriptInterface public void removePeer(String f) { try { p.engine.removePeer(fp(f)); } catch (Exception ignored) {} }
    @JavascriptInterface public void receiving(boolean on) { p.setReceiving(on); }
    @JavascriptInterface public void panic() { bg(new Runnable() { public void run() { p.engine.panic(); } }); Notify.nm(MainActivity.this).cancel(Notify.PROG); }
    @JavascriptInterface public void wipePrivate() { bg(new Runnable() { public void run() { p.engine.wipeAllPrivate(); } }); }
    // --- lo recibido: por id de la transferencia y número de archivo ---
    @JavascriptInterface public void keep(final String i) {
      bg(new Runnable() { public void run() {
        try { String w = p.engine.keepPrivateId(id(i)); emit("kept", Json.o("ok", true, "id", i, "where", "Descargas/Puente/" + w)); }
        catch (Exception e) { emit("kept", Json.o("ok", false, "id", i, "error", e.getMessage())); }
      } });
    }
    @JavascriptInterface public String listPrivate(String i) { try { return Json.str(p.engine.listPrivate(id(i))); } catch (Exception e) { return "[]"; } }
    @JavascriptInterface public void openPrivate(String i, int index) {
      try { File f = p.engine.privateFile(id(i), index); openUri(PrivateProvider.uriFor(p.engine.privateDir(), f), true); } catch (Exception e) { toast("Ya no está (¿se borró?)"); }
    }
    @JavascriptInterface public void openReceived(String i, int index) {
      try { String at = p.engine.receivedAt(id(i), index); if (at.startsWith("content://media/")) openUri(Uri.parse(at), true); else openDownloads(); } catch (Exception e) { openDownloads(); }
    }
    @JavascriptInterface public void openDownloads() {
      ui.post(new Runnable() { public void run() {
        try { startActivity(new Intent("android.intent.action.VIEW_DOWNLOADS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception e) { toast("Lo tienes en Descargas › Puente"); }
      } });
    }
    // --- borrar del móvil lo ya enviado ---
    @JavascriptInterface public void deleteSent(final String i, final boolean yes) {
      try { id(i); } catch (Exception e) { return; }
      bg(new Runnable() { public void run() { p.answerDelete(i, yes); } });
    }
    @JavascriptInterface public void deleteConsent() { requestConsent(); }
    @JavascriptInterface public void historyClear() { p.engine.clearHistory(); }
    @JavascriptInterface public void copy(String t) { if (t == null || t.length() > 200) return; ((ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Puente", t)); toast("Copiado"); }
    @JavascriptInterface public String lan() { return Json.str(p.engine.lanVisible()); }
    @JavascriptInterface public void toast(String t) { if (t != null && t.length() <= 300) MainActivity.this.toast(t); }
  }
}

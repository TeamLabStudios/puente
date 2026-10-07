package com.teamlabstudios.puente.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Motor de Puente para el móvil (Java puro: se prueba en la JVM contra el Puente de PC).
 * Mismo protocolo que electron/engine.cjs: emparejar con código + 6 cifras, aparatos de confianza,
 * enviar y recibir por la red de casa, dirección directa o relé; sesión privada; botón del pánico.
 */
public final class Engine {
  // ---------- lo que pone quien lo usa (Android o las pruebas) ----------
  /** Dónde guardar ajustes y claves (en Android: SharedPreferences). */
  public interface Store { String get(String k); void put(String k, String v); }
  /** Cifrar lo que se guarda (en Android: con una clave del almacén de claves del sistema). */
  public interface Guard { String protect(String s); String unprotect(String s); }
  /** Dejar un archivo ya comprobado en su sitio final (en Android: Descargas/Puente). Devuelve dónde quedó. */
  public interface Saver { String save(File part, String rel) throws IOException; }
  /** Avisos para la pantalla. */
  public interface Listener { void on(String type, Map<String, Object> data); }
  /** Algo que mandar. */
  public interface Source { String rel(); long size(); long mtime(); InputStream open() throws IOException; }

  public static final int UDP_PORT = 47831;
  static final long PAIR_TTL = 3 * 60_000L;
  static final int PAIR_TRIES = 5, MAX_FILES = 10000, MAX_REL = 1024, OFFER_CHUNK = 48000;

  final Store store; final Guard guard; final Saver saver; final File work;
  volatile Listener listener = new Listener() { public void on(String t, Map<String, Object> d) {} };
  final Noise.KeyPair identity;
  public final String myFp;
  final Map<String, Object> settings = new LinkedHashMap<>();
  final List<Peer> peers = Collections.synchronizedList(new ArrayList<Peer>());
  final List<Map<String, Object>> history = Collections.synchronizedList(new ArrayList<Map<String, Object>>());
  final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
  final Set<Conn> live = Collections.newSetFromMap(new ConcurrentHashMap<Conn, Boolean>());

  public Engine(Store store, Guard guard, File work, Saver saver, String name) {
    this.store = store; this.guard = guard == null ? new Guard() { public String protect(String s) { return s; } public String unprotect(String s) { return s; } } : guard;
    this.work = work; this.saver = saver;
    work.mkdirs();
    // identidad: clave fija de este móvil
    Noise.KeyPair id = null;
    String raw = store.get("identidad");
    if (raw != null) { try { id = new Noise.KeyPair(Bytes.unb64(this.guard.unprotect(raw))); } catch (Exception ignored) {} }
    if (id == null) { id = Noise.KeyPair.generate(); put("identidad", Bytes.b64(id.priv)); }
    else if (raw.startsWith("txt:")) put("identidad", Bytes.b64(id.priv)); // de 0.2.0 sin cifrar: se vuelve a guardar cifrado
    identity = id;
    myFp = Noise.fingerprint(identity.pub);
    // ajustes
    settings.put("name", name); settings.put("port", 47830); settings.put("visible", true);
    settings.put("relayHost", ""); settings.put("relayPort", 47840); settings.put("relayKey", "");
    settings.put("private", false); settings.put("privateMinutes", 30); settings.put("history", true); settings.put("deleteAfter", "no");
    settings.putAll(load("ajustes"));
    for (Object o : loadList("confianza")) { try { peers.add(Peer.from(Json.obj(Json.str(o)))); } catch (Exception ignored) {} }
    for (Object o : loadList("historial")) if (o instanceof Map) history.add(m(o));
    // lo que 0.2.0 guardó sin cifrar (si el almacén de claves falló) se vuelve a guardar cifrado
    if (startsTxt("ajustes")) saveSettings();
    if (startsTxt("confianza")) savePeers();
    if (startsTxt("historial")) saveHistory();
  }
  boolean startsTxt(String k) { String v = store.get(k); return v != null && v.startsWith("txt:"); }

  public void setListener(Listener l) { listener = l; }
  void emit(String t, Map<String, Object> d) { try { listener.on(t, d == null ? Json.o() : d); } catch (RuntimeException ignored) {} }

  // ---------- guardar ----------
  @SuppressWarnings("unchecked") static Map<String, Object> m(Object o) { return (Map<String, Object>) o; }
  Map<String, Object> load(String k) { try { String s = store.get(k); return s == null ? new LinkedHashMap<String, Object>() : Json.obj(guard.unprotect(s)); } catch (Exception e) { return new LinkedHashMap<>(); } }
  @SuppressWarnings("unchecked") List<Object> loadList(String k) { try { String s = store.get(k); return s == null ? new ArrayList<>() : (List<Object>) Json.parse(guard.unprotect(s)); } catch (Exception e) { return new ArrayList<>(); } }
  /** Guarda cifrado. Si el almacén de claves falla, NO se guarda nada (nunca en claro) y se avisa. */
  volatile boolean storageBroken = false;
  void put(String k, String plain) {
    try { store.put(k, guard.protect(plain)); }
    catch (RuntimeException e) { if (!storageBroken) { storageBroken = true; emit("storage-error", Json.o("reason", "No puedo guardar de forma segura: lo nuevo solo dura hasta cerrar Puente")); } }
  }
  public boolean storageBroken() { return storageBroken; }
  synchronized void saveSettings() { put("ajustes", Json.str(settings)); }
  void savePeers() { List<Object> l = new ArrayList<>(); synchronized (peers) { for (Peer p : peers) l.add(p.map(true)); } put("confianza", Json.str(l)); }
  void saveHistory() { List<Object> l; synchronized (history) { l = new ArrayList<Object>(history); } put("historial", Json.str(l)); }

  public String setting(String k) { Object v = settings.get(k); return v == null ? "" : v.toString(); }
  public long settingNum(String k) { Object v = settings.get(k); return v instanceof Number ? ((Number) v).longValue() : 0; }
  public boolean settingOn(String k) { return Boolean.TRUE.equals(settings.get(k)); }
  public Map<String, Object> settings() { Map<String, Object> s = new LinkedHashMap<>(settings); s.put("relayKey", setting("relayKey").isEmpty() ? "" : "••••••"); s.put("hasRelayKey", !setting("relayKey").isEmpty()); return s; }
  public void setSettings(Map<String, Object> patch) {
    boolean relay;
    synchronized (this) {
      String before = setting("relayHost") + "|" + setting("relayPort") + "|" + setting("relayKey");
      for (Map.Entry<String, Object> e : patch.entrySet()) if (settings.containsKey(e.getKey())) settings.put(e.getKey(), e.getValue());
      relay = !before.equals(setting("relayHost") + "|" + setting("relayPort") + "|" + setting("relayKey"));
      saveSettings();
    }
    if (relay) refreshRelayListeners();
  }

  // ---------- lo que pide la pantalla: solo claves conocidas, del tipo y rango correctos ----------
  static final Pattern HOST = Pattern.compile("^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^[0-9A-Fa-f:]{2,39}$");
  static final Pattern FP = Pattern.compile("^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$"), ID = Pattern.compile("^[0-9a-f]{8,32}$");
  public static boolean isHost(String h) { return h != null && HOST.matcher(h).matches(); }
  public static String checkId(String id) { if (id == null || !ID.matcher(id).matches()) throw new IllegalArgumentException("Identificador no válido"); return id; }
  public static String checkFp(String fp) { if (fp == null || !FP.matcher(fp).matches()) throw new IllegalArgumentException("Aparato no válido"); return fp; }
  static long intIn(Object v, long lo, long hi, String what) {
    if (!(v instanceof Number) || ((Number) v).doubleValue() != Math.rint(((Number) v).doubleValue()) || ((Number) v).longValue() < lo || ((Number) v).longValue() > hi) throw new IllegalArgumentException(what + ": entre " + lo + " y " + hi);
    return ((Number) v).longValue();
  }
  static boolean boolOf(Object v, String what) { if (!(v instanceof Boolean)) throw new IllegalArgumentException(what + ": sí o no"); return (Boolean) v; }
  static String textIn(Object v, int lo, int hi, String what) { if (!(v instanceof String) || ((String) v).trim().length() < lo || ((String) v).length() > hi) throw new IllegalArgumentException(what + ": entre " + lo + " y " + hi + " caracteres"); return ((String) v).trim(); }
  /** Ajustes desde la pantalla (lanza IllegalArgumentException si algo no vale; no se cambia nada). */
  public void setSettingsUi(Map<String, Object> patch) {
    Map<String, Object> ok = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : patch.entrySet()) {
      String k = e.getKey(); Object v = e.getValue();
      if (k.equals("name")) ok.put(k, textIn(v, 1, 64, "Nombre").replaceAll("[\\x00-\\x1f]", ""));
      else if (k.equals("port")) ok.put(k, (int) intIn(v, 1024, 65535, "Puerto"));
      else if (k.equals("visible") || k.equals("private") || k.equals("history")) ok.put(k, boolOf(v, k));
      else if (k.equals("privateMinutes")) ok.put(k, (int) intIn(v, 1, 1440, "Minutos"));
      else if (k.equals("relayHost")) { String h = v instanceof String ? ((String) v).trim() : null; if (h == null || (!h.isEmpty() && !isHost(h))) throw new IllegalArgumentException("Dirección del relé no válida"); ok.put(k, h); }
      else if (k.equals("relayPort")) ok.put(k, (int) intIn(v, 1, 65535, "Puerto del relé"));
      else if (k.equals("relayKey")) { if (!(v instanceof String) || ((String) v).length() > 200) throw new IllegalArgumentException("Clave del relé no válida"); ok.put(k, v); }
      else if (k.equals("deleteAfter")) { if (!"no".equals(v) && !"preguntar".equals(v) && !"si".equals(v)) throw new IllegalArgumentException("Opción no válida"); ok.put(k, v); }
      else throw new IllegalArgumentException("Ajuste desconocido: " + k);
    }
    setSettings(ok);
  }
  public void setPeerUi(String fp, Map<String, Object> patch) {
    checkFp(fp);
    Map<String, Object> ok = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : patch.entrySet()) {
      String k = e.getKey(); Object v = e.getValue();
      if (k.equals("name")) ok.put(k, textIn(v, 1, 64, "Nombre"));
      else if (k.equals("autoAccept")) ok.put(k, boolOf(v, "Aceptar siempre"));
      else if (k.equals("direct")) {
        String d = v == null ? "" : String.valueOf(v).trim();
        if (!d.isEmpty()) { String[] hp = d.split(":"); if (hp.length > 2 || !isHost(hp[0]) || (hp.length == 2 && (!hp[1].matches("\\d{1,5}") || Integer.parseInt(hp[1]) < 1 || Integer.parseInt(hp[1]) > 65535))) throw new IllegalArgumentException("Dirección directa no válida (ip:puerto)"); }
        ok.put(k, d);
      } else throw new IllegalArgumentException("Cambio desconocido: " + k);
    }
    setPeer(fp, ok);
  }

  // ---------- aparatos de confianza ----------
  public static final class Peer {
    public String fp, pub, name, secret, added, lastSeen, direct = ""; public boolean autoAccept;
    Map<String, Object> map(boolean withSecret) {
      Map<String, Object> m = Json.o("fp", fp, "pub", pub, "name", name, "added", added, "lastSeen", lastSeen, "autoAccept", autoAccept, "direct", direct);
      if (withSecret) m.put("secret", secret);
      return m;
    }
    static Peer from(Map<String, Object> m) {
      Peer p = new Peer(); p.fp = Json.s(m, "fp"); p.pub = Json.s(m, "pub"); p.name = Json.s(m, "name"); p.secret = Json.s(m, "secret");
      p.added = Json.s(m, "added"); p.lastSeen = Json.s(m, "lastSeen"); p.autoAccept = Json.b(m, "autoAccept"); p.direct = Json.s(m, "direct") == null ? "" : Json.s(m, "direct");
      return p;
    }
  }
  Peer peerByFp(String fp) { synchronized (peers) { for (Peer p : peers) if (p.fp.equals(fp)) return p; } return null; }
  Peer peerByPub(byte[] pub) { String b = Bytes.b64(pub); synchronized (peers) { for (Peer p : peers) if (b.equals(p.pub)) return p; } return null; }

  public List<Map<String, Object>> peers() {
    List<Map<String, Object>> out = new ArrayList<>();
    synchronized (peers) {
      for (Peer p : peers) {
        Map<String, Object> m = p.map(false);
        Lan d = discovered.get(p.fp);
        m.put("home", d != null && now() - d.at < 15000);
        m.put("relay", !setting("relayHost").isEmpty() && relayWaits.containsKey(p.fp));
        out.add(m);
      }
    }
    return out;
  }
  public void setPeer(String fp, Map<String, Object> patch) {
    Peer p = peerByFp(fp); if (p == null) return;
    if (patch.containsKey("name")) p.name = safePart(Json.s(patch, "name"));
    if (patch.containsKey("autoAccept")) p.autoAccept = Json.b(patch, "autoAccept");
    if (patch.containsKey("direct")) { String d = Json.s(patch, "direct"); p.direct = d == null ? "" : d.trim(); if (p.direct.length() > 100) p.direct = p.direct.substring(0, 100); }
    savePeers(); emit("peers", null);
  }
  public void removePeer(String fp) {
    synchronized (peers) { for (int i = peers.size() - 1; i >= 0; i--) if (peers.get(i).fp.equals(fp)) peers.remove(i); }
    savePeers();
    Set<Conn> open = liveByFp.remove(fp); // revocación inmediata: lo que tenga abierto se corta ya
    if (open != null) for (Conn c : open) c.close();
    discovered.remove(fp);
    refreshRelayListeners(); emit("peers", null);
  }
  final Map<String, Set<Conn>> liveByFp = new ConcurrentHashMap<>();
  void track(String fp, Conn c) {
    Set<Conn> s = liveByFp.get(fp);
    if (s == null) { s = Collections.newSetFromMap(new ConcurrentHashMap<Conn, Boolean>()); Set<Conn> o = ((ConcurrentHashMap<String, Set<Conn>>) liveByFp).putIfAbsent(fp, s); if (o != null) s = o; }
    s.add(c); live.add(c);
  }
  void untrack(String fp, Conn c) { Set<Conn> s = liveByFp.get(fp); if (s != null) s.remove(c); live.remove(c); }

  // ---------- nombres seguros ----------
  static final Pattern RESERVED = Pattern.compile("^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$", Pattern.CASE_INSENSITIVE);
  public static String safePart(String p) {
    String s = Normalizer.normalize(p == null ? "" : p, Normalizer.Form.NFC).replaceAll("[\\x00-\\x1f<>:\"|?*]", "_").replaceAll("[. ]+$", "").trim();
    if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "_";
    if (RESERVED.matcher(s).matches()) s = "_" + s;
    return s.length() > 200 ? s.substring(0, 200) : s;
  }
  public static String safeRel(String rel) {
    List<String> out = new ArrayList<>();
    for (String x : String.valueOf(rel == null ? "" : rel).split("[\\\\/]+")) { if (x.isEmpty() || x.equals(".") || x.equals("..")) continue; if (out.size() < 32) out.add(safePart(x)); }
    if (out.isEmpty()) return null;
    StringBuilder b = new StringBuilder();
    for (String x : out) { if (b.length() > 0) b.append('/'); b.append(x); }
    return b.toString();
  }
  public static boolean inside(File root, File f) {
    try { return f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator); } catch (IOException e) { return false; }
  }
  public static File uniqueFile(File f) {
    if (!f.exists()) return f;
    String n = f.getName(); int dot = n.lastIndexOf('.');
    String base = dot > 0 ? n.substring(0, dot) : n, ext = dot > 0 ? n.substring(dot) : "";
    for (int i = 2; ; i++) { File q = new File(f.getParentFile(), base + " (" + i + ")" + ext); if (!q.exists()) return q; }
  }

  static long now() { return System.currentTimeMillis(); }
  static String iso(long t) { SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT); f.setTimeZone(TimeZone.getTimeZone("UTC")); return f.format(new Date(t)); }
  static String randCode(int n) { byte[] b = Noise.random(n); StringBuilder s = new StringBuilder(); for (byte x : b) s.append(Noise.B32.charAt((x & 0xff) % Noise.B32.length())); return s.toString(); }
  static String randHex(int n) { return Bytes.hex(Noise.random(n)); }
  static String hexSha(byte[] b) { return Bytes.hex(Noise.sha256(b)); }

  // ---------- emparejar ----------
  private volatile String pairCode; private volatile long pairUntil; private int pairTries;
  final Map<String, Pending> pending = new ConcurrentHashMap<>();
  static final class Pending { String id, sas, name, fp, pub, secret; Conn conn; Boolean mine, theirs; }
  static String fmtCode(String c) { return c.substring(0, 4) + "-" + c.substring(4); }
  static String cleanCode(String c) { return String.valueOf(c == null ? "" : c).toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", ""); }
  static String proof(String code, byte[] hash, String who) { return Bytes.b64(Noise.hmac(Bytes.utf8(code), hash, Bytes.utf8(who))); }
  static String roomSecret(byte[] hash) { return Bytes.b64(Noise.hkdf(Bytes.utf8("puente-sala"), hash, 2)[0]); }

  public synchronized Map<String, Object> startPairing() {
    pairCode = randCode(8); pairUntil = now() + PAIR_TTL; pairTries = 0;
    Map<String, Object> p = pairing();
    emit("pairing", p);
    Map<String, Object> out = new LinkedHashMap<>(p);
    out.put("fp", myFp); out.put("name", setting("name")); out.put("port", port()); out.put("addrs", lanAddrs());
    return out;
  }
  public synchronized void stopPairing() { pairCode = null; emit("pairing", null); }
  public Map<String, Object> pairing() { String c = pairCode; return c == null ? null : Json.o("code", fmtCode(c), "until", pairUntil); }

  Pending pairPending(Conn conn, String name) {
    Pending p = new Pending();
    p.id = randHex(6); p.conn = conn; p.sas = Noise.sas(conn.hash); p.name = safePart(name == null ? "PC" : name);
    p.fp = Noise.fingerprint(conn.peer); p.pub = Bytes.b64(conn.peer); p.secret = roomSecret(conn.hash);
    pending.put(p.id, p);
    emit("pair-confirm", Json.o("id", p.id, "sas", p.sas, "name", p.name, "fp", p.fp));
    return p;
  }
  void finishPair(Pending p) {
    synchronized (p) {
      if (!Boolean.TRUE.equals(p.mine) || !Boolean.TRUE.equals(p.theirs) || pending.remove(p.id) == null) return;
    }
    synchronized (peers) {
      for (int i = peers.size() - 1; i >= 0; i--) if (peers.get(i).fp.equals(p.fp)) peers.remove(i);
      Peer n = new Peer(); n.fp = p.fp; n.pub = p.pub; n.name = p.name; n.secret = p.secret; n.added = iso(now());
      peers.add(n);
    }
    savePeers();
    stopPairing();
    emit("pair-ended", Json.o("id", p.id, "ok", true, "name", p.name, "fp", p.fp));
    emit("peers", null);
    final Conn c = p.conn;
    timer.schedule(new Runnable() { public void run() { c.close(); } }, 200, TimeUnit.MILLISECONDS);
    refreshRelayListeners();
  }
  public boolean confirmPair(String id, boolean ok) {
    Pending p = pending.get(id);
    if (p == null) return false;
    p.mine = ok;
    p.conn.tell(Json.o("t", "pair-confirm", "ok", ok));
    if (!ok) { pending.remove(id); p.conn.close(); emit("pair-ended", Json.o("id", id, "ok", false, "reason", "No coincidía: no se ha emparejado")); return true; }
    finishPair(p);
    return true;
  }
  void watchPair(final Pending p) {
    try {
      p.conn.sock.setSoTimeout(0);
      while (true) {
        Conn.Msg m = p.conn.read();
        if (!"pair-confirm".equals(m.t())) continue;
        p.theirs = Json.b(m.json, "ok");
        if (!p.theirs) { pending.remove(p.id); p.conn.close(); emit("pair-ended", Json.o("id", p.id, "ok", false, "reason", "El otro aparato dijo que el código no coincidía")); return; }
        finishPair(p);
      }
    } catch (IOException e) {
      if (pending.remove(p.id) != null) emit("pair-ended", Json.o("id", p.id, "ok", false, "reason", "Se cortó la conexión"));
    }
  }

  /** Este móvil inicia: «emparejar con 192.168.1.20 usando el código K7QM-4R2X». Bloquea hasta tener las 6 cifras. */
  public Map<String, Object> pairWith(String host, int port, String code) throws IOException {
    Socket s = tcp(host, port > 0 ? port : 47830);
    final Conn conn = Conn.connect(s, true, identity, Json.o("mode", "pair", "v", 1));
    String c = cleanCode(code);
    conn.json(Json.o("t", "pair", "name", setting("name"), "proof", proof(c, conn.hash, "I")));
    Conn.Msg reply;
    try { conn.sock.setSoTimeout(15000); reply = conn.read(); }
    catch (IOException e) { conn.close(); throw new IOException("El otro aparato cortó: ¿el código es correcto y sigue activo?"); }
    if (!"pair-ok".equals(reply.t()) || !MessageDigest.isEqual(Bytes.utf8(String.valueOf(Json.s(reply.json, "proof"))), Bytes.utf8(proof(c, conn.hash, "R")))) {
      conn.close(); throw new IOException("El otro aparato no ha demostrado conocer el código: no es quien dice ser");
    }
    final Pending p = pairPending(conn, Json.s(reply.json, "name"));
    thread("emparejar", new Runnable() { public void run() { watchPair(p); } });
    return Json.o("id", p.id, "sas", p.sas, "name", p.name, "fp", p.fp);
  }

  // El otro inicia: lo atiende el servidor (en el hilo de esa conexión)
  void onPairRequest(Conn conn) throws IOException {
    conn.sock.setSoTimeout(30000);
    Conn.Msg m = conn.read();
    synchronized (this) {
      if (!"pair".equals(m.t()) || pairCode == null || now() > pairUntil) { conn.close(); return; }
      if (++pairTries > PAIR_TRIES) { stopPairing(); conn.close(); return; }
      if (!MessageDigest.isEqual(Bytes.utf8(proof(pairCode, conn.hash, "I")), Bytes.utf8(String.valueOf(Json.s(m.json, "proof"))))) {
        conn.close(); emit("pair-failed", Json.o("reason", "Alguien probó un código incorrecto")); return;
      }
      conn.json(Json.o("t", "pair-ok", "name", setting("name"), "proof", proof(pairCode, conn.hash, "R")));
    }
    watchPair(pairPending(conn, Json.s(m.json, "name")));
  }

  // ---------- conexiones ----------
  static Thread thread(String name, Runnable r) { Thread t = new Thread(r, "puente-" + name); t.setDaemon(true); t.start(); return t; }

  static Socket tcp(String host, int port) throws IOException {
    Socket s = new Socket();
    try { s.connect(new InetSocketAddress(host, port), 6000); }
    catch (java.net.ConnectException e) { s.close(); throw new IOException("Puente no está abierto allí"); }
    catch (java.net.SocketTimeoutException e) { s.close(); throw new IOException("Sin respuesta"); }
    catch (IOException e) { s.close(); throw e; }
    s.setTcpNoDelay(true);
    return s;
  }

  public static List<String> lanAddrs() {
    List<String> out = new ArrayList<>();
    try {
      for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e != null && e.hasMoreElements(); ) {
        NetworkInterface ni = e.nextElement();
        if (!ni.isUp() || ni.isLoopback()) continue;
        for (InterfaceAddress a : ni.getInterfaceAddresses()) if (a.getAddress() instanceof java.net.Inet4Address) out.add(a.getAddress().getHostAddress());
      }
    } catch (Exception ignored) {}
    return out;
  }

  private ServerSocket server;
  void handleIncoming(Socket sock, String via) {
    Conn conn = null;
    try {
      sock.setTcpNoDelay(true);
      conn = Conn.connect(sock, false, identity, Json.o("v", 1, "name", setting("name")));
      conn.via = via;
      if ("pair".equals(Json.s(conn.hello, "mode"))) { onPairRequest(conn); return; }
      Peer peer = peerByPub(conn.peer);
      if (peer == null) { conn.close(); emit("intruder", Json.o("fp", Noise.fingerprint(conn.peer), "via", via)); return; }
      peer.lastSeen = iso(now()); savePeers();
      receive(conn, peer);
    } catch (IOException e) {
      if (conn != null) conn.close(); else try { sock.close(); } catch (IOException ignored) {}
    }
  }
  /** Abre el servidor para recibir (red de casa / dirección directa). Devuelve el puerto. */
  public synchronized int listen(int port) throws IOException {
    if (server != null) return server.getLocalPort();
    ServerSocket s = new ServerSocket();
    s.setReuseAddress(true);
    try { s.bind(new InetSocketAddress(port)); } catch (IOException e) { s.bind(new InetSocketAddress(0)); } // ocupado → otro cualquiera
    server = s;
    final ServerSocket srv = s;
    thread("servidor", new Runnable() { public void run() {
      while (!srv.isClosed()) {
        try { final Socket c = srv.accept(); thread("entrada", new Runnable() { public void run() { handleIncoming(c, "casa"); } }); }
        catch (IOException e) { if (srv.isClosed()) return; }
      }
    } });
    return s.getLocalPort();
  }
  public int port() { ServerSocket s = server; return s == null ? (int) settingNum("port") : s.getLocalPort(); }

  String room(Peer p, String toFp) { return Bytes.hex(Noise.hmac(Bytes.unb64(p.secret), Bytes.utf8("sala:" + toFp))); }

  /** Abrir canal con un aparato de confianza: casa → directo → relé */
  Conn open(Peer peer) throws IOException {
    List<String> errs = new ArrayList<>();
    List<String> vias = new ArrayList<>();
    Lan lan = discovered.get(peer.fp);
    if (lan != null && now() - lan.at < 15000) vias.add("casa");
    if (peer.direct != null && !peer.direct.isEmpty()) vias.add("directo");
    if (!setting("relayHost").isEmpty() && peer.secret != null) vias.add("relé");
    if (vias.isEmpty()) throw new IOException("No sé cómo llegar a «" + peer.name + "»: no está en tu red y no hay relé configurado");
    for (String via : vias) {
      try {
        Socket s;
        if (via.equals("casa")) s = tcp(lan.host, lan.port);
        else if (via.equals("directo")) { String[] hp = peer.direct.split(":"); s = tcp(hp[0], hp.length > 1 ? Integer.parseInt(hp[1].trim()) : 47830); }
        else s = dialRelay(peer);
        Conn c = Conn.connect(s, true, identity, Json.o("v", 1, "name", setting("name")));
        if (!MessageDigest.isEqual(c.peer, Bytes.unb64(peer.pub))) { c.close(); throw new IOException("Contestó otro aparato (no es el emparejado)"); }
        c.via = via;
        return c;
      } catch (IOException | RuntimeException e) { errs.add(via + ": " + e.getMessage()); }
    }
    StringBuilder b = new StringBuilder();
    for (String e : errs) { if (b.length() > 0) b.append(" · "); b.append(e); }
    throw new IOException("No llego a «" + peer.name + "» (" + b + ")");
  }
  Socket dialRelay(Peer peer) throws IOException {
    for (int i = 0; ; i++) {
      try { return Relay.connect(setting("relayHost"), (int) settingNum("relayPort"), room(peer, peer.fp), false, setting("relayKey"), 30000, null); }
      catch (IOException e) {
        if (i >= 3 || e.getMessage() == null || !e.getMessage().contains("no está conectado")) throw e;
        try { Thread.sleep(1500); } catch (InterruptedException x) { throw new IOException("Cancelado"); }
      }
    }
  }

  // ---------- transferencias ----------
  public static final class Transfer {
    public String id, dir, peer, name, status, via, error, at, saved; public int files; public long size, done, resumed; public boolean priv;
    volatile boolean cancel; long last; List<Object> list; volatile Conn conn; List<String> paths;
    public Map<String, Object> map() {
      Map<String, Object> m = Json.o("id", id, "dir", dir, "peer", peer, "name", name, "files", files, "size", size, "done", done, "status", status, "via", via, "error", error, "private", priv, "at", at, "saved", saved, "resumed", resumed);
      if (list != null) m.put("list", list);
      return m;
    }
  }
  final Map<String, Transfer> transfers = new ConcurrentHashMap<>();
  void upd(Transfer t) { emit("transfer", t.map()); }
  void tick(Transfer t) { if (now() - t.last > 250) { t.last = now(); upd(t); } }
  public List<Map<String, Object>> transfers() { List<Map<String, Object>> l = new ArrayList<>(); for (Transfer t : transfers.values()) l.add(t.map()); return l; }
  public void cancel(String id) { Transfer t = transfers.get(id); if (t != null) { t.cancel = true; Conn c = t.conn; if (c != null && "in".equals(t.dir)) { c.tell(Json.o("t", "cancel")); c.close(); } } }
  void addHistory(Transfer t) {
    if (!settingOn("history") || t.priv) return;
    Map<String, Object> h = t.map(); h.remove("list");
    synchronized (history) { history.add(0, h); while (history.size() > 300) history.remove(history.size() - 1); }
    saveHistory();
  }
  public List<Map<String, Object>> history() { synchronized (history) { return new ArrayList<>(history); } }
  public void clearHistory() { history.clear(); saveHistory(); }

  // ---------- enviar ----------
  /** Manda a un aparato de confianza (bloquea hasta terminar; llamar desde un hilo de trabajo). */
  public Map<String, Object> send(String fp, List<Source> list, boolean priv) {
    final Transfer t = new Transfer();
    t.id = randHex(8); t.dir = "out"; t.status = "conectando"; t.at = iso(now());
    t.priv = priv || settingOn("private");
    Peer peer = peerByFp(fp);
    t.peer = fp; t.name = peer == null ? "?" : peer.name;
    t.files = list.size();
    for (Source s : list) t.size += s.size();
    transfers.put(t.id, t); upd(t);
    Conn conn = null;
    try {
      if (peer == null) throw new IOException("Ese aparato no es de confianza");
      if (list.isEmpty()) throw new IOException("No hay nada que enviar");
      conn = open(peer);
      t.conn = conn;
      track(peer.fp, conn);
      final Conn c = conn;
      final LinkedBlockingQueue<Map<String, Object>> inbox = new LinkedBlockingQueue<>();
      thread("leer", new Runnable() { public void run() {
        try { while (true) { Conn.Msg m = c.read(); if (m.json != null) inbox.add(m.json); } }
        catch (IOException e) { inbox.add(Json.o("t", "__closed", "reason", e.getMessage())); }
      } });
      t.status = "esperando"; t.via = conn.via; upd(t);
      List<Object> files = new ArrayList<>();
      for (int i = 0; i < list.size(); i++) {
        Source s = list.get(i);
        String rel = s.rel().replace('\\', '/');
        files.add(Json.o("fid", i + 1, "rel", rel, "size", s.size(), "key", hexSha(Bytes.utf8(rel + "|" + s.size() + "|" + Math.round((double) s.mtime()))).substring(0, 24)));
      }
      for (Object f : files) if (Json.s(m(f), "rel").length() > MAX_REL) throw new IOException("Hay una ruta demasiado larga para enviarla");
      if (files.size() > MAX_FILES) throw new IOException("Demasiados archivos de una vez (máximo 10.000): envíalo en varias tandas");
      // la lista va en trozos: cada mensaje cifrado cabe en 64 KB
      List<List<Object>> parts = new ArrayList<>(); List<Object> cur = new ArrayList<>(); int len = 0;
      for (Object f : files) { int k = Json.str(f).length() + 1; if (!cur.isEmpty() && len + k > OFFER_CHUNK) { parts.add(cur); cur = new ArrayList<>(); len = 0; } cur.add(f); len += k; }
      parts.add(cur);
      conn.json(Json.o("t", "offer", "id", t.id, "files", parts.get(0), "count", files.size(), "total", t.size, "private", t.priv, "from", setting("name"), "more", parts.size() > 1));
      for (int i = 1; i < parts.size(); i++) conn.json(Json.o("t", "offer+", "files", parts.get(i), "more", i < parts.size() - 1));
      Map<String, Object> ans = reply(inbox, new String[] { "accept", "reject" }, 10 * 60_000L, t);
      if ("reject".equals(Json.s(ans, "t"))) { t.status = "rechazado"; upd(t); conn.close(); return t.map(); }
      t.status = "enviando"; upd(t);
      Map<String, Object> start = ans.get("start") instanceof Map ? m(ans.get("start")) : new HashMap<String, Object>();
      byte[] buf = new byte[Conn.CHUNK * 4];
      for (int i = 0; i < list.size(); i++) {
        Source s = list.get(i);
        int fid = i + 1;
        Object st = start.get(String.valueOf(fid));
        long from = Math.max(0, Math.min(st instanceof Number ? ((Number) st).longValue() : 0, s.size()));
        MessageDigest h = MessageDigest.getInstance("SHA-256");
        InputStream in = s.open();
        try {
          // lo que el otro ya tiene: solo se lee para la huella final
          long skip = from;
          while (skip > 0) { int n = in.read(buf, 0, (int) Math.min(buf.length, skip)); if (n < 0) throw new IOException("El archivo ha cambiado"); h.update(buf, 0, n); skip -= n; }
          t.done += from; if (from > 0) t.resumed += from;
          conn.json(Json.o("t", "file", "fid", fid, "from", from));
          long left = s.size() - from;
          while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) throw new IOException("«" + s.rel() + "» ha cambiado mientras se enviaba");
            h.update(buf, 0, n);
            conn.data(fid, buf, 0, n);
            left -= n; t.done += n;
            tick(t);
            if (t.cancel) throw new IOException("Cancelado");
            if (!inbox.isEmpty() && "cancel".equals(Json.s(inbox.peek(), "t"))) throw new IOException("El otro aparato lo canceló");
          }
        } finally { try { in.close(); } catch (IOException ignored) {} }
        conn.json(Json.o("t", "end", "fid", fid, "sha", Bytes.hex(h.digest())));
      }
      conn.json(Json.o("t", "done"));
      Map<String, Object> fin = reply(inbox, new String[] { "received", "error" }, 120_000L, t);
      if ("error".equals(Json.s(fin, "t"))) throw new IOException(Json.s(fin, "reason") == null ? "El otro aparato no pudo guardarlo" : Json.s(fin, "reason"));
      t.status = "hecho"; t.done = t.size; upd(t);
      addHistory(t);
      conn.close();
    } catch (Exception e) {
      t.status = "error"; t.error = e.getMessage() == null ? e.toString() : e.getMessage(); upd(t);
      if (conn != null) { conn.tell(Json.o("t", "cancel")); conn.close(); }
    } finally { if (conn != null && peer != null) untrack(peer.fp, conn); }
    return t.map();
  }
  Map<String, Object> reply(LinkedBlockingQueue<Map<String, Object>> inbox, String[] types, long ms, Transfer t) throws IOException {
    long until = now() + ms;
    while (true) {
      if (t.cancel) throw new IOException("Cancelado");
      Map<String, Object> m;
      try { m = inbox.poll(Math.min(500, Math.max(1, until - now())), TimeUnit.MILLISECONDS); } catch (InterruptedException e) { throw new IOException("Cancelado"); }
      if (m == null) { if (now() >= until) throw new IOException("El otro aparato no contesta"); continue; }
      String ty = Json.s(m, "t");
      for (String x : types) if (x.equals(ty)) return m;
      if ("cancel".equals(ty)) throw new IOException("El otro aparato lo canceló");
      if ("__closed".equals(ty)) throw new IOException(Json.s(m, "reason") == null ? "Se cortó la conexión" : "Se cortó la conexión (" + Json.s(m, "reason") + ")");
    }
  }

  // ---------- recibir ----------
  static final class Ask { final CountDownLatch latch = new CountDownLatch(1); volatile boolean ok; }
  final Map<String, Ask> asks = new ConcurrentHashMap<>();
  public boolean answer(String id, boolean ok) { Ask a = asks.remove(id); if (a == null) return false; a.ok = ok; a.latch.countDown(); return true; }

  public File privateDir() { return new File(work, "privado"); }
  static final class InFile { int fid; String rel, key; long size; File part; }

  void receive(Conn conn, Peer peer) {
    Transfer t = null;
    Map<Integer, InFile> files = null;
    InFile cur = null; OutputStream out = null; MessageDigest h = null; long n = 0;
    File root = null; List<String> writes = new ArrayList<>();
    Map<String, Object> partial = null; List<Object> partialFiles = null;
    track(peer.fp, conn);
    try {
      conn.sock.setSoTimeout(0);
      while (true) {
        Conn.Msg m = conn.read();
        if (m.json == null) {
          // trozo de archivo
          if (cur == null || cur.fid != m.fid) throw new Fail("Datos fuera de orden");
          n += m.data.length;
          if (n > cur.size) throw new Fail("Llega más de lo anunciado");
          h.update(m.data); out.write(m.data);
          t.done += m.data.length; tick(t);
          if (t.cancel) throw new Fail("Cancelado");
          continue;
        }
        String ty = m.t();
        // la lista de archivos puede llegar en varios trozos
        if (("offer".equals(ty) && t == null && partial == null) || ("offer+".equals(ty) && partial != null)) {
          Object fl = m.json.get("files");
          if (!(fl instanceof List)) throw new Fail("Oferta no válida");
          if ("offer".equals(ty)) { partial = m.json; partialFiles = new ArrayList<>(); }
          partialFiles.addAll((List<?>) fl);
          Object cnt = partial.get("count");
          if (partialFiles.size() > MAX_FILES || (cnt instanceof Number && partialFiles.size() > ((Number) cnt).longValue())) throw new Fail("Demasiados archivos de una vez");
          if (Json.b(m.json, "more")) continue;
          if (cnt instanceof Number && partialFiles.size() != ((Number) cnt).longValue()) throw new Fail("Oferta incompleta");
          m.json = new LinkedHashMap<>(partial); m.json.put("files", partialFiles); m.json.put("t", "offer");
          partial = null; ty = "offer";
        }
        if ("offer".equals(ty) && t == null) {
          Object fl = m.json.get("files");
          if (!(fl instanceof List) || ((List<?>) fl).size() > MAX_FILES) throw new Fail("Oferta no válida");
          files = new LinkedHashMap<>();
          List<Object> shown = new ArrayList<>();
          long total = 0;
          for (Object o : (List<?>) fl) {
            Map<String, Object> f = m(o);
            InFile x = new InFile();
            String rawRel = Json.s(f, "rel");
            x.rel = safeRel(rawRel); x.key = String.valueOf(Json.s(f, "key")).replaceAll("[^0-9a-f]", "");
            Object fidO = f.get("fid");
            if (!(fidO instanceof Number) || ((Number) fidO).doubleValue() != Math.rint(((Number) fidO).doubleValue()) || ((Number) fidO).doubleValue() < 0 || ((Number) fidO).doubleValue() > Integer.MAX_VALUE) throw new Fail("Oferta no válida");
            x.fid = ((Number) fidO).intValue();
            if (files.containsKey(x.fid) || rawRel == null || rawRel.length() > MAX_REL) throw new Fail("Nombre o tamaño no válido");
            Object sz = f.get("size");
            if (x.rel == null || !(sz instanceof Number) || ((Number) sz).doubleValue() < 0 || ((Number) sz).doubleValue() != Math.rint(((Number) sz).doubleValue())) throw new Fail("Nombre o tamaño no válido");
            x.size = ((Number) sz).longValue();
            if (x.key.length() > 24) x.key = x.key.substring(0, 24);
            if (x.key.isEmpty()) x.key = hexSha(Bytes.utf8(x.rel + "|" + x.size)).substring(0, 24);
            files.put(x.fid, x); total += x.size;
            if (shown.size() < 50) shown.add(Json.o("rel", x.rel, "size", x.size));
          }
          t = new Transfer();
          // id propio, nunca el del otro: con «../» en el id podía sacar lo privado de su carpeta
          t.id = randHex(8); t.dir = "in"; t.peer = peer.fp; t.name = peer.name; t.files = files.size(); t.size = total;
          t.status = "pregunta"; t.priv = Json.b(m.json, "private") || settingOn("private"); t.via = conn.via; t.at = iso(now()); t.list = shown; t.conn = conn;
          transfers.put(t.id, t);
          boolean ok = peer.autoAccept;
          if (!ok) {
            Ask a = new Ask(); asks.put(t.id, a);
            upd(t); emit("ask", t.map());
            try { ok = a.latch.await(10, TimeUnit.MINUTES) && a.ok; } catch (InterruptedException e) { ok = false; }
            asks.remove(t.id);
          }
          if (!ok || conn.closed()) { t.status = "rechazado"; upd(t); conn.tell(Json.o("t", "reject")); sleep(200); return; }
          root = t.priv ? new File(privateDir(), t.id) : null;
          File parts = new File(work, ".puente");
          parts.mkdirs();
          Map<String, Object> start = new LinkedHashMap<>();
          for (InFile f : files.values()) {
            f.part = new File(parts, f.key + ".part");
            if (f.part.isFile() && f.part.length() <= f.size && f.part.length() > 0) start.put(String.valueOf(f.fid), f.part.length());
          }
          t.status = "recibiendo"; upd(t);
          conn.json(Json.o("t", "accept", "start", start));
        } else if ("file".equals(ty) && files != null && files.containsKey((int) Json.l(m.json, "fid"))) {
          InFile f = files.get((int) Json.l(m.json, "fid"));
          long from = Math.max(0, Math.min(Json.l(m.json, "from"), f.size));
          h = MessageDigest.getInstance("SHA-256");
          if (from > 0) {
            RandomAccessFile raf = new RandomAccessFile(f.part, "rw"); raf.setLength(from); raf.close();
            InputStream in = new FileInputStream(f.part);
            try { byte[] b = new byte[1 << 16]; int k; while ((k = in.read(b)) > 0) h.update(b, 0, k); } finally { in.close(); }
          } else { new FileOutputStream(f.part).close(); }
          t.done += from; n = from;
          cur = f; out = new java.io.BufferedOutputStream(new FileOutputStream(f.part, true), 1 << 18);
        } else if ("end".equals(ty) && cur != null && cur.fid == (int) Json.l(m.json, "fid")) {
          InFile c = cur; cur = null;
          out.close(); out = null;
          if (n != c.size || !Bytes.hex(h.digest()).equals(Json.s(m.json, "sha"))) { c.part.delete(); throw new Fail("«" + c.rel + "» llegó dañado: se ha descartado"); }
          if (root != null) {
            File dest = new File(root, c.rel);
            root.mkdirs();
            if (!inside(root, dest)) throw new Fail("Ruta no permitida");
            dest.getParentFile().mkdirs();
            File fin = uniqueFile(dest);
            if (!c.part.renameTo(fin)) throw new Fail("No se pudo guardar «" + c.rel + "»");
            writes.add(fin.getPath());
          } else writes.add(saver.save(c.part, c.rel));
        } else if ("done".equals(ty) && t != null) {
          t.status = "hecho"; t.done = t.size; t.saved = root != null ? root.getPath() : "Descargas/Puente"; t.paths = new ArrayList<>(writes); upd(t);
          conn.json(Json.o("t", "received", "n", writes.size()));
          addHistory(t);
          Map<String, Object> r = t.map(); r.put("paths", writes.size() > 200 ? new ArrayList<Object>(writes.subList(0, 200)) : new ArrayList<Object>(writes));
          emit("received", r);
          if (t.priv && root != null) schedulePrivateWipe(root);
          sleep(300);
          return;
        } else if ("cancel".equals(ty)) {
          if (t != null) { t.status = "cancelado"; upd(t); }
          return;
        }
      }
    } catch (Fail e) {
      if (t != null) { t.status = "error"; t.error = e.getMessage(); upd(t); }
      conn.tell(Json.o("t", "error", "reason", e.getMessage()));
    } catch (Exception e) {
      if (t != null && !isEnd(t.status)) { t.status = "cortado"; t.error = "Se cortó: al volver a enviarlo seguirá donde lo dejó"; upd(t); }
    } finally {
      if (out != null) try { out.close(); } catch (IOException ignored) {}
      untrack(peer.fp, conn);
      conn.close();
    }
  }
  static boolean isEnd(String s) { return "hecho".equals(s) || "rechazado".equals(s) || "error".equals(s) || "cancelado".equals(s); }
  static final class Fail extends IOException { Fail(String m) { super(m); } }
  static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }

  // ---------- sesión privada: lo recibido se borra solo ----------
  final Map<String, ScheduledFuture<?>> wipes = new ConcurrentHashMap<>();
  void schedulePrivateWipe(final File dir) {
    Object pm = settings.get("privateMinutes");
    double min = Math.max(0.001, pm instanceof Number && ((Number) pm).doubleValue() > 0 ? ((Number) pm).doubleValue() : 30);
    ScheduledFuture<?> old = wipes.remove(dir.getPath());
    if (old != null) old.cancel(false);
    wipes.put(dir.getPath(), timer.schedule(new Runnable() { public void run() { wipe(dir); } }, (long) (min * 60_000), TimeUnit.MILLISECONDS));
  }
  void wipe(File dir) {
    if (!inside(privateDir(), dir) && !dir.getAbsolutePath().equals(privateDir().getAbsolutePath())) return;
    deleteTree(dir);
    emit("wiped", Json.o("dir", dir.getPath()));
  }
  static void deleteTree(File f) {
    File[] k = f.listFiles();
    if (k != null) for (File x : k) deleteTree(x);
    f.delete();
  }
  public void wipeAllPrivate() { wipe(privateDir()); }
  /** La carpeta privada de una transferencia, por su id (rutas canónicas: nada fuera de «privado»). */
  public File privateOf(String id) throws IOException {
    File dir = new File(privateDir(), checkId(id));
    if (!inside(privateDir(), dir) || !dir.isDirectory()) throw new IOException("Ya no está (¿se borró?)");
    return dir;
  }
  /** Lo recibido en privado: nombre y tamaño (sin rutas). */
  public List<Map<String, Object>> listPrivate(String id) throws IOException {
    File dir = privateOf(id);
    List<File> all = new ArrayList<>(); walk(dir, all);
    List<Map<String, Object>> out = new ArrayList<>();
    for (int i = 0; i < all.size() && i < 500; i++) out.add(Json.o("i", i, "name", dir.toURI().relativize(all.get(i).toURI()).getPath(), "size", all.get(i).length()));
    return out;
  }
  public File privateFile(String id, int index) throws IOException {
    File dir = privateOf(id);
    List<File> all = new ArrayList<>(); walk(dir, all);
    if (index < 0 || index >= all.size() || !inside(dir, all.get(index))) throw new IOException("Ya no está");
    return all.get(index);
  }
  /** Dónde quedó lo recibido (normal): la dirección que dio Descargas. */
  public String receivedAt(String id, int index) throws IOException {
    Transfer t = transfers.get(checkId(id));
    if (t == null || t.paths == null || index < 0 || index >= t.paths.size()) throw new IOException("Ya no está");
    return t.paths.get(index);
  }
  public String keepPrivateId(String id) throws IOException { return keepPrivate(privateOf(id)); }
  /** «Guardar» lo de la sesión privada en Descargas/Puente antes de que se borre */
  String keepPrivate(File dir) throws IOException {
    if (!inside(privateDir(), dir)) throw new IOException("No es de la sesión privada");
    String base = "Puente privado " + iso(now()).substring(0, 10);
    List<File> all = new ArrayList<>(); walk(dir, all);
    String where = null;
    for (File f : all) { String rel = dir.toURI().relativize(f.toURI()).getPath(); where = saver.save(f, base + "/" + rel); }
    deleteTree(dir);
    ScheduledFuture<?> w = wipes.remove(dir.getPath()); if (w != null) w.cancel(false);
    return where == null ? "" : base;
  }
  static void walk(File d, List<File> out) { File[] k = d.listFiles(); if (k == null) return; for (File x : k) { if (x.isDirectory()) walk(x, out); else out.add(x); } }

  // ---------- red de casa: avisos por UDP ----------
  static final class Lan { String host, name, fp; int port; long at; }
  final Map<String, Lan> discovered = new ConcurrentHashMap<>();
  final Map<String, Lan> visibleOnLan = new ConcurrentHashMap<>();
  static long window5(long t) { return t / 300_000L; }
  static String tag(String pubB64, long w) { return hexSha(Bytes.cat(Bytes.utf8("puente-marca"), Bytes.unb64(pubB64), Bytes.utf8(Long.toString(w)))).substring(0, 16); }
  public Map<String, Object> beacon() {
    if (pairCode != null) return Json.o("app", "puente", "v", 1, "port", port(), "name", setting("name"), "fp", myFp);
    return Json.o("app", "puente", "v", 1, "port", port(), "tag", tag(Bytes.b64(identity.pub), window5(now())));
  }
  public void onBeacon(Map<String, Object> msg, String host) {
    if (msg == null || !"puente".equals(Json.s(msg, "app")) || !(msg.get("port") instanceof Number)) return;
    double pd = ((Number) msg.get("port")).doubleValue();
    if (pd != Math.rint(pd) || pd <= 0 || pd > 65535) return;
    int port = (int) pd;
    String fp = Json.s(msg, "fp"), name = Json.s(msg, "name"), tg = Json.s(msg, "tag");
    if (fp != null && fp.equals(myFp)) return;
    if (name != null && fp != null) { Lan l = new Lan(); l.name = safePart(name); l.host = host; l.port = port; l.fp = fp; l.at = now(); visibleOnLan.put(fp, l); emit("lan", null); }
    if (tg != null) {
      long w = window5(now());
      synchronized (peers) {
        for (Peer p : peers) if (tg.equals(tag(p.pub, w)) || tg.equals(tag(p.pub, w - 1))) {
          Lan was = discovered.get(p.fp);
          Lan l = new Lan(); l.host = host; l.port = port; l.fp = p.fp; l.at = now(); discovered.put(p.fp, l);
          if (was == null || now() - was.at > 15000) emit("peers", null);
        }
      }
    }
    if (fp != null && peerByFp(fp) != null) { Lan l = new Lan(); l.host = host; l.port = port; l.fp = fp; l.at = now(); discovered.put(fp, l); }
  }
  public List<Map<String, Object>> lanVisible() {
    List<Map<String, Object>> out = new ArrayList<>();
    for (Lan l : visibleOnLan.values()) if (now() - l.at < 10000) out.add(Json.o("name", l.name, "host", l.host, "port", l.port, "fp", l.fp));
    return out;
  }

  private DatagramSocket udp;
  private ScheduledFuture<?> shouter;
  /** Escucha y manda avisos en la red de casa (en Android hace falta un MulticastLock). */
  public synchronized void startUdp() {
    if (udp != null) return;
    try {
      final DatagramSocket u = new DatagramSocket(null);
      u.setReuseAddress(true); u.setBroadcast(true);
      u.bind(new InetSocketAddress(UDP_PORT));
      udp = u;
      thread("udp", new Runnable() { public void run() {
        byte[] b = new byte[1500];
        while (!u.isClosed()) {
          try {
            DatagramPacket p = new DatagramPacket(b, b.length);
            u.receive(p);
            if (p.getLength() > 1024) continue;
            onBeacon(Json.obj(new String(p.getData(), 0, p.getLength(), Bytes.UTF8)), p.getAddress().getHostAddress());
          } catch (Exception e) { if (u.isClosed()) return; }
        }
      } });
      shouter = timer.scheduleAtFixedRate(new Runnable() { public void run() { shout(); } }, 500, 3000, TimeUnit.MILLISECONDS);
    } catch (IOException e) { udp = null; }
  }
  void shout() {
    DatagramSocket u = udp;
    if (u == null || (!settingOn("visible") && pairCode == null)) return;
    byte[] msg = Bytes.utf8(Json.str(beacon()));
    Set<InetAddress> targets = new LinkedHashSet<>();
    try { targets.add(InetAddress.getByName("255.255.255.255")); } catch (IOException ignored) {}
    try {
      for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e != null && e.hasMoreElements(); ) {
        NetworkInterface ni = e.nextElement();
        if (!ni.isUp() || ni.isLoopback()) continue;
        for (InterfaceAddress a : ni.getInterfaceAddresses()) if (a.getBroadcast() != null) targets.add(a.getBroadcast());
      }
    } catch (Exception ignored) {}
    for (InetAddress t : targets) { try { u.send(new DatagramPacket(msg, msg.length, t, UDP_PORT)); } catch (Exception ignored) {} }
  }

  // ---------- relé: esperar a los míos ----------
  static final class Wait { volatile boolean stop; volatile Socket sock; long delay = 2000; }
  final Map<String, Wait> relayWaits = new ConcurrentHashMap<>();
  volatile Boolean relayOk = null;
  public Boolean relayStatus() { return relayOk; }
  private volatile boolean relayEnabled = true;
  /** En el móvil solo se espera en el relé mientras «Recibir» está encendido. */
  public void setRelayEnabled(boolean on) { relayEnabled = on; refreshRelayListeners(); }
  public synchronized void refreshRelayListeners() {
    for (Map.Entry<String, Wait> e : relayWaits.entrySet()) { e.getValue().stop = true; Socket s = e.getValue().sock; if (s != null) try { s.close(); } catch (IOException ignored) {} }
    relayWaits.clear();
    if (setting("relayHost").isEmpty() || !relayEnabled) { relayOk = null; emit("relay", Json.o("ok", null)); return; }
    synchronized (peers) { for (Peer p : peers) if (p.secret != null) waitOnRelay(p); }
  }
  void waitOnRelay(final Peer p) {
    final Wait w = new Wait();
    relayWaits.put(p.fp, w);
    thread("rele", new Runnable() { public void run() {
      while (!w.stop) {
        try {
          final Socket s = Relay.connect(setting("relayHost"), (int) settingNum("relayPort"), room(p, myFp), true, setting("relayKey"), 0, new Relay.Waiting() { public void on(Socket s) {
            w.sock = s;
            if (!Boolean.TRUE.equals(relayOk)) { relayOk = true; emit("relay", Json.o("ok", true)); }
          } });
          w.delay = 2000;
          thread("entrada-rele", new Runnable() { public void run() { handleIncoming(s, "relé"); } });
        } catch (IOException e) {
          if (w.stop) return;
          if (!Boolean.FALSE.equals(relayOk) && (e.getMessage() == null || !e.getMessage().contains("cerró la espera"))) { relayOk = false; emit("relay", Json.o("ok", false)); }
          sleep(w.delay); w.delay = Math.min(60000, w.delay * 2);
        }
      }
    } });
  }

  // ---------- varios ----------
  /** Botón del pánico: corta todo, olvida claves de sesión y borra lo privado. */
  public void panic() {
    for (Pending p : pending.values()) p.conn.close();
    pending.clear(); stopPairing();
    for (Wait w : relayWaits.values()) { w.stop = true; Socket s = w.sock; if (s != null) try { s.close(); } catch (IOException ignored) {} }
    relayWaits.clear();
    for (Ask a : asks.values()) { a.ok = false; a.latch.countDown(); }
    for (Transfer t : transfers.values()) { t.cancel = true; Conn c = t.conn; if (c != null) c.close(); }
    for (Conn c : live) c.close();
    wipeAllPrivate();
  }

  public synchronized void stop() {
    for (Wait w : relayWaits.values()) { w.stop = true; Socket s = w.sock; if (s != null) try { s.close(); } catch (IOException ignored) {} }
    relayWaits.clear();
    if (server != null) { try { server.close(); } catch (IOException ignored) {} server = null; }
    if (udp != null) { udp.close(); udp = null; }
    if (shouter != null) { shouter.cancel(false); shouter = null; }
  }
  public boolean listening() { return server != null; }
  public String identityPub() { return Bytes.b64(identity.pub); }

  /** Guardado sencillo en una carpeta (pruebas y Android antiguo). */
  public static Saver folderSaver(final File dir) {
    return new Saver() { public String save(File part, String rel) throws IOException {
      File dest = new File(dir, rel);
      if (!inside(dir, dest)) throw new IOException("Ruta no permitida");
      dest.getParentFile().mkdirs();
      File fin = uniqueFile(dest);
      if (!part.renameTo(fin)) {
        InputStream in = new FileInputStream(part); OutputStream o = new FileOutputStream(fin);
        try { byte[] b = new byte[1 << 16]; int k; while ((k = in.read(b)) > 0) o.write(b, 0, k); } finally { in.close(); o.close(); }
        part.delete();
      }
      return fin.getPath();
    } };
  }
}

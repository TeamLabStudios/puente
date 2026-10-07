import com.teamlabstudios.puente.core.*;
import java.io.*;
import java.net.Socket;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** Entradas hostiles contra el motor del móvil: nombres, JSON, ajustes, y un aparato emparejado que se porta mal. */
public class FuzzTest {
  static int fails = 0;
  static void ok(boolean c, String what) { if (c) System.out.println("✓ " + what); else { fails++; System.out.println("✗ " + what); } }
  static Engine mk(File dir, String name, Map<String, String> mem) {
    Engine.Store st = new Engine.Store() { public String get(String k) { return mem.get(k); } public void put(String k, String v) { mem.put(k, v); } };
    return new Engine(st, null, dir, Engine.folderSaver(new File(dir, "descargas")), name);
  }
  @SuppressWarnings("unchecked") static Map<String, Object> m(Object o) { return (Map<String, Object>) o; }

  public static void main(String[] a) throws Exception {
    Thread wd = new Thread(() -> { try { Thread.sleep(180_000); } catch (InterruptedException e) { return; } System.out.println("✗ TIEMPO AGOTADO"); System.exit(2); }); wd.setDaemon(true); wd.start();
    Random R = new Random(7);
    // 1. nombres
    String[] bits = { "..", ".", "/", "\\", "C:", "\\\\srv\\c$", "CON", "nul.txt", "a", "ñ", "‮", "\0", " ", "x".repeat(300), ":", "*" };
    File root = new File("/raiz/recibidos");
    boolean good = true;
    for (int i = 0; i < 20000 && good; i++) {
      StringBuilder s = new StringBuilder(); for (int k = 0; k <= i % 9; k++) s.append(bits[R.nextInt(bits.length)]);
      String r = Engine.safeRel(s.toString());
      if (r == null) continue;
      String full = new File(root, r).getCanonicalPath();
      if (!full.startsWith(root.getPath() + "/")) good = false;
      for (String part : r.split("/")) if (part.equals("..") || part.equals(".") || part.length() > 200 || part.matches(".*[\\x00-\\x1f<>:\"|?*].*")) good = false;
    }
    ok(good, "fuzz de nombres: ninguna ruta se sale de la carpeta");
    // 2. JSON roto o muy anidado: solo errores controlados
    boolean jsonOk = true;
    String alpha = "{}[]\",:0123456789.eE-+truefalsn \\u";
    for (int i = 0; i < 20000; i++) {
      StringBuilder s = new StringBuilder(); int n = R.nextInt(40); for (int k = 0; k < n; k++) s.append(alpha.charAt(R.nextInt(alpha.length())));
      try { Json.parse(s.toString()); } catch (RuntimeException e) { /* bien */ } catch (Throwable e) { jsonOk = false; }
    }
    try { Json.parse("[".repeat(100000)); jsonOk = false; } catch (IllegalArgumentException e) { /* bien */ } catch (Throwable e) { jsonOk = false; }
    ok(jsonOk, "fuzz de JSON: nada tumba el lector (ni 100.000 corchetes)");
    // 3. ajustes desde la pantalla
    File tmp = Files.createTempDirectory("puente-fuzz").toFile();
    Map<String, String> m1 = new HashMap<>(), m2 = new HashMap<>();
    Engine J = mk(new File(tmp, "movil"), "Movil", m1), X = mk(new File(tmp, "otro"), "Otro", m2);
    Object[][] bad = { { "downloads", "/" }, { "port", 80 }, { "port", "47830" }, { "privateMinutes", 0 }, { "name", "" }, { "relayHost", "a b" }, { "relayPort", 70000 }, { "deleteAfter", "quizas" }, { "evil", 1 } };
    int rejected = 0;
    for (Object[] b : bad) { try { J.setSettingsUi(Json.o((String) b[0], b[1])); } catch (IllegalArgumentException e) { rejected++; } }
    ok(rejected == bad.length, "ajustes: se rechaza lo no permitido (" + rejected + "/" + bad.length + ")");
    J.setSettingsUi(Json.o("name", "Mi móvil", "deleteAfter", "preguntar", "relayHost", "casa.duckdns.org", "relayPort", 47840));
    ok("Mi móvil".equals(J.setting("name")) && "preguntar".equals(J.setting("deleteAfter")), "ajustes válidos se guardan");
    J.setSettingsUi(Json.o("relayHost", ""));
    // 4. guardado: si el almacén de claves falla, no se guarda nada en claro
    Map<String, String> m3 = new HashMap<>();
    final boolean[] failing = { false };
    Engine.Guard g = new Engine.Guard() {
      public String protect(String s) { if (failing[0]) throw new IllegalStateException("sin almacén"); return "ks:" + Bytes.b64(Bytes.utf8(s)); }
      public String unprotect(String s) { return Bytes.str(Bytes.unb64(s.substring(3))); }
    };
    Engine K = new Engine(new Engine.Store() { public String get(String k) { return m3.get(k); } public void put(String k, String v) { m3.put(k, v); } }, g, new File(tmp, "k"), Engine.folderSaver(new File(tmp, "k")), "K");
    failing[0] = true;
    K.setSettingsUi(Json.o("name", "SECRETO-NUEVO"));
    boolean plain = false; for (String v : m3.values()) if (!v.startsWith("ks:") || v.contains("SECRETO")) plain = true;
    ok(!plain && K.storageBroken(), "almacén de claves roto: no se guarda nada en claro y se avisa");
    // 5. un aparato emparejado que se porta mal
    J.listen(0); X.listen(0);
    final LinkedBlockingQueue<Object[]> ev = new LinkedBlockingQueue<>();
    J.setListener((t, d) -> ev.add(new Object[] { t, d }));
    X.setListener((t, d) -> {});
    Map<String, Object> pr = J.startPairing();
    Map<String, Object> mine = X.pairWith("127.0.0.1", J.port(), (String) pr.get("code"));
    Map<String, Object> theirs = null; long until = System.currentTimeMillis() + 5000;
    while (theirs == null && System.currentTimeMillis() < until) { Object[] e = ev.poll(100, TimeUnit.MILLISECONDS); if (e != null && "pair-confirm".equals(e[0])) theirs = m(e[1]); }
    X.confirmPair((String) mine.get("id"), true); J.confirmPair((String) theirs.get("id"), true);
    Thread.sleep(500);
    ok(J.peers().size() == 1 && X.peers().size() == 1, "móvil ↔ móvil: emparejados");
    String xfp = (String) J.peers().get(0).get("fp");
    J.setPeerUi(xfp, Json.o("autoAccept", true));
    Noise.KeyPair xid = new Noise.KeyPair(Bytes.unb64(m2.get("identidad")));
    // 5a. id trucado en privado → se queda dentro de «privado»
    Conn c = Conn.connect(new Socket("127.0.0.1", J.port()), true, xid, Json.o("v", 1, "name", "Otro"));
    byte[] data = Bytes.utf8("trampa");
    c.json(Json.o("t", "offer", "id", "../../../../fuera", "files", Arrays.asList((Object) Json.o("fid", 1, "rel", "x.txt", "size", data.length, "key", "ab")), "private", true));
    String acc = c.read().t();
    c.json(Json.o("t", "file", "fid", 1, "from", 0)); c.data(1, data, 0, data.length);
    c.json(Json.o("t", "end", "fid", 1, "sha", Bytes.hex(MessageDigest.getInstance("SHA-256").digest(data)))); c.json(Json.o("t", "done"));
    String fin = c.read().t(); c.close();
    List<File> got = new ArrayList<>(); walk(J.privateDir(), got);
    ok("accept".equals(acc) && "received".equals(fin) && got.size() == 1 && got.get(0).getCanonicalPath().startsWith(J.privateDir().getCanonicalPath() + "/") && !new File(tmp, "fuera").exists(), "id trucado: lo privado no sale de su carpeta");
    // 5b. mensajes trucados → se rechazan y el motor sigue
    Object[] attacks = {
      Json.o("t", "offer", "files", "no"),
      Json.o("t", "offer", "files", Arrays.asList((Object) Json.o("fid", 1, "rel", "..", "size", 1))),
      Json.o("t", "offer", "files", Arrays.asList((Object) Json.o("fid", 1, "rel", "a", "size", -1))),
      Json.o("t", "offer", "files", Arrays.asList((Object) Json.o("fid", 1.5, "rel", "a", "size", 1))),
      Json.o("t", "offer", "files", Arrays.asList((Object) Json.o("fid", 1, "rel", "a".repeat(5000), "size", 1))),
      Json.o("t", "offer", "files", Arrays.asList((Object) Json.o("fid", 1, "rel", "a", "size", 1), Json.o("fid", 1, "rel", "b", "size", 1))),
    };
    int refused = 0;
    for (Object at : attacks) {
      Conn h = Conn.connect(new Socket("127.0.0.1", J.port()), true, xid, Json.o("v", 1));
      h.json(m(at));
      try { Conn.Msg r = h.read(); if ("error".equals(r.t())) refused++; } catch (IOException e) { refused++; }
      h.close();
    }
    // demasiados archivos declarados en trozos
    Conn h = Conn.connect(new Socket("127.0.0.1", J.port()), true, xid, Json.o("v", 1));
    List<Object> many = new ArrayList<>(); for (int i = 0; i < 1500; i++) many.add(Json.o("fid", i + 1, "rel", "f" + i, "size", 0));
    h.json(Json.o("t", "offer", "files", many, "count", 20000, "more", true));
    try { for (int i = 0; i < 8; i++) h.json(Json.o("t", "offer+", "files", many, "more", true)); Conn.Msg r = h.read(); if ("error".equals(r.t())) refused++; } catch (IOException e) { refused++; }
    h.close();
    // JSON muy anidado dentro del canal
    h = Conn.connect(new Socket("127.0.0.1", J.port()), true, xid, Json.o("v", 1));
    Object deep = "x"; for (int i = 0; i < 2000; i++) deep = Arrays.asList(deep);
    try { h.json(Json.o("t", "offer", "files", deep)); h.read(); } catch (IOException e) { refused++; }
    h.close();
    ok(refused == attacks.length + 2, "mensajes trucados: todos rechazados (" + refused + "/" + (attacks.length + 2) + ")");
    // sigue vivo
    h = Conn.connect(new Socket("127.0.0.1", J.port()), true, xid, Json.o("v", 1));
    h.json(Json.o("t", "offer", "files", Arrays.asList((Object) Json.o("fid", 1, "rel", "bien.txt", "size", 2, "key", "cf"))));
    ok("accept".equals(h.read().t()), "después de todo eso, el motor sigue aceptando envíos");
    // 5c. quitarlo corta lo que tenga abierto
    J.removePeer(xfp);
    boolean cut = false; try { h.sock.setSoTimeout(3000); h.read(); } catch (IOException e) { cut = true; }
    ok(cut, "quitar un aparato corta en el acto su conexión");
    h.close();
    // 6. ids de la pantalla
    int idsOk = 0;
    for (String bid : new String[] { "../x", "", "ABC", "0123456789abcdef0123456789abcdef00" }) { try { J.listPrivate(bid); } catch (IllegalArgumentException e) { idsOk++; } }
    ok(idsOk == 4, "la pantalla solo puede pedir por id (sin rutas)");
    J.panic(); J.stop(); X.stop();
    System.out.println(fails == 0 ? "TODO BIEN" : fails + " FALLOS");
    System.exit(fails == 0 ? 0 : 1);
  }
  static void walk(File d, List<File> out) { File[] k = d.listFiles(); if (k == null) return; for (File x : k) { if (x.isDirectory()) walk(x, out); else out.add(x); } }
}

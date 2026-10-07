import com.teamlabstudios.puente.core.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** El motor del móvil contra el Puente de PC real (Node): emparejar, enviar, recibir, relé, privado, reanudar. */
public class InteropTest {
  static int fails = 0;
  static void ok(boolean c, String what) { if (c) System.out.println("✓ " + what); else { fails++; System.out.println("✗ " + what); } }

  // ---- el PC (Node) ----
  static Process node; static BufferedWriter nin; static int seq = 0;
  static final LinkedBlockingQueue<Map<String, Object>> nodeEvents = new LinkedBlockingQueue<>();
  static final Map<Integer, Map<String, Object>> replies = new ConcurrentHashMap<>();
  static Object call(Map<String, Object> c) throws Exception {
    int n = ++seq; c.put("n", n);
    synchronized (nin) { nin.write(Json.str(c) + "\n"); nin.flush(); }
    long until = System.currentTimeMillis() + 60000;
    while (System.currentTimeMillis() < until) { Map<String, Object> r = replies.remove(n); if (r != null) { if (r.get("error") != null) throw new IOException("PC: " + r.get("error")); return r.get("r"); } Thread.sleep(10); }
    throw new IOException("PC no contesta a " + c.get("cmd"));
  }
  @SuppressWarnings("unchecked") static Map<String, Object> m(Object o) { return (Map<String, Object>) o; }
  static Map<String, Object> nodeEv(String ev, long ms) throws Exception {
    long until = System.currentTimeMillis() + ms;
    List<Map<String, Object>> skipped = new ArrayList<>();
    try {
      while (System.currentTimeMillis() < until) {
        Map<String, Object> e = nodeEvents.poll(100, TimeUnit.MILLISECONDS);
        if (e == null) continue;
        if (ev.equals(e.get("ev"))) return m(e.get("d"));
        skipped.add(e);
      }
      return null;
    } finally { nodeEvents.addAll(skipped); }
  }

  // ---- el móvil (Java) ----
  static final LinkedBlockingQueue<Object[]> javaEvents = new LinkedBlockingQueue<>();
  static volatile Boolean autoAnswer = true;
  static Map<String, Object> javaEv(String type, long ms) throws Exception {
    long until = System.currentTimeMillis() + ms;
    while (System.currentTimeMillis() < until) { Object[] e = javaEvents.poll(100, TimeUnit.MILLISECONDS); if (e != null && type.equals(e[0])) return m(e[1]); }
    return null;
  }
  static Engine.Source src(final File f, final String rel) {
    return new Engine.Source() {
      public String rel() { return rel; } public long size() { return f.length(); } public long mtime() { return f.lastModified(); }
      public InputStream open() throws IOException { return new FileInputStream(f); }
    };
  }
  static byte[] rnd(int n) { byte[] b = new byte[n]; new Random(n).nextBytes(b); return b; }
  static boolean same(File a, File b) throws IOException { return a.isFile() && b.isFile() && Arrays.equals(Files.readAllBytes(a.toPath()), Files.readAllBytes(b.toPath())); }

  public static void main(String[] args) throws Exception {
    Thread wd = new Thread(new Runnable() { public void run() { try { Thread.sleep(280_000); } catch (InterruptedException e) { return; } System.out.println("✗ TIEMPO AGOTADO"); if (node != null) node.destroyForcibly(); System.exit(2); } });
    wd.setDaemon(true); wd.start();
    File tmp = Files.createTempDirectory("puente-interop").toFile();
    File pcDir = new File(tmp, "pc"), mWork = new File(tmp, "movil"), mDl = new File(tmp, "movil-descargas");
    node = new ProcessBuilder("node", "test/peer.cjs").redirectError(ProcessBuilder.Redirect.INHERIT).start();
    nin = new BufferedWriter(new OutputStreamWriter(node.getOutputStream(), "UTF-8"));
    final BufferedReader nout = new BufferedReader(new InputStreamReader(node.getInputStream(), "UTF-8"));
    Thread rd = new Thread(new Runnable() { public void run() {
      try { String l; while ((l = nout.readLine()) != null) { Map<String, Object> o = Json.obj(l); if (o.containsKey("re")) replies.put(((Number) o.get("re")).intValue(), o); else nodeEvents.add(o); } } catch (Exception e) {}
    } }); rd.setDaemon(true); rd.start();
    try {
      Map<String, Object> init = m(call(Json.o("cmd", "init", "dir", pcDir.getPath(), "name", "PC-Estudio")));
      int pcPort = ((Number) init.get("port")).intValue(); String pcFp = (String) init.get("fp");

      final Map<String, String> mem = new ConcurrentHashMap<>();
      Engine.Store store = new Engine.Store() { public String get(String k) { return mem.get(k); } public void put(String k, String v) { mem.put(k, v); } };
      final Engine J = new Engine(store, null, mWork, Engine.folderSaver(mDl), "Móvil de prueba");
      J.setListener(new Engine.Listener() { public void on(String t, Map<String, Object> d) {
        javaEvents.add(new Object[] { t, d });
        if (t.equals("ask") && autoAnswer != null) J.answer((String) d.get("id"), autoAnswer);
      } });
      int jPort = J.listen(0);

      // 0. huella y 6 cifras: mismas cuentas que el PC
      byte[] pub = Noise.KeyPair.generate().pub, hash = Noise.random(32);
      Map<String, Object> calc = m(call(Json.o("cmd", "calc", "pub", Bytes.b64(pub), "hash", Bytes.hex(hash))));
      ok(Noise.fingerprint(pub).equals(calc.get("fp")) && Noise.sas(hash).equals(calc.get("sas")), "huella y 6 cifras iguales que en el PC");

      // 1. el móvil se empareja con el PC (código del PC)
      Map<String, Object> pr = m(call(Json.o("cmd", "startPairing")));
      Map<String, Object> mine = J.pairWith("127.0.0.1", pcPort, (String) pr.get("code"));
      Map<String, Object> theirs = nodeEv("pair-confirm", 5000);
      ok(theirs != null && mine.get("sas").equals(theirs.get("sas")), "emparejar: las 6 cifras coinciden (" + mine.get("sas") + ")");
      ok(J.myFp.equals(theirs.get("fp")) && pcFp.equals(mine.get("fp")), "emparejar: cada uno ve la huella del otro");
      J.confirmPair((String) mine.get("id"), true);
      call(Json.o("cmd", "confirm", "id", theirs.get("id"), "ok", true));
      Map<String, Object> endPc = nodeEv("pair-ended", 5000), endJ = javaEv("pair-ended", 5000);
      ok(endPc != null && Boolean.TRUE.equals(endPc.get("ok")) && endJ != null && Boolean.TRUE.equals(endJ.get("ok")), "emparejar: los dos se guardan como de confianza");
      ok(J.peers().size() == 1 && "PC-Estudio".equals(J.peers().get(0).get("name")), "el móvil conoce al «PC-Estudio»");

      // 2. móvil → PC (directo)
      J.setPeer(pcFp, Json.o("direct", "127.0.0.1:" + pcPort));
      File a = new File(tmp, "foto.jpg"); Files.write(a.toPath(), rnd(3_000_000));
      File b = new File(tmp, "nota.txt"); Files.write(b.toPath(), Bytes.utf8("hola desde el móvil ñ"));
      File z = new File(tmp, "vacio.bin"); Files.write(z.toPath(), new byte[0]);
      Map<String, Object> r = J.send(pcFp, Arrays.asList(src(a, "foto.jpg"), src(b, "Notas/nota.txt"), src(z, "vacio.bin")), false);
      ok("hecho".equals(r.get("status")), "móvil → PC: enviado (" + r.get("status") + " " + (r.get("error") == null ? "" : r.get("error")) + ")");
      File pcDl = new File(pcDir, "descargas");
      ok(same(a, new File(pcDl, "foto.jpg")) && same(b, new File(pcDl, "Notas/nota.txt")) && new File(pcDl, "vacio.bin").isFile(), "móvil → PC: llega idéntico (con carpetas y archivo vacío)");

      // 3. PC → móvil (directo)
      call(Json.o("cmd", "setPeer", "fp", J.myFp, "patch", Json.o("direct", "127.0.0.1:" + jPort)));
      File dir = new File(tmp, "Vacaciones"); new File(dir, "dia1").mkdirs();
      File c1 = new File(dir, "dia1/playa.mp4"); Files.write(c1.toPath(), rnd(5_000_123));
      File c2 = new File(dir, "lista.txt"); Files.write(c2.toPath(), Bytes.utf8("toalla"));
      Map<String, Object> s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(dir.getPath()))));
      ok("hecho".equals(s.get("status")), "PC → móvil: enviado (" + s.get("status") + " " + s.get("error") + ")");
      ok(same(c1, new File(mDl, "Vacaciones/dia1/playa.mp4")) && same(c2, new File(mDl, "Vacaciones/lista.txt")), "PC → móvil: llega idéntico");
      ok(javaEv("received", 2000) != null, "PC → móvil: aviso de recibido");
      // repetido: no pisa, «(2)»
      call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(c2.getPath())));
      ok(new File(mDl, "lista.txt").isFile() && same(c2, new File(mDl, "lista (2).txt")) == false && new File(mDl, "lista.txt").isFile(), "nombre repetido: se guarda aparte");
      call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(c2.getPath())));
      ok(new File(mDl, "lista (2).txt").isFile(), "nombre repetido: «lista (2).txt»");

      // 4. rechazar
      autoAnswer = false;
      s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(c2.getPath()))));
      ok("rechazado".equals(s.get("status")), "el móvil puede rechazar");
      autoAnswer = true;

      // 5. código incorrecto
      call(Json.o("cmd", "startPairing"));
      boolean failed = false; try { J.pairWith("127.0.0.1", pcPort, "AAAA-AAAA"); } catch (IOException e) { failed = true; }
      ok(failed && nodeEv("pair-failed", 3000) != null, "código incorrecto: no empareja y el PC avisa");

      // 6. el PC se empareja con el móvil (código del móvil)
      Map<String, Object> jp = J.startPairing();
      final Map<String, Object> pw = new HashMap<>();
      Thread th = new Thread(new Runnable() { public void run() { try { pw.putAll(m(call(Json.o("cmd", "pairWith", "host", "127.0.0.1", "port", J.port(), "code", jp.get("code"))))); } catch (Exception e) { pw.put("error", e.getMessage()); } } });
      th.start();
      Map<String, Object> jc = javaEv("pair-confirm", 5000); th.join(5000);
      ok(jc != null && jc.get("sas").equals(pw.get("sas")), "PC → móvil emparejar: 6 cifras iguales");
      // si el PC dice que no coincide, no se empareja
      call(Json.o("cmd", "confirm", "id", pw.get("id"), "ok", false));
      Map<String, Object> je = javaEv("pair-ended", 5000);
      ok(je != null && Boolean.FALSE.equals(je.get("ok")), "si el otro dice «no coinciden», se anula");

      // 8. relé (fuera de casa)
      int rp = ((Number) m(call(Json.o("cmd", "relay", "key", "clave-rele"))).get("port")).intValue();
      call(Json.o("cmd", "setPeer", "fp", J.myFp, "patch", Json.o("direct", "")));
      J.setPeer(pcFp, Json.o("direct", ""));
      call(Json.o("cmd", "settings", "patch", Json.o("relay", Json.o("host", "127.0.0.1", "port", rp, "key", "clave-rele"))));
      J.setSettings(Json.o("relayHost", "127.0.0.1", "relayPort", rp, "relayKey", "clave-rele"));
      Thread.sleep(800);
      r = J.send(pcFp, Arrays.asList(src(a, "por-rele.jpg")), false);
      ok("hecho".equals(r.get("status")) && "relé".equals(r.get("via")) && same(a, new File(pcDl, "por-rele.jpg")), "móvil → PC por el relé (" + r.get("status") + " " + r.get("via") + " " + r.get("error") + ")");
      s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(c1.getPath()))));
      ok("hecho".equals(s.get("status")) && "relé".equals(s.get("via")) && same(c1, new File(mDl, "playa.mp4")), "PC → móvil por el relé (" + s.get("status") + " " + s.get("via") + " " + s.get("error") + ")");
      ok(Boolean.TRUE.equals(J.relayStatus()), "el móvil está esperando en el relé");

      // 7. avisos de casa (UDP): se reconocen por la marca
      call(Json.o("cmd", "onBeacon", "msg", J.beacon(), "host", "127.0.0.1"));
      List<Object> pcPeers = (List<Object>) call(Json.o("cmd", "peers"));
      ok(Boolean.TRUE.equals(m(pcPeers.get(0)).get("home")), "el PC reconoce el aviso del móvil en casa");
      J.onBeacon(m(call(Json.o("cmd", "beacon"))), "127.0.0.1");
      ok(Boolean.TRUE.equals(J.peers().get(0).get("home")), "el móvil reconoce el aviso del PC en casa");
      J.setPeer(pcFp, Json.o("direct", ""));
      r = J.send(pcFp, Arrays.asList(src(b, "por-casa.txt")), false);
      ok("hecho".equals(r.get("status")) && "casa".equals(r.get("via")), "móvil → PC por la red de casa");

      // 9. sesión privada en el móvil: aparte y se borra sola
      J.setSettings(Json.o("privateMinutes", 0.002));
      s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(b.getPath()), "private", true)));
      Map<String, Object> rec = null; for (int i = 0; i < 5 && rec == null; i++) { Map<String, Object> x = javaEv("received", 3000); if (x != null && Boolean.TRUE.equals(x.get("private"))) rec = x; }
      ok(rec != null && String.valueOf(rec.get("saved")).startsWith(J.privateDir().getPath()) && !new File(mDl, "nota (2).txt").exists(), "privado: no va a Descargas");
      ok(javaEv("wiped", 5000) != null && rec != null && !new File(String.valueOf(rec.get("saved"))).exists(), "privado: se borra solo");
      ok(J.history().size() > 0 && !J.history().get(0).get("private").equals(true), "privado: no queda en el historial");

      // 10. reanudar: se corta a mitad y al repetir sigue donde lo dejó
      File big = new File(tmp, "grande.bin"); Files.write(big.toPath(), rnd(48_000_000));
      J.setListener(new Engine.Listener() { boolean cut = false; public void on(String t, Map<String, Object> d) {
        javaEvents.add(new Object[] { t, d });
        if (t.equals("ask")) J.answer((String) d.get("id"), true);
        if (t.equals("transfer") && !cut && "in".equals(d.get("dir")) && ((Number) d.get("done")).longValue() > 6_000_000) { cut = true; J.cancel((String) d.get("id")); }
      } });
      s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(big.getPath()))));
      ok(!"hecho".equals(s.get("status")), "reanudar: el primer intento se corta (" + s.get("status") + ")");
      s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(big.getPath()))));
      ok("hecho".equals(s.get("status")) && ((Number) s.get("resumed")).longValue() > 1_000_000 && same(big, new File(mDl, "grande.bin")), "reanudar: sigue donde lo dejó (" + s.get("resumed") + " bytes ahorrados) y llega idéntico");

      // 12. muchos archivos de una vez (la lista va en trozos), en los dos sentidos
      J.setListener(new Engine.Listener() { public void on(String t, Map<String, Object> d) { javaEvents.add(new Object[] { t, d }); if (t.equals("ask")) J.answer((String) d.get("id"), true); } });
      J.setPeer(pcFp, Json.o("direct", "127.0.0.1:" + pcPort));
      call(Json.o("cmd", "setPeer", "fp", J.myFp, "patch", Json.o("direct", "127.0.0.1:" + jPort)));
      List<Engine.Source> lots = new ArrayList<>();
      File lotsDir = new File(tmp, "lote"); lotsDir.mkdirs();
      for (int i = 0; i < 2500; i++) { File f = new File(lotsDir, "IMG_2026_vacaciones_" + i + ".jpg"); Files.write(f.toPath(), Bytes.utf8("foto " + i)); lots.add(src(f, "Camara/IMG_2026_vacaciones_" + i + ".jpg")); }
      r = J.send(pcFp, lots, false);
      ok("hecho".equals(r.get("status")) && new File(pcDl, "Camara").list().length == 2500, "móvil → PC: 2.500 archivos de una vez (" + r.get("status") + " " + r.get("error") + ")");
      s = m(call(Json.o("cmd", "send", "fp", J.myFp, "paths", Arrays.asList(lotsDir.getPath()))));
      ok("hecho".equals(s.get("status")) && new File(mDl, "lote").list().length == 2500, "PC → móvil: 2.500 archivos de una vez (" + s.get("status") + " " + s.get("error") + ")");

      // 11. un desconocido no entra
      File other = new File(tmp, "otro");
      Map<String, String> mem2 = new HashMap<>();
      Engine X = new Engine(new Engine.Store() { public String get(String k) { return mem2.get(k); } public void put(String k, String v) { mem2.put(k, v); } }, null, other, Engine.folderSaver(other), "Intruso");
      try { Conn.connect(new java.net.Socket("127.0.0.1", jPort), true, Noise.KeyPair.generate(), Json.o("v", 1)).json(Json.o("t", "offer", "files", new ArrayList<Object>())); } catch (IOException ignored) {}
      ok(javaEv("intruder", 3000) != null, "un aparato desconocido es rechazado y se avisa");

      J.panic(); J.stop();
    } finally {
      try { call(Json.o("cmd", "quit")); } catch (Exception ignored) {}
      node.destroy();
    }
    System.out.println(fails == 0 ? "TODO BIEN" : fails + " FALLOS");
    System.exit(fails == 0 ? 0 : 1);
  }
}

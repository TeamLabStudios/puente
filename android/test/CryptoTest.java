import com.teamlabstudios.puente.core.*;
import java.nio.file.*;
import java.util.*;

/** X25519 (RFC 7748) y Noise XX (vectores oficiales) en la JVM. */
public class CryptoTest {
  static int fails = 0;
  static void eq(Object a, Object b, String what) { if (!Objects.equals(a, b)) { fails++; System.out.println("✗ " + what + "\n   " + a + "\n   " + b); } else System.out.println("✓ " + what); }
  static byte[] hx(Object s) { return Bytes.unhex((String) s); }

  @SuppressWarnings("unchecked")
  public static void main(String[] a) throws Exception {
    eq(Bytes.hex(X25519.scalarMult(Bytes.unhex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), Bytes.unhex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"))), "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552", "X25519 RFC 7748 §5.2");
    byte[] ap = Bytes.unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"), bp = Bytes.unhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
    eq(Bytes.hex(X25519.publicKey(ap)), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "X25519 clave pública de Alice");
    eq(Bytes.hex(X25519.publicKey(bp)), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "X25519 clave pública de Bob");
    eq(Bytes.hex(X25519.scalarMult(ap, X25519.publicKey(bp))), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742", "X25519 secreto compartido");
    // 1000 iteraciones (RFC 7748 §5.2)
    byte[] k = X25519.BASE.clone(), u = X25519.BASE.clone();
    for (int i = 0; i < 1000; i++) { byte[] r = X25519.scalarMult(k, u); u = k; k = r; }
    eq(Bytes.hex(k), "684cf59ba83309552800ef566f2f4d3c1c3887c49360e3875f2eb94d99532c51", "X25519 1000 iteraciones");

    Map<String, Object> V = Json.obj(new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8"));
    Noise.Handshake I = new Noise.Handshake(true, new Noise.KeyPair(hx(V.get("init_static"))), new Noise.KeyPair(hx(V.get("init_ephemeral"))), hx(V.get("init_prologue")));
    Noise.Handshake R = new Noise.Handshake(false, new Noise.KeyPair(hx(V.get("resp_static"))), new Noise.KeyPair(hx(V.get("resp_ephemeral"))), hx(V.get("resp_prologue")));
    List<Object> m = (List<Object>) V.get("messages");
    Map<String, Object> mm;
    for (int i = 0; i < 3; i++) {
      mm = (Map<String, Object>) m.get(i);
      Noise.Handshake w = i % 2 == 0 ? I : R, r = i % 2 == 0 ? R : I;
      byte[] c = w.write(hx(mm.get("payload")));
      eq(Bytes.hex(c), mm.get("ciphertext"), "Noise mensaje de saludo " + i);
      eq(Bytes.hex(r.read(c)), mm.get("payload"), "Noise lee saludo " + i);
    }
    eq(Bytes.hex(I.hash), V.get("handshake_hash"), "Noise huella del saludo");
    for (int i = 3; i < m.size(); i++) {
      mm = (Map<String, Object>) m.get(i);
      Noise.Handshake w = i % 2 == 1 ? R : I, r = i % 2 == 1 ? I : R;
      byte[] c = w.send.encrypt(new byte[0], hx(mm.get("payload")));
      eq(Bytes.hex(c), mm.get("ciphertext"), "Noise transporte " + i);
      eq(Bytes.hex(r.recv.decrypt(new byte[0], c)), mm.get("payload"), "Noise descifra " + i);
    }
    // un bit cambiado → se rechaza
    byte[] c = I.send.encrypt(new byte[0], Bytes.utf8("hola")); c[2] ^= 1;
    boolean rej = false; try { R.recv.decrypt(new byte[0], c); } catch (Exception e) { rej = true; }
    eq(rej, true, "un bit cambiado se rechaza");
    eq(Bytes.b64(Bytes.utf8("Puente!")), "UHVlbnRlIQ==", "base64");
    eq(Bytes.str(Bytes.unb64("UHVlbnRlIQ==")), "Puente!", "base64 al revés");
    eq(Noise.sas(I.hash), Noise.sas(R.hash), "las 6 cifras coinciden");
    System.out.println(fails == 0 ? "TODO BIEN" : fails + " FALLOS");
    System.exit(fails == 0 ? 0 : 1);
  }
}

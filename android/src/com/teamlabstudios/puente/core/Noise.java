package com.teamlabstudios.puente.core;

import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Noise_XX_25519_AESGCM_SHA256: el mismo saludo cifrado que el Puente de PC (electron/noise.cjs).
 * Claves nuevas en cada conexión y AES-256-GCM para todo lo que viaja. Comprobado con los vectores oficiales.
 */
public final class Noise {
  private Noise() {}
  public static final String NAME = "Noise_XX_25519_AESGCM_SHA256";
  public static final String B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  static final int DHLEN = 32, HASHLEN = 32, TAGLEN = 16;
  static final SecureRandom RNG = new SecureRandom();

  public static byte[] random(int n) { byte[] b = new byte[n]; RNG.nextBytes(b); return b; }

  public static byte[] sha256(byte[]... parts) {
    try { MessageDigest d = MessageDigest.getInstance("SHA-256"); for (byte[] p : parts) d.update(p); return d.digest(); }
    catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
  }
  public static byte[] hmac(byte[] key, byte[]... parts) {
    try {
      Mac m = Mac.getInstance("HmacSHA256");
      // HMAC con clave vacía: javax no la admite, pero equivale a una clave de un byte cero (se rellena con ceros igual)
      m.init(new SecretKeySpec(key.length == 0 ? new byte[1] : key, "HmacSHA256"));
      for (byte[] p : parts) m.update(p);
      return m.doFinal();
    } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
  }
  public static byte[][] hkdf(byte[] ck, byte[] ikm, int n) {
    byte[] tk = hmac(ck, ikm);
    byte[] o1 = hmac(tk, new byte[] { 1 });
    byte[] o2 = hmac(tk, o1, new byte[] { 2 });
    if (n == 2) return new byte[][] { o1, o2 };
    return new byte[][] { o1, o2, hmac(tk, o2, new byte[] { 3 }) };
  }

  public static final class KeyPair {
    public final byte[] priv, pub;
    public KeyPair(byte[] priv) { this.priv = priv.clone(); this.pub = X25519.publicKey(this.priv); }
    public static KeyPair generate() { return new KeyPair(random(32)); }
  }
  static byte[] dh(KeyPair kp, byte[] pub) {
    byte[] out = X25519.scalarMult(kp.priv, pub);
    int acc = 0; for (byte b : out) acc |= b;
    if (acc == 0) throw new IllegalArgumentException("Clave pública no válida");
    return out;
  }

  public static final class CipherState {
    byte[] k; long n = 0; // n se trata como número sin signo de 64 bits
    private Cipher enc, dec;
    CipherState(byte[] k) { this.k = k; }
    boolean has() { return k != null; }
    private static byte[] nonce(long n) { byte[] b = new byte[12]; for (int i = 0; i < 8; i++) b[4 + i] = (byte) (n >>> (56 - 8 * i)); return b; }
    public byte[] encrypt(byte[] ad, byte[] pt) { return encrypt(ad, pt, 0, pt.length); }
    public byte[] encrypt(byte[] ad, byte[] pt, int off, int len) {
      if (k == null) return Arrays.copyOfRange(pt, off, off + len);
      if (n == -1L) throw new IllegalStateException("Nonce agotado");
      try {
        if (enc == null) enc = Cipher.getInstance("AES/GCM/NoPadding");
        enc.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, nonce(n++)));
        if (ad.length > 0) enc.updateAAD(ad);
        return enc.doFinal(pt, off, len);
      } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    public byte[] decrypt(byte[] ad, byte[] ct) throws GeneralSecurityException {
      if (k == null) return ct.clone();
      if (n == -1L) throw new GeneralSecurityException("Nonce agotado");
      if (ct.length < TAGLEN) throw new GeneralSecurityException("Mensaje demasiado corto");
      if (dec == null) dec = Cipher.getInstance("AES/GCM/NoPadding");
      dec.init(Cipher.DECRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, nonce(n)));
      if (ad.length > 0) dec.updateAAD(ad);
      byte[] p = dec.doFinal(ct); // si alguien tocó un solo bit, aquí falla
      n++;
      return p;
    }
    public void wipe() { if (k != null) Arrays.fill(k, (byte) 0); }
  }

  static final class Symmetric {
    byte[] h, ck; CipherState cs = new CipherState(null);
    Symmetric() {
      byte[] nb = Bytes.utf8(NAME);
      h = nb.length <= HASHLEN ? Arrays.copyOf(nb, HASHLEN) : sha256(nb);
      ck = h.clone();
    }
    void mixKey(byte[] ikm) { byte[][] o = hkdf(ck, ikm, 2); ck = o[0]; cs = new CipherState(o[1]); }
    void mixHash(byte[] d) { h = sha256(h, d); }
    byte[] encryptAndHash(byte[] pt) { byte[] c = cs.encrypt(h, pt); mixHash(c); return c; }
    byte[] decryptAndHash(byte[] c) throws GeneralSecurityException { byte[] p = cs.decrypt(h, c); mixHash(c); return p; }
    CipherState[] split() { byte[][] o = hkdf(ck, new byte[0], 2); return new CipherState[] { new CipherState(o[0]), new CipherState(o[1]) }; }
  }

  /** Saludo XX:  -> e   ·   <- e, ee, s, es   ·   -> s, se */
  public static final class Handshake {
    final boolean init; final KeyPair s; KeyPair e;
    public byte[] re, rs, hash;
    public CipherState send, recv;
    public boolean done;
    final Symmetric ss = new Symmetric();
    int step = 0;

    public Handshake(boolean initiator, KeyPair s, KeyPair e, byte[] prologue) {
      this.init = initiator; this.s = s; this.e = e;
      ss.mixHash(prologue == null ? Bytes.utf8("Puente/1") : prologue);
    }
    public Handshake(boolean initiator, KeyPair s) { this(initiator, s, null, null); }

    public byte[] write(byte[] payload) {
      if (payload == null) payload = new byte[0];
      byte[] out;
      if (init && step == 0) {
        if (e == null) e = KeyPair.generate();
        ss.mixHash(e.pub); out = e.pub.clone();
      } else if (!init && step == 1) {
        if (e == null) e = KeyPair.generate();
        ss.mixHash(e.pub);
        ss.mixKey(dh(e, re));
        byte[] cs = ss.encryptAndHash(s.pub);
        ss.mixKey(dh(s, re));
        out = Bytes.cat(e.pub, cs);
      } else if (init && step == 2) {
        out = ss.encryptAndHash(s.pub);
        ss.mixKey(dh(s, re));
      } else throw new IllegalStateException("No me toca escribir");
      out = Bytes.cat(out, ss.encryptAndHash(payload));
      if (++step == 3) finish();
      return out;
    }

    public byte[] read(byte[] msg) throws GeneralSecurityException {
      int p = 0;
      if (!init && step == 0) {
        if (msg.length < DHLEN) throw new GeneralSecurityException("Saludo incompleto");
        re = Arrays.copyOfRange(msg, 0, DHLEN); p = DHLEN; ss.mixHash(re);
      } else if (init && step == 1) {
        if (msg.length < DHLEN) throw new GeneralSecurityException("Saludo incompleto");
        re = Arrays.copyOfRange(msg, 0, DHLEN); p = DHLEN; ss.mixHash(re);
        ss.mixKey(dh(e, re));
        int n = DHLEN + (ss.cs.has() ? TAGLEN : 0);
        if (msg.length < p + n) throw new GeneralSecurityException("Saludo incompleto");
        rs = ss.decryptAndHash(Arrays.copyOfRange(msg, p, p + n)); p += n;
        ss.mixKey(dh(e, rs));
      } else if (!init && step == 2) {
        int n = DHLEN + (ss.cs.has() ? TAGLEN : 0);
        if (msg.length < n) throw new GeneralSecurityException("Saludo incompleto");
        rs = ss.decryptAndHash(Arrays.copyOfRange(msg, 0, n)); p = n;
        ss.mixKey(dh(e, rs));
      } else throw new IllegalStateException("No me toca leer");
      byte[] payload = ss.decryptAndHash(Arrays.copyOfRange(msg, p, msg.length));
      if (++step == 3) finish();
      return payload;
    }

    private void finish() {
      CipherState[] c = ss.split();
      send = init ? c[0] : c[1];
      recv = init ? c[1] : c[0];
      hash = ss.h.clone();
      done = true;
      if (e != null) Arrays.fill(e.priv, (byte) 0);
    }
  }

  /** Código de 6 cifras para comparar en las dos pantallas */
  public static String sas(byte[] hash) {
    byte[] m = hmac(hash, Bytes.utf8("puente-sas"));
    long v = ((m[0] & 0xffL) << 24) | ((m[1] & 0xff) << 16) | ((m[2] & 0xff) << 8) | (m[3] & 0xff);
    return String.format("%06d", v % 1000000);
  }
  /** Huella corta de una clave fija: «K7QM-4R2X-…» */
  public static String fingerprint(byte[] pub) {
    byte[] h = sha256(Bytes.utf8("puente-id"), pub);
    StringBuilder s = new StringBuilder();
    for (int i = 0; i < 12; i++) { if (i > 0 && i % 4 == 0) s.append('-'); s.append(B32.charAt((h[i] & 0xff) % B32.length())); }
    return s.toString();
  }
}

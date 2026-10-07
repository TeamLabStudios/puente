package com.teamlabstudios.puente.core;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;

/** Ayudas con bytes: base64 (estándar, con relleno, como Node), hex, concatenar, texto UTF-8. */
public final class Bytes {
  private Bytes() {}
  public static final Charset UTF8 = Charset.forName("UTF-8");
  private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
  private static final char[] HEX = "0123456789abcdef".toCharArray();

  public static byte[] utf8(String s) { return s.getBytes(UTF8); }
  public static String str(byte[] b) { return new String(b, UTF8); }

  public static byte[] cat(byte[]... parts) {
    int n = 0; for (byte[] p : parts) n += p.length;
    byte[] o = new byte[n]; int k = 0;
    for (byte[] p : parts) { System.arraycopy(p, 0, o, k, p.length); k += p.length; }
    return o;
  }

  public static String hex(byte[] b) {
    char[] c = new char[b.length * 2];
    for (int i = 0; i < b.length; i++) { c[2 * i] = HEX[(b[i] >> 4) & 15]; c[2 * i + 1] = HEX[b[i] & 15]; }
    return new String(c);
  }
  public static byte[] unhex(String s) {
    byte[] o = new byte[s.length() / 2];
    for (int i = 0; i < o.length; i++) o[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
    return o;
  }

  public static String b64(byte[] b) {
    StringBuilder s = new StringBuilder((b.length + 2) / 3 * 4);
    for (int i = 0; i < b.length; i += 3) {
      int n = (b[i] & 0xff) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xff) << 8 : 0) | (i + 2 < b.length ? b[i + 2] & 0xff : 0);
      s.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63]);
      s.append(i + 1 < b.length ? B64[(n >> 6) & 63] : '=');
      s.append(i + 2 < b.length ? B64[n & 63] : '=');
    }
    return s.toString();
  }
  public static byte[] unb64(String s) {
    ByteArrayOutputStream o = new ByteArrayOutputStream();
    int acc = 0, bits = 0;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      int v = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' || c == '-' ? 62 : c == '/' || c == '_' ? 63 : -1;
      if (v < 0) continue;
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; o.write((acc >> bits) & 0xff); }
    }
    return o.toByteArray();
  }
}

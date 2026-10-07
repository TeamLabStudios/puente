package com.teamlabstudios.puente.core;

import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Canal seguro sobre una conexión TCP (igual que electron/channel.cjs): saludo Noise XX y luego mensajes
 * cifrados con AES-256-GCM, cada uno con su tamaño delante (2 bytes).
 * Dentro: 0 = control (JSON) · 1 = trozo de archivo (id 4 bytes + datos).
 */
public final class Conn {
  public static final int MAX = 65535, TAG = 16, CHUNK = MAX - TAG - 5;
  static final int HELLO_TIMEOUT = 15000;
  private static final byte[] EMPTY = new byte[0];

  public final Socket sock;
  private final DataInputStream in;
  private final OutputStream out;
  private final Noise.Handshake hs;
  public final byte[] peer, hash;
  public Map<String, Object> hello = new LinkedHashMap<>();
  public String via = "casa";
  private volatile boolean closed;

  /** Un mensaje recibido: o JSON (json != null) o un trozo de archivo (fid + data). */
  public static final class Msg {
    public Map<String, Object> json; public int fid; public byte[] data;
    public String t() { return json == null ? null : Json.s(json, "t"); }
  }

  private Conn(Socket s, DataInputStream in, OutputStream out, Noise.Handshake hs) {
    this.sock = s; this.in = in; this.out = out; this.hs = hs; this.peer = hs.rs; this.hash = hs.hash;
  }

  static byte[] readFrame(DataInputStream in) throws IOException {
    int n = in.readUnsignedShort();
    byte[] b = new byte[n];
    in.readFully(b);
    return b;
  }
  static void writeFrame(OutputStream out, byte[] b) throws IOException {
    if (b.length > MAX) throw new IOException("Mensaje demasiado grande");
    out.write((b.length >> 8) & 0xff); out.write(b.length & 0xff); out.write(b); out.flush();
  }

  /** Hace el saludo y devuelve el canal listo. «identity» = clave fija de este aparato. */
  public static Conn connect(Socket s, boolean initiator, Noise.KeyPair identity, Map<String, Object> hello) throws IOException {
    return connect(s, s.getInputStream(), initiator, identity, hello);
  }
  public static Conn connect(Socket s, InputStream rawIn, boolean initiator, Noise.KeyPair identity, Map<String, Object> hello) throws IOException {
    int old = s.getSoTimeout();
    s.setSoTimeout(HELLO_TIMEOUT);
    DataInputStream in = new DataInputStream(rawIn);
    OutputStream out = new BufferedOutputStream(s.getOutputStream(), 1 << 17);
    Noise.Handshake hs = new Noise.Handshake(initiator, identity);
    byte[] mine = Bytes.utf8(Json.str(hello == null ? Json.o() : hello));
    byte[] theirs;
    try {
      if (initiator) {
        writeFrame(out, hs.write(EMPTY));
        theirs = hs.read(readFrame(in));
        writeFrame(out, hs.write(mine));
      } else {
        hs.read(readFrame(in));
        writeFrame(out, hs.write(mine));
        theirs = hs.read(readFrame(in));
      }
    } catch (GeneralSecurityException | RuntimeException e) {
      try { s.close(); } catch (IOException ignored) {}
      throw new IOException("Saludo no válido: " + e.getMessage());
    } catch (IOException e) {
      try { s.close(); } catch (IOException ignored) {}
      throw new IOException(e instanceof java.net.SocketTimeoutException ? "El otro aparato no responde" : e instanceof EOFException ? "Conexión cerrada durante el saludo" : e.getMessage());
    }
    s.setSoTimeout(old);
    Conn c = new Conn(s, in, out, hs);
    try { String t = Bytes.str(theirs); if (t.length() > 0) c.hello = Json.obj(t); } catch (RuntimeException ignored) {}
    return c;
  }

  private void frame(byte[] pt, int off, int len) throws IOException {
    if (closed) throw new IOException("Conexión cerrada");
    byte[] ct = hs.send.encrypt(EMPTY, pt, off, len);
    writeFrame(out, ct);
  }

  public synchronized void json(Map<String, Object> m) throws IOException {
    byte[] j = Bytes.utf8(Json.str(m));
    byte[] pt = new byte[j.length + 1];
    System.arraycopy(j, 0, pt, 1, j.length);
    frame(pt, 0, pt.length);
  }
  /** Igual que json() pero sin lanzar error si ya está cerrado */
  public void tell(Map<String, Object> m) { try { json(m); } catch (IOException ignored) {} }

  /** Datos de un archivo; se trocean al tamaño máximo. Si la red va llena, espera (no se acumula en memoria). */
  public synchronized void data(int fid, byte[] buf, int off, int len) throws IOException {
    byte[] pt = new byte[5 + Math.min(len, CHUNK)];
    for (int p = 0; p < len; p += CHUNK) {
      int n = Math.min(CHUNK, len - p);
      pt[0] = 1; pt[1] = (byte) (fid >>> 24); pt[2] = (byte) (fid >>> 16); pt[3] = (byte) (fid >>> 8); pt[4] = (byte) fid;
      System.arraycopy(buf, off + p, pt, 5, n);
      frame(pt, 0, 5 + n);
    }
  }

  /** Lee el siguiente mensaje (bloquea). Si algo llega alterado, corta. */
  public Msg read() throws IOException {
    byte[] ct = readFrame(in);
    byte[] pt;
    try { pt = hs.recv.decrypt(EMPTY, ct); } catch (GeneralSecurityException e) { close(); throw new IOException("Mensaje alterado: se corta la conexión"); }
    Msg m = new Msg();
    if (pt.length >= 1 && pt[0] == 0) {
      try { m.json = Json.obj(Bytes.str(Arrays.copyOfRange(pt, 1, pt.length))); } catch (RuntimeException e) { close(); throw new IOException("Mensaje no válido"); }
    } else if (pt.length >= 5 && pt[0] == 1) {
      m.fid = ((pt[1] & 0xff) << 24) | ((pt[2] & 0xff) << 16) | ((pt[3] & 0xff) << 8) | (pt[4] & 0xff);
      m.data = Arrays.copyOfRange(pt, 5, pt.length);
    } else { close(); throw new IOException("Mensaje desconocido"); }
    return m;
  }

  public boolean closed() { return closed; }
  public void close() {
    if (closed) return;
    closed = true;
    try { sock.close(); } catch (IOException ignored) {}
    // las claves de la sesión fuera de la memoria
    hs.send.wipe(); hs.recv.wipe();
  }
}

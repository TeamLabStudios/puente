package com.teamlabstudios.puente.core;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;

/**
 * Cliente del relé (igual que electron/relay.cjs). El relé solo une dos conexiones que piden la misma «sala»
 * y pasa bytes cifrados que no puede abrir.
 * Al conectar: {"v":1,"room":"…","role":"listen"|"dial","key":"…"}\n  →  0x01 unidos · 0x00 no · 0x02 latido
 */
public final class Relay {
  private Relay() {}

  public interface Waiting { void on(Socket s); }

  public static Socket connect(String host, int port, String room, boolean listen, String key, int timeoutMs, Waiting onWaiting) throws IOException {
    Socket s = new Socket();
    try {
      s.connect(new InetSocketAddress(host, port), 8000);
    } catch (IOException e) {
      try { s.close(); } catch (IOException ignored) {}
      throw new IOException("No llego al relé (" + e.getMessage() + ")");
    }
    s.setTcpNoDelay(true);
    try {
      OutputStream out = s.getOutputStream();
      out.write(Bytes.utf8(Json.str(Json.o("v", 1, "room", room, "role", listen ? "listen" : "dial", "key", key == null ? "" : key)) + "\n"));
      out.flush();
      if (onWaiting != null) onWaiting.on(s);
      // esperando: el relé manda un latido cada 25 s; si en 70 s no llega nada, la conexión está muerta
      s.setSoTimeout(listen ? 70000 : timeoutMs);
      InputStream in = s.getInputStream();
      while (true) {
        int b = in.read();
        if (b == 2) continue;
        if (b == 1) break;
        if (b == -1) throw new IOException(listen ? "El relé cerró la espera" : "El otro aparato no está conectado al relé");
        throw new IOException("El relé no ha unido la conexión");
      }
      s.setSoTimeout(0);
      return s;
    } catch (SocketTimeoutException e) {
      try { s.close(); } catch (IOException ignored) {}
      throw new IOException(listen ? "El relé cerró la espera" : "El relé no responde");
    } catch (IOException e) {
      try { s.close(); } catch (IOException ignored) {}
      throw e;
    }
  }
}

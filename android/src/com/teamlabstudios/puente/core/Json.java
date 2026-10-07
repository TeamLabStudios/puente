package com.teamlabstudios.puente.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** JSON mínimo (sin librerías): objetos → Map, listas → List, números → Double. */
public final class Json {
  private final String s;
  private int i, depth;
  static final int MAX_DEPTH = 64; // JSON muy anidado: se rechaza (si no, desbordaría la pila)
  private Json(String s) { this.s = s; }

  public static Object parse(String text) {
    Json j = new Json(text);
    j.ws();
    Object v = j.value();
    j.ws();
    if (j.i != j.s.length()) throw new IllegalArgumentException("JSON con basura al final");
    return v;
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(String text) { return (Map<String, Object>) parse(text); }

  private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

  private Object value() {
    if (i >= s.length()) throw new IllegalArgumentException("JSON incompleto");
    char c = s.charAt(i);
    if (c == '{' || c == '[') {
      if (++depth > MAX_DEPTH) throw new IllegalArgumentException("JSON demasiado anidado");
      Object v = c == '{' ? object() : array();
      depth--;
      return v;
    }
    if (c == '"') return string();
    if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
    if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
    if (s.startsWith("null", i)) { i += 4; return null; }
    return number();
  }

  private Map<String, Object> object() {
    Map<String, Object> m = new LinkedHashMap<>();
    i++; ws();
    if (s.charAt(i) == '}') { i++; return m; }
    while (true) {
      ws(); String k = string(); ws();
      if (s.charAt(i++) != ':') throw new IllegalArgumentException("se esperaba :");
      ws(); m.put(k, value()); ws();
      char c = s.charAt(i++);
      if (c == '}') return m;
      if (c != ',') throw new IllegalArgumentException("se esperaba ,");
    }
  }

  private List<Object> array() {
    List<Object> l = new ArrayList<>();
    i++; ws();
    if (s.charAt(i) == ']') { i++; return l; }
    while (true) {
      ws(); l.add(value()); ws();
      char c = s.charAt(i++);
      if (c == ']') return l;
      if (c != ',') throw new IllegalArgumentException("se esperaba ,");
    }
  }

  private String string() {
    if (s.charAt(i) != '"') throw new IllegalArgumentException("se esperaba texto");
    i++;
    StringBuilder b = new StringBuilder();
    while (true) {
      char c = s.charAt(i++);
      if (c == '"') return b.toString();
      if (c == '\\') {
        char e = s.charAt(i++);
        switch (e) {
          case 'n': b.append('\n'); break;
          case 't': b.append('\t'); break;
          case 'r': b.append('\r'); break;
          case 'b': b.append('\b'); break;
          case 'f': b.append('\f'); break;
          case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
          default: b.append(e);
        }
      } else b.append(c);
    }
  }

  private Double number() {
    int st = i;
    while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
    if (st == i) throw new IllegalArgumentException("JSON no válido");
    return Double.valueOf(s.substring(st, i));
  }

  // ---------- escribir ----------
  public static String str(Object v) { StringBuilder b = new StringBuilder(); write(b, v); return b.toString(); }

  @SuppressWarnings("unchecked")
  private static void write(StringBuilder b, Object v) {
    if (v == null) b.append("null");
    else if (v instanceof String) quote(b, (String) v);
    else if (v instanceof Boolean) b.append(v.toString());
    else if (v instanceof Integer || v instanceof Long) b.append(v.toString());
    else if (v instanceof Number) { double d = ((Number) v).doubleValue(); if (d == Math.rint(d) && Math.abs(d) < 9e15) b.append((long) d); else b.append(d); }
    else if (v instanceof Map) {
      b.append('{'); boolean first = true;
      for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) { if (!first) b.append(','); first = false; quote(b, e.getKey()); b.append(':'); write(b, e.getValue()); }
      b.append('}');
    } else if (v instanceof List) {
      b.append('['); boolean first = true;
      for (Object o : (List<Object>) v) { if (!first) b.append(','); first = false; write(b, o); }
      b.append(']');
    } else quote(b, v.toString());
  }

  private static void quote(StringBuilder b, String s) {
    b.append('"');
    for (int k = 0; k < s.length(); k++) {
      char c = s.charAt(k);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
      }
    }
    b.append('"');
  }

  /** Pequeño constructor de objetos: Json.o("a", 1, "b", "x") */
  public static Map<String, Object> o(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int k = 0; k + 1 < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]);
    return m;
  }

  public static String s(Map<String, Object> m, String k) { Object v = m.get(k); return v == null ? null : v.toString(); }
  public static long l(Map<String, Object> m, String k) { Object v = m.get(k); return v instanceof Number ? ((Number) v).longValue() : 0; }
  public static boolean b(Map<String, Object> m, String k) { return Boolean.TRUE.equals(m.get(k)); }
}

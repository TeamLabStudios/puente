package com.teamlabstudios.puente;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * Para ver lo recibido en sesión privada sin sacarlo de la zona interna de la app:
 * solo lectura, solo archivos de la carpeta privada y solo con permiso puntual (no exportado).
 */
public class PrivateProvider extends ContentProvider {
  static final String AUTH = "com.teamlabstudios.puente.privado";

  static Uri uriFor(File root, File f) {
    String rel = root.toURI().relativize(f.toURI()).getPath();
    return new Uri.Builder().scheme("content").authority(AUTH).encodedPath("/" + Uri.encode(rel, "/")).build();
  }
  private File fileOf(Uri u) throws FileNotFoundException {
    File root = Puente.get(getContext()).engine.privateDir();
    File f = new File(root, u.getPath() == null ? "" : u.getPath());
    try {
      if (!f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator) || !f.isFile()) throw new FileNotFoundException("No existe (¿se borró ya?)");
    } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    return f;
  }

  @Override public boolean onCreate() { return true; }
  @Override public String getType(Uri uri) { return Puente.mime(uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment()); }
  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new SecurityException("Solo lectura");
    return ParcelFileDescriptor.open(fileOf(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }
  @Override public Cursor query(Uri uri, String[] p, String s, String[] a, String o) {
    try {
      File f = fileOf(uri);
      MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
      c.addRow(new Object[] { f.getName(), f.length() });
      return c;
    } catch (FileNotFoundException e) { return null; }
  }
  @Override public Uri insert(Uri uri, ContentValues v) { throw new UnsupportedOperationException(); }
  @Override public int delete(Uri uri, String s, String[] a) { return 0; }
  @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}

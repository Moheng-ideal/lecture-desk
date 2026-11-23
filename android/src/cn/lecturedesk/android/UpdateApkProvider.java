package cn.lecturedesk.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

public final class UpdateApkProvider extends ContentProvider {
    static final String MIME_TYPE = "application/vnd.android.package-archive";
    private static final String FILE_NAME = "lecture-desk-update.apk";

    static File apk(Context context) { return new File(context.getCacheDir(), FILE_NAME); }

    static Uri uri(Context context) {
        return Uri.parse("content://" + context.getPackageName() + ".updates/" + FILE_NAME);
    }

    @Override public boolean onCreate() { return true; }

    @Override public String getType(Uri requested) {
        return uri(getContext()).equals(requested) ? MIME_TYPE : null;
    }

    @Override public ParcelFileDescriptor openFile(Uri requested, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) || getType(requested) == null) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(apk(getContext()), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri requested, String[] projection, String selection, String[] args, String order) {
        if (getType(requested) == null) return null;
        String[] columns = projection == null ? new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE } : projection;
        MatrixCursor cursor = new MatrixCursor(columns);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) {
            if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(FILE_NAME);
            else if (OpenableColumns.SIZE.equals(column)) row.add(apk(getContext()).length());
            else row.add(null);
        }
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}

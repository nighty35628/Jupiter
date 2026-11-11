package dev.jupiter.mobile.qa;
import dev.jupiter.mobile.runtime.BoundedLines;

import java.io.Reader;
import java.io.StringReader;

public final class BoundedLinesTest {
  private static void check(boolean condition) { if (!condition) throw new AssertionError(); }
  public static void main(String[] args) throws Exception {
    BoundedLines normal = new BoundedLines(new StringReader("one\n\ntail"), 4);
    check(normal.next().text.equals("one")); check(normal.next().text.equals(""));
    check(normal.next().text.equals("tail")); check(normal.next() == null);
    // A generated 16 MiB line is drained without storing it, and the next frame survives.
    Reader huge = new Reader() {
      int position;
      final int size = 16 * 1024 * 1024;
      public int read(char[] chars, int offset, int length) {
        if (position > size + 3) return -1;
        int count = Math.min(length, size + 4 - position);
        for (int i = 0; i < count; i++, position++) chars[offset + i] = position < size ? 'x' : position == size ? '\n' : 'o';
        return count;
      }
      public void close() {}
    };
    BoundedLines bounded = new BoundedLines(huge, 16);
    BoundedLines.Line line = bounded.next(); check(line.truncated); check(line.text.length() == 16);
    line = bounded.next(); check(!line.truncated); check(line.text.equals("ooo")); check(bounded.next() == null);
    System.out.println("BoundedLines tests passed");
  }
}

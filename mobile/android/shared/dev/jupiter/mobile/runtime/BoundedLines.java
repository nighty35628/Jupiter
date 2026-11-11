package dev.jupiter.mobile.runtime;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;

/** Drains oversized child output without accumulating an unbounded line. */
public final class BoundedLines {
  public static final class Line {
    public final String text;
    public final boolean truncated;
    Line(String text, boolean truncated) { this.text = text; this.truncated = truncated; }
  }
  private final BufferedReader input;
  private final int limit;
  public BoundedLines(Reader input, int limit) {
    if (limit < 1) throw new IllegalArgumentException("Invalid line limit");
    this.input = new BufferedReader(input); this.limit = limit;
  }
  public Line next() throws IOException {
    StringBuilder value = new StringBuilder(); boolean truncated = false; boolean seen = false;
    for (int character; (character = input.read()) != -1;) {
      seen = true;
      if (character == '\n') return new Line(value.toString(), truncated);
      if (value.length() < limit) value.append((char)character); else truncated = true;
    }
    return !seen ? null : new Line(value.toString(), truncated);
  }
}

// The terminal, and only the terminal. The operator script runs in Karim's own Terminal, never in
// an agent session, which would put every live code into transcripts on disk and at the model
// provider (spec, "The money path"). So stdin must be a TTY, which is also what keeps a passphrase
// from being piped in; the passphrase is read with echo off, as bytes, and wiped after use; and
// the links are written to /dev/tty, so a shell that redirects stdout to a file or a pipe does not
// catch them.

import fs from 'node:fs';

export type Terminal = {
  // A line typed at the terminal. Secret: nothing echoes, and the bytes are the caller's to wipe.
  // Null when the person cancelled (Ctrl-C, or Ctrl-D on an empty line).
  ask(prompt: string, opts: { secret: boolean }): Promise<Buffer | null>;
  // Text for the terminal itself, never stdout.
  write(text: string): void;
};

const MAX_LINE = 1024;

/* One line from a raw-mode TTY. Enter ends it; Backspace drops the last character, whole, however
   many bytes it took; Ctrl-U clears it; an escape sequence (an arrow key) is skipped; any other
   control byte is ignored. The bytes collect in one fixed buffer that is wiped before return. */
export function readTerminalLine(
  input: NodeJS.ReadStream,
  output: (text: string) => void,
  prompt: string,
  secret: boolean,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const buf = Buffer.alloc(MAX_LINE);
    let len = 0;
    let escape = 0; // 0 outside an escape sequence, 1 after ESC, 2 inside CSI
    // Echo goes off before the prompt shows, so nothing typed the moment it appears is echoed.
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    output(prompt);
    input.resume();

    function finish(value: Buffer | null): void {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output('\n');
      buf.fill(0);
      resolve(value);
    }

    function onData(chunk: Buffer): void {
      for (const byte of chunk) {
        if (escape === 1) {
          escape = byte === 0x5b ? 2 : 0;
          continue;
        }
        if (escape === 2) {
          if (byte >= 0x40 && byte <= 0x7e) escape = 0;
          continue;
        }
        if (byte === 0x03 || (byte === 0x04 && len === 0)) {
          chunk.fill(0);
          finish(null);
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          const line = Buffer.from(buf.subarray(0, len));
          chunk.fill(0);
          finish(line);
          return;
        }
        if (byte === 0x1b) {
          escape = 1;
        } else if (byte === 0x7f || byte === 0x08) {
          if (len > 0) {
            let cut = len - 1;
            while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut -= 1;
            buf.fill(0, cut, len);
            if (!secret) output('\b \b');
            len = cut;
          }
        } else if (byte === 0x15) {
          if (!secret) output('\r' + ' '.repeat(prompt.length + len) + '\r' + prompt);
          buf.fill(0, 0, len);
          len = 0;
        } else if (byte >= 0x20 && len < MAX_LINE) {
          buf[len] = byte;
          len += 1;
          if (!secret && (byte & 0xc0) !== 0x80) output(byte < 0x80 ? String.fromCharCode(byte) : '*');
        }
      }
      chunk.fill(0);
    }

    input.on('data', onData);
  });
}

// The live terminal: stdin in raw mode for input, /dev/tty for output.
export function liveTerminal(): Terminal {
  const write = (text: string): void => {
    const fd = fs.openSync('/dev/tty', 'w');
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
  };
  return {
    ask: (prompt, opts) => readTerminalLine(process.stdin, write, prompt, opts.secret),
    write,
  };
}

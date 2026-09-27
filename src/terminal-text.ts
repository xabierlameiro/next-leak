import { stripVTControlCharacters } from "node:util";

// Everything in C0 except tab and line feed, then DEL and the C1 block.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Text as it can be written to a terminal.
 *
 * Heap node names, source paths, route names and the build's own output all
 * come from the measured app, and a terminal obeys what it is sent: an escape
 * sequence in a string name can clear the screen, move the cursor over a
 * verdict already printed, or retitle the window. next-leak writes no
 * sequences of its own, so none that reaches the output is ours to keep.
 *
 * A complete sequence is an instruction, not text, and is dropped. A control
 * character left on its own is shown as `\xNN`: it was in the value, and a
 * reader comparing the report against `run.json` should still find it.
 */
export function terminalSafe(text: string): string {
  return stripVTControlCharacters(text.replaceAll("\r\n", "\n")).replaceAll(
    CONTROL_CHARACTER,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
}

// key/code -> Windows virtual key code, so the remote page's keyCode-based
// handlers and the browser's own shortcut handling fire correctly. US layout.
// NAMED is keyed by physical `code` (layout-invariant), NOT by `key`: a shifted
// symbol like `:` arrives as code "Semicolon" / key ":", and keying by the
// unshifted char would miss it and resolve to vk 0.
const NAMED: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, ShiftLeft: 16, ShiftRight: 16,
  Control: 17, ControlLeft: 17, ControlRight: 17, Alt: 18, AltLeft: 18, AltRight: 18,
  Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  Meta: 91, MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119,
  F9: 120, F10: 121, F11: 122, F12: 123,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192,
  BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
};

// Fallback for the rare key-only path (no `code` supplied): the UNSHIFTED punctuation
// chars and the named keys whose `key` equals their `code`.
const BY_KEY: Record<string, number> = {
  ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192,
  "[": 219, "\\": 220, "]": 221, "'": 222,
};

export function virtualKeyCode(key?: string, code?: string): number {
  if (code) {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);        // KeyA -> 65
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);      // Digit0 -> 48
    if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6)); // Numpad0 -> 96
    const byCode = NAMED[code];
    if (byCode !== undefined) return byCode;
  }
  if (key) {
    if (key.length === 1) {
      const cc = key.toUpperCase().charCodeAt(0);
      if ((cc >= 65 && cc <= 90) || (cc >= 48 && cc <= 57)) return cc;
    }
    const byKey = NAMED[key] ?? BY_KEY[key];
    if (byKey !== undefined) return byKey;
  }
  return 0;
}

import { CURSOR_MARKER, decodeKittyPrintable } from "@earendil-works/pi-tui";

interface TuiRenderTarget {
  requestRender(): void;
}

interface KeyMatcher {
  matches(data: string, action: string): boolean;
}

interface SecretInputTheme {
  fg(color: "accent" | "dim" | "muted" | "text", text: string): string;
}

/** A deliberately tiny password editor: no history, undo stack, kill ring, or plaintext render. */
export class MaskedSecretInput {
  readonly #tui: TuiRenderTarget;
  readonly #theme: SecretInputTheme;
  readonly #keybindings: KeyMatcher;
  readonly #done: (value: string | undefined) => void;
  #value = "";
  #paste = "";
  #pasting = false;
  #settled = false;

  constructor(
    tui: TuiRenderTarget,
    theme: SecretInputTheme,
    keybindings: KeyMatcher,
    done: (value: string | undefined) => void,
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keybindings = keybindings;
    this.#done = done;
  }

  render(): string[] {
    const masked = "•".repeat(Math.min(32, Math.max(1, this.#value.length)));
    return [
      this.#theme.fg("accent", "SiliconFlow API Key"),
      "",
      `${this.#theme.fg("text", this.#value.length === 0 ? "" : masked)}${CURSOR_MARKER}`,
      "",
      this.#theme.fg("muted", "Enter Save   Esc Cancel"),
    ];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.#settled) return;
    if (data.includes("\u001b[200~")) {
      this.#pasting = true;
      this.#paste = "";
      data = data.replace("\u001b[200~", "");
    }
    if (this.#pasting) {
      this.#paste += data;
      const end = this.#paste.indexOf("\u001b[201~");
      if (end === -1) return;
      this.#append(this.#paste.slice(0, end));
      const remaining = this.#paste.slice(end + 6);
      this.#paste = "";
      this.#pasting = false;
      if (remaining !== "") this.handleInput(remaining);
      this.#tui.requestRender();
      return;
    }
    if (this.#keybindings.matches(data, "tui.select.cancel")) {
      this.#settled = true;
      this.#value = "";
      this.#paste = "";
      this.#done(undefined);
      return;
    }
    if (this.#keybindings.matches(data, "tui.input.submit") || data === "\n") {
      const submitted = this.#value.trim();
      this.#settled = true;
      this.#value = "";
      this.#paste = "";
      this.#done(submitted === "" ? undefined : submitted);
      return;
    }
    if (this.#keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.#value = [...this.#value].slice(0, -1).join("");
      this.#tui.requestRender();
      return;
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (![...printable].some((character) => character.charCodeAt(0) < 32)) {
      this.#append(printable);
      this.#tui.requestRender();
    }
  }

  dispose(): void {
    this.#value = "";
    this.#paste = "";
  }

  #append(value: string): void {
    this.#value += [...value]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join("")
      .slice(0, 16_384);
  }
}

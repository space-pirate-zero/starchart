/** Minimal XML property list parser (dict, array, string, integer, real, true/false, date, data). */

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

interface Token {
  kind: "open" | "close" | "empty" | "text";
  name: string;
  text: string;
  offset: number;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

function tokenize(xml: string): Token[] {
  const cleaned = xml
    .replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length))
    .replace(/<\?[\s\S]*?\?>/g, (m) => " ".repeat(m.length))
    .replace(/<!DOCTYPE[\s\S]*?>/gi, (m) => " ".repeat(m.length));
  const tokens: Token[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)(?:\s[^>]*?)?(\/?)>/g;
  let last = 0;
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
    const text = cleaned.slice(last, m.index);
    if (text) tokens.push({ kind: "text", name: "", text: decode(text), offset: last });
    const name = m[2]!;
    const kind = m[1] ? "close" : m[3] ? "empty" : "open";
    tokens.push({ kind, name, text: "", offset: m.index });
    last = re.lastIndex;
  }
  if (cleaned.slice(last).trim()) throw new Error(`unexpected text after the last tag at offset ${last}`);
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private skipWhitespace(): void {
    while (this.tokens[this.pos]?.kind === "text" && !this.tokens[this.pos]!.text.trim()) this.pos++;
  }

  private next(): Token {
    this.skipWhitespace();
    const t = this.tokens[this.pos++];
    if (!t) throw new Error("unexpected end of document");
    return t;
  }

  private peek(): Token | undefined {
    this.skipWhitespace();
    return this.tokens[this.pos];
  }

  private expectClose(name: string): void {
    const t = this.next();
    if (t.kind !== "close" || t.name !== name) throw new Error(`expected </${name}> at offset ${t.offset}`);
  }

  /** Raw text content up to the closing tag (whitespace preserved for <string>). */
  private textUntil(name: string): string {
    let text = "";
    for (;;) {
      const t = this.tokens[this.pos++];
      if (!t) throw new Error(`unterminated <${name}>`);
      if (t.kind === "text") text += t.text;
      else if (t.kind === "close" && t.name === name) return text;
      else throw new Error(`unexpected <${t.name}> inside <${name}> at offset ${t.offset}`);
    }
  }

  document(): PlistValue {
    const root = this.next();
    if (root.kind === "open" && root.name === "plist") {
      const value = this.value();
      this.expectClose("plist");
      return value;
    }
    this.pos--;
    return this.value();
  }

  value(): PlistValue {
    const t = this.next();
    if (t.kind === "empty") {
      switch (t.name) {
        case "true":
          return true;
        case "false":
          return false;
        case "string":
        case "data":
        case "date":
          return "";
        case "dict":
          return {};
        case "array":
          return [];
        default:
          throw new Error(`unknown element <${t.name}/> at offset ${t.offset}`);
      }
    }
    if (t.kind !== "open") throw new Error(`expected a value at offset ${t.offset}`);
    switch (t.name) {
      case "dict":
        return this.dict();
      case "array":
        return this.array();
      case "string":
        return this.textUntil("string");
      case "date":
      case "data":
        return this.textUntil(t.name).trim();
      case "integer":
      case "real": {
        const raw = this.textUntil(t.name).trim();
        const n = Number(raw);
        if (raw === "" || !Number.isFinite(n)) throw new Error(`invalid <${t.name}> "${raw}" at offset ${t.offset}`);
        return n;
      }
      case "true":
      case "false":
        this.expectClose(t.name);
        return t.name === "true";
      default:
        throw new Error(`unknown element <${t.name}> at offset ${t.offset}`);
    }
  }

  private dict(): Record<string, PlistValue> {
    const out: Record<string, PlistValue> = {};
    for (;;) {
      const t = this.peek();
      if (t?.kind === "close" && t.name === "dict") {
        this.pos++;
        return out;
      }
      const key = this.next();
      if (key.kind !== "open" || key.name !== "key") throw new Error(`expected <key> in <dict> at offset ${key.offset}`);
      const name = this.textUntil("key").trim();
      out[name] = this.value();
    }
  }

  private array(): PlistValue[] {
    const out: PlistValue[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.kind === "close" && t.name === "array") {
        this.pos++;
        return out;
      }
      out.push(this.value());
    }
  }
}

/** Parses an XML plist document. Throws with an offset on malformed input. */
export function parsePlist(xml: string): PlistValue {
  const tokens = tokenize(xml);
  if (!tokens.some((t) => t.kind !== "text")) throw new Error("not a property list");
  return new Parser(tokens).document();
}

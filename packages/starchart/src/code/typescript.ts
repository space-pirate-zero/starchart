import ts from "typescript";
import { EVENT_FUNCS, FLAG_FUNCS, isEnvName, isSignalKey } from "./signals.js";
import type { AnnotationComment, I18nRef, ParsedFile, ScreenDecl, Signal, SourceFile, SymbolDecl } from "./types.js";
import { computeLineStarts, hashText, lineAt, sha16, type LiteralValue } from "./util.js";

export interface TsImportBinding {
  local: string;
  /** Imported name, "default", or "*" for namespace imports. */
  imported: string;
}

export interface TsImport {
  spec: string;
  bindings: TsImportBinding[];
  line: number;
}

export interface TsExportEntry {
  /** Local binding name (a top-level declaration or an import). */
  local?: string;
  /** Re-export source specifier. */
  from?: string;
  /** Name imported from `from` ("*" for `export * as ns`). */
  imported?: string;
}

export interface TsLocalRef {
  from: string;
  name: string;
  member?: string;
}

export interface TsParsed extends ParsedFile {
  lang: "ts";
  imports: TsImport[];
  exports: Map<string, TsExportEntry>;
  starExports: string[];
  /** Top-level declaration name -> symbol id. */
  topLevel: Map<string, string>;
  /** Symbol id -> member name -> member symbol id. */
  members: Map<string, Map<string, string>>;
  localRefs: TsLocalRef[];
}

const JS_EXT = /\.(?:js|mjs|cjs)$/;

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (JS_EXT.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** File path without its extension, as used in TS symbol ids. */
export function stripTsExtension(rel: string): string {
  return rel.replace(/\.d\.ts$/, "").replace(/\.(?:tsx?|jsx?|mjs|cjs|mts|cts|mdx)$/, "");
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === kind) ?? false;
}

function propName(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Literal value of an initializer, or undefined when it is not a pure literal. */
export function tsLiteral(expr: ts.Expression): LiteralValue | undefined {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) {
    const n = Number(e.text.replace(/_/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
    const n = Number(e.operand.text.replace(/_/g, ""));
    return Number.isFinite(n) ? -n : undefined;
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(e)) {
    const out: LiteralValue[] = [];
    for (const el of e.elements) {
      if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return undefined;
      const v = tsLiteral(el);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, LiteralValue> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const key = propName(p.name);
      if (key === undefined) return undefined;
      const v = tsLiteral(p.initializer);
      if (v === undefined) return undefined;
      out[key] = v;
    }
    return out;
  }
  return undefined;
}

function stringArg(call: ts.CallExpression, index = 0): string | undefined {
  const arg = call.arguments[index];
  if (!arg) return undefined;
  const e = unwrap(arg);
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined;
}

/** The final name of a callee: `track` in `track()`, `posthog.capture()`, `a?.b.track()`. */
function calleeName(expr: ts.Expression): string | undefined {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

function calleeBase(expr: ts.Expression): string | undefined {
  let e = unwrap(expr);
  while (ts.isPropertyAccessExpression(e)) e = unwrap(e.expression);
  return ts.isIdentifier(e) ? e.text : undefined;
}

/** Identifier positions that are declarations or property names rather than references. */
function isReferenceIdentifier(node: ts.Identifier): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p)) return p.expression === node;
  if (ts.isQualifiedName(p)) return p.left === node;
  if (ts.isBindingElement(p)) return p.initializer === node;
  if (ts.isMetaProperty(p)) return false;
  if (ts.isShorthandPropertyAssignment(p)) return true;
  if (
    ts.isPropertyAssignment(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isEnumMember(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isTypeParameterDeclaration(p) ||
    ts.isModuleDeclaration(p) ||
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isNamespaceExport(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p) ||
    ts.isJsxAttribute(p) ||
    ts.isImportEqualsDeclaration(p)
  ) {
    return (p as unknown as { name?: ts.Node }).name !== node;
  }
  return true;
}

export function parseTypeScript(file: SourceFile, text: string, generated: boolean): TsParsed {
  const sf = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true, scriptKind(file.path));
  const starts = computeLineStarts(text);
  const lineOf = (pos: number) => lineAt(starts, pos);
  const base = `symbol:${file.scope}/${stripTsExtension(file.rel)}#`;

  const symbols: SymbolDecl[] = [];
  const symbolIds = new Set<string>();
  const imports: TsImport[] = [];
  const exports = new Map<string, TsExportEntry>();
  const starExports: string[] = [];
  const topLevel = new Map<string, string>();
  const members = new Map<string, Map<string, string>>();
  const localRefs: TsLocalRef[] = [];
  const signals: Signal[] = [];
  const i18nRefs: I18nRef[] = [];
  const nodeOwner = new Map<ts.Node, string>();
  const bodies: { node: ts.Node; id: string | undefined }[] = [];

  const addSymbol = (node: ts.Node, qname: string, name: string, kind: string, extra: Partial<SymbolDecl> = {}): string => {
    const id = base + qname;
    const decl: SymbolDecl = {
      id,
      name,
      qname,
      kind,
      line: lineOf(node.getStart(sf)),
      endLine: lineOf(node.end),
      depth: qname.includes(".") ? 1 : 0,
      hash: hashText(node.getText(sf)),
      ...extra,
    };
    if (symbolIds.has(id)) {
      const existing = symbols.find((s) => s.id === id)!;
      existing.ranges = [...(existing.ranges ?? [[existing.line, existing.endLine]]), [decl.line, decl.endLine]];
      existing.hash = sha16(existing.hash + decl.hash);
      return id;
    }
    symbolIds.add(id);
    symbols.push(decl);
    return id;
  };

  const addMember = (owner: string, ownerName: string, node: ts.Node, name: string, kind: string, value?: LiteralValue, isStatic?: boolean) => {
    const id = addSymbol(node, `${ownerName}.${name}`, name, kind, { parent: owner, value, isStatic });
    let map = members.get(owner);
    if (!map) {
      map = new Map();
      members.set(owner, map);
    }
    map.set(name, id);
    nodeOwner.set(node, id);
    return id;
  };

  // Pass 1: imports, exports and top-level declarations.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const bindings: TsImportBinding[] = [];
      const clause = stmt.importClause;
      if (clause?.name) bindings.push({ local: clause.name.text, imported: "default" });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ local: nb.name.text, imported: "*" });
      else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) bindings.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text });
      }
      imports.push({ spec: stmt.moduleSpecifier.text, bindings, line: lineOf(stmt.getStart(sf)) });
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference) && ts.isStringLiteral(stmt.moduleReference.expression)) {
      imports.push({ spec: stmt.moduleReference.expression.text, bindings: [{ local: stmt.name.text, imported: "*" }], line: lineOf(stmt.getStart(sf)) });
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
      if (spec) imports.push({ spec, bindings: [], line: lineOf(stmt.getStart(sf)) });
      const clause = stmt.exportClause;
      if (!clause) {
        if (spec) starExports.push(spec);
      } else if (ts.isNamespaceExport(clause)) {
        if (spec) exports.set(clause.name.text, { from: spec, imported: "*" });
      } else {
        for (const el of clause.elements) {
          const imported = (el.propertyName ?? el.name).text;
          exports.set(el.name.text, spec ? { from: spec, imported } : { local: imported });
        }
      }
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      const e = unwrap(stmt.expression);
      if (ts.isIdentifier(e)) exports.set("default", { local: e.text });
      else {
        const id = addSymbol(stmt, "default", "default", "default", { exported: true, value: tsLiteral(stmt.expression) });
        topLevel.set("default", id);
        exports.set("default", { local: "default" });
        bodies.push({ node: stmt.expression, id });
      }
      continue;
    }

    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
    const declare = (name: string, id: string) => {
      topLevel.set(name, id);
      if (exported && isDefault) exports.set("default", { local: name });
      else if (exported) exports.set(name, { local: name });
    };

    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      const name = stmt.name?.text ?? (isDefault ? "default" : undefined);
      if (!name) continue;
      const kind = ts.isFunctionDeclaration(stmt) ? "function" : "class";
      const id = addSymbol(stmt, name, name, kind, { exported: exported || undefined, isType: kind === "class" || undefined });
      declare(name, id);
      nodeOwner.set(stmt, id);
      bodies.push({ node: stmt, id });
      if (ts.isClassDeclaration(stmt)) {
        for (const m of stmt.members) {
          const mName = ts.isConstructorDeclaration(m) ? "constructor" : propName(m.name);
          if (!mName) continue;
          const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword);
          let value: LiteralValue | undefined;
          if (ts.isPropertyDeclaration(m) && m.initializer && hasModifier(m, ts.SyntaxKind.ReadonlyKeyword)) value = tsLiteral(m.initializer);
          const kindName = ts.isMethodDeclaration(m) ? "method" : ts.isConstructorDeclaration(m) ? "constructor" : ts.isPropertyDeclaration(m) ? "property" : "accessor";
          addMember(id, name, m, mName, kindName, value, isStatic || undefined);
        }
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isModuleDeclaration(stmt)) {
      const name = propName(stmt.name as ts.PropertyName);
      if (!name) continue;
      const kind = ts.isInterfaceDeclaration(stmt) ? "interface" : ts.isTypeAliasDeclaration(stmt) ? "type" : "namespace";
      const id = addSymbol(stmt, name, name, kind, { exported: exported || undefined, isType: true });
      declare(name, id);
      bodies.push({ node: stmt, id });
      continue;
    }
    if (ts.isEnumDeclaration(stmt)) {
      const name = stmt.name.text;
      const id = addSymbol(stmt, name, name, "enum", { exported: exported || undefined, isType: true });
      declare(name, id);
      bodies.push({ node: stmt, id });
      let next: number | undefined = 0;
      for (const m of stmt.members) {
        const mName = propName(m.name);
        if (!mName) continue;
        let value: LiteralValue | undefined;
        if (m.initializer) {
          value = tsLiteral(m.initializer);
          next = typeof value === "number" ? value + 1 : undefined;
        } else if (next !== undefined) {
          value = next;
          next++;
        }
        addMember(id, name, m, mName, "member", value, true);
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const single = stmt.declarationList.declarations.length === 1;
      for (const d of stmt.declarationList.declarations) {
        const rangeNode = single ? stmt : d;
        if (ts.isIdentifier(d.name)) {
          const name = d.name.text;
          const value = isConst && d.initializer ? tsLiteral(d.initializer) : undefined;
          const id = addSymbol(rangeNode, name, name, isConst ? "const" : "variable", { exported: exported || undefined, value });
          declare(name, id);
          nodeOwner.set(d, id);
          bodies.push({ node: d, id });
          const init = d.initializer ? unwrap(d.initializer) : undefined;
          if (init && ts.isObjectLiteralExpression(init)) {
            for (const p of init.properties) {
              if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p))) continue;
              const pName = propName(p.name);
              if (!pName) continue;
              const pValue = isConst && ts.isPropertyAssignment(p) ? tsLiteral(p.initializer) : undefined;
              addMember(id, name, p, pName, "property", pValue, true);
            }
          }
        } else {
          let first: string | undefined;
          for (const el of bindingNames(d.name)) {
            const id = addSymbol(rangeNode, el, el, isConst ? "const" : "variable", { exported: exported || undefined });
            declare(el, id);
            first ??= id;
          }
          bodies.push({ node: d, id: first });
        }
      }
      continue;
    }
    bodies.push({ node: stmt, id: undefined });
  }

  const known = new Set<string>([...topLevel.keys(), ...imports.flatMap((i) => i.bindings.map((b) => b.local))]);
  const tNamespaces = new Map<string, string>();

  const addI18n = (key: string, from: string | undefined, line: number, ns?: string) => {
    const full = ns ? `${ns}.${key}` : key;
    i18nRefs.push({ key: full, from, line });
    if (!ns && key.includes(":")) i18nRefs.push({ key: key.slice(key.indexOf(":") + 1), from, line });
  };

  // Pass 2: references and signals inside every top-level statement.
  const visit = (node: ts.Node, from: string | undefined): void => {
    const own = nodeOwner.get(node);
    if (own) from = own;
    const line = () => lineOf(node.getStart(sf));

    if (ts.isIdentifier(node)) {
      if (from && known.has(node.text) && isReferenceIdentifier(node)) localRefs.push({ from, name: node.text });
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const env = envName(node);
      if (env) {
        if (isEnvName(env)) signals.push({ kind: "env", name: env, from, line: line() });
        return;
      }
      const e = node.expression;
      if (ts.isIdentifier(e) && known.has(e.text)) {
        if (from) localRefs.push({ from, name: e.text, member: node.name.text });
        return;
      }
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && known.has(node.left.text)) {
      if (from) localRefs.push({ from, name: node.left.text, member: node.right.text });
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = unwrap(node.argumentExpression);
      if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && isEnvObject(node.expression)) {
        if (isEnvName(arg.text)) signals.push({ kind: "env", name: arg.text, from, line: line() });
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(ts.isAwaitExpression(unwrap(node.initializer)) ? (unwrap(node.initializer) as ts.AwaitExpression).expression : node.initializer);
      if (ts.isIdentifier(node.name) && ts.isCallExpression(init)) {
        const cn = calleeName(init.expression);
        if (cn === "useTranslations" || cn === "getTranslations") {
          const first = init.arguments[0] ? unwrap(init.arguments[0]) : undefined;
          let ns: string | undefined;
          if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) ns = first.text;
          else if (first && ts.isObjectLiteralExpression(first)) {
            for (const p of first.properties) {
              if (ts.isPropertyAssignment(p) && propName(p.name) === "namespace") {
                const v = tsLiteral(p.initializer);
                if (typeof v === "string") ns = v;
              }
            }
          }
          tNamespaces.set(node.name.text, ns ?? "");
        }
      }
      if (ts.isObjectBindingPattern(node.name) && isEnvObject(init)) {
        for (const el of node.name.elements) {
          const key = propName(el.propertyName ?? el.name);
          if (key && isEnvName(key)) signals.push({ kind: "env", name: key, from, line: line() });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const cn = calleeName(node.expression);
      if (cn) {
        if (FLAG_FUNCS.has(cn)) {
          const key = stringArg(node);
          if (key !== undefined && isSignalKey(key)) signals.push({ kind: "flag", name: key, from, line: line() });
        } else if (EVENT_FUNCS.has(cn)) {
          const name = stringArg(node);
          if (name !== undefined && isSignalKey(name)) signals.push({ kind: "event", name, from, line: line() });
        }
        const baseName = calleeBase(node.expression);
        const isT =
          (ts.isIdentifier(unwrap(node.expression)) && (cn === "t" || cn === "$t" || tNamespaces.has(cn))) ||
          (ts.isPropertyAccessExpression(unwrap(node.expression)) &&
            ((cn === "t" && (baseName === "i18n" || baseName === "i18next")) || (baseName !== undefined && tNamespaces.has(baseName) && ["rich", "markup", "raw", "has"].includes(cn))));
        if (isT) {
          const key = stringArg(node);
          const nsName = ts.isIdentifier(unwrap(node.expression)) ? cn : baseName;
          const ns = nsName ? tNamespaces.get(nsName) : undefined;
          if (key) addI18n(key, from, line(), ns || undefined);
        }
        if (cn === "formatMessage") {
          const first = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
          if (first && ts.isObjectLiteralExpression(first)) {
            for (const p of first.properties) {
              if (ts.isPropertyAssignment(p) && propName(p.name) === "id") {
                const v = tsLiteral(p.initializer);
                if (typeof v === "string") addI18n(v, from, line());
              }
            }
          }
        }
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const attr = ts.isIdentifier(node.name) ? node.name.text : undefined;
      const init = node.initializer;
      const value = ts.isStringLiteral(init) ? init.text : undefined;
      if (value !== undefined) {
        const tag = node.parent.parent;
        const tagName = ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag) ? tag.tagName.getText(sf) : "";
        if (attr === "i18nKey" || (attr === "id" && tagName === "FormattedMessage")) addI18n(value, from, line());
      }
    }
    ts.forEachChild(node, (c) => visit(c, from));
  };
  for (const b of bodies) visit(b.node, b.id);

  const hasAnnotations = text.includes("@starchart");
  const { annotations, codeLines } = hasAnnotations ? tsAnnotations(sf, text, starts) : { annotations: [], codeLines: new Set<number>() };
  const screens: ScreenDecl[] = [];

  return {
    file,
    lang: "ts",
    hash: sha16(text),
    generated,
    symbols,
    signals,
    i18nRefs,
    annotations,
    codeLines,
    screens,
    imports,
    exports,
    starExports,
    topLevel,
    members,
    localRefs,
  };
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    out.push(...bindingNames(el.name));
  }
  return out;
}

/** `process.env` or `import.meta.env`. */
function isEnvObject(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== "env") return false;
  const obj = unwrap(e.expression);
  if (ts.isIdentifier(obj) && obj.text === "process") return true;
  return ts.isMetaProperty(obj) && obj.keywordToken === ts.SyntaxKind.ImportKeyword && obj.name.text === "meta";
}

function envName(node: ts.PropertyAccessExpression): string | undefined {
  return isEnvObject(node.expression) ? node.name.text : undefined;
}

/** Every comment in the file that carries `@starchart`, plus the set of lines holding code. */
function tsAnnotations(sf: ts.SourceFile, text: string, starts: number[]): { annotations: AnnotationComment[]; codeLines: Set<number> } {
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (list: ts.CommentRange[] | undefined) => {
    for (const r of list ?? []) ranges.set(r.pos, r);
  };
  const visit = (node: ts.Node) => {
    if (node.kind !== ts.SyntaxKind.JsxText) {
      collect(ts.getLeadingCommentRanges(text, node.pos));
      collect(ts.getTrailingCommentRanges(text, node.end));
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  const sorted = [...ranges.values()].sort((a, b) => a.pos - b.pos);

  // blank out comments to find code lines
  const chars = text.split("");
  for (const r of sorted) for (let i = r.pos; i < r.end; i++) if (chars[i] !== "\n") chars[i] = " ";
  const blanked = chars.join("");
  const codeLines = new Set<number>();
  const lines = blanked.split("\n");
  lines.forEach((l, i) => {
    if (l.trim().length > 0) codeLines.add(i + 1);
  });

  const annotations: AnnotationComment[] = [];
  for (const r of sorted) {
    const body = text.slice(r.pos, r.end);
    if (!body.includes("@starchart")) continue;
    const line = lineAt(starts, r.pos);
    const lineStart = starts[line - 1]!;
    annotations.push({
      text: body,
      line,
      endLine: lineAt(starts, Math.max(r.pos, r.end - 1)),
      trailing: blanked.slice(lineStart, r.pos).trim().length > 0,
    });
  }
  return { annotations, codeLines };
}

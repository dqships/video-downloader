// A minimal XML reader for DASH manifests. Service workers have no DOMParser,
// and an MPD only needs elements, attributes and short text (BaseURL).

export interface XmlElement {
  /** Local name, without any namespace prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1);

/** Parses a document and returns its root element. Throws on broken markup. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i) stack[stack.length - 1]!.text += decode(xml.slice(i, textEnd));
    if (lt < 0) break;

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new Error("Unclosed XML comment");
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new Error("Unclosed CDATA section");
      stack[stack.length - 1]!.text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new Error("Unclosed XML declaration");
      i = end + 1;
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt);
      if (end < 0) throw new Error("Unclosed end tag");
      const name = localName(xml.slice(lt + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name || stack.length === 0) throw new Error(`Unexpected </${name}>`);
      i = end + 1;
    } else {
      // Start tag: name, then attributes up to > or />, honouring quotes.
      const tag = /^<([^\s/>]+)/.exec(xml.slice(lt, lt + 256));
      if (!tag) throw new Error("Broken start tag");
      const el: XmlElement = { name: localName(tag[1]!), attrs: {}, children: [], text: "" };
      const attrRe = /\s*([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?)>/y;
      attrRe.lastIndex = lt + tag[0].length;
      let closed = false;
      let selfClosing = false;
      for (;;) {
        const m = attrRe.exec(xml);
        if (!m) throw new Error(`Broken attributes in <${el.name}>`);
        if (m[1] !== undefined) {
          el.attrs[localName(m[1])] = decode(m[3] ?? m[4] ?? "");
        } else {
          closed = true;
          selfClosing = m[5] === "/";
        }
        if (closed) break;
      }
      i = attrRe.lastIndex;
      stack[stack.length - 1]!.children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1]!.name}>`);
  const top = root.children[0];
  if (!top) throw new Error("Empty XML document");
  return top;
}

export const child = (el: XmlElement | undefined, name: string) => el?.children.find((c) => c.name === name);
export const childrenNamed = (el: XmlElement | undefined, name: string) => el?.children.filter((c) => c.name === name) ?? [];

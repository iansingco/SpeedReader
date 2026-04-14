import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";

// ── helpers ───────────────────────────────────────────────────────────────────

export function tokenize(text) {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

export function highlightWord(word) {
  if (word.length <= 1) return { bold: word, post: "" };
  const pivot = Math.max(1, Math.round(word.length * 0.4));
  return { bold: word.slice(0, pivot), post: word.slice(pivot) };
}

export function makeBookId(filename) {
  return filename.replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

async function loadBuffer(uri) {
  if (Platform.OS === "web") {
    return (await fetch(uri)).arrayBuffer();
  }
  const b64  = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const bin  = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ── PDF ───────────────────────────────────────────────────────────────────────

async function parsePDF(uri) {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const data = await (await fetch(uri)).arrayBuffer();
  const pdf  = await pdfjsLib.getDocument({ data }).promise;

  // Metadata
  let title = "", author = "";
  try {
    const info = (await pdf.getMetadata())?.info;
    title  = info?.Title  || "";
    author = info?.Author || "";
  } catch {}

  // Cover — render page 1 to canvas (web only)
  let coverDataUrl = null;
  try {
    const page     = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    coverDataUrl = canvas.toDataURL("image/jpeg", 0.7);
  } catch {}

  // Text
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(" "));
  }

  return { text: pages.join("\n"), meta: { title, author, coverDataUrl }, annotations: {} };
}

// ── EPUB ──────────────────────────────────────────────────────────────────────

async function parseEPUB(uri) {
  const { default: JSZip } = await import("jszip");
  const buffer = await loadBuffer(uri);
  const zip    = await JSZip.loadAsync(buffer);

  // OPF location
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid EPUB file.");
  const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error("Malformed EPUB: no OPF path.");
  const opfDir = opfPath.includes("/")
    ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1)
    : "";
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) throw new Error("Cannot read EPUB package.");

  // Metadata
  const title  = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i)?.[1]?.trim()   || "";
  const author = opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i)?.[1]?.trim() || "";

  // Cover image
  let coverDataUrl = null;
  const coverId   = opf.match(/<meta\s+name="cover"\s+content="([^"]+)"/i)?.[1];
  let   coverHref = null;
  for (const item of [...opf.matchAll(/<item\s[^>]*>/gi)].map(m => m[0])) {
    const itemId     = item.match(/\bid="([^"]+)"/)?.[1];
    const href       = item.match(/\bhref="([^"]+)"/)?.[1];
    const mediaType  = item.match(/\bmedia-type="([^"]+)"/)?.[1];
    const properties = item.match(/\bproperties="([^"]+)"/)?.[1];
    if (!href || !mediaType?.startsWith("image/")) continue;
    if (
      (coverId && itemId === coverId) ||
      properties?.includes("cover-image") ||
      href.toLowerCase().includes("cover")
    ) { coverHref = href; break; }
  }
  if (coverHref) {
    const f = zip.file(opfDir + coverHref) ?? zip.file(coverHref);
    if (f) {
      const b64  = await f.async("base64");
      const ext  = coverHref.split(".").pop().toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
      coverDataUrl = `data:${mime};base64,${b64}`;
    }
  }

  // Spine
  const manifest = Object.fromEntries(
    [...opf.matchAll(/<item\s[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/gi)].map(m => [m[1], m[2]])
  );
  const spine = [...opf.matchAll(/<itemref\s[^>]*\bidref="([^"]+)"/gi)]
    .map(m => manifest[m[1]])
    .filter(Boolean);

  // First pass — collect footnote/endnote content by id
  const footnoteContent = {};
  for (const href of spine) {
    const html = await (zip.file(opfDir + href) ?? zip.file(href))?.async("string");
    if (!html) continue;
    // Match elements that are likely footnote containers
    const idRx = /<(?:aside|li|div|p|section)[^>]+\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:aside|li|div|p|section)>/gi;
    let m;
    while ((m = idRx.exec(html)) !== null) {
      const text = htmlToText(m[2]);
      if (text && text.length > 0 && text.length < 2000)
        footnoteContent[m[1]] = text;
    }
  }

  // Second pass — extract text and map noterefs to approximate word indices
  const parts       = [];
  const annotations = {};
  let   globalWords = 0;

  for (const href of spine) {
    const html = await (zip.file(opfDir + href) ?? zip.file(href))?.async("string");
    if (!html) continue;

    // Find noteref anchors: <a href="#fn1" epub:type="noteref"> or href="#fn1" in <sup>
    const noterefs = [
      ...html.matchAll(/<a[^>]+href="#([^"]+)"[^>]*epub:type="noteref"[^>]*>[\s\S]*?<\/a>/gi),
      ...html.matchAll(/<sup[^>]*>\s*<a[^>]+href="#([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<\/sup>/gi),
    ];

    for (const ref of noterefs) {
      const refId    = ref[1];
      const refPos   = ref.index;
      const textBefore = htmlToText(html.slice(0, refPos));
      const wordsBefore = textBefore.split(" ").filter(Boolean).length;
      const wordIndex   = globalWords + wordsBefore;
      const note = footnoteContent[refId];
      if (note && !annotations[wordIndex]) {
        annotations[wordIndex] = { note, source: "epub", linkedWordIndex: null, createdAt: Date.now() };
      }
    }

    const text = htmlToText(html);
    if (text) {
      parts.push(text);
      globalWords += text.split(" ").filter(Boolean).length;
    }
  }

  if (!parts.length) throw new Error("No readable text found in EPUB.");
  return { text: parts.join(" "), meta: { title, author, coverDataUrl }, annotations };
}

// ── MOBI ──────────────────────────────────────────────────────────────────────

function decompressPalmDOC(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c === 0x00) {
      out.push(0x00);
    } else if (c <= 0x08) {
      for (let j = 0; j < c; j++) out.push(data[i++]);
    } else if (c <= 0x7f) {
      out.push(c);
    } else if (c <= 0xbf) {
      const n    = data[i++];
      const dist = ((c & 0x3f) << 5) | (n >> 3);
      const len  = (n & 0x7) + 3;
      const base = out.length - dist;
      for (let j = 0; j < len; j++) out.push(base + j >= 0 ? out[base + j] : 0x20);
    } else {
      out.push(0x20);
      out.push(c & 0x7f);
    }
  }
  return new Uint8Array(out);
}

function stripMobiTrailing(record, extraDataFlags) {
  if (!extraDataFlags) return record;
  let end = record.length;
  if (extraDataFlags & 1) end -= (record[end - 1] & 0x3) + 1;
  return record.slice(0, Math.max(0, end));
}

async function parseMOBI(uri) {
  const buffer = await loadBuffer(uri);
  const bytes  = new Uint8Array(buffer);
  const dv     = new DataView(buffer);

  const dbType    = String.fromCharCode(bytes[60], bytes[61], bytes[62], bytes[63]);
  const dbCreator = String.fromCharCode(bytes[64], bytes[65], bytes[66], bytes[67]);
  if (dbType !== "BOOK" || dbCreator !== "MOBI")
    throw new Error("Not a valid MOBI file.");

  const numRecords = dv.getUint16(76);
  const recOffsets = [];
  for (let i = 0; i < numRecords; i++) recOffsets.push(dv.getUint32(78 + i * 8));
  recOffsets.push(buffer.byteLength);

  const r0          = recOffsets[0];
  const compression = dv.getUint16(r0 + 0);
  const textCount   = dv.getUint16(r0 + 8);
  const encryption  = dv.getUint16(r0 + 12);

  if (encryption !== 0)  throw new Error("DRM-protected MOBI files cannot be read.");
  if (compression === 17480)
    throw new Error("AZW3/KF8 Huffman compression is not supported.\nConvert to EPUB using Calibre (calibre-ebook.com).");
  if (compression !== 1 && compression !== 2)
    throw new Error(`Unsupported MOBI compression type: ${compression}.`);

  const mobiMagic = String.fromCharCode(bytes[r0+16], bytes[r0+17], bytes[r0+18], bytes[r0+19]);
  if (mobiMagic !== "MOBI") throw new Error("Invalid MOBI header.");

  const mobiLen      = dv.getUint32(r0 + 20);
  const encoding     = dv.getUint32(r0 + 28);
  let   extraDataFlags = 0;
  if (mobiLen >= 228) extraDataFlags = dv.getUint16(r0 + 16 + 226);

  const decoder = new TextDecoder(encoding === 65001 ? "utf-8" : "windows-1252");
  const parts   = [];

  for (let i = 1; i <= textCount && i < recOffsets.length - 1; i++) {
    let record = bytes.slice(recOffsets[i], recOffsets[i + 1]);
    record     = stripMobiTrailing(record, extraDataFlags);
    const raw  = compression === 2 ? decompressPalmDOC(record) : record;
    const text = decodeHtmlEntities(
      decoder.decode(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    );
    if (text) parts.push(text);
  }

  if (!parts.length) throw new Error("No readable text found in MOBI file.");
  return { text: parts.join(" "), meta: { title: "", author: "", coverDataUrl: null }, annotations: {} };
}

// ── dispatcher ────────────────────────────────────────────────────────────────

export async function parseFile(asset) {
  const ext = asset.name.split(".").pop().toLowerCase();

  if (ext === "pdf") {
    if (Platform.OS !== "web") throw new Error("PDF parsing is only supported on web.");
    return parsePDF(asset.uri);
  }
  if (ext === "epub") return parseEPUB(asset.uri);
  if (ext === "mobi" || ext === "azw") return parseMOBI(asset.uri);
  if (ext === "azw3")
    throw new Error("AZW3 uses KF8/Huffman compression and cannot be parsed.\nConvert to EPUB using Calibre (calibre-ebook.com).");

  // Plain text / markdown
  const text = Platform.OS === "web"
    ? await (await fetch(asset.uri)).text()
    : await FileSystem.readAsStringAsync(asset.uri);
  return { text, meta: { title: "", author: "", coverDataUrl: null }, annotations: {} };
}

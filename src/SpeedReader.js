import { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  SafeAreaView,
  StatusBar,
  ScrollView,
} from "react-native";
import Slider from "@react-native-community/slider";
// Web-safe slider wrapper
function WpmSlider({ value, onValueChange, minimumTrackTintColor, maximumTrackTintColor, thumbTintColor, style }) {
  if (Platform.OS === "web") {
    return (
      <input
        type="range"
        min={50}
        max={1000}
        step={10}
        value={value}
        onChange={e => onValueChange(Number(e.target.value))}
        style={{ flex: 1, maxWidth: 260, accentColor: minimumTrackTintColor }}
      />
    );
  }
  return (
    <Slider
      style={style}
      minimumValue={50}
      maximumValue={1000}
      step={10}
      value={value}
      onValueChange={onValueChange}
      minimumTrackTintColor={minimumTrackTintColor}
      maximumTrackTintColor={maximumTrackTintColor}
      thumbTintColor={thumbTintColor}
    />
  );
}
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";

// ── file parsers ──────────────────────────────────────────────────────────────

async function parsePDF(uri) {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  const response = await fetch(uri);
  const data = await response.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(" "));
  }
  return pages.join("\n");
}

async function parseEPUB(uri) {
  const { default: JSZip } = await import("jszip");
  let buffer;
  if (Platform.OS === "web") {
    buffer = await (await fetch(uri)).arrayBuffer();
  } else {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    buffer = bytes.buffer;
  }
  const zip = await JSZip.loadAsync(buffer);
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid EPUB file.");
  const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error("Malformed EPUB: no OPF path.");
  const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) throw new Error("Cannot read EPUB package.");
  const manifest = Object.fromEntries(
    [...opf.matchAll(/<item\s[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/gi)].map(m => [m[1], m[2]])
  );
  const spine = [...opf.matchAll(/<itemref\s[^>]*\bidref="([^"]+)"/gi)]
    .map(m => manifest[m[1]])
    .filter(Boolean);
  const parts = [];
  for (const href of spine) {
    const html = await (zip.file(opfDir + href) ?? zip.file(href))?.async("string");
    if (!html) continue;
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(text);
  }
  if (!parts.length) throw new Error("No readable text found in EPUB.");
  return parts.join(" ");
}

// PalmDOC LZ77 decompression
function decompressPalmDOC(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c === 0x00) {
      out.push(0x00);
    } else if (c <= 0x08) {
      for (let j = 0; j < c; j++) out.push(data[i++]);
    } else if (c <= 0x7F) {
      out.push(c);
    } else if (c <= 0xBF) {
      const n = data[i++];
      const dist = ((c & 0x3F) << 5) | (n >> 3);
      const len  = (n & 0x7) + 3;
      const base = out.length - dist;
      for (let j = 0; j < len; j++) out.push(base + j >= 0 ? out[base + j] : 0x20);
    } else {
      out.push(0x20);        // space
      out.push(c & 0x7F);
    }
  }
  return new Uint8Array(out);
}

// Strip trailing bytes added by newer MOBI encoders
function stripMobiTrailing(record, extraDataFlags) {
  if (!extraDataFlags) return record;
  let end = record.length;
  if (extraDataFlags & 1) end -= (record[end - 1] & 0x3) + 1;
  return record.slice(0, Math.max(0, end));
}

async function parseMOBI(uri) {
  let buffer;
  if (Platform.OS === "web") {
    buffer = await (await fetch(uri)).arrayBuffer();
  } else {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    buffer = bytes.buffer;
  }

  const bytes = new Uint8Array(buffer);
  const dv    = new DataView(buffer);

  // Validate PalmDB header magic
  const dbType    = String.fromCharCode(bytes[60], bytes[61], bytes[62], bytes[63]);
  const dbCreator = String.fromCharCode(bytes[64], bytes[65], bytes[66], bytes[67]);
  if (dbType !== "BOOK" || dbCreator !== "MOBI") throw new Error("Not a valid MOBI file.");

  const numRecords = dv.getUint16(76);
  const recOffsets = [];
  for (let i = 0; i < numRecords; i++) recOffsets.push(dv.getUint32(78 + i * 8));
  recOffsets.push(buffer.byteLength); // sentinel

  // Record 0 = PalmDOC header (bytes 0-15) + MOBI header (bytes 16+)
  const r0 = recOffsets[0];
  const compression     = dv.getUint16(r0 + 0);
  const textRecordCount = dv.getUint16(r0 + 8);
  const encryption      = dv.getUint16(r0 + 12);

  if (encryption !== 0)
    throw new Error("DRM-protected MOBI files cannot be read.");
  if (compression === 17480)  // 0x4448 = HUFF/CDIC used by AZW3/KF8
    throw new Error("AZW3/KF8 Huffman compression is not supported.\nConvert to EPUB using Calibre (calibre-ebook.com).");
  if (compression !== 1 && compression !== 2)
    throw new Error(`Unsupported MOBI compression type: ${compression}.`);

  const mobiMagic = String.fromCharCode(bytes[r0+16], bytes[r0+17], bytes[r0+18], bytes[r0+19]);
  if (mobiMagic !== "MOBI") throw new Error("Invalid MOBI header.");

  const mobiLen  = dv.getUint32(r0 + 20); // MOBI header length
  const encoding = dv.getUint32(r0 + 28); // 65001 = UTF-8, 1252 = CP1252

  // extraDataFlags tells us how many trailing bytes to strip from each text record
  let extraDataFlags = 0;
  if (mobiLen >= 228) extraDataFlags = dv.getUint16(r0 + 16 + 226);

  const decoder = new TextDecoder(encoding === 65001 ? "utf-8" : "windows-1252");
  const parts   = [];

  for (let i = 1; i <= textRecordCount && i < recOffsets.length - 1; i++) {
    let record     = bytes.slice(recOffsets[i], recOffsets[i + 1]);
    record         = stripMobiTrailing(record, extraDataFlags);
    const raw      = compression === 2 ? decompressPalmDOC(record) : record;
    const text     = decoder.decode(raw)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(text);
  }

  if (!parts.length) throw new Error("No readable text found in MOBI file.");
  return parts.join(" ");
}

async function parseFile(asset) {
  const ext = asset.name.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    if (Platform.OS !== "web") throw new Error("PDF parsing is only supported on web.");
    return parsePDF(asset.uri);
  }
  if (ext === "epub") return parseEPUB(asset.uri);
  if (ext === "mobi" || ext === "azw") return parseMOBI(asset.uri);
  if (ext === "azw3") throw new Error("AZW3 uses KF8/Huffman compression and cannot be parsed.\nConvert to EPUB using Calibre (calibre-ebook.com).");
  if (Platform.OS === "web") return (await fetch(asset.uri)).text();
  return FileSystem.readAsStringAsync(asset.uri);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function tokenize(text) {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

function highlightWord(word) {
  if (word.length <= 1) return { bold: word, post: "" };
  const pivot = Math.max(1, Math.round(word.length * 0.4));
  return { bold: word.slice(0, pivot), post: word.slice(pivot) };
}

// ── sample text ───────────────────────────────────────────────────────────────

const SAMPLE = `The art of reading swiftly is not merely about speed — it is about presence. When each word arrives alone, stripped of the noise of the page, the mind locks in. There is nowhere else to look. The sentence assembles itself inside you, word by word, like a slow tide becoming a wave. Speed reading does not reduce comprehension; it sharpens it. The eye, freed from wandering, delivers each token cleanly to the mind. Rhythm emerges. Meaning deepens. The reader becomes the reading.`;

// ── themes ────────────────────────────────────────────────────────────────────

const THEMES = {
  dark:  { bg: "#0a0a0f", surface: "#13131a", text: "#e8e4d9", accent: "#f0c040", muted: "#555" },
  sepia: { bg: "#1a1208", surface: "#221a0e", text: "#d4b896", accent: "#c8842a", muted: "#6a5030" },
  light: { bg: "#f5f0e8", surface: "#fffdf7", text: "#1a1a1a", accent: "#2563eb", muted: "#aaa" },
};

const MONO = Platform.OS === "ios" ? "Courier" : "monospace";

// ── component ─────────────────────────────────────────────────────────────────

export default function SpeedReader() {
  const [words, setWords]         = useState(tokenize(SAMPLE));
  const [index, setIndex]         = useState(0);
  const [playing, setPlaying]     = useState(false);
  const [wpm, setWpm]             = useState(300);
  const [progress, setProgress]   = useState(0);
  const [fileName, setFileName]   = useState("Sample Text");
  const [showSettings, setShowSettings] = useState(false);
  const [fontSize, setFontSize]   = useState(48);
  const [theme, setTheme]         = useState("dark");
  const [chunkSize, setChunkSize] = useState(1);
  const [finished, setFinished]   = useState(false);
  const [loading, setLoading]     = useState(false);
  const [parseError, setParseError] = useState(null);

  const intervalRef = useRef(null);
  const t = THEMES[theme];
  const delay = Math.round((60 / wpm) * 1000 * chunkSize);

  // ── playback ────────────────────────────────────────────────────────────────

  const stop = useCallback(() => {
    clearInterval(intervalRef.current);
    setPlaying(false);
  }, []);

  const play = useCallback(() => {
    if (index >= words.length - chunkSize) {
      setIndex(0);
      setFinished(false);
    }
    setPlaying(true);
  }, [index, words.length, chunkSize]);

  useEffect(() => {
    if (!playing) { clearInterval(intervalRef.current); return; }
    intervalRef.current = setInterval(() => {
      setIndex(prev => {
        const next = prev + chunkSize;
        if (next >= words.length) {
          clearInterval(intervalRef.current);
          setPlaying(false);
          setFinished(true);
          return words.length - 1;
        }
        setProgress(Math.round((next / words.length) * 100));
        return next;
      });
    }, delay);
    return () => clearInterval(intervalRef.current);
  }, [playing, delay, words.length, chunkSize]);

  // ── file loading ────────────────────────────────────────────────────────────

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "text/plain", "text/markdown",
          "application/pdf",
          "application/epub+zip",
          "application/x-mobipocket-ebook",  // .mobi
          "application/vnd.amazon.ebook",    // .azw
          "application/x-mobi8-ebook",       // .azw3 (will show error)
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      stop();
      setFileName(asset.name);
      setParseError(null);
      setLoading(true);
      try {
        const text = await parseFile(asset);
        setWords(tokenize(text));
        setIndex(0);
        setProgress(0);
        setFinished(false);
      } catch (err) {
        setParseError(err.message);
        console.error("Parse error:", err);
      } finally {
        setLoading(false);
      }
    } catch (err) {
      console.error("File pick error:", err);
    }
  };

  // ── display ─────────────────────────────────────────────────────────────────

  const displayText = words.slice(index, index + chunkSize).join(" ");
  const { bold, post } = highlightWord(displayText);

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: t.bg, minHeight: Platform.OS === "web" ? "100vh" : undefined }]}>
      <StatusBar barStyle={theme === "light" ? "dark-content" : "light-content"} />
      <ScrollView
        contentContainerStyle={[s.container, { backgroundColor: t.bg }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ── */}
        <View style={[s.header, { borderBottomColor: t.muted + "44" }]}>
          <Text style={[s.logo, { color: t.accent, fontFamily: MONO }]}>⚡ SwiftRead</Text>
          <View style={s.headerRight}>
            {["dark", "sepia", "light"].map(th => (
              <TouchableOpacity
                key={th}
                style={[s.iconBtn, { borderColor: t.muted + "88" }]}
                onPress={() => setTheme(th)}
              >
                <Text style={{ color: t.muted, fontSize: 14 }}>
                  {th === "dark" ? "◐" : th === "sepia" ? "☕" : "○"}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[s.iconBtn, { borderColor: t.muted + "88" }]}
              onPress={() => setShowSettings(v => !v)}
            >
              <Text style={{ color: t.muted, fontSize: 11, fontFamily: MONO, letterSpacing: 1 }}>
                {showSettings ? "▲ less" : "▼ settings"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── File picker ── */}
        <TouchableOpacity
          style={[s.dropZone, { borderColor: t.muted + "88", backgroundColor: t.surface + "cc" }]}
          onPress={pickFile}
          activeOpacity={0.7}
        >
          <Text style={[s.dropText, { color: t.muted }]}>
            {Platform.OS === "web"
              ? "Drop a .txt / .md / .pdf / .epub here, or click to browse"
              : "Tap to open a .txt, .md, or .epub file"}
          </Text>
          <Text style={[s.dropText, { color: t.muted, fontSize: 11, marginTop: 4 }]}>
            {Platform.OS === "web" ? "PDF, EPUB, MOBI supported · AZW3: convert to EPUB first" : "EPUB, MOBI supported · PDF on web only · AZW3: convert to EPUB"}
          </Text>
          {loading && (
            <Text style={[s.dropText, { color: t.accent, fontSize: 11, marginTop: 6 }]}>
              Parsing file…
            </Text>
          )}
          {parseError && (
            <Text style={[s.dropText, { color: "#e05050", fontSize: 11, marginTop: 6, textAlign: "center" }]}>
              {parseError}
            </Text>
          )}
          <Text style={[s.fileName, { color: t.accent, fontFamily: MONO }]}>{fileName}</Text>
        </TouchableOpacity>

        {/* ── RSVP stage ── */}
        <View style={[s.stage, { backgroundColor: t.surface }]}>
          {finished ? (
            <View style={s.finishBadge}>
              <Text style={[s.finishText, { color: t.accent, fontFamily: MONO }]}>✦ Finished</Text>
              <Text style={[s.finishSub, { color: t.muted, fontFamily: MONO }]}>
                {words.length} words · {Math.round(words.length / wpm)} min read
              </Text>
            </View>
          ) : (
            <Text style={[s.orp, { fontSize }]} selectable={false}>
              <Text style={{ color: t.accent, fontWeight: "700" }}>{bold}</Text>
              <Text style={{ color: t.text,   fontWeight: "400" }}>{post}</Text>
            </Text>
          )}
          <Text style={[s.wordCount, { color: t.muted, fontFamily: MONO }]}>
            {index + 1} / {words.length}
          </Text>
        </View>

        {/* ── Progress bar ── */}
        <View style={[s.progressWrap, { backgroundColor: t.muted + "44" }]}>
          <View style={[s.progressBar, { backgroundColor: t.accent, width: `${progress}%` }]} />
        </View>

        {/* ── Controls ── */}
        <View style={s.controls}>
          <Ctrl
            label="↺ Reset"
            t={t}
            onPress={() => { stop(); setIndex(0); setProgress(0); setFinished(false); }}
          />
          <Ctrl label="‹‹" t={t} onPress={() => setIndex(i => Math.max(0, i - 20))} />
          {playing
            ? <Ctrl label="⏸ Pause" t={t} active onPress={stop} />
            : <Ctrl label="▶  Play"  t={t} active onPress={play} />
          }
          <Ctrl label="››" t={t} onPress={() => setIndex(i => Math.min(words.length - 1, i + 20))} />
        </View>

        {/* ── WPM slider ── */}
        <View style={s.wpmRow}>
          <Text style={[s.wpmLabel, { color: t.muted, fontFamily: MONO }]}>WPM</Text>
          <WpmSlider
            style={s.slider}
            value={wpm}
            onValueChange={v => setWpm(Math.round(v))}
            minimumTrackTintColor={t.accent}
            maximumTrackTintColor={t.muted}
            thumbTintColor={t.accent}
          />
          <Text style={[s.wpmValue, { color: t.accent, fontFamily: MONO }]}>{wpm}</Text>
        </View>

        {/* ── Settings panel ── */}
        {showSettings && (
          <View style={[s.settingsPanel, { backgroundColor: t.surface }]}>
            <SettingRow label="FONT SIZE" t={t}>
              {[32, 40, 48, 60, 72].map(sz => (
                <Chip
                  key={sz}
                  label={String(sz)}
                  active={fontSize === sz}
                  t={t}
                  onPress={() => setFontSize(sz)}
                />
              ))}
            </SettingRow>
            <SettingRow label="WORDS PER FLASH" t={t}>
              {[1, 2, 3].map(n => (
                <Chip
                  key={n}
                  label={String(n)}
                  active={chunkSize === n}
                  t={t}
                  onPress={() => setChunkSize(n)}
                />
              ))}
            </SettingRow>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── small sub-components ──────────────────────────────────────────────────────

function Ctrl({ label, t, active, onPress }) {
  return (
    <TouchableOpacity
      style={[
        s.btn,
        {
          borderColor:     active ? t.accent : t.muted + "88",
          backgroundColor: active ? t.accent : "transparent",
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={{
        color:      active ? t.bg : t.text,
        fontFamily: MONO,
        fontWeight: "600",
        fontSize:   14,
      }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function SettingRow({ label, t, children }) {
  return (
    <View style={s.settingRow}>
      <Text style={[s.settingLabel, { color: t.muted, fontFamily: MONO }]}>{label}</Text>
      <View style={s.settingControl}>{children}</View>
    </View>
  );
}

function Chip({ label, active, t, onPress }) {
  return (
    <TouchableOpacity
      style={[
        s.chipBtn,
        {
          borderColor:     active ? t.accent : t.muted + "66",
          backgroundColor: active ? t.accent + "33" : "transparent",
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={{ color: active ? t.accent : t.muted, fontSize: 12, fontFamily: MONO }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe:      { flex: 1 },
  container: { alignItems: "center", paddingHorizontal: 16, paddingBottom: 48 },

  header: {
    width: "100%", maxWidth: 720,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 20, borderBottomWidth: 1,
  },
  logo:        { fontSize: 13, letterSpacing: 3 },
  headerRight: { flexDirection: "row", gap: 8, alignItems: "center" },
  iconBtn:     { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },

  dropZone: {
    width: "100%", maxWidth: 720, marginTop: 24,
    borderWidth: 2, borderStyle: "dashed", borderRadius: 12,
    padding: 28, alignItems: "center",
  },
  dropText: { fontSize: 13, letterSpacing: 0.5, textAlign: "center" },
  fileName: { fontSize: 11, marginTop: 8, letterSpacing: 2, textTransform: "uppercase" },

  stage: {
    width: "100%", maxWidth: 720, marginTop: 32,
    borderRadius: 16, paddingVertical: 56, paddingHorizontal: 32,
    alignItems: "center", justifyContent: "center",
    minHeight: 180,
  },
  orp:       { textAlign: "center" },
  wordCount: { position: "absolute", bottom: 16, right: 20, fontSize: 11, letterSpacing: 2 },

  finishBadge: { alignItems: "center", gap: 10 },
  finishText:  { fontSize: 20, letterSpacing: 3 },
  finishSub:   { fontSize: 12, letterSpacing: 2 },

  progressWrap: { width: "100%", maxWidth: 720, marginTop: 16, height: 3, borderRadius: 99 },
  progressBar:  { height: "100%", borderRadius: 99 },

  controls: {
    width: "100%", maxWidth: 720, marginTop: 24,
    flexDirection: "row", gap: 10, alignItems: "center",
    justifyContent: "center", flexWrap: "wrap",
  },
  btn: {
    borderWidth: 1.5, borderRadius: 8,
    paddingHorizontal: 20, paddingVertical: 10,
    minWidth: 80, alignItems: "center",
  },

  wpmRow: {
    width: "100%", maxWidth: 720, marginTop: 20,
    flexDirection: "row", alignItems: "center", gap: 12, justifyContent: "center",
  },
  wpmLabel: { fontSize: 12, letterSpacing: 2 },
  wpmValue: { fontSize: 22, fontWeight: "700", minWidth: 52, textAlign: "right" },
  slider:   { flex: 1, maxWidth: 260 },

  settingsPanel: {
    width: "100%", maxWidth: 720, marginTop: 16,
    borderRadius: 12, padding: 20, gap: 16,
  },
  settingRow:    { gap: 6 },
  settingLabel:  { fontSize: 11, letterSpacing: 2, textTransform: "uppercase" },
  settingControl:{ flexDirection: "row", gap: 8, flexWrap: "wrap" },
  chipBtn:       { paddingHorizontal: 14, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
});

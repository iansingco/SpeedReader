import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  SafeAreaView,
  StatusBar,
  AppState,
  ScrollView,
  Modal,
  TextInput,
  Alert,
  useWindowDimensions,
} from "react-native";
import Slider from "@react-native-community/slider";
import * as DocumentPicker from "expo-document-picker";
import { THEMES, MONO, WORD_COLORS } from "./constants";
import ThemeDropdown from "./ThemeDropdown";
import { parseFile, tokenize, highlightWord, makeBookId } from "./parsers";
import * as storage from "./storage";

// ── web-safe slider ───────────────────────────────────────────────────────────

function WpmSlider({ value, onValueChange, minimumTrackTintColor, maximumTrackTintColor, thumbTintColor, style, onSlidingStart, onSlidingComplete }) {
  if (Platform.OS === "web") {
    return (
      <input
        type="range" min={50} max={1000} step={10} value={value}
        onChange={e => onValueChange(Number(e.target.value))}
        style={{ flex: 1, maxWidth: 260, accentColor: minimumTrackTintColor, height: 28 }}
      />
    );
  }
  return (
    <Slider
      style={style}
      minimumValue={50} maximumValue={1000} step={10}
      value={value} onValueChange={onValueChange}
      minimumTrackTintColor={minimumTrackTintColor}
      maximumTrackTintColor={maximumTrackTintColor}
      thumbTintColor={thumbTintColor}
      onSlidingStart={onSlidingStart}
      onSlidingComplete={onSlidingComplete}
    />
  );
}

function PauseSlider({ value, onChange, min, max, step, t }) {
  if (Platform.OS === "web") {
    return (
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Math.round(Number(e.target.value) * 10) / 10)}
        style={{ flex: 1, maxWidth: 180, accentColor: t.accent }}
      />
    );
  }
  return (
    <Slider
      style={{ flex: 1, maxWidth: 180 }}
      minimumValue={min} maximumValue={max} step={step}
      value={value} onValueChange={v => onChange(Math.round(v * 10) / 10)}
      minimumTrackTintColor={t.accent}
      maximumTrackTintColor={t.muted + "66"}
      thumbTintColor={t.accent}
    />
  );
}

// ── sample text ───────────────────────────────────────────────────────────────

const SAMPLE = `The art of reading swiftly is not merely about speed — it is about presence. When each word arrives alone, stripped of the noise of the page, the mind locks in. There is nowhere else to look. The sentence assembles itself inside you, word by word, like a slow tide becoming a wave. Speed reading does not reduce comprehension; it sharpens it. The eye, freed from wandering, delivers each token cleanly to the mind. Rhythm emerges. Meaning deepens. The reader becomes the reading.`;

// ── component ─────────────────────────────────────────────────────────────────

/**
 * SpeedReader
 *
 * Props (all optional — standalone mode when omitted):
 *   book        { id, title, author, words[], annotations{}, lastPosition }
 *   onBack      () => void   — shows a back-to-library button
 *   onProgress  (wordIndex) => void  — called on back / finish
 */
// Multiplier applied to base word delay based on trailing punctuation.
// Strips trailing quotes/brackets before testing so "word." still matches.
function getPauseMult(word, strength = 1, custom = null) {
  const w       = word.replace(/["""'''\])}]+$/, "").trim();
  const isStop  = /[.!?…]$/.test(w);
  const isSemi  = /[;:]$/.test(w);
  const isComma = /[,—–\-]$/.test(w);

  if (strength === "custom" && custom) {
    if (isStop)  return custom.sentence;
    if (isSemi)  return custom.semi;
    if (isComma) return custom.comma;
    return 1;
  }
  if (!strength || strength <= 0) return 1;
  if (isStop)  return 1 + 1.5 * strength;
  if (isSemi)  return 1 + 0.8 * strength;
  if (isComma) return 1 + 0.4 * strength;
  return 1;
}

export default function SpeedReader({ book, onBack, onProgress }) {
  // ── reader state ─────────────────────────────────────────────────────────────
  const [words,       setWords]       = useState(() => book?.words?.length ? book.words : tokenize(SAMPLE));
  const [index,       setIndex]       = useState(() => book?.lastPosition || 0);
  const [playing,     setPlaying]     = useState(false);
  const [wpm,         setWpm]         = useState(300);
  const [progress,    setProgress]    = useState(0);
  const [fileName,    setFileName]    = useState(book?.title || "Sample Text");
  const [showSettings,setShowSettings]= useState(false);
  const [fontSize,    setFontSize]    = useState(48);
  const [theme,       setTheme]       = useState("dark");
  const [chunkSize,   setChunkSize]   = useState(1);
  const [finished,    setFinished]    = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [parseError,  setParseError]  = useState(null);
  const [wordColor,     setWordColor]     = useState(null);
  const [skipAmount,    setSkipAmount]    = useState(20);
  const [pauseStrength, setPauseStrength] = useState(1);
  const [customPause,   setCustomPause]   = useState({ sentence: 2.5, semi: 1.8, comma: 1.4 });
  const [chapters,      setChapters]      = useState(book?.chapters || []);
  const [customAccent,  setCustomAccent]  = useState(null);
  const [customBg,      setCustomBg]      = useState(null);
  const [highlightMode, setHighlightMode] = useState("orp");
  const [jumpHistory,   setJumpHistory]   = useState([]);

  const [scrollEnabled, setScrollEnabled] = useState(true);

  const { width: screenW, height: screenH } = useWindowDimensions();
  const isLandscape = screenW > screenH;

  // ── annotation state ─────────────────────────────────────────────────────────
  const [annotations,       setAnnotations]       = useState(book?.annotations || {});
  const [showAnnotation,    setShowAnnotation]     = useState(null);
  const [showAnnotateModal, setShowAnnotateModal]  = useState(false);
  const [annNote,           setAnnNote]            = useState("");
  const [annLink,           setAnnLink]            = useState("");

  // ── context panel + jump-to-word ─────────────────────────────────────────────
  const [showContext,     setShowContext]     = useState(false);
  const [showJumpModal,   setShowJumpModal]   = useState(false);
  const [jumpInput,       setJumpInput]       = useState("");
  const contextScrollRef  = useRef(null);
  const pauseStrengthRef  = useRef(pauseStrength);
  useEffect(() => { pauseStrengthRef.current = pauseStrength; }, [pauseStrength]);
  const customPauseRef    = useRef(customPause);
  useEffect(() => { customPauseRef.current = customPause; }, [customPause]);

  // Load persisted reader prefs once on mount
  useEffect(() => {
    storage.getReaderPrefs().then(prefs => {
      if (prefs.wpm)          setWpm(prefs.wpm);
      if (prefs.fontSize)     setFontSize(prefs.fontSize);
      if (prefs.chunkSize)    setChunkSize(prefs.chunkSize);
      if (prefs.skipAmount !== undefined) setSkipAmount(prefs.skipAmount);
      if (prefs.pauseStrength !== undefined) setPauseStrength(prefs.pauseStrength);
      if (prefs.customAccent)  setCustomAccent(prefs.customAccent);
      if (prefs.customBg)      setCustomBg(prefs.customBg);
      if (prefs.wordColor !== undefined) setWordColor(prefs.wordColor);
      if (prefs.highlightMode) setHighlightMode(prefs.highlightMode);
    });
  }, []);

  const savePrefs = useCallback((patch) => {
    storage.getReaderPrefs().then(current => {
      storage.saveReaderPrefs({ ...current, ...patch });
    });
  }, []);

  // Auto-bookmark when app goes to background
  useEffect(() => {
    if (!book?.id) return;
    const sub = AppState.addEventListener("change", state => {
      if (state === "background" || state === "inactive")
        storage.updatePosition(book.id, indexRef.current);
    });
    return () => sub.remove();
  }, [book?.id]);

  // bookId drives storage persistence
  const bookId = book?.id || makeBookId(fileName);

  const intervalRef    = useRef(null);
  const indexRef       = useRef(index);
  useEffect(() => { indexRef.current = index; }, [index]);
  const annotationsRef = useRef(annotations);
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);

  const t     = useMemo(() => {
    const base = THEMES[theme];
    return {
      ...base,
      ...(customAccent ? { accent: customAccent } : {}),
      ...(customBg     ? { bg: customBg, surface: customBg + "dd" } : {}),
    };
  }, [theme, customAccent, customBg]);
  const delay = Math.round((60 / wpm) * 1000 * chunkSize);

  // Keep progress in sync when index changes externally (e.g. nav)
  useEffect(() => {
    setProgress(words.length > 0 ? Math.round((index / words.length) * 100) : 0);
  }, [index, words.length]);

  // ── sentence boundaries ───────────────────────────────────────────────────────

  const sentenceBounds = useMemo(
    () => words.reduce((acc, w, i) => (/[.!?]["'\u201d]?$/.test(w) ? [...acc, i] : acc), []),
    [words]
  );

  // ── skip ──────────────────────────────────────────────────────────────────────

  const skipBy = useCallback((dir) => {
    setIndex(prev => {
      if (skipAmount === "sentence") {
        if (dir > 0) {
          const next = sentenceBounds.find(b => b > prev);
          return next !== undefined ? Math.min(next + 1, words.length - 1) : words.length - 1;
        } else {
          const behind = sentenceBounds.filter(b => b < prev - 1);
          const target = behind[behind.length - 2];
          return target !== undefined ? target + 1 : 0;
        }
      }
      return Math.max(0, Math.min(words.length - 1, prev + dir * skipAmount));
    });
  }, [skipAmount, sentenceBounds, words.length]);

  // ── playback ──────────────────────────────────────────────────────────────────

  const stop = useCallback(() => {
    clearTimeout(intervalRef.current);
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
    if (!playing) { clearTimeout(intervalRef.current); return; }

    let cancelled = false;

    const tick = (fromIndex) => {
      if (cancelled) return;
      const word = words[fromIndex] || "";
      const mult = getPauseMult(word, pauseStrengthRef.current, customPauseRef.current);

      intervalRef.current = setTimeout(() => {
        if (cancelled) return;
        const next = fromIndex + chunkSize;

        if (next >= words.length) {
          setPlaying(false);
          setFinished(true);
          setIndex(words.length - 1);
          setProgress(100);
          if (onProgress) onProgress(words.length - 1);
          if (book?.id) storage.updatePosition(book.id, words.length - 1);
          return;
        }

        setIndex(next);
        setProgress(Math.round((next / words.length) * 100));

        if (annotationsRef.current[next]) {
          setPlaying(false);
          setShowAnnotation(annotationsRef.current[next]);
          return;
        }

        tick(next);
      }, Math.round(delay * mult));
    };

    tick(indexRef.current);

    return () => {
      cancelled = true;
      clearTimeout(intervalRef.current);
    };
  }, [playing, delay, words.length, chunkSize]);

  const jumpTo = useCallback((newIdx) => {
    setJumpHistory(prev => [...prev.slice(-4), indexRef.current]);
    stop();
    setIndex(newIdx);
    setShowAnnotation(null);
  }, [stop]);

  // ── back to library ───────────────────────────────────────────────────────────

  const handleBack = () => {
    stop();
    if (book?.id) storage.updatePosition(book.id, index);
    if (onProgress) onProgress(index);
    onBack?.();
  };

  // ── file loading (standalone mode) ───────────────────────────────────────────

  const pickFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "text/plain", "text/markdown",
          "application/pdf",
          "application/epub+zip",
          "application/x-mobipocket-ebook",
          "application/vnd.amazon.ebook",
          "application/x-mobi8-ebook",
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
        const { text, annotations: fileAnns } = await parseFile(asset);
        const ws = tokenize(text);
        setWords(ws);
        setIndex(0);
        setProgress(0);
        setFinished(false);
        setAnnotations(fileAnns || {});
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

  // ── annotation management ─────────────────────────────────────────────────────

  const openAnnotateModal = () => {
    stop();
    setAnnNote("");
    setAnnLink("");
    setShowAnnotateModal(true);
  };

  const saveAnnotation = async () => {
    if (!annNote.trim()) return;
    const linkedIndex = annLink.trim()
      ? Math.max(0, Math.min(words.length - 1, parseInt(annLink.trim(), 10) - 1))
      : null;
    const ann = {
      note:             annNote.trim(),
      linkedWordIndex:  isNaN(linkedIndex) ? null : linkedIndex,
      source:           "user",
      createdAt:        Date.now(),
    };
    const updated = await storage.saveAnnotation(bookId, index, ann);
    setAnnotations(updated);
    setShowAnnotateModal(false);
  };

  const deleteAnnotation = async (wordIndex) => {
    Alert.alert(
      "Delete Annotation",
      "Remove this annotation?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete", style: "destructive",
          onPress: async () => {
            const updated = await storage.deleteAnnotation(bookId, wordIndex);
            setAnnotations(updated);
            if (showAnnotation?.wordIndex === wordIndex) setShowAnnotation(null);
          },
        },
      ]
    );
  };

  // ── display ───────────────────────────────────────────────────────────────────

  const displayText = words.slice(index, index + chunkSize).join(" ");
  const { hlPre, hlBold, hlPost } = (() => {
    if (highlightMode === "off") return { hlPre: "", hlBold: displayText, hlPost: "" };
    if (highlightMode === "center") {
      if (displayText.length <= 1) return { hlPre: "", hlBold: displayText, hlPost: "" };
      const mid = Math.floor(displayText.length / 2);
      return { hlPre: displayText.slice(0, mid), hlBold: displayText[mid], hlPost: displayText.slice(mid + 1) };
    }
    const { bold: b, post: p } = highlightWord(displayText);
    return { hlPre: "", hlBold: b, hlPost: p };
  })();
  const hasAnnotation = !!annotations[index];

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={[s.safe, { backgroundColor: t.bg, minHeight: Platform.OS === "web" ? "100vh" : undefined }]}>
      <StatusBar barStyle={theme === "light" ? "dark-content" : "light-content"} />
      <ScrollView
        contentContainerStyle={[s.container, { backgroundColor: t.bg }]}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={scrollEnabled}
      >

        {/* ── Header ── */}
        <View style={[s.header, { borderBottomColor: t.muted + "44" }]}>
          <View style={s.headerLeft}>
            {onBack && (
              <TouchableOpacity
                style={[s.iconBtn, { borderColor: t.muted + "88", marginRight: 8 }]}
                onPress={handleBack}
              >
                <Text style={{ color: t.muted, fontSize: 13 }}>← Library</Text>
              </TouchableOpacity>
            )}
            <Text style={[s.logo, { color: t.accent, fontFamily: MONO }]} numberOfLines={1}>
              {book ? (book.title || "Untitled") : "⚡ SwiftRead"}
            </Text>
          </View>
          <View style={s.headerRight}>
            <ThemeDropdown theme={theme} onChange={setTheme} t={t} />
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

        {/* ── File picker (standalone mode only) ── */}
        {!book && (
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
              {Platform.OS === "web"
                ? "PDF, EPUB, MOBI supported · AZW3: convert to EPUB first"
                : "EPUB, MOBI supported · PDF on web only · AZW3: convert to EPUB"}
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
        )}

        {/* ── RSVP stage — tap to play/pause ── */}
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => playing ? stop() : play()}
          style={[
            s.stage,
            {
              backgroundColor: t.surface,
              height: isLandscape ? Math.round(screenH * 0.52) : 220,
              marginTop: isLandscape ? 8 : Math.max(32, Math.round(screenH * 0.1)),
            },
          ]}
        >
          {finished ? (
            <View style={s.finishBadge}>
              <Text style={[s.finishText, { color: t.accent, fontFamily: MONO }]}>✦ Finished</Text>
              <Text style={[s.finishSub, { color: t.muted, fontFamily: MONO }]}>
                {words.length} words · {Math.round(words.length / wpm)} min read
              </Text>
            </View>
          ) : (
            <Text
              style={[s.orp, { fontSize }]}
              selectable={false}
              adjustsFontSizeToFit
              numberOfLines={1}
              minimumFontScale={0.4}
            >
              {hlPre ? <Text style={{ color: wordColor ?? t.text, fontWeight: "400" }}>{hlPre}</Text> : null}
              <Text style={{ color: highlightMode === "off" ? (wordColor ?? t.text) : (wordColor ?? t.accent), fontWeight: highlightMode === "off" ? "400" : "700" }}>{hlBold}</Text>
              {hlPost ? <Text style={{ color: wordColor ?? t.text, fontWeight: "400" }}>{hlPost}</Text> : null}
            </Text>
          )}
          {/* Word counter — tap to open jump-to-word */}
          <TouchableOpacity
            style={s.wordCountBtn}
            onPress={(e) => { e.stopPropagation?.(); setJumpInput(String(index + 1)); setShowJumpModal(true); }}
            activeOpacity={0.6}
          >
            <Text style={[s.wordCount, { color: hasAnnotation ? t.accent : t.muted, fontFamily: MONO }]}>
              {hasAnnotation ? "✦ " : ""}{index + 1} / {words.length}
            </Text>
          </TouchableOpacity>
          {hasAnnotation && !showAnnotation && (
            <TouchableOpacity
              style={[s.annDot, { backgroundColor: t.accent }]}
              onPress={(e) => { e.stopPropagation?.(); setShowAnnotation(annotations[index]); }}
            />
          )}
          {/* Play/pause hint */}
          {!playing && !finished && (
            <Text style={[s.stagePauseHint, { color: t.muted }]}>▶ tap to play</Text>
          )}
        </TouchableOpacity>

        {/* ── Annotation popup ── */}
        {showAnnotation && (
          <View style={[s.annCard, { backgroundColor: t.surface, borderColor: t.accent + "55" }]}>
            <View style={s.annCardHeader}>
              <Text style={[s.annCardLabel, { color: t.accent, fontFamily: MONO }]}>
                {showAnnotation.source === "epub" ? "✦ FOOTNOTE" : "✦ ANNOTATION"}
              </Text>
              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity onPress={() => deleteAnnotation(showAnnotation.wordIndex ?? index)}>
                  <Text style={{ color: t.muted, fontSize: 12, fontFamily: MONO }}>delete</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowAnnotation(null)}>
                  <Text style={{ color: t.muted }}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={[s.annCardText, { color: t.text }]}>{showAnnotation.note}</Text>
            <View style={s.annCardActions}>
              {showAnnotation.linkedWordIndex != null && (
                <TouchableOpacity
                  style={[s.annActionBtn, { borderColor: t.accent }]}
                  onPress={() => {
                    setIndex(showAnnotation.linkedWordIndex);
                    setShowAnnotation(null);
                  }}
                >
                  <Text style={{ color: t.accent, fontFamily: MONO, fontSize: 12 }}>→ Jump to §</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[s.annActionBtn, { backgroundColor: t.accent, borderColor: t.accent }]}
                onPress={() => { setShowAnnotation(null); play(); }}
              >
                <Text style={{ color: t.bg, fontFamily: MONO, fontSize: 12 }}>▶ Continue</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Context panel ── */}
        {showContext && (
          <ContextPanel
            words={words}
            currentIndex={index}
            chapters={chapters}
            t={t}
            scrollRef={contextScrollRef}
            onJump={jumpTo}
          />
        )}

        {/* ── Progress bar + ETA ── */}
        <ProgressSection
          progress={progress}
          index={index}
          words={words}
          wpm={wpm}
          chapters={chapters}
          t={t}
          onJump={jumpTo}
        />

        {/* ── Controls ── */}
        <View style={s.mainControls}>
          <Ctrl label="‹‹" t={t} onPress={() => skipBy(-1)} />
          {playing
            ? <Ctrl label="⏸" t={t} active onPress={stop} large />
            : <Ctrl label="▶" t={t} active onPress={play} large />
          }
          <Ctrl label="››" t={t} onPress={() => skipBy(1)} />
        </View>
        <View style={s.secondaryControls}>
          {jumpHistory.length > 0 && (
            <Ctrl
              label="↩"
              t={t}
              small
              onPress={() => {
                const prev = jumpHistory[jumpHistory.length - 1];
                setJumpHistory(h => h.slice(0, -1));
                stop();
                setIndex(prev);
                setShowAnnotation(null);
              }}
            />
          )}
          <Ctrl
            label={showContext ? "▲ ctx" : "▼ ctx"}
            t={t}
            active={showContext}
            onPress={() => setShowContext(v => !v)}
            small
          />
          <Ctrl
            label="✦ Ann"
            t={t}
            onPress={openAnnotateModal}
            small
            style={{ borderColor: hasAnnotation ? t.accent + "aa" : t.muted + "55" }}
          />
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
            onSlidingStart={() => setScrollEnabled(false)}
            onSlidingComplete={() => setScrollEnabled(true)}
          />
          <Text style={[s.wpmValue, { color: t.accent, fontFamily: MONO }]}>{wpm}</Text>
        </View>

        {/* ── Settings panel ── */}
        {showSettings && (
          <View style={[s.settingsPanel, { backgroundColor: t.surface }]}>
            <SettingRow label="FONT SIZE" t={t}>
              {[32, 40, 48, 60, 72, 80, 100, 120].map(sz => (
                <Chip key={sz} label={String(sz)} active={fontSize === sz} t={t} onPress={() => { setFontSize(sz); savePrefs({ fontSize: sz }); }} />
              ))}
            </SettingRow>
            <SettingRow label="WORDS PER FLASH" t={t}>
              {[1, 2, 3].map(n => (
                <Chip key={n} label={String(n)} active={chunkSize === n} t={t} onPress={() => { setChunkSize(n); savePrefs({ chunkSize: n }); }} />
              ))}
            </SettingRow>
            <SettingRow label="SKIP AMOUNT" t={t}>
              {[10, 20, 50, "sentence"].map(n => (
                <Chip
                  key={String(n)}
                  label={n === "sentence" ? "sentence" : `${n}w`}
                  active={skipAmount === n}
                  t={t}
                  onPress={() => { setSkipAmount(n); savePrefs({ skipAmount: n }); }}
                />
              ))}
            </SettingRow>
            <SettingRow label="PUNCT PAUSE" t={t}>
              {[["Off", 0], ["Light", 0.5], ["Normal", 1], ["Heavy", 2], ["Custom", "custom"]].map(([label, val]) => (
                <Chip
                  key={label}
                  label={label}
                  active={pauseStrength === val}
                  t={t}
                  onPress={() => { setPauseStrength(val); savePrefs({ pauseStrength: val }); }}
                />
              ))}
            </SettingRow>

            {/* Custom pause sub-panel */}
            {pauseStrength === "custom" && (
              <View style={[s.customPausePanel, { backgroundColor: t.bg, borderColor: t.muted + "33" }]}>
                {[
                  ["FULL STOP  . ! ?", "sentence", 1, 5],
                  ["SEMICOLON  ; :",   "semi",     1, 3],
                  ["COMMA  , —",       "comma",    1, 2.5],
                ].map(([label, key, min, max]) => (
                  <View key={key} style={s.customPauseRow}>
                    <Text style={[s.customPauseLabel, { color: t.muted, fontFamily: MONO }]}>
                      {label}
                    </Text>
                    <View style={s.customPauseControl}>
                      <PauseSlider
                        value={customPause[key]}
                        onChange={v => setCustomPause(prev => ({ ...prev, [key]: v }))}
                        min={min} max={max} step={0.1}
                        t={t}
                      />
                      <Text style={[s.customPauseValue, { color: t.accent, fontFamily: MONO }]}>
                        {customPause[key].toFixed(1)}×
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <SettingRow label="HIGHLIGHT MODE" t={t}>
              {[["ORP", "orp"], ["Center", "center"], ["Off", "off"]].map(([label, val]) => (
                <Chip key={val} label={label} active={highlightMode === val} t={t}
                  onPress={() => { setHighlightMode(val); savePrefs({ highlightMode: val }); }} />
              ))}
            </SettingRow>

            <SettingRow label="FONT COLOR" t={t}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {WORD_COLORS.map(({ value, dot }) => (
                  <TouchableOpacity
                    key={value ?? "default"}
                    onPress={() => { setWordColor(value); savePrefs({ wordColor: value }); }}
                    style={[s.colorDot, { backgroundColor: dot ?? t.accent, borderColor: wordColor === value ? t.text : "transparent" }]}
                  />
                ))}
              </View>
              <RgbColorPicker
                color={wordColor ?? THEMES[theme].text}
                onChange={c => { setWordColor(c); savePrefs({ wordColor: c }); }}
                onReset={() => { setWordColor(null); savePrefs({ wordColor: null }); }}
                t={t}
              />
            </SettingRow>
            <SettingRow label="ACCENT COLOR" t={t}>
              <RgbColorPicker
                color={customAccent ?? t.accent}
                onChange={c => { setCustomAccent(c); savePrefs({ customAccent: c }); }}
                onReset={() => { setCustomAccent(null); savePrefs({ customAccent: null }); }}
                t={t}
              />
            </SettingRow>
            <SettingRow label="BACKGROUND COLOR" t={t}>
              <RgbColorPicker
                color={customBg ?? THEMES[theme].bg}
                onChange={c => { setCustomBg(c); savePrefs({ customBg: c }); }}
                onReset={() => { setCustomBg(null); savePrefs({ customBg: null }); }}
                t={t}
              />
            </SettingRow>
          </View>
        )}
      </ScrollView>

      {/* ── Annotation creation modal ── */}
      <Modal
        visible={showAnnotateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAnnotateModal(false)}
      >
        <View style={s.modalOverlay}>
          <View style={[s.modalBox, { backgroundColor: t.surface }]}>
            <Text style={[s.modalTitle, { color: t.text, fontFamily: MONO }]}>
              Add Annotation
            </Text>
            <Text style={[s.modalSub, { color: t.muted, fontFamily: MONO }]}>
              Word #{index + 1} — "{words[index]}"
            </Text>

            <Text style={[s.inputLabel, { color: t.muted, fontFamily: MONO }]}>NOTE</Text>
            <TextInput
              style={[s.textInput, { color: t.text, borderColor: t.muted + "55", backgroundColor: t.bg }]}
              multiline
              numberOfLines={4}
              value={annNote}
              onChangeText={setAnnNote}
              placeholder="Enter your note…"
              placeholderTextColor={t.muted}
            />

            <Text style={[s.inputLabel, { color: t.muted, fontFamily: MONO }]}>
              LINK TO WORD # (optional)
            </Text>
            <TextInput
              style={[s.textInput, { color: t.text, borderColor: t.muted + "55", backgroundColor: t.bg }]}
              keyboardType="numeric"
              value={annLink}
              onChangeText={setAnnLink}
              placeholder={`1 – ${words.length}`}
              placeholderTextColor={t.muted}
            />
            <Text style={[s.inputHint, { color: t.muted }]}>
              When the reader reaches this annotation during playback, it will pause and show your note.
              Optionally link to another word position to enable a "jump" button.
            </Text>

            <View style={s.modalActions}>
              <TouchableOpacity
                style={[s.modalBtn, { borderColor: t.muted + "55" }]}
                onPress={() => setShowAnnotateModal(false)}
              >
                <Text style={{ color: t.muted, fontFamily: MONO }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, { backgroundColor: t.accent, borderColor: t.accent }]}
                onPress={saveAnnotation}
              >
                <Text style={{ color: t.bg, fontFamily: MONO, fontWeight: "600" }}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Jump-to-word modal ── */}
      <Modal
        visible={showJumpModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowJumpModal(false)}
      >
        <View style={s.modalOverlay}>
          <View style={[s.modalBox, { backgroundColor: t.surface }]}>
            <Text style={[s.modalTitle, { color: t.text, fontFamily: MONO }]}>
              Go to Word
            </Text>
            <Text style={[s.modalSub, { color: t.muted, fontFamily: MONO }]}>
              1 – {words.length}
            </Text>
            <TextInput
              style={[s.textInput, { color: t.text, borderColor: t.muted + "55", backgroundColor: t.bg }]}
              keyboardType="numeric"
              value={jumpInput}
              onChangeText={setJumpInput}
              placeholder={String(index + 1)}
              placeholderTextColor={t.muted}
              autoFocus
              selectTextOnFocus
            />
            <View style={s.modalActions}>
              <TouchableOpacity
                style={[s.modalBtn, { borderColor: t.muted + "55" }]}
                onPress={() => setShowJumpModal(false)}
              >
                <Text style={{ color: t.muted, fontFamily: MONO }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, { backgroundColor: t.accent, borderColor: t.accent }]}
                onPress={() => {
                  const n = parseInt(jumpInput, 10);
                  if (!isNaN(n)) jumpTo(Math.max(0, Math.min(words.length - 1, n - 1)));
                  setShowJumpModal(false);
                }}
              >
                <Text style={{ color: t.bg, fontFamily: MONO, fontWeight: "600" }}>Go</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function Ctrl({ label, t, active, onPress, style, large, small }) {
  return (
    <TouchableOpacity
      style={[
        s.btn,
        large && s.btnLarge,
        small && s.btnSmall,
        {
          borderColor:     active ? t.accent : t.muted + "88",
          backgroundColor: active ? t.accent : "transparent",
        },
        style,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={{ color: active ? t.bg : t.text, fontFamily: MONO, fontWeight: "600", fontSize: large ? 22 : small ? 12 : 14 }}>
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

// ── RGB color picker ──────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return "#" + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function RgbChannelSlider({ label, value, onChange, t }) {
  if (Platform.OS === "web") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10, width: 12 }}>{label}</Text>
        <input
          type="range" min={0} max={255} step={1} value={value}
          onChange={e => onChange(Number(e.target.value))}
          style={{ flex: 1, maxWidth: 160, accentColor: t.accent }}
        />
        <Text style={{ color: t.text, fontFamily: MONO, fontSize: 10, width: 28, textAlign: "right" }}>{value}</Text>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
      <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10, width: 12 }}>{label}</Text>
      <Slider
        style={{ flex: 1, maxWidth: 160 }}
        minimumValue={0} maximumValue={255} step={1}
        value={value} onValueChange={onChange}
        minimumTrackTintColor={t.accent}
        maximumTrackTintColor={t.muted + "66"}
        thumbTintColor={t.accent}
      />
      <Text style={{ color: t.text, fontFamily: MONO, fontSize: 10, width: 28, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

function RgbColorPicker({ color, onChange, onReset, t }) {
  const rgb = useMemo(() => {
    try { return hexToRgb(color); } catch { return { r: 128, g: 128, b: 128 }; }
  }, [color]);

  const update = (channel, val) => onChange(rgbToHex({ ...rgb, [channel]: val }));

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: color, borderWidth: 1, borderColor: t.muted + "66" }} />
        <Text style={{ color: t.text, fontFamily: MONO, fontSize: 11 }}>{color.toUpperCase()}</Text>
        <TouchableOpacity onPress={onReset}>
          <Text style={{ color: t.muted, fontSize: 11, fontFamily: MONO }}>reset</Text>
        </TouchableOpacity>
      </View>
      <RgbChannelSlider label="R" value={rgb.r} onChange={v => update("r", v)} t={t} />
      <RgbChannelSlider label="G" value={rgb.g} onChange={v => update("g", v)} t={t} />
      <RgbChannelSlider label="B" value={rgb.b} onChange={v => update("b", v)} t={t} />
    </View>
  );
}

// ── progress section ──────────────────────────────────────────────────────────

function ProgressSection({ progress, index, words, wpm, chapters, t, onJump }) {
  const [barWidth, setBarWidth] = useState(0);

  const wordsLeft   = Math.max(0, words.length - index);
  const minsLeft    = wordsLeft / Math.max(1, wpm);
  const etaStr      = minsLeft < 1
    ? `< 1 min`
    : minsLeft < 60
      ? `${Math.round(minsLeft)} min`
      : `${Math.floor(minsLeft / 60)}h ${Math.round(minsLeft % 60)}m`;

  const handleTap = (e) => {
    if (!barWidth) return;
    const x   = e.nativeEvent.locationX;
    const pct = Math.max(0, Math.min(1, x / barWidth));
    onJump(Math.round(pct * (words.length - 1)));
  };

  return (
    <View style={{ width: "100%", maxWidth: 720, marginTop: 16 }}>
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={handleTap}
        onLayout={e => setBarWidth(e.nativeEvent.layout.width)}
        style={[s.progressWrap, { backgroundColor: t.muted + "44" }]}
      >
        <View style={[s.progressBar, { backgroundColor: t.accent, width: `${progress}%` }]} />
        {/* Chapter marks */}
        {chapters.map((ch, i) => {
          const pct = ch.wordIndex / Math.max(1, words.length - 1);
          return (
            <View
              key={i}
              style={[s.chapterMark, { left: `${pct * 100}%`, backgroundColor: t.bg }]}
            />
          );
        })}
      </TouchableOpacity>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
        <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10, letterSpacing: 1 }}>
          {progress}%
        </Text>
        <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10, letterSpacing: 1 }}>
          {etaStr} left
        </Text>
      </View>
    </View>
  );
}

const PAGE_SIZE     = 250;
const DEFAULT_BEFORE = 80;
const DEFAULT_AFTER  = 220;
const SENTENCE_END   = /[.!?…]["''"]?$/;

function ContextPanel({ words, currentIndex, chapters, t, scrollRef, onJump }) {
  const [pageMode,    setPageMode]    = useState(true);
  const [windowStart, setWindowStart] = useState(null); // null = auto-follow

  const isManual = windowStart !== null;

  // In auto mode, keep current word near the top of the window
  const effectiveStart = isManual
    ? windowStart
    : Math.max(0, currentIndex - DEFAULT_BEFORE);
  const effectiveEnd = Math.min(words.length - 1, effectiveStart + DEFAULT_BEFORE + DEFAULT_AFTER);
  const slice = words.slice(effectiveStart, effectiveEnd + 1);

  const canPrev = effectiveStart > 0;
  const canNext = effectiveEnd < words.length - 1;

  const goPrev = () => setWindowStart(Math.max(0, effectiveStart - PAGE_SIZE));
  const goNext = () => setWindowStart(Math.min(Math.max(0, words.length - 1 - PAGE_SIZE), effectiveStart + PAGE_SIZE));
  const goNow  = () => { setWindowStart(null); scrollRef?.current?.scrollTo({ y: 0, animated: true }); };

  // ── flow-mode: auto-scroll to current word ────────────────────────────────
  const itemRefs = useRef({});
  useEffect(() => {
    if (pageMode || isManual) return;
    const relIdx = currentIndex - effectiveStart;
    const node   = itemRefs.current[relIdx];
    if (node?.measureLayout && scrollRef?.current) {
      node.measureLayout(
        scrollRef.current,
        (_x, y) => scrollRef.current.scrollTo({ y: Math.max(0, y - 80), animated: true }),
        () => {}
      );
    }
  }, [currentIndex, effectiveStart, pageMode, isManual]);

  // ── page-mode: scroll to current sentence ────────────────────────────────
  const sentenceRef = useRef(null);
  useEffect(() => {
    if (!pageMode || isManual) return;
    sentenceRef.current?.measureLayout?.(
      scrollRef.current,
      (_x, y) => scrollRef.current?.scrollTo({ y: Math.max(0, y - 60), animated: true }),
      () => {}
    );
  }, [currentIndex, pageMode, isManual]);

  const sentences = useMemo(() => {
    const result = [];
    let cur = [];
    for (let i = 0; i < slice.length; i++) {
      const absIdx = effectiveStart + i;
      cur.push({ word: slice[i], absIdx });
      if (SENTENCE_END.test(slice[i]) || i === slice.length - 1) {
        result.push(cur);
        cur = [];
      }
    }
    return result;
  }, [slice, effectiveStart]);

  // Chapter info for current position
  const currentChapter = useMemo(() => {
    if (!chapters?.length) return null;
    let ch = chapters[0];
    for (const c of chapters) { if (c.wordIndex <= currentIndex) ch = c; else break; }
    return ch;
  }, [chapters, currentIndex]);
  const prevChapter = useMemo(() => {
    if (!chapters?.length) return null;
    const idx = chapters.indexOf(currentChapter);
    return idx > 0 ? chapters[idx - 1] : null;
  }, [chapters, currentChapter]);
  const nextChapter = useMemo(() => {
    if (!chapters?.length) return null;
    const idx = chapters.indexOf(currentChapter);
    return idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;
  }, [chapters, currentChapter]);

  // Determine if current word is visible in this window
  const currentVisible = currentIndex >= effectiveStart && currentIndex <= effectiveEnd;

  const header = (
    <View style={s.ctxHeader}>
      {currentChapter && (
        <Text style={{ color: t.accent, fontFamily: MONO, fontSize: 10, letterSpacing: 1, flex: 1 }} numberOfLines={1}>
          {currentChapter.title}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {prevChapter && (
          <TouchableOpacity onPress={() => onJump(prevChapter.wordIndex)}>
            <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10 }}>‹ ch</Text>
          </TouchableOpacity>
        )}
        {nextChapter && (
          <TouchableOpacity onPress={() => onJump(nextChapter.wordIndex)}>
            <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10 }}>ch ›</Text>
          </TouchableOpacity>
        )}
        {/* Page navigation */}
        <TouchableOpacity onPress={goPrev} disabled={!canPrev} style={{ opacity: canPrev ? 1 : 0.3 }}>
          <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 12 }}>◀</Text>
        </TouchableOpacity>
        {isManual && (
          <TouchableOpacity onPress={goNow}>
            <Text style={{ color: t.accent, fontFamily: MONO, fontSize: 10 }}>
              {currentVisible ? "● now" : "→ now"}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={goNext} disabled={!canNext} style={{ opacity: canNext ? 1 : 0.3 }}>
          <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 12 }}>▶</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setPageMode(v => !v)} style={s.ctxToggle}>
          <Text style={{ color: t.accent, fontFamily: MONO, fontSize: 10, letterSpacing: 1 }}>
            {pageMode ? "≡ FLOW" : "¶ PAGE"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <ScrollView
      ref={scrollRef}
      style={[s.ctxPanel, { backgroundColor: t.surface, borderColor: t.muted + "33" }]}
      contentContainerStyle={s.ctxContent}
      showsVerticalScrollIndicator={false}
    >
      {header}

      {pageMode ? (
        sentences.map((sentence) => {
          const hasCurrent = sentence.some(w => w.absIdx === currentIndex);
          return (
            <View
              key={sentence[0].absIdx}
              ref={hasCurrent ? sentenceRef : null}
              style={s.ctxSentence}
            >
              <Text style={[s.ctxPageText, { lineHeight: 22 }]}>
                {sentence.map(({ word, absIdx }) => {
                  const isCur = absIdx === currentIndex;
                  return (
                    <Text
                      key={absIdx}
                      onPress={() => onJump(absIdx)}
                      style={[
                        { color: isCur ? t.bg : t.text },
                        isCur && { backgroundColor: t.accent, borderRadius: 3 },
                      ]}
                    >
                      {word}{" "}
                    </Text>
                  );
                })}
              </Text>
            </View>
          );
        })
      ) : (
        <View style={s.ctxWords}>
          {slice.map((word, i) => {
            const absIdx = effectiveStart + i;
            const isCur  = absIdx === currentIndex;
            return (
              <TouchableOpacity
                key={absIdx}
                ref={el => { itemRefs.current[i] = el; }}
                onPress={() => onJump(absIdx)}
                activeOpacity={0.6}
              >
                <Text style={[s.ctxWord, { color: isCur ? t.bg : t.text }, isCur && { backgroundColor: t.accent, borderRadius: 4 }]}>
                  {word}{" "}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe:      { flex: 1, paddingTop: Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0 },
  container: { alignItems: "center", paddingHorizontal: 16, paddingBottom: 48 },

  header: {
    width: "100%", maxWidth: 720,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 20, borderBottomWidth: 1,
  },
  headerLeft:  { flexDirection: "row", alignItems: "center", flex: 1, marginRight: 8 },
  headerRight: { flexDirection: "row", gap: 8, alignItems: "center" },
  logo:        { fontSize: 13, letterSpacing: 3, flexShrink: 1 },
  iconBtn:     { borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },

  dropZone: {
    width: "100%", maxWidth: 720, marginTop: 24,
    borderWidth: 2, borderStyle: "dashed", borderRadius: 12,
    padding: 28, alignItems: "center",
  },
  dropText: { fontSize: 13, letterSpacing: 0.5, textAlign: "center" },
  fileName: { fontSize: 11, marginTop: 8, letterSpacing: 2, textTransform: "uppercase" },

  stage: {
    width: "100%", maxWidth: 720,
    borderRadius: 16, paddingHorizontal: 32,
    alignItems: "center", justifyContent: "center",
    position: "relative",
  },
  orp:       { textAlign: "center" },
  wordCount:    { fontSize: 11, letterSpacing: 2 },
  wordCountBtn: { position: "absolute", bottom: 16, right: 20 },
  stagePauseHint: { position: "absolute", bottom: 14, left: 0, right: 0, textAlign: "center", fontSize: 10, letterSpacing: 1.5 },
  annDot: {
    position: "absolute", top: 14, right: 14,
    width: 8, height: 8, borderRadius: 4,
  },

  finishBadge: { alignItems: "center", gap: 10 },
  finishText:  { fontSize: 20, letterSpacing: 3 },
  finishSub:   { fontSize: 12, letterSpacing: 2 },

  annCard: {
    width: "100%", maxWidth: 720, marginTop: 16,
    borderWidth: 1, borderRadius: 12,
    padding: 16, gap: 10,
  },
  annCardHeader:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  annCardLabel:   { fontSize: 11, letterSpacing: 2 },
  annCardText:    { fontSize: 14, lineHeight: 21 },
  annCardActions: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  annActionBtn: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 7,
  },

  progressWrap: { width: "100%", height: 6, borderRadius: 99, overflow: "hidden" },
  progressBar:  { height: "100%", borderRadius: 99 },
  chapterMark:  { position: "absolute", top: 0, width: 2, height: "100%", opacity: 0.6 },

  mainControls: {
    width: "100%", maxWidth: 720, marginTop: 24,
    flexDirection: "row", gap: 14, alignItems: "center",
    justifyContent: "center",
  },
  secondaryControls: {
    width: "100%", maxWidth: 720, marginTop: 10,
    flexDirection: "row", gap: 10, alignItems: "center",
    justifyContent: "center",
  },
  btn: {
    borderWidth: 1.5, borderRadius: 8,
    paddingHorizontal: 20, paddingVertical: 10,
    minWidth: 70, alignItems: "center",
  },
  btnLarge: {
    paddingHorizontal: 36, paddingVertical: 14, minWidth: 110, borderRadius: 12,
  },
  btnSmall: {
    paddingHorizontal: 14, paddingVertical: 6, minWidth: 50,
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
  settingControl:{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" },
  chipBtn:       { paddingHorizontal: 14, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  colorDot:      { width: 24, height: 24, borderRadius: 12, borderWidth: 2.5 },

  customPausePanel: {
    borderWidth: 1, borderRadius: 10,
    padding: 14, gap: 14, marginTop: 4,
  },
  customPauseRow:     { gap: 4 },
  customPauseLabel:   { fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase" },
  customPauseControl: { flexDirection: "row", alignItems: "center", gap: 10 },
  customPauseValue:   { fontSize: 13, minWidth: 38, textAlign: "right" },

  // Annotation modal
  modalOverlay: {
    flex: 1, justifyContent: "center", alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.6)", padding: 24,
  },
  modalBox: {
    width: "100%", maxWidth: 480,
    borderRadius: 16, padding: 24, gap: 10,
  },
  modalTitle: { fontSize: 15, letterSpacing: 2, marginBottom: 2 },
  modalSub:   { fontSize: 12, letterSpacing: 1, marginBottom: 8 },
  inputLabel: { fontSize: 11, letterSpacing: 2 },
  textInput: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, minHeight: 40,
  },
  inputHint:    { fontSize: 11, lineHeight: 16 },
  modalActions: { flexDirection: "row", gap: 10, justifyContent: "flex-end", marginTop: 8 },
  modalBtn: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 20, paddingVertical: 10,
  },

  // Context panel
  ctxPanel: {
    width: "100%", maxWidth: 720, marginTop: 16,
    maxHeight: 480, borderWidth: 1, borderRadius: 12,
  },
  ctxContent:  { padding: 14 },
  ctxHeader:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 },
  ctxToggle:   { paddingHorizontal: 4 },
  ctxWords:    { flexDirection: "row", flexWrap: "wrap" },
  ctxWord:     { fontSize: 14, lineHeight: 22, paddingHorizontal: 2 },
  ctxSentence: { marginBottom: 10 },
  ctxPageText: { fontSize: 14 },
});

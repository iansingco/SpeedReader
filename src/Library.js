import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  Image,
  Alert,
  Modal,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  Platform,
  ActivityIndicator,
  Dimensions,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { THEMES, MONO } from "./constants";
import * as storage from "./storage";
import { parseFile, tokenize, makeBookId } from "./parsers";
import CalibreModal from "./CalibreModal";

const ACCEPTED_TYPES = [
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/epub+zip",
  "application/x-mobipocket-ebook",
  "application/vnd.amazon.ebook",
  "application/x-mobi8-ebook",
];

// ── book card ──────────────────────────────────────────────────────────────────

function BookCard({ book, onPress, onLongPress, t }) {
  const progress = book.wordCount > 0 ? book.lastPosition / book.wordCount : 0;
  const pct      = Math.min(100, Math.round(progress * 100));

  return (
    <TouchableOpacity
      style={[cs.card, { backgroundColor: t.surface }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.75}
    >
      {/* Cover */}
      <View style={cs.coverWrap}>
        {book.coverDataUrl ? (
          <Image source={{ uri: book.coverDataUrl }} style={cs.cover} resizeMode="cover" />
        ) : (
          <View style={[cs.coverPlaceholder, { backgroundColor: t.bg }]}>
            <Text style={[cs.coverInitial, { color: t.accent }]}>
              {(book.title || "?").charAt(0).toUpperCase()}
            </Text>
            <Text style={[cs.coverFmt, { color: t.muted, fontFamily: MONO }]}>
              {(book.format || "").toUpperCase()}
            </Text>
          </View>
        )}
        {/* Reading progress bar */}
        {pct > 0 && (
          <View style={cs.progressWrap}>
            <View style={[cs.progressBar, { width: `${pct}%`, backgroundColor: t.accent }]} />
          </View>
        )}
      </View>

      {/* Info */}
      <View style={cs.cardInfo}>
        <Text style={[cs.cardTitle, { color: t.text }]} numberOfLines={2}>
          {book.title || book.id}
        </Text>
        {!!book.author && (
          <Text style={[cs.cardAuthor, { color: t.muted }]} numberOfLines={1}>
            {book.author}
          </Text>
        )}
        <View style={cs.cardMeta}>
          <Text style={[cs.fmtBadge, { color: t.accent, borderColor: t.accent + "55" }]}>
            {(book.format || "").toUpperCase()}
          </Text>
          {pct > 0 && (
            <Text style={[cs.pctText, { color: t.muted, fontFamily: MONO }]}>{pct}%</Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function Library({ theme, onChangeTheme, onOpenBook }) {
  const [books,        setBooks]        = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [loadingName,  setLoadingName]  = useState("");
  const [loadError,    setLoadError]    = useState(null);
  const [showCalibre,  setShowCalibre]  = useState(false);
  const [openingId,    setOpeningId]    = useState(null);
  const [numCols,      setNumCols]      = useState(2);

  const t = THEMES[theme];

  // Responsive columns
  useEffect(() => {
    const update = () => {
      const w = Dimensions.get("window").width;
      setNumCols(w >= 900 ? 4 : w >= 600 ? 3 : 2);
    };
    update();
    const sub = Dimensions.addEventListener("change", update);
    return () => sub?.remove?.();
  }, []);

  // Load persisted library
  useEffect(() => {
    storage.getLibrary().then(setBooks);
  }, []);

  // ── open a book from library ─────────────────────────────────────────────────

  const openBook = useCallback(async (bookMeta) => {
    setOpeningId(bookMeta.id);
    try {
      const words       = await storage.getWords(bookMeta.id);
      const annotations = await storage.getAnnotations(bookMeta.id);
      onOpenBook({ ...bookMeta, words: words || [], annotations: annotations || {} });
    } finally {
      setOpeningId(null);
    }
  }, [onOpenBook]);

  // ── add a book from the file picker ─────────────────────────────────────────

  const addBook = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ACCEPTED_TYPES,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];

      setLoading(true);
      setLoadingName(asset.name);
      setLoadError(null);

      try {
        const { text, meta, annotations } = await parseFile(asset);
        const words  = tokenize(text);
        const bookId = makeBookId(asset.name);
        const ext    = asset.name.split(".").pop().toLowerCase();

        const bookMeta = {
          id:           bookId,
          title:        meta.title  || asset.name.replace(/\.[^.]+$/, ""),
          author:       meta.author || "",
          format:       ext,
          coverDataUrl: meta.coverDataUrl || null,
          wordCount:    words.length,
          lastPosition: 0,
          addedAt:      Date.now(),
          calibreId:    null,
        };

        await storage.upsertBook(bookMeta);
        await storage.setWords(bookId, words);
        if (Object.keys(annotations).length > 0)
          await storage.setAnnotations(bookId, annotations);

        setBooks(prev => {
          const idx = prev.findIndex(b => b.id === bookId);
          if (idx >= 0) { const u = [...prev]; u[idx] = bookMeta; return u; }
          return [bookMeta, ...prev];
        });

        // Auto-open immediately after adding
        onOpenBook({ ...bookMeta, words, annotations });
      } catch (err) {
        setLoadError(err.message);
        console.error("Parse error:", err);
      } finally {
        setLoading(false);
        setLoadingName("");
      }
    } catch (err) {
      console.error("File pick error:", err);
    }
  }, [onOpenBook]);

  // ── delete a book ────────────────────────────────────────────────────────────

  const deleteBook = useCallback((bookId) => {
    Alert.alert(
      "Remove Book",
      "Remove this book from your library? Reading progress and annotations will be lost.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            await storage.removeBook(bookId);
            setBooks(prev => prev.filter(b => b.id !== bookId));
          },
        },
      ]
    );
  }, []);

  // ── import from Calibre ──────────────────────────────────────────────────────

  const importCalibreBook = useCallback(async ({ uri, name, title, author, coverDataUrl, calibreId }) => {
    setLoading(true);
    setLoadingName(title || name);
    try {
      const asset  = { uri, name: name || `${title}.epub` };
      const { text, meta, annotations } = await parseFile(asset);
      const words  = tokenize(text);
      const bookId = calibreId ? `calibre_${calibreId}` : makeBookId(name);

      const bookMeta = {
        id:           bookId,
        title:        title  || meta.title  || name.replace(/\.[^.]+$/, ""),
        author:       author || meta.author || "",
        format:       "epub",
        coverDataUrl: coverDataUrl || meta.coverDataUrl || null,
        wordCount:    words.length,
        lastPosition: 0,
        addedAt:      Date.now(),
        calibreId:    calibreId || null,
      };

      await storage.upsertBook(bookMeta);
      await storage.setWords(bookId, words);
      if (Object.keys(annotations).length > 0)
        await storage.setAnnotations(bookId, annotations);

      setBooks(prev => {
        const idx = prev.findIndex(b => b.id === bookId);
        if (idx >= 0) { const u = [...prev]; u[idx] = bookMeta; return u; }
        return [bookMeta, ...prev];
      });

      setShowCalibre(false);
      onOpenBook({ ...bookMeta, words, annotations });
    } catch (err) {
      Alert.alert("Import Failed", err.message);
    } finally {
      setLoading(false);
      setLoadingName("");
    }
  }, [onOpenBook]);

  // ── render ───────────────────────────────────────────────────────────────────

  const isEmpty = books.length === 0;

  return (
    <SafeAreaView style={[cs.safe, { backgroundColor: t.bg }]}>
      <StatusBar barStyle={theme === "light" ? "dark-content" : "light-content"} />

      {/* Header */}
      <View style={[cs.header, { borderBottomColor: t.muted + "44" }]}>
        <Text style={[cs.logo, { color: t.accent, fontFamily: MONO }]}>⚡ SwiftRead</Text>
        <View style={cs.headerRight}>
          {["dark", "sepia", "light"].map(th => (
            <TouchableOpacity
              key={th}
              style={[cs.iconBtn, { borderColor: t.muted + "88" }]}
              onPress={() => onChangeTheme(th)}
            >
              <Text style={{ color: theme === th ? t.accent : t.muted, fontSize: 14 }}>
                {th === "dark" ? "◐" : th === "sepia" ? "☕" : "○"}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[cs.iconBtn, { borderColor: t.muted + "88" }]}
            onPress={() => setShowCalibre(true)}
          >
            <Text style={{ color: t.muted, fontSize: 11, fontFamily: MONO, letterSpacing: 1 }}>
              Calibre
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[cs.addBtn, { backgroundColor: t.accent }]}
            onPress={addBook}
          >
            <Text style={{ color: t.bg, fontFamily: MONO, fontSize: 18, lineHeight: 22 }}>+</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Loading banner */}
      {loading && (
        <View style={[cs.loadBanner, { backgroundColor: t.surface }]}>
          <ActivityIndicator size="small" color={t.accent} />
          <Text style={[cs.loadText, { color: t.muted, fontFamily: MONO }]}>
            {loadingName ? `Parsing ${loadingName}…` : "Loading…"}
          </Text>
        </View>
      )}
      {loadError && (
        <View style={[cs.loadBanner, { backgroundColor: "#2a0a0a" }]}>
          <Text style={[cs.loadText, { color: "#e05050" }]}>{loadError}</Text>
          <TouchableOpacity onPress={() => setLoadError(null)}>
            <Text style={{ color: "#e05050", marginLeft: 8 }}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Empty state */}
      {isEmpty ? (
        <View style={cs.emptyState}>
          <Text style={[cs.emptyTitle, { color: t.text }]}>Your library is empty</Text>
          <Text style={[cs.emptySub, { color: t.muted }]}>
            Add books to start reading
          </Text>
          <TouchableOpacity
            style={[cs.emptyBtn, { backgroundColor: t.accent }]}
            onPress={addBook}
          >
            <Text style={{ color: t.bg, fontFamily: MONO, fontSize: 14, fontWeight: "600" }}>
              Open a File
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[cs.emptyBtnOutline, { borderColor: t.muted + "66" }]}
            onPress={() => setShowCalibre(true)}
          >
            <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 13 }}>
              Connect Calibre
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          key={numCols}
          data={books}
          numColumns={numCols}
          keyExtractor={b => b.id}
          contentContainerStyle={cs.grid}
          renderItem={({ item }) => (
            <View style={{ flex: 1 / numCols, padding: 6 }}>
              <BookCard
                book={item}
                t={t}
                onPress={() => openBook(item)}
                onLongPress={() => deleteBook(item.id)}
              />
              {/* Opening spinner overlay */}
              {openingId === item.id && (
                <View style={cs.openingOverlay}>
                  <ActivityIndicator color={t.accent} />
                </View>
              )}
            </View>
          )}
        />
      )}

      <CalibreModal
        visible={showCalibre}
        onClose={() => setShowCalibre(false)}
        theme={theme}
        t={t}
        onImport={importCalibreBook}
      />
    </SafeAreaView>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const cs = StyleSheet.create({
  safe:   { flex: 1 },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  logo:        { fontSize: 13, letterSpacing: 3 },
  headerRight: { flexDirection: "row", gap: 8, alignItems: "center" },
  iconBtn: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  addBtn: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },

  loadBanner: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  loadText: { fontSize: 12, flex: 1 },

  emptyState: {
    flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 40,
  },
  emptyTitle: { fontSize: 20, fontWeight: "600" },
  emptySub:   { fontSize: 14 },
  emptyBtn: {
    paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: 10, marginTop: 8,
  },
  emptyBtnOutline: {
    paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: 10, borderWidth: 1,
  },

  grid: { padding: 10 },

  card: {
    borderRadius: 10, overflow: "hidden",
  },
  coverWrap: { width: "100%", aspectRatio: 0.67, position: "relative" },
  cover:     { width: "100%", height: "100%" },
  coverPlaceholder: {
    width: "100%", height: "100%",
    alignItems: "center", justifyContent: "center", gap: 6,
  },
  coverInitial: { fontSize: 40, fontWeight: "700" },
  coverFmt:     { fontSize: 11, letterSpacing: 2 },
  progressWrap: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    height: 4, backgroundColor: "rgba(0,0,0,0.3)",
  },
  progressBar: { height: "100%" },

  cardInfo: { padding: 10, gap: 3 },
  cardTitle:  { fontSize: 13, fontWeight: "600", lineHeight: 17 },
  cardAuthor: { fontSize: 11 },
  cardMeta:   { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 4 },
  fmtBadge: {
    fontSize: 10, fontFamily: MONO, letterSpacing: 1,
    paddingHorizontal: 5, paddingVertical: 2,
    borderRadius: 4, borderWidth: 1,
  },
  pctText: { fontSize: 10, letterSpacing: 1 },

  openingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center", justifyContent: "center",
    borderRadius: 10,
  },
});

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  Image,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  StatusBar,
  Platform,
  ActivityIndicator,
  Dimensions,
  TextInput,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { THEMES, MONO } from "./constants";
import * as storage from "./storage";
import { parseFile, tokenize, makeBookId } from "./parsers";
import CalibreModal from "./CalibreModal";
import ThemeDropdown from "./ThemeDropdown";

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

// ── book row (list view) ───────────────────────────────────────────────────────

function BookRow({ book, onPress, onLongPress, t }) {
  const progress = book.wordCount > 0 ? book.lastPosition / book.wordCount : 0;
  const pct      = Math.min(100, Math.round(progress * 100));

  return (
    <TouchableOpacity
      style={[cs.row, { borderBottomColor: t.muted + "22" }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.75}
    >
      <View style={cs.rowThumb}>
        {book.coverDataUrl ? (
          <Image source={{ uri: book.coverDataUrl }} style={cs.rowThumbImg} resizeMode="cover" />
        ) : (
          <View style={[cs.rowThumbPlaceholder, { backgroundColor: t.surface }]}>
            <Text style={[cs.coverInitial, { color: t.accent, fontSize: 22 }]}>
              {(book.title || "?").charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
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
        {pct > 0 && (
          <View style={[cs.rowProgressWrap, { backgroundColor: t.muted + "44" }]}>
            <View style={[cs.progressBar, { width: `${pct}%`, backgroundColor: t.accent }]} />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── local folders ─────────────────────────────────────────────────────────────

const SUPPORTED_EXTS = /\.(epub|mobi|azw|txt|md)$/i;
const KINDLE_DEFAULT = "file:///storage/emulated/0/Kindle";

function LocalFoldersModal({ visible, onClose, t, importedIds, onImport }) {
  const [folders,     setFolders]     = useState([]);
  const [newPath,     setNewPath]     = useState("");
  const [scanResults, setScanResults] = useState({});
  const [scanning,    setScanning]    = useState(false);
  const [scanError,   setScanError]   = useState("");

  useEffect(() => {
    if (!visible) return;
    storage.getLocalFolders().then(saved => {
      if (saved.length === 0 && Platform.OS === "android") {
        const defaults = [KINDLE_DEFAULT];
        setFolders(defaults);
        storage.saveLocalFolders(defaults);
      } else {
        setFolders(saved);
      }
    });
    setScanResults({});
    setScanError("");
  }, [visible]);

  const persistFolders = async (list) => {
    setFolders(list);
    await storage.saveLocalFolders(list);
  };

  const addFolder = () => {
    const raw = newPath.trim();
    if (!raw) return;
    const normalized = (Platform.OS !== "web" && !raw.startsWith("file://"))
      ? "file://" + raw
      : raw;
    if (folders.includes(normalized)) return;
    persistFolders([...folders, normalized]);
    setNewPath("");
  };

  const removeFolder = (path) => {
    persistFolders(folders.filter(f => f !== path));
    setScanResults(prev => { const n = { ...prev }; delete n[path]; return n; });
  };

  const scan = async () => {
    setScanning(true);
    setScanError("");
    const results = {};
    for (const folder of folders) {
      try {
        const items = await FileSystem.readDirectoryAsync(folder);
        results[folder] = items
          .filter(name => SUPPORTED_EXTS.test(name))
          .map(name => ({
            name,
            path: folder.replace(/\/$/, "") + "/" + name,
            format: name.split(".").pop().toLowerCase(),
          }));
      } catch {
        results[folder] = null;
      }
    }
    setScanResults(results);
    setScanning(false);
    const total = Object.values(results).reduce((s, r) => s + (r?.length ?? 0), 0);
    const inaccessible = Object.values(results).filter(r => r === null).length;
    if (total === 0 && folders.length > 0) {
      setScanError(
        inaccessible > 0
          ? "Folders not accessible. On Android 13+ grant 'All files access' in Settings → Apps → SwiftRead → Permissions."
          : "No supported books found in the configured folders."
      );
    }
  };

  const totalFound = Object.values(scanResults).reduce((s, r) => s + (r?.length ?? 0), 0);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={[cs.safe, { backgroundColor: t.bg }]}>
        <View style={[cs.header, { borderBottomColor: t.muted + "44" }]}>
          <Text style={[cs.logo, { color: t.accent, fontFamily: MONO }]}>Local Folders</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }}>
            <Text style={{ color: t.muted, fontSize: 20 }}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Scan local folders for EPUB, MOBI, AZW, TXT, and MD files.
            DRM-protected Kindle books cannot be read.
          </Text>

          {folders.map(folder => (
            <View key={folder} style={[cs.folderRow, { borderColor: t.muted + "33", backgroundColor: t.surface }]}>
              <Text style={{ color: t.text, flex: 1, fontSize: 11, fontFamily: MONO }} numberOfLines={2}>
                {folder}
              </Text>
              {scanResults[folder] === null && (
                <Text style={{ color: "#e05050", fontSize: 10, marginRight: 4 }}>✗</Text>
              )}
              {Array.isArray(scanResults[folder]) && (
                <Text style={{ color: t.accent, fontSize: 10, marginRight: 4, fontFamily: MONO }}>
                  {scanResults[folder].length}
                </Text>
              )}
              <TouchableOpacity onPress={() => removeFolder(folder)}>
                <Text style={{ color: t.muted, fontSize: 16, paddingLeft: 4 }}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              style={[cs.searchInput, { flex: 1, color: t.text, borderColor: t.muted + "44", backgroundColor: t.surface }]}
              value={newPath}
              onChangeText={setNewPath}
              placeholder={Platform.OS === "android" ? "/storage/emulated/0/Books" : "/path/to/books"}
              placeholderTextColor={t.muted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={addFolder}
            />
            <TouchableOpacity
              style={[cs.addBtn, { backgroundColor: t.accent, width: 56, borderRadius: 8 }]}
              onPress={addFolder}
            >
              <Text style={{ color: t.bg, fontFamily: MONO, fontSize: 13 }}>Add</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[cs.emptyBtn, { backgroundColor: scanning ? t.muted : t.accent, opacity: folders.length === 0 ? 0.4 : 1 }]}
            onPress={scan}
            disabled={scanning || folders.length === 0}
          >
            {scanning
              ? <ActivityIndicator color={t.bg} />
              : <Text style={{ color: t.bg, fontFamily: MONO, fontSize: 14, fontWeight: "600" }}>Scan Folders</Text>
            }
          </TouchableOpacity>

          {!!scanError && (
            <Text style={{ color: "#e05050", fontSize: 12 }}>{scanError}</Text>
          )}

          {totalFound > 0 && (
            <>
              <Text style={{ color: t.muted, fontFamily: MONO, fontSize: 10, letterSpacing: 1, marginTop: 8 }}>
                FOUND {totalFound} FILE{totalFound !== 1 ? "S" : ""}
              </Text>
              {Object.entries(scanResults).flatMap(([, items]) =>
                (items ?? []).map(item => {
                  const alreadyIn = importedIds.has(makeBookId(item.name));
                  return (
                    <View key={item.path} style={[cs.folderRow, { borderColor: t.muted + "22", backgroundColor: t.surface }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: t.text, fontSize: 13 }} numberOfLines={1}>{item.name}</Text>
                        <Text style={{ color: t.muted, fontSize: 10, fontFamily: MONO }}>{item.format.toUpperCase()}</Text>
                      </View>
                      {alreadyIn
                        ? <Text style={{ color: t.accent, fontSize: 11, fontFamily: MONO }}>✓ In library</Text>
                        : (
                          <TouchableOpacity
                            style={[cs.sortChip, { borderColor: t.accent, backgroundColor: t.accent + "22" }]}
                            onPress={() => onImport(item)}
                          >
                            <Text style={{ color: t.accent, fontSize: 11, fontFamily: MONO }}>Import</Text>
                          </TouchableOpacity>
                        )
                      }
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function Library({ theme, onChangeTheme, onOpenBook }) {
  const [books,        setBooks]        = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [loadingName,  setLoadingName]  = useState("");
  const [loadError,    setLoadError]    = useState(null);
  const [showCalibre,  setShowCalibre]  = useState(false);
  const [showFolders,  setShowFolders]  = useState(false);
  const [openingId,    setOpeningId]    = useState(null);
  const [numCols,      setNumCols]      = useState(2);
  const [searchQuery,  setSearchQuery]  = useState("");
  const [listView,     setListView]     = useState(false);
  const [sortBy,       setSortBy]       = useState("recent");

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
      const [words, annotations, chapters] = await Promise.all([
        storage.getWords(bookMeta.id),
        storage.getAnnotations(bookMeta.id),
        storage.getChapters(bookMeta.id),
      ]);
      onOpenBook({ ...bookMeta, words: words || [], annotations: annotations || {}, chapters: chapters || [] });
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
        const { text, meta, annotations, chapters = [] } = await parseFile(asset);
        const words  = tokenize(text);
        if (!words.length) throw new Error("No readable text found. The file may be DRM-protected or in an unsupported format.");
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
        if (chapters.length > 0)
          await storage.setChapters(bookId, chapters);

        setBooks(prev => {
          const idx = prev.findIndex(b => b.id === bookId);
          if (idx >= 0) { const u = [...prev]; u[idx] = bookMeta; return u; }
          return [bookMeta, ...prev];
        });

        // Auto-open immediately after adding
        onOpenBook({ ...bookMeta, words, annotations, chapters });
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

  // ── import from local path ───────────────────────────────────────────────────

  const importedIds = useMemo(() => new Set(books.map(b => b.id)), [books]);

  const importLocalBook = useCallback(async (item) => {
    setLoading(true);
    setLoadingName(item.name);
    setLoadError(null);
    try {
      const asset = { uri: item.path, name: item.name };
      const { text, meta, annotations, chapters = [] } = await parseFile(asset);
      const words = tokenize(text);
      if (!words.length) throw new Error("No readable text found. The file may be DRM-protected.");
      const bookId = makeBookId(item.name);
      const bookMeta = {
        id:           bookId,
        title:        meta.title  || item.name.replace(/\.[^.]+$/, ""),
        author:       meta.author || "",
        format:       item.format,
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
      if (chapters.length > 0)
        await storage.setChapters(bookId, chapters);
      setBooks(prev => {
        const idx = prev.findIndex(b => b.id === bookId);
        if (idx >= 0) { const u = [...prev]; u[idx] = bookMeta; return u; }
        return [bookMeta, ...prev];
      });
      setShowFolders(false);
      onOpenBook({ ...bookMeta, words, annotations, chapters });
    } catch (err) {
      Alert.alert("Import Failed", err.message);
    } finally {
      setLoading(false);
      setLoadingName("");
    }
  }, [onOpenBook]);

  // ── import from Calibre ──────────────────────────────────────────────────────

  const importCalibreBook = useCallback(async ({ uri, name, title, author, coverDataUrl, calibreId }) => {
    setLoading(true);
    setLoadingName(title || name);
    try {
      // On web, download to a blob URL first so the parser gets a stable
      // local reference rather than re-fetching through the proxy.
      let parseUri = uri;
      if (Platform.OS === "web") {
        const res = await fetch(uri);
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        parseUri = URL.createObjectURL(await res.blob());
      }
      const assetName = name || `${title}.epub`;
      const asset  = { uri: parseUri, name: assetName };
      const { text, meta, annotations, chapters = [] } = await parseFile(asset);
      if (Platform.OS === "web" && parseUri !== uri) URL.revokeObjectURL(parseUri);
      const words  = tokenize(text);
      if (!words.length) throw new Error("No readable text found. The file may be DRM-protected or in an unsupported format.");
      const bookId = calibreId ? `calibre_${calibreId}` : makeBookId(name);
      const ext    = assetName.split(".").pop().toLowerCase();

      const bookMeta = {
        id:           bookId,
        title:        title  || meta.title  || assetName.replace(/\.[^.]+$/, ""),
        author:       author || meta.author || "",
        format:       ext,
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
      if (chapters.length > 0)
        await storage.setChapters(bookId, chapters);

      setBooks(prev => {
        const idx = prev.findIndex(b => b.id === bookId);
        if (idx >= 0) { const u = [...prev]; u[idx] = bookMeta; return u; }
        return [bookMeta, ...prev];
      });

      setShowCalibre(false);
      onOpenBook({ ...bookMeta, words, annotations, chapters });
    } catch (err) {
      Alert.alert("Import Failed", err.message);
    } finally {
      setLoading(false);
      setLoadingName("");
    }
  }, [onOpenBook]);

  // ── filter + sort ────────────────────────────────────────────────────────────

  const displayedBooks = useMemo(() => {
    let list = [...books];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(b =>
        (b.title  || "").toLowerCase().includes(q) ||
        (b.author || "").toLowerCase().includes(q)
      );
    }
    if (sortBy === "title")  list.sort((a, b) => (a.title  || "").localeCompare(b.title  || ""));
    if (sortBy === "author") list.sort((a, b) => (a.author || "").localeCompare(b.author || ""));
    if (sortBy === "read")   list.sort((a, b) => (b.lastPosition || 0) - (a.lastPosition || 0));
    return list;
  }, [books, searchQuery, sortBy]);

  // ── render ───────────────────────────────────────────────────────────────────

  const isEmpty = books.length === 0;

  return (
    <SafeAreaView style={[cs.safe, { backgroundColor: t.bg }]}>
      <StatusBar barStyle={theme === "light" ? "dark-content" : "light-content"} />

      {/* Header */}
      <View style={[cs.header, { borderBottomColor: t.muted + "44" }]}>
        <Text style={[cs.logo, { color: t.accent, fontFamily: MONO }]}>⚡ SwiftRead</Text>
        <View style={cs.headerRight}>
          <ThemeDropdown theme={theme} onChange={onChangeTheme} t={t} />
          <TouchableOpacity
            style={[cs.iconBtn, { borderColor: t.muted + "88" }]}
            onPress={() => setShowFolders(true)}
          >
            <Text style={{ color: t.muted, fontSize: 11, fontFamily: MONO, letterSpacing: 1 }}>
              Folders
            </Text>
          </TouchableOpacity>
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

      {/* Search + view controls (hidden when library is empty) */}
      {!isEmpty && (
        <View style={[cs.searchRow, { borderBottomColor: t.muted + "22" }]}>
          <TextInput
            style={[cs.searchInput, { color: t.text, borderColor: t.muted + "44", backgroundColor: t.surface }]}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search title or author…"
            placeholderTextColor={t.muted}
            clearButtonMode="while-editing"
          />
          <TouchableOpacity
            style={[cs.iconBtn, { borderColor: t.muted + "44" }]}
            onPress={() => setListView(v => !v)}
          >
            <Text style={{ color: listView ? t.accent : t.muted, fontSize: 16, lineHeight: 20 }}>
              {listView ? "⊟" : "⊞"}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {!isEmpty && (
        <View style={cs.sortRow}>
          {[["recent", "Recent"], ["read", "Last Read"], ["title", "Title"], ["author", "Author"]].map(([key, label]) => (
            <TouchableOpacity
              key={key}
              style={[cs.sortChip, { borderColor: sortBy === key ? t.accent : t.muted + "44", backgroundColor: sortBy === key ? t.accent + "22" : "transparent" }]}
              onPress={() => setSortBy(key)}
            >
              <Text style={{ color: sortBy === key ? t.accent : t.muted, fontSize: 10, fontFamily: MONO }}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
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
        <>
          {displayedBooks.length === 0 && (
            <View style={{ padding: 40, alignItems: "center" }}>
              <Text style={{ color: t.muted, fontSize: 14 }}>No books match your search.</Text>
            </View>
          )}
          <FlatList
            key={(listView ? "L" : "G") + numCols}
            data={displayedBooks}
            numColumns={listView ? 1 : numCols}
            keyExtractor={b => b.id}
            contentContainerStyle={listView ? cs.listGrid : cs.grid}
            renderItem={({ item }) => listView ? (
              <View style={{ position: "relative" }}>
                <BookRow
                  book={item}
                  t={t}
                  onPress={() => openBook(item)}
                  onLongPress={() => deleteBook(item.id)}
                />
                {openingId === item.id && (
                  <View style={[cs.openingOverlay, { borderRadius: 0 }]}>
                    <ActivityIndicator color={t.accent} />
                  </View>
                )}
              </View>
            ) : (
              <View style={{ flex: 1 / numCols, padding: 6 }}>
                <BookCard
                  book={item}
                  t={t}
                  onPress={() => openBook(item)}
                  onLongPress={() => deleteBook(item.id)}
                />
                {openingId === item.id && (
                  <View style={cs.openingOverlay}>
                    <ActivityIndicator color={t.accent} />
                  </View>
                )}
              </View>
            )}
          />
        </>
      )}

      <LocalFoldersModal
        visible={showFolders}
        onClose={() => setShowFolders(false)}
        t={t}
        importedIds={importedIds}
        onImport={importLocalBook}
      />
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
  safe:   { flex: 1, paddingTop: Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0 },
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

  grid:     { padding: 10 },
  listGrid: { paddingHorizontal: 12, paddingVertical: 6 },

  searchRow: {
    flexDirection: "row", gap: 8, alignItems: "center",
    paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1,
  },
  searchInput: {
    flex: 1, borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 7, fontSize: 14,
  },
  sortRow: {
    flexDirection: "row", gap: 6, flexWrap: "wrap",
    paddingHorizontal: 12, paddingVertical: 8,
  },
  sortChip: {
    paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: 6, borderWidth: 1,
  },

  row: {
    flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  rowThumb:            { width: 52, height: 78, borderRadius: 6, overflow: "hidden" },
  rowThumbImg:         { width: "100%", height: "100%" },
  rowThumbPlaceholder: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  rowProgressWrap:     { height: 3, borderRadius: 99, marginTop: 4 },

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

  folderRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderRadius: 8, padding: 10,
  },
  openingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center", justifyContent: "center",
    borderRadius: 10,
  },
});

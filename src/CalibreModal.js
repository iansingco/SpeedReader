import { useState, useEffect } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Alert,
  ScrollView,
} from "react-native";
import * as FileSystem from "expo-file-system";
import { MONO } from "./constants";
import { getCalibreConfig, saveCalibreConfig } from "./storage";

// ── helpers ───────────────────────────────────────────────────────────────────

function basicAuthHeader(user, pass) {
  if (!user) return {};
  return { Authorization: "Basic " + btoa(`${user}:${pass}`) };
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── CalibreModal ──────────────────────────────────────────────────────────────

export default function CalibreModal({ visible, onClose, theme, t, onImport }) {
  const [url,        setUrl]        = useState("http://localhost:8080");
  const [username,   setUsername]   = useState("");
  const [password,   setPassword]   = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connected,  setConnected]  = useState(false);
  const [libraryId,  setLibraryId]  = useState("");
  const [books,      setBooks]      = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);
  const [importing,  setImporting]  = useState({});

  // Restore saved config on open
  useEffect(() => {
    if (!visible) return;
    getCalibreConfig().then(cfg => {
      if (cfg) {
        setUrl(cfg.url || "http://localhost:8080");
        setUsername(cfg.username || "");
        // Don't restore password for security
        setConnected(false);
        setBooks([]);
      }
    });
  }, [visible]);

  const headers = () => basicAuthHeader(username, password);

  // ── connect ──────────────────────────────────────────────────────────────────

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/ajax/library-info`, {
        headers: headers(),
      });
      if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
      const info = await res.json();
      const lib  = info.default_library || Object.keys(info.library_map || {})[0] || "Calibre_Library";
      setLibraryId(lib);
      setConnected(true);
      await saveCalibreConfig({ url: url.replace(/\/$/, ""), username });
      fetchBooks(lib);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("CORS")) {
        setError(
          "Could not reach Calibre server.\n\n" +
          "On web browsers, you must enable \"Allow CORS\" in Calibre → Preferences → Sharing → Content Server → Advanced.\n\n" +
          "On the native app, make sure the server URL is reachable on your network."
        );
      } else {
        setError(`Connection failed: ${msg}`);
      }
    } finally {
      setConnecting(false);
    }
  };

  // ── fetch book list ───────────────────────────────────────────────────────────

  const fetchBooks = async (libId) => {
    setLoading(true);
    setError(null);
    const base = url.replace(/\/$/, "");
    try {
      // Search returns up to 100 book IDs
      const searchRes  = await fetch(
        `${base}/ajax/search?num=100&sort=title&library_id=${encodeURIComponent(libId)}`,
        { headers: headers() }
      );
      if (!searchRes.ok) throw new Error(`Search failed: HTTP ${searchRes.status}`);
      const searchData = await searchRes.json();
      const ids        = (searchData.book_ids || []).slice(0, 100);
      if (!ids.length) { setBooks([]); return; }

      const booksRes  = await fetch(
        `${base}/ajax/books?ids=${ids.join(",")}&fields=title,authors,cover&library_id=${encodeURIComponent(libId)}`,
        { headers: headers() }
      );
      if (!booksRes.ok) throw new Error(`Books fetch failed: HTTP ${booksRes.status}`);
      const booksData = await booksRes.json();

      setBooks(
        Object.entries(booksData).map(([id, d]) => ({
          calibreId:  id,
          title:      d.title  || "Unknown",
          author:     Array.isArray(d.authors) ? d.authors[0] : (d.authors || ""),
          hasCover:   !!d.cover,
          coverUrl:   d.cover
            ? `${base}/get/cover/${id}/${encodeURIComponent(libId)}`
            : null,
          epubUrl:    `${base}/get/EPUB/${id}/${encodeURIComponent(libId)}`,
        }))
      );
    } catch (e) {
      setError(`Failed to load books: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  // ── import a single book ──────────────────────────────────────────────────────

  const importBook = async (book) => {
    setImporting(prev => ({ ...prev, [book.calibreId]: true }));
    try {
      let epubUri      = book.epubUrl;
      let coverDataUrl = null;

      // On native, download to cache first
      if (Platform.OS !== "web") {
        const dest   = FileSystem.cacheDirectory + `calibre_${book.calibreId}.epub`;
        const result = await FileSystem.downloadAsync(book.epubUrl, dest, {
          headers: headers(),
        });
        if (result.status !== 200) throw new Error(`Download failed: HTTP ${result.status}`);
        epubUri = result.uri;
      }

      // Fetch cover as data URL
      if (book.coverUrl) {
        try {
          if (Platform.OS === "web") {
            const res  = await fetch(book.coverUrl, { headers: headers() });
            const blob = await res.blob();
            coverDataUrl = await blobToDataUrl(blob);
          } else {
            const dest   = FileSystem.cacheDirectory + `calibre_cover_${book.calibreId}.jpg`;
            const result = await FileSystem.downloadAsync(book.coverUrl, dest, {
              headers: headers(),
            });
            if (result.status === 200) {
              const b64 = await FileSystem.readAsStringAsync(result.uri, {
                encoding: FileSystem.EncodingType.Base64,
              });
              coverDataUrl = `data:image/jpeg;base64,${b64}`;
            }
          }
        } catch { /* cover is optional */ }
      }

      await onImport({
        uri:         epubUri,
        name:        `${book.title}.epub`,
        title:       book.title,
        author:      book.author,
        coverDataUrl,
        calibreId:   book.calibreId,
      });
    } catch (e) {
      Alert.alert("Import Failed", e.message);
    } finally {
      setImporting(prev => ({ ...prev, [book.calibreId]: false }));
    }
  };

  // ── render ────────────────────────────────────────────────────────────────────

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={ms.overlay}>
        <View style={[ms.sheet, { backgroundColor: t.bg }]}>

          {/* Header */}
          <View style={[ms.sheetHeader, { borderBottomColor: t.muted + "44" }]}>
            <Text style={[ms.sheetTitle, { color: t.text, fontFamily: MONO }]}>
              Calibre Content Server
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={{ color: t.muted, fontSize: 20 }}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={ms.body} keyboardShouldPersistTaps="handled">

            {/* Connection form */}
            {!connected && (
              <View style={ms.formGroup}>
                <Text style={[ms.label, { color: t.muted, fontFamily: MONO }]}>SERVER URL</Text>
                <TextInput
                  style={[ms.input, { color: t.text, borderColor: t.muted + "44", backgroundColor: t.surface }]}
                  value={url}
                  onChangeText={setUrl}
                  placeholder="http://192.168.1.x:8080"
                  placeholderTextColor={t.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <Text style={[ms.label, { color: t.muted, fontFamily: MONO, marginTop: 12 }]}>
                  USERNAME (optional)
                </Text>
                <TextInput
                  style={[ms.input, { color: t.text, borderColor: t.muted + "44", backgroundColor: t.surface }]}
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Leave blank if no auth"
                  placeholderTextColor={t.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                {!!username && (
                  <>
                    <Text style={[ms.label, { color: t.muted, fontFamily: MONO, marginTop: 12 }]}>
                      PASSWORD
                    </Text>
                    <TextInput
                      style={[ms.input, { color: t.text, borderColor: t.muted + "44", backgroundColor: t.surface }]}
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      placeholder="Password"
                      placeholderTextColor={t.muted}
                    />
                  </>
                )}

                {!!error && (
                  <Text style={[ms.errorText, { color: "#e05050" }]}>{error}</Text>
                )}

                <TouchableOpacity
                  style={[ms.connectBtn, { backgroundColor: t.accent }]}
                  onPress={connect}
                  disabled={connecting}
                >
                  {connecting
                    ? <ActivityIndicator color={t.bg} />
                    : <Text style={{ color: t.bg, fontFamily: MONO, fontWeight: "600" }}>Connect</Text>
                  }
                </TouchableOpacity>

                <Text style={[ms.hint, { color: t.muted }]}>
                  Calibre must have its Content Server running (Preferences → Sharing → Content Server → Start Server).{"\n"}
                  On web browsers, also enable "Allow CORS" in Advanced options.
                </Text>
              </View>
            )}

            {/* Connected — book list */}
            {connected && (
              <>
                <View style={ms.connectedRow}>
                  <Text style={[ms.connectedText, { color: t.accent, fontFamily: MONO }]}>
                    ✓ Connected · {libraryId}
                  </Text>
                  <TouchableOpacity onPress={() => { setConnected(false); setBooks([]); }}>
                    <Text style={{ color: t.muted, fontSize: 12, fontFamily: MONO }}>Disconnect</Text>
                  </TouchableOpacity>
                </View>

                {loading && (
                  <View style={ms.loadingRow}>
                    <ActivityIndicator color={t.accent} />
                    <Text style={{ color: t.muted, marginLeft: 10, fontFamily: MONO, fontSize: 12 }}>
                      Loading library…
                    </Text>
                  </View>
                )}

                {!!error && (
                  <Text style={[ms.errorText, { color: "#e05050" }]}>{error}</Text>
                )}

                {books.map(book => (
                  <View
                    key={book.calibreId}
                    style={[ms.bookRow, { borderBottomColor: t.muted + "22" }]}
                  >
                    {book.coverUrl ? (
                      <Image
                        source={{ uri: book.coverUrl, headers: headers() }}
                        style={ms.thumb}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[ms.thumbPlaceholder, { backgroundColor: t.surface }]}>
                        <Text style={{ color: t.accent, fontSize: 18, fontWeight: "700" }}>
                          {book.title.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={[ms.bookTitle, { color: t.text }]} numberOfLines={2}>
                        {book.title}
                      </Text>
                      {!!book.author && (
                        <Text style={[ms.bookAuthor, { color: t.muted }]} numberOfLines={1}>
                          {book.author}
                        </Text>
                      )}
                    </View>
                    <TouchableOpacity
                      style={[ms.importBtn, { borderColor: t.accent }]}
                      onPress={() => importBook(book)}
                      disabled={!!importing[book.calibreId]}
                    >
                      {importing[book.calibreId]
                        ? <ActivityIndicator size="small" color={t.accent} />
                        : <Text style={{ color: t.accent, fontFamily: MONO, fontSize: 12 }}>Import</Text>
                      }
                    </TouchableOpacity>
                  </View>
                ))}

                {!loading && !books.length && !error && (
                  <Text style={{ color: t.muted, textAlign: "center", marginTop: 24 }}>
                    No books found in this library.
                  </Text>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const ms = StyleSheet.create({
  overlay: {
    flex: 1, justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: "85%",
  },
  sheetHeader: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    padding: 20, borderBottomWidth: 1,
  },
  sheetTitle: { fontSize: 15, letterSpacing: 2 },
  body:       { padding: 20, gap: 0 },

  formGroup: { gap: 4 },
  label:     { fontSize: 11, letterSpacing: 2, marginBottom: 4 },
  input: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14,
  },
  errorText: { fontSize: 12, marginTop: 8, lineHeight: 18 },
  connectBtn: {
    marginTop: 16, paddingVertical: 14, borderRadius: 10,
    alignItems: "center",
  },
  hint: { fontSize: 12, lineHeight: 18, marginTop: 16 },

  connectedRow: {
    flexDirection: "row", justifyContent: "space-between",
    alignItems: "center", marginBottom: 16,
  },
  connectedText: { fontSize: 12, letterSpacing: 1 },
  loadingRow: { flexDirection: "row", alignItems: "center", marginBottom: 12 },

  bookRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingVertical: 12, borderBottomWidth: 1,
  },
  thumb:            { width: 44, height: 66, borderRadius: 4 },
  thumbPlaceholder: {
    width: 44, height: 66, borderRadius: 4,
    alignItems: "center", justifyContent: "center",
  },
  bookTitle:  { fontSize: 14, fontWeight: "600" },
  bookAuthor: { fontSize: 12, marginTop: 2 },
  importBtn: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    minWidth: 60, alignItems: "center",
  },
});

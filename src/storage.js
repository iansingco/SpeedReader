import AsyncStorage from "@react-native-async-storage/async-storage";

const LIBRARY_KEY  = "sr_library_v1";
const WORDS_PREFIX = "sr_words_v1_";
const ANN_PREFIX   = "sr_ann_v1_";
const CALIBRE_KEY  = "sr_calibre_v1";

// ── library list (metadata only, no words) ────────────────────────────────────

export async function getLibrary() {
  try {
    const json = await AsyncStorage.getItem(LIBRARY_KEY);
    return json ? JSON.parse(json) : [];
  } catch { return []; }
}

async function saveLibraryList(list) {
  await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
}

export async function upsertBook(book) {
  const list = await getLibrary();
  const idx  = list.findIndex(b => b.id === book.id);
  if (idx >= 0) list[idx] = book;
  else          list.unshift(book); // newest first
  await saveLibraryList(list);
}

export async function removeBook(bookId) {
  const list = await getLibrary();
  await saveLibraryList(list.filter(b => b.id !== bookId));
  await AsyncStorage.removeItem(WORDS_PREFIX + bookId);
  await AsyncStorage.removeItem(ANN_PREFIX + bookId);
}

export async function updatePosition(bookId, position) {
  const list = await getLibrary();
  const idx  = list.findIndex(b => b.id === bookId);
  if (idx >= 0) {
    list[idx].lastPosition = position;
    await saveLibraryList(list);
  }
}

// ── words (stored separately to keep library list fast to load) ───────────────

export async function getWords(bookId) {
  try {
    const json = await AsyncStorage.getItem(WORDS_PREFIX + bookId);
    return json ? JSON.parse(json) : null;
  } catch { return null; }
}

export async function setWords(bookId, words) {
  await AsyncStorage.setItem(WORDS_PREFIX + bookId, JSON.stringify(words));
}

// ── annotations ───────────────────────────────────────────────────────────────

export async function getAnnotations(bookId) {
  try {
    const json = await AsyncStorage.getItem(ANN_PREFIX + bookId);
    return json ? JSON.parse(json) : {};
  } catch { return {}; }
}

export async function setAnnotations(bookId, annotations) {
  await AsyncStorage.setItem(ANN_PREFIX + bookId, JSON.stringify(annotations));
}

export async function saveAnnotation(bookId, wordIndex, ann) {
  const anns = await getAnnotations(bookId);
  anns[wordIndex] = { ...ann, wordIndex };
  await AsyncStorage.setItem(ANN_PREFIX + bookId, JSON.stringify(anns));
  return anns;
}

export async function deleteAnnotation(bookId, wordIndex) {
  const anns = await getAnnotations(bookId);
  delete anns[wordIndex];
  await AsyncStorage.setItem(ANN_PREFIX + bookId, JSON.stringify(anns));
  return anns;
}

// ── calibre config ────────────────────────────────────────────────────────────

export async function getCalibreConfig() {
  try {
    const json = await AsyncStorage.getItem(CALIBRE_KEY);
    return json ? JSON.parse(json) : null;
  } catch { return null; }
}

export async function saveCalibreConfig(config) {
  await AsyncStorage.setItem(CALIBRE_KEY, JSON.stringify(config));
}

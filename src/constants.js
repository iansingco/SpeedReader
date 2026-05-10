import { Platform } from "react-native";

export const THEMES = {
  dark:  { bg: "#0a0a0f", surface: "#13131a", text: "#e8e4d9", accent: "#f0c040", muted: "#555" },
  sepia: { bg: "#1a1208", surface: "#221a0e", text: "#d4b896", accent: "#c8842a", muted: "#6a5030" },
  light: { bg: "#f5f0e8", surface: "#fffdf7", text: "#1a1a1a", accent: "#2563eb", muted: "#aaa" },
};

export const MONO = Platform.OS === "ios" ? "Courier" : "monospace";

export const WORD_COLORS = [
  { value: null,      dot: null },
  { value: "#ffffff", dot: "#ffffff" },
  { value: "#f0c040", dot: "#f0c040" },
  { value: "#4ade80", dot: "#4ade80" },
  { value: "#60a5fa", dot: "#60a5fa" },
  { value: "#f472b6", dot: "#f472b6" },
  { value: "#fb923c", dot: "#fb923c" },
];

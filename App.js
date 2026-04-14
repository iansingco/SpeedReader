import { useState, useCallback } from "react";
import { registerRootComponent } from "expo";
import Library from "./src/Library";
import SpeedReader from "./src/SpeedReader";
import * as storage from "./src/storage";

function App() {
  const [screen,      setScreen]      = useState("library");
  const [activeBook,  setActiveBook]  = useState(null);
  const [theme,       setTheme]       = useState("dark");

  const openBook = useCallback((book) => {
    setActiveBook(book);
    setScreen("reader");
  }, []);

  const handleBack = useCallback(() => {
    setScreen("library");
    setActiveBook(null);
  }, []);

  const handleProgress = useCallback((wordIndex) => {
    if (activeBook?.id) {
      storage.updatePosition(activeBook.id, wordIndex);
    }
  }, [activeBook]);

  if (screen === "reader") {
    return (
      <SpeedReader
        book={activeBook}
        onBack={handleBack}
        onProgress={handleProgress}
      />
    );
  }

  return (
    <Library
      theme={theme}
      onChangeTheme={setTheme}
      onOpenBook={openBook}
    />
  );
}

registerRootComponent(App);

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push("mjs");
config.resolver.assetExts = config.resolver.assetExts.filter(ext => ext !== "mjs");

// pdfjs-dist uses import.meta and Node canvas APIs incompatible with Hermes.
// Return an empty module on native platforms so it's never bundled into the APK.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform !== "web" && moduleName === "pdfjs-dist") {
    return { type: "empty" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

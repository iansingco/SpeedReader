const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push("mjs");
config.resolver.assetExts = config.resolver.assetExts.filter(ext => ext !== "mjs");

module.exports = config;

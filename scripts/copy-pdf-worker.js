const fs   = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const dst = path.join(__dirname, "..", "web", "pdf.worker.min.mjs");

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log("✓ pdf.worker.min.mjs copied to web/");

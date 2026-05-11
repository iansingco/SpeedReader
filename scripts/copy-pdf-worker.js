const fs   = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.js");
const dst = path.join(__dirname, "..", "web", "pdf.worker.min.js");

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log("✓ pdf.worker.min.js copied to web/");

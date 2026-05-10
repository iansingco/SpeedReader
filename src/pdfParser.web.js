export async function parsePDF(uri) {
  const pdfjsModule = await import("pdfjs-dist");
  const pdfjsLib = pdfjsModule.default ?? pdfjsModule;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

  const data = await (await fetch(uri)).arrayBuffer();
  const pdf  = await pdfjsLib.getDocument({ data }).promise;

  let title = "", author = "";
  try {
    const info = (await pdf.getMetadata())?.info;
    title  = info?.Title  || "";
    author = info?.Author || "";
  } catch {}

  let coverDataUrl = null;
  try {
    const page     = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas   = document.createElement("canvas");
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    coverDataUrl = canvas.toDataURL("image/jpeg", 0.7);
  } catch {}

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(" "));
  }

  return { text: pages.join("\n"), meta: { title, author, coverDataUrl }, annotations: {} };
}

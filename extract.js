// PDF extraction → markdown, with IndexedDB cache keyed by file SHA-1.

import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

// --- IndexedDB cache (single object store, key/value) ---

const DB_NAME = 'qm_cache';
const STORE = 'markdown';
let _dbPromise;

function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _dbPromise;
}

async function cacheGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function cacheSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// --- Hashing ---

export async function fileSha1(file) {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// --- Page text extraction ---

// Group text items into lines by y-position, then join lines with newlines.
// pdf.js returns items left-to-right, top-to-bottom roughly; grouping by
// rounded y gives us reasonable line structure.
function itemsToText(items) {
    const lines = new Map();
    for (const item of items) {
        if (!item.str) continue;
        const y = Math.round(item.transform[5]);
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push(item);
    }
    const sortedYs = [...lines.keys()].sort((a, b) => b - a);
    const out = [];
    for (const y of sortedYs) {
        const lineItems = lines.get(y).sort(
            (a, b) => a.transform[4] - b.transform[4]
        );
        out.push(lineItems.map(i => i.str).join(' ').trim());
    }
    return out.filter(Boolean).join('\n');
}

export async function extractPdfToMarkdown(file, { onProgress } = {}) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const pageBlocks = [];
    const ocrNeeded = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        if (onProgress) onProgress(i, pdf.numPages);
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = itemsToText(content.items);
        pageBlocks.push({ pageNum: i, text, needsOcr: text.trim().length < 10 });
        if (text.trim().length < 10) ocrNeeded.push(i);
    }

    // Markdown assembly — lenient, just per-page headings and text.
    const markdown = pageBlocks
        .map(b => `# Page ${b.pageNum}\n\n${b.text || '_(no extractable text — OCR required)_'}`)
        .join('\n\n---\n\n');

    return {
        markdown,
        numPages: pdf.numPages,
        ocrNeeded,
        pageBlocks,
    };
}

// --- Public extraction entry point with caching ---

export async function extractFileCached(file, { onProgress } = {}) {
    const hash = await fileSha1(file);
    const cached = await cacheGet(hash);
    if (cached) {
        return { ...cached, hash, cached: true };
    }
    const result = await extractPdfToMarkdown(file, { onProgress });
    const record = {
        filename: file.name,
        markdown: result.markdown,
        numPages: result.numPages,
        ocrNeeded: result.ocrNeeded,
        extractedAt: Date.now(),
    };
    await cacheSet(hash, record);
    return { ...record, hash, cached: false };
}

export async function updateCachedMarkdown(hash, markdown) {
    const existing = await cacheGet(hash);
    if (!existing) return;
    await cacheSet(hash, { ...existing, markdown, updatedAt: Date.now() });
}

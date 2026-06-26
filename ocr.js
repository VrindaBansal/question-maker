// OCR fallback for PDF pages with no extractable text layer.
// Renders the page with pdf.js, sends image to OpenAI vision.

import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OCR_MODEL = 'gpt-4o-mini';

export async function renderPageImage(file, pageNum, scale = 2) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.85);
}

export async function ocrImage(dataUrl, apiKey) {
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: OCR_MODEL,
            temperature: 0,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'Extract all text from this page exactly as written. Preserve paragraph breaks. Return only the text content — no commentary, no formatting markers. If the page is blank or unreadable, return an empty string.',
                    },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            }],
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`OCR ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
}

// Run a list of async tasks with bounded concurrency.
async function withConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    async function runOne() {
        while (i < items.length) {
            const idx = i++;
            try {
                results[idx] = await worker(items[idx], idx);
            } catch (err) {
                results[idx] = { error: err };
            }
        }
    }
    const runners = Array.from({ length: Math.min(limit, items.length) }, runOne);
    await Promise.all(runners);
    return results;
}

// Replace OCR-placeholder blocks in markdown with the OCR'd text.
function replacePlaceholder(markdown, pageNum, text) {
    const header = `# Page ${pageNum}`;
    const placeholder = '_(no extractable text — OCR required)_';
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `(${escapedHeader}\\n\\n)${placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    );
    return markdown.replace(pattern, (_, prefix) => `${prefix}${text || '_(blank page)_'}`);
}

export async function ocrPagesIntoMarkdown(file, markdown, pageNums, apiKey, { onProgress } = {}) {
    let working = markdown;
    let done = 0;
    await withConcurrency(pageNums, 4, async (pageNum) => {
        const dataUrl = await renderPageImage(file, pageNum);
        const text = await ocrImage(dataUrl, apiKey);
        working = replacePlaceholder(working, pageNum, text);
        done += 1;
        if (onProgress) onProgress(done, pageNums.length);
    });
    return working;
}

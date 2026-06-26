// Question Maker — main app

import { extractFileCached, updateCachedMarkdown } from './extract.js';
import { ocrPagesIntoMarkdown } from './ocr.js';
import { combineMarkdowns, generateQuiz } from './generate.js';
import { startQuiz, wireQuizControls } from './quiz.js';

const KEY_STORAGE = 'qm_openai_key';

// --- API key handling ---

function getKey() {
    return localStorage.getItem(KEY_STORAGE) || '';
}

function setKey(key) {
    localStorage.setItem(KEY_STORAGE, key);
}

function promptForKey() {
    const modal = document.getElementById('keyModal');
    const input = document.getElementById('keyInput');
    input.value = getKey();
    modal.hidden = false;
    input.focus();
    return new Promise((resolve) => {
        const save = () => {
            const v = input.value.trim();
            if (v) {
                setKey(v);
                modal.hidden = true;
                cleanup();
                resolve(true);
            }
        };
        const cancel = () => {
            modal.hidden = true;
            cleanup();
            resolve(false);
        };
        const onKey = (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
        };
        function cleanup() {
            document.getElementById('keySaveBtn').removeEventListener('click', save);
            document.getElementById('keyCancelBtn').removeEventListener('click', cancel);
            input.removeEventListener('keydown', onKey);
        }
        document.getElementById('keySaveBtn').addEventListener('click', save);
        document.getElementById('keyCancelBtn').addEventListener('click', cancel);
        input.addEventListener('keydown', onKey);
    });
}

async function ensureKey() {
    if (getKey()) return true;
    return await promptForKey();
}

// --- File handling ---

const state = {
    files: [],  // [{ id, file, status, hash?, markdown?, numPages?, ocrNeeded?, error?, progress? }]
    quiz: null, // { questions, chunksUsed, sourceMarkdown }
    history: { previousStems: [], excludeChunkIds: [], flaggedStems: [] },
};

function addFiles(fileList) {
    for (const file of fileList) {
        if (file.type !== 'application/pdf') {
            showStatus(`Skipped "${file.name}" — only PDFs are supported.`, 'error');
            continue;
        }
        if (state.files.some(f => f.file.name === file.name && f.file.size === file.size)) {
            continue;
        }
        const entry = {
            id: crypto.randomUUID(),
            file,
            status: 'extracting',
        };
        state.files.push(entry);
        kickExtraction(entry);
    }
    renderFileList();
    updateControls();
}

async function kickExtraction(entry) {
    try {
        const result = await extractFileCached(entry.file, {
            onProgress: (page, total) => {
                entry.progress = { page, total };
                renderFileList();
            },
        });
        entry.hash = result.hash;
        entry.markdown = result.markdown;
        entry.numPages = result.numPages;
        entry.ocrNeeded = result.ocrNeeded || [];
        entry.cached = result.cached;
        entry.status = 'ready';
        delete entry.progress;
    } catch (err) {
        console.error('extract failed', entry.file.name, err);
        entry.status = 'error';
        entry.error = err?.message || 'extract failed';
    }
    renderFileList();
    updateControls();

    // Auto-run OCR if a key is already configured.
    if (entry.status === 'ready' && entry.ocrNeeded.length > 0 && getKey()) {
        runOcr(entry);
    }
}

async function runOcr(entry) {
    if (!entry.ocrNeeded?.length) return;
    const key = getKey();
    if (!key) return;
    entry.status = 'ocr';
    entry.progress = { page: 0, total: entry.ocrNeeded.length };
    renderFileList();
    updateControls();
    try {
        const updated = await ocrPagesIntoMarkdown(
            entry.file,
            entry.markdown,
            entry.ocrNeeded,
            key,
            {
                onProgress: (done, total) => {
                    entry.progress = { page: done, total };
                    renderFileList();
                },
            },
        );
        entry.markdown = updated;
        entry.ocrNeeded = [];
        entry.status = 'ready';
        delete entry.progress;
        await updateCachedMarkdown(entry.hash, updated);
    } catch (err) {
        console.error('ocr failed', entry.file.name, err);
        entry.status = 'error';
        entry.error = err?.message || 'OCR failed';
    }
    renderFileList();
    updateControls();
}

async function ensurePendingOcrRuns() {
    const pending = state.files.filter(
        f => f.status === 'ready' && f.ocrNeeded?.length > 0,
    );
    if (pending.length === 0) return true;
    if (!(await ensureKey())) return false;
    for (const entry of pending) {
        await runOcr(entry);
    }
    return state.files.every(f => f.status === 'ready' && !f.ocrNeeded?.length);
}

function removeFile(id) {
    state.files = state.files.filter(f => f.id !== id);
    renderFileList();
    updateControls();
}

function renderFileList() {
    const list = document.getElementById('fileList');
    list.innerHTML = '';
    for (const f of state.files) {
        const div = document.createElement('div');
        div.className = 'file-item';
        const sizeKB = Math.round(f.file.size / 1024);

        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = `${f.file.name} (${sizeKB} KB)`;

        const status = document.createElement('span');
        status.className = `file-status ${f.status}`;
        let label;
        if (f.status === 'extracting') {
            label = f.progress
                ? `extracting ${f.progress.page}/${f.progress.total}…`
                : 'extracting…';
        } else if (f.status === 'ocr') {
            label = f.progress
                ? `OCR ${f.progress.page}/${f.progress.total}…`
                : 'OCR…';
        } else if (f.status === 'ready') {
            const ocrTag = f.ocrNeeded?.length
                ? ` (${f.ocrNeeded.length} pages need OCR — runs on Generate)`
                : '';
            label = `ready · ${f.numPages} pages${ocrTag}`;
        } else if (f.status === 'error') {
            label = f.error || 'error';
        } else {
            label = f.status;
        }
        status.textContent = label;

        const remove = document.createElement('button');
        remove.className = 'file-remove';
        remove.textContent = '×';
        remove.title = 'Remove';
        remove.addEventListener('click', () => removeFile(f.id));

        div.appendChild(name);
        div.appendChild(status);
        div.appendChild(remove);
        list.appendChild(div);
    }
}

function updateControls() {
    const controls = document.getElementById('controls');
    const generateBtn = document.getElementById('generateBtn');
    if (state.files.length > 0) {
        controls.hidden = false;
        const allReady = state.files.every(f => f.status === 'ready');
        generateBtn.disabled = !allReady;
    } else {
        controls.hidden = true;
    }
}

function showStatus(msg, kind = 'info') {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = `status ${kind === 'error' ? 'error' : ''}`;
    el.hidden = false;
}

function clearStatus() {
    const el = document.getElementById('status');
    el.hidden = true;
    el.textContent = '';
}

// --- Wiring ---

function wireDropzone() {
    const dropzone = document.getElementById('dropzone');
    const input = document.getElementById('fileInput');

    dropzone.addEventListener('click', () => input.click());

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
    });

    input.addEventListener('change', () => {
        if (input.files) addFiles(input.files);
        input.value = '';
    });
}

function wireSlider() {
    const slider = document.getElementById('lengthSlider');
    const value = document.getElementById('lengthValue');
    slider.addEventListener('input', () => {
        value.textContent = slider.value;
    });
}

function wireGenerate() {
    const btn = document.getElementById('generateBtn');
    btn.addEventListener('click', async () => {
        clearStatus();
        if (!(await ensureKey())) return;
        showStatus('Running OCR for any pages without a text layer…');
        const ocrOk = await ensurePendingOcrRuns();
        if (!ocrOk) {
            showStatus('OCR failed for some files. Check the file list for errors.', 'error');
            return;
        }
        await runGeneration({ resetHistory: true });
    });
}

async function runGeneration({ resetHistory = false } = {}) {
    const n = parseInt(document.getElementById('lengthSlider').value, 10) || 10;
    const apiKey = getKey();
    const sourceMarkdown = combineMarkdowns(state.files);

    if (resetHistory) {
        state.history = { previousStems: [], excludeChunkIds: [], flaggedStems: [] };
    }

    showStatus(`Generating ${n} questions…`);
    document.getElementById('generateBtn').disabled = true;

    try {
        const result = await generateQuiz(sourceMarkdown, n, apiKey, {
            excludeChunkIds: state.history.excludeChunkIds,
            previousStems: [...state.history.previousStems, ...state.history.flaggedStems],
            onProgress: (done, total) => {
                showStatus(`Generated ${done}/${total} questions…`);
            },
        });
        if (result.questions.length === 0) {
            showStatus('No grounded questions could be generated from the uploaded material.', 'error');
            document.getElementById('generateBtn').disabled = false;
            return;
        }
        state.quiz = {
            questions: result.questions,
            chunksUsed: result.chunksUsed,
            sourceMarkdown,
        };
        state.history.excludeChunkIds = [
            ...new Set([...state.history.excludeChunkIds, ...result.chunksUsed]),
        ];
        state.history.previousStems = [
            ...state.history.previousStems,
            ...result.questions.map(q => q.question),
        ];
        clearStatus();
        startQuiz(result.questions, {
            onFlag: (q, flagged) => {
                if (flagged) {
                    state.history.flaggedStems = [
                        ...new Set([...state.history.flaggedStems, q.question]),
                    ];
                } else {
                    state.history.flaggedStems = state.history.flaggedStems.filter(
                        s => s !== q.question,
                    );
                }
            },
        });
    } catch (err) {
        console.error('generate failed', err);
        showStatus(err?.message || 'generation failed', 'error');
    } finally {
        document.getElementById('generateBtn').disabled = false;
    }
}

function init() {
    wireDropzone();
    wireSlider();
    wireGenerate();
    wireQuizControls({
        onRegenerate: () => runGeneration({ resetHistory: false }),
        onBackToUpload: () => { state.quiz = null; },
    });
}

document.addEventListener('DOMContentLoaded', init);

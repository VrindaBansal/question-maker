// Question Maker — main app

import { extractFileCached } from './extract.js';

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
        } else if (f.status === 'ready') {
            const ocrTag = f.ocrNeeded?.length
                ? ` (OCR needed: ${f.ocrNeeded.length} pages)`
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
        const ok = await ensureKey();
        if (!ok) return;
        showStatus('Generation will be wired up in the next step.');
    });
}

function init() {
    wireDropzone();
    wireSlider();
    wireGenerate();
}

document.addEventListener('DOMContentLoaded', init);

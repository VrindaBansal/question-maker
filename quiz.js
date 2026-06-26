// Quiz UI logic — renders the quiz view, handles selection, check,
// next/prev, running stats. Quiz data comes from app.js as an array
// of { question, options, correct, explanation, tricky, source_chunk_id }.

let quizState = null;
let callbacks = {};

export function startQuiz(questions, opts = {}) {
    callbacks = opts;
    quizState = {
        questions,
        idx: 0,
        // per-question UI state: { selected, checked, flagged }
        ui: questions.map(() => ({ selected: null, checked: false, flagged: false, skipped: false })),
        stats: { total: 0, correct: 0 },
    };
    showQuizView();
    renderCurrent();
}

export function getQuizState() {
    return quizState;
}

function showQuizView() {
    document.getElementById('uploadView').classList.remove('active');
    document.getElementById('quizView').classList.add('active');
    document.getElementById('completion').hidden = true;
    document.querySelector('.question-block').style.display = 'block';
    document.querySelector('.bottom-controls').style.display = 'block';
}

function showUploadView() {
    document.getElementById('quizView').classList.remove('active');
    document.getElementById('uploadView').classList.add('active');
}

function renderCurrent() {
    const q = quizState.questions[quizState.idx];
    const ui = quizState.ui[quizState.idx];
    document.getElementById('qNumber').textContent = quizState.idx + 1;
    document.getElementById('qProgress').textContent = quizState.idx + 1;
    document.getElementById('qTotal').textContent = quizState.questions.length;
    document.getElementById('qText').textContent = q.question;

    const optionsDiv = document.getElementById('qOptions');
    optionsDiv.innerHTML = '';
    q.options.forEach((option, i) => {
        const div = document.createElement('div');
        div.className = 'option';
        div.textContent = `${String.fromCharCode(97 + i)}. ${option}`;
        if (ui.selected === i) div.classList.add('selected');
        if (ui.checked) {
            if (i === q.correct) div.classList.add('correct');
            else if (i === ui.selected) div.classList.add('incorrect');
        }
        div.onclick = () => {
            if (ui.checked) return;
            ui.selected = i;
            renderCurrent();
        };
        optionsDiv.appendChild(div);
    });

    const feedback = document.getElementById('feedback');
    if (ui.checked) {
        const correct = ui.selected === q.correct;
        feedback.className = `feedback show ${correct ? 'correct' : 'incorrect'}`;
        feedback.innerHTML =
            `<strong>${correct ? 'Yes — correct.' : 'No — not quite.'}</strong><br>${q.explanation || ''}`;
    } else {
        feedback.className = 'feedback';
        feedback.innerHTML = '';
    }

    document.getElementById('prevBtn').disabled = quizState.idx === 0;
    document.getElementById('checkBtn').disabled = ui.checked || ui.selected === null;
    document.getElementById('skipBtn').disabled = ui.checked;
    const flagBtn = document.getElementById('flagBtn');
    flagBtn.classList.toggle('active', ui.flagged);
    flagBtn.textContent = ui.flagged ? '⚑ Flagged' : '⚑ Flag';

    renderStats();
}

function renderStats() {
    const { total, correct } = quizState.stats;
    document.getElementById('totalAnswered').textContent = total;
    document.getElementById('correctCount').textContent = correct;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    document.getElementById('accuracy').textContent = `${pct}%`;
}

function checkAnswer() {
    const ui = quizState.ui[quizState.idx];
    if (ui.checked || ui.selected === null) return;
    const q = quizState.questions[quizState.idx];
    ui.checked = true;
    quizState.stats.total += 1;
    if (ui.selected === q.correct) quizState.stats.correct += 1;
    renderCurrent();
}

function next() {
    if (quizState.idx >= quizState.questions.length - 1) {
        showCompletion();
        return;
    }
    quizState.idx += 1;
    renderCurrent();
}

function skip() {
    // Mark as skipped (informational only) and advance. Does NOT count
    // toward stats. If the user comes back via Previous they can still
    // select and check this question normally.
    const ui = quizState.ui[quizState.idx];
    if (!ui.checked) {
        ui.skipped = true;
    }
    next();
}

function prev() {
    if (quizState.idx === 0) return;
    quizState.idx -= 1;
    renderCurrent();
}

function flag() {
    const ui = quizState.ui[quizState.idx];
    const q = quizState.questions[quizState.idx];
    ui.flagged = !ui.flagged;
    if (callbacks.onFlag) callbacks.onFlag(q, ui.flagged);
    renderCurrent();
}

function showCompletion() {
    document.querySelector('.question-block').style.display = 'none';
    document.querySelector('.bottom-controls').style.display = 'none';
    document.getElementById('completion').hidden = false;
    const { total, correct } = quizState.stats;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    document.getElementById('finalScore').textContent =
        `${correct}/${total} (${pct}%)`;
}

export function wireQuizControls({ onRegenerate, onBackToUpload }) {
    document.getElementById('checkBtn').addEventListener('click', checkAnswer);
    document.getElementById('nextBtn').addEventListener('click', next);
    document.getElementById('skipBtn').addEventListener('click', skip);
    document.getElementById('prevBtn').addEventListener('click', prev);
    document.getElementById('flagBtn').addEventListener('click', flag);

    const regen = async () => {
        if (!onRegenerate) return;
        // Switch back to upload view so generation status is visible.
        showUploadView();
        await onRegenerate();
    };
    const back = () => {
        showUploadView();
        if (onBackToUpload) onBackToUpload();
    };
    document.getElementById('regenerateBtn').addEventListener('click', regen);
    document.getElementById('regenerateBtnTop').addEventListener('click', regen);
    document.getElementById('backToUploadBtn').addEventListener('click', back);
    document.getElementById('backToUploadBtnTop').addEventListener('click', back);
}

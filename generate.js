// Question generation: chunk markdown, prompt OpenAI per chunk,
// verify the correct answer is grounded in the source passage.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GEN_MODEL = 'gpt-4o';
const CHUNK_TARGET_CHARS = 3500;
const MAX_PASSES = 4;

export function combineMarkdowns(files) {
    return files
        .map(f => `## File: ${f.filename || f.file?.name || 'untitled'}\n\n${f.markdown}`)
        .join('\n\n---\n\n');
}

export function chunkMarkdown(markdown) {
    const paragraphs = markdown.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    for (const p of paragraphs) {
        if (current.length + p.length + 2 > CHUNK_TARGET_CHARS && current) {
            chunks.push(current.trim());
            current = '';
        }
        current = current ? `${current}\n\n${p}` : p;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.map((text, i) => ({ id: `c${i}`, text }));
}

// Heuristic grounding check — the correct option's content words should mostly
// appear somewhere in the source chunk. Catches the most blatant hallucinations.
export function verifyGrounded(question, chunkText) {
    const correct = question.options?.[question.correct] || '';
    const tokens = correct
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 4);
    if (tokens.length === 0) return true;
    const haystack = chunkText.toLowerCase();
    const hits = tokens.filter(t => haystack.includes(t)).length;
    return hits / tokens.length >= 0.5;
}

const SYSTEM_PROMPT =
    'You are an expert quiz writer. You write multiple-choice questions strictly grounded in a provided passage. ' +
    'You output JSON only. You never invent facts beyond the passage. ' +
    "The correct answer's key phrase must appear in the passage (verbatim or close paraphrase).";

function buildUserPrompt(chunk, n, previousStems) {
    let avoid = '';
    if (previousStems.length) {
        const sample = previousStems.slice(-40);
        avoid =
            '\n\nDo NOT generate questions similar in topic or wording to any of these previously asked stems:\n' +
            sample.map(s => `- ${s}`).join('\n');
    }
    return `Generate ${n} multiple-choice questions from this passage.

PASSAGE:
${chunk.text}

REQUIREMENTS:
- "question": well-formed, tests comprehension of the passage.
- "options": exactly 4 mutually-exclusive choices.
- "correct": integer 0-3, the index of the right choice.
- "explanation": 1-2 sentences why the correct answer is right, citing the passage.
- "tricky": boolean. About 10% of questions should be true — these should have plausible-but-wrong distractors that test careful reading. The other 90% should be straightforward.
- The correct answer's key phrase MUST appear in the passage (verbatim or as a close paraphrase).
- Wrong options must be plausible but UNSUPPORTED by the passage. No obvious nonsense.
- Vary forms: definitions, cause/effect, identification, sequence, comparison, numbers/dates/names.
- Do not invent facts.

IMPORTANT: Aim to produce exactly ${n} questions. Most passages contain
many testable facts — names, numbers, dates, definitions, relationships,
sequences, locations, attributes. Find varied angles. Only return fewer
if the passage is genuinely too sparse (e.g. one sentence).${avoid}

Return JSON of the form: {"questions": [{"question": "...", "options": ["a","b","c","d"], "correct": 0, "explanation": "...", "tricky": false}]}`;
}

export async function generateFromChunk(chunk, n, apiKey, previousStems = []) {
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: GEN_MODEL,
            temperature: 0.7,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt(chunk, n, previousStems) },
            ],
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`generation ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        return [];
    }
    const items = Array.isArray(parsed.questions) ? parsed.questions : [];
    return items
        .filter(q =>
            typeof q.question === 'string' &&
            Array.isArray(q.options) &&
            q.options.length === 4 &&
            q.options.every(o => typeof o === 'string') &&
            Number.isInteger(q.correct) &&
            q.correct >= 0 && q.correct < 4
        )
        .filter(q => verifyGrounded(q, chunk.text))
        .map(q => ({
            question: q.question.trim(),
            options: q.options.map(o => o.trim()),
            correct: q.correct,
            explanation: (q.explanation || '').trim(),
            tricky: !!q.tricky,
            source_chunk_id: chunk.id,
        }));
}

function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function normalizeStem(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function generateQuiz(markdown, n, apiKey, options = {}) {
    const { excludeChunkIds = [], previousStems = [], onProgress } = options;
    const allChunks = chunkMarkdown(markdown);
    const totalChunks = allChunks.length;
    let pool = allChunks.filter(c => !excludeChunkIds.includes(c.id));
    if (pool.length === 0) pool = allChunks;  // recycle when exhausted

    const questions = [];
    const seenStems = new Set(previousStems.map(normalizeStem));
    const chunksUsed = new Set();

    for (let pass = 0; pass < MAX_PASSES && questions.length < n; pass++) {
        const passPool = shuffled(pool);
        const remaining = n - questions.length;
        // Later passes pull additional, different questions from the same
        // material — the avoid list keeps them from repeating.
        const perChunkBase = Math.ceil(remaining / passPool.length);
        const perChunk = Math.max(2, perChunkBase + (pass === 0 ? 1 : 2));

        for (const chunk of passPool) {
            if (questions.length >= n) break;
            const need = n - questions.length;
            const ask = Math.min(perChunk, need + 3);
            try {
                const batch = await generateFromChunk(
                    chunk,
                    ask,
                    apiKey,
                    [...previousStems, ...questions.map(q => q.question)],
                );
                let added = 0;
                for (const q of batch) {
                    if (questions.length >= n) break;
                    const key = normalizeStem(q.question);
                    if (seenStems.has(key)) continue;
                    seenStems.add(key);
                    questions.push(q);
                    added++;
                }
                if (added > 0) chunksUsed.add(chunk.id);
            } catch (err) {
                console.error('chunk gen failed', chunk.id, err);
            }
            if (onProgress) onProgress(questions.length, n, { pass: pass + 1 });
        }
    }

    return {
        questions: questions.slice(0, n),
        chunksUsed: [...chunksUsed],
        totalChunks,
        requested: n,
        shortfall: questions.length < n,
    };
}

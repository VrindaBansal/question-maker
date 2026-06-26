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

// Heuristic grounding check — the correct option's content words (or the
// explanation, which we ask to cite the passage) should overlap with the
// source chunk. Catches blatant hallucinations while allowing paraphrase.
export function verifyGrounded(question, chunkText) {
    const correct = question.options?.[question.correct] || '';
    const explanation = question.explanation || '';
    const haystack = chunkText.toLowerCase();

    const tokensOf = (s) => s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 4);

    const correctTokens = tokensOf(correct);
    const explanationTokens = tokensOf(explanation);
    const combined = [...correctTokens, ...explanationTokens];
    if (combined.length === 0) return true;
    const hits = combined.filter(t => haystack.includes(t)).length;
    return hits / combined.length >= 0.4;
}

const SYSTEM_PROMPT =
    'You are an expert academic test writer. You produce clear, fair, ' +
    'unambiguous multiple-choice questions grounded strictly in a provided ' +
    'passage. Every question you write would pass a peer review: stems are ' +
    'complete questions, options are parallel in form and length, exactly ' +
    'one option is correct, distractors are plausible but clearly incorrect ' +
    'on careful reading. You output JSON only. You never invent facts beyond ' +
    'the passage.';

const DIFFICULTY_GUIDANCE = {
    easy:
        'Target difficulty: EASY. Focus on surface-level recall — single ' +
        'facts, names, dates, locations, basic definitions stated directly ' +
        'in the passage. The correct answer should be clearly distinguishable ' +
        'from the distractors.',
    medium:
        'Target difficulty: MEDIUM. Mix recall with comprehension. Test ' +
        'relationships between concepts, definitions in context, how and why ' +
        'questions. Distractors should be plausible but clearly unsupported.',
    hard:
        'Target difficulty: HARD. Emphasize synthesis, multi-step reasoning, ' +
        'and nuanced distinctions. Many questions should require careful ' +
        'reading of the passage to distinguish the correct answer from highly ' +
        'plausible distractors. Test edge cases and subtle differences.',
};

function buildUserPrompt(chunk, n, previousStems, difficulty = 'medium') {
    let avoid = '';
    if (previousStems.length) {
        const sample = previousStems.slice(-40);
        avoid =
            '\n\nDo NOT generate questions similar in topic or wording to any of these previously asked stems:\n' +
            sample.map(s => `- ${s}`).join('\n');
    }
    const difficultyText = DIFFICULTY_GUIDANCE[difficulty] || DIFFICULTY_GUIDANCE.medium;
    return `Generate ${n} multiple-choice questions from this passage.

PASSAGE:
${chunk.text}

${difficultyText}

EVERY question MUST satisfy ALL of the following rules.

STEM:
- A complete, unambiguous question that ends in "?".
- No fill-in-the-blank or sentence-completion stems.
- No "all of the above" / "none of the above" / "both A and B" style options.
- Avoid negative wording ("Which is NOT...", "EXCEPT..."). At most 1 in 10.
- The stem itself should not telegraph the correct answer via grammar, length, or word repetition with one option.

OPTIONS:
- Exactly 4 options.
- Options are PARALLEL in length, grammar, and specificity. A test-taker should not be able to pick the answer by looking at form alone.
- Exactly one option is correct AND supported by the passage.
- The other three are plausible distractors — readable as candidates by a skim reader, but clearly falsified on close reading of the passage. Do not use absurd or unrelated text as distractors.
- No two options are paraphrases of each other. Each must be meaningfully distinct.
- The correct answer must be supported by the passage (verbatim or a close paraphrase). Do not invent facts.

EXPLANATION:
- 1-2 sentences citing or quoting the passage to justify the correct answer.
- Begin with phrasing like "The passage states..." or "According to the passage...".

BATCH QUALITY:
- Each question tests a DIFFERENT fact, concept, or relationship. No duplicates or near-duplicates.
- Spread coverage across the whole passage — don't focus all questions on one paragraph.
- Vary question forms: definitions, cause/effect, identification, comparison, sequence, application.

SELF-CHECK before emitting each question:
1. Could a reader of the passage answer this with confidence? (must be yes)
2. Could a reader who did NOT read the passage get it right via test-taking heuristics (longest option, grammar, common sense)? (must be no)
3. Are all 4 options parallel in form and length?
4. Is the correct answer truly supported by the passage, not invented?

If any rule fails, rewrite or skip the question.

Aim to produce exactly ${n} questions. Most passages contain many testable facts — names, numbers, dates, definitions, relationships, sequences. Find varied angles. Only return fewer if the passage is genuinely too sparse.${avoid}

Return JSON of the form: {"questions": [{"question": "...", "options": ["a","b","c","d"], "correct": 0, "explanation": "..."}]}`;
}

export async function generateFromChunk(chunk, n, apiKey, previousStems = [], difficulty = 'medium') {
    const res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: GEN_MODEL,
            temperature: 0.5,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: buildUserPrompt(chunk, n, previousStems, difficulty) },
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
    const { excludeChunkIds = [], previousStems = [], onProgress, difficulty = 'medium' } = options;
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
                    difficulty,
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

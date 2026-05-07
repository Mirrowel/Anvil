/**
 * Clarify-stage primitives owned by core-pipeline.
 *
 * The full clarify orchestration (explore → Q&A → synthesize) needs
 * multi-turn agent semantics — `agentManager.sendInput` to resume the
 * same session for synthesis — which the one-shot `AgentRunner.run`
 * doesn't model today. The dashboard's `runClarifyForProject` keeps
 * that orchestration; this module owns the pure, runner-agnostic parts:
 *
 *   - `parseClarifyQuestions` — extract numbered questions from agent text
 *   - `formatQAPairs` — render Q&A pairs for the synthesis prompt
 *   - `buildClarifySynthesisPrompt` — the verbatim synthesis prompt
 *   - `runClarifyQALoop` — drive the question-by-question Q&A loop given
 *     a caller-supplied `inputResolver`. Pure logic; no LLM calls.
 *
 * Both consumers import these. The cli uses a stdin-based inputResolver;
 * the dashboard uses a WS-based inputResolver. The loop is identical.
 */

export interface ClarifyQAPair {
  question: string;
  answer: string;
}

/** Parse a clarifier agent's output into a list of clarifying questions. */
export function parseClarifyQuestions(output: string): string[] {
  const lines = output.split('\n');
  const questions: string[] = [];
  let current = '';

  for (const line of lines) {
    const isNewQ = /^\s*\d+[.)]\s+/.test(line);
    if (isNewQ) {
      if (current.trim()) questions.push(current.trim());
      current = line.replace(/^\s*\d+[.)]\s+/, '');
    } else if (current) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.toLowerCase().startsWith('please answer')) {
        current += '\n' + line;
      }
    }
  }
  if (current.trim()) questions.push(current.trim());

  const seen = new Set<string>();
  return questions.filter((q) => {
    if (q.length <= 10) return false;
    const normalized = q.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/** Format Q&A pairs into the body the synthesis prompt expects. */
export function formatQAPairs(qaPairs: readonly ClarifyQAPair[]): string {
  return qaPairs
    .map((qa, i) => `**Q${i + 1}**: ${qa.question}\n**A${i + 1}**: ${qa.answer}`)
    .join('\n\n');
}

/** Canonical clarifier synthesis prompt — verbatim from the legacy path. */
export function buildClarifySynthesisPrompt(qaText: string): string {
  return `Here are the clarifying questions and the user's answers:\n\n${qaText}\n\n`
    + 'Now synthesize a CLARIFICATION.md document that combines the questions, '
    + "answers, and your codebase understanding into clear context for the next "
    + 'stages. Output ONLY the markdown content.';
}

export interface ClarifyQALoopOptions {
  /** Questions to ask the user (already parsed). */
  questions: readonly string[];
  /** Caller-supplied resolver. Returns the user's answer for one question. */
  inputResolver: (question: string, index: number, total: number) => Promise<string>;
  /** Cancellation predicate. Loop breaks when this returns true. */
  isCancelled: () => boolean;
  /** Optional hooks. */
  onQuestion?: (index: number, total: number, question: string) => void;
  onAnswer?: (index: number, total: number, answer: string) => void;
  onCancelled?: () => void;
}

export interface ClarifyQALoopResult {
  qaPairs: ClarifyQAPair[];
  cancelled: boolean;
}

/**
 * Drive the Q&A loop. For each question: emit `onQuestion`, await
 * `inputResolver`, append to `qaPairs`. Bails on cancellation or empty
 * answer (matches legacy semantics). Pure logic — no LLM, no I/O of
 * its own beyond what the resolver does.
 */
export async function runClarifyQALoop(
  opts: ClarifyQALoopOptions,
): Promise<ClarifyQALoopResult> {
  const qaPairs: ClarifyQAPair[] = [];
  let cancelled = false;

  for (let qi = 0; qi < opts.questions.length; qi += 1) {
    if (opts.isCancelled()) {
      cancelled = true;
      break;
    }
    const question = opts.questions[qi];
    opts.onQuestion?.(qi, opts.questions.length, question);

    let answer: string;
    try {
      answer = await opts.inputResolver(question, qi, opts.questions.length);
    } catch {
      cancelled = true;
      break;
    }

    if (opts.isCancelled() || !answer) {
      cancelled = true;
      break;
    }

    qaPairs.push({ question, answer });
    opts.onAnswer?.(qi, opts.questions.length, answer);
  }

  if (cancelled) opts.onCancelled?.();

  return { qaPairs, cancelled };
}

/**
 * Three-tier fallback for parsing — happy path returns the parsed list;
 * non-empty unparsed output is treated as one question; empty output
 * surfaces a generic catch-all so the run can proceed.
 */
export function deriveClarifyQuestions(rawOutput: string): string[] {
  const parsed = parseClarifyQuestions(rawOutput);
  if (parsed.length > 0) return parsed;
  const trimmed = rawOutput.trim();
  if (trimmed.length > 0) return [trimmed];
  return [
    'I could not generate clarifying questions automatically. ' +
    'Please describe the feature in more detail — scope, constraints, ' +
    'edge cases, and any acceptance criteria you have in mind.',
  ];
}

/**
 * TypeSafe "System One" rerank — one call, one Noul probability per candidate.
 *
 * The Rust `typesafe_eval` command holds the API key; this helper only assembles
 * the request, sorts by the returned nouls, and falls back to the input order on
 * any failure (missing key, network, non-2xx). A missing key is cached so the
 * panel never hammers a doomed call on every keystroke — env is fixed for a
 * process lifetime, so caching within a session is safe.
 */
import { desktopInvoke, DesktopInvokeError } from "@/lib/backend/desktop/invoke";

export interface RerankCandidate {
  /** stable id; the caller maps it back to the real object */
  id: string;
  /** the text Jev scores against the query (e.g. `${name}: ${description}`) */
  text: string;
}

interface SystemOneAnswer {
  type: string;
  noul?: number;
}
interface SystemOneResponse {
  answers: Record<string, SystemOneAnswer>;
}

// Flipped false the first time the backend reports the key is missing; the rest
// of the session then skips the round-trip entirely.
let notConfigured = false;

export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[],
  limit = 40,
): Promise<RerankCandidate[]> {
  if (notConfigured || !query.trim() || candidates.length <= 1) return candidates;

  const pool = candidates.slice(0, limit);
  const questions: Record<string, unknown> = {};
  for (const c of pool) {
    questions[`r_${c.id}`] = {
      type: "noul",
      instructions: {
        candidate: c.text,
        query,
        question: "Does `candidate` answer `query`?",
      },
      criteria: {
        true: "The candidate's name and description directly address the query.",
        false: "The candidate is only loosely related or unrelated to the query.",
      },
    };
  }

  let res: SystemOneResponse;
  try {
    res = await desktopInvoke<SystemOneResponse>("typesafe_eval", {
      state: query,
      questions,
    });
  } catch (e) {
    if (e instanceof DesktopInvokeError && e.message.includes("not-configured")) {
      notConfigured = true;
    }
    return candidates; // graceful: keep the substring shortlist order
  }

  return pool
    .map((c) => ({ c, n: res.answers[`r_${c.id}`]?.noul ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .map((s) => s.c);
}

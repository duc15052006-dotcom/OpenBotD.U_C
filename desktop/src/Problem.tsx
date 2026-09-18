import { useState } from "react";
import {
  collectDesktopDiagnostics,
  formatDesktopDiagnostics,
} from "./diagnostics";

/**
 * A failure, in both registers, wherever one happens.
 *
 * ONE IMPLEMENTATION, because there is one rule and every screen owes it: the sentence is the
 * headline and the real output lives behind a disclosure. A second copy is how one screen ends up
 * showing an engine dump as its title, and how another ends up rendering `[object Object]` because
 * it stringified a failure that was never a string.
 */
export type Problem = {
  said: string;
  detail?: string | null;
};

/** Anything thrown, as a problem. A bare string keeps working and reads as it always did. */
export function asProblem(thrown: unknown): Problem {
  if (thrown && typeof thrown === "object" && "said" in thrown) {
    return thrown as Problem;
  }
  return { said: String(thrown) };
}

export function Failure({ problem }: { problem: Problem }) {
  return (
    <div className="blocker" role="alert">
      <h2>That did not finish</h2>
      <p>{problem.said}</p>
      {/* The real output, kept but not the headline. Whoever is debugging opens this; the person
          reading the sentence above never has to. */}
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <DiagnosticsPanel />
    </div>
  );
}

/**
 * The same two registers where a whole panel would be too much.
 *
 * Used inside the provider rows, which are small and already have a heading. The sentence reads as
 * a caution and the output is still one click away, so a sign-in that fails inside a card is no
 * less diagnosable than one that fails on its own screen.
 */
export function InlineFailure({ problem }: { problem: Problem }) {
  return (
    <div role="alert">
      <p className="caution">{problem.said}</p>
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <DiagnosticsPanel compact />
    </div>
  );
}

function DiagnosticsPanel({ compact = false }: { compact?: boolean }) {
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setReport(formatDesktopDiagnostics(await collectDesktopDiagnostics()));
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "OpenBot could not gather diagnostics.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "diagnostics compact" : "diagnostics"}>
      <button
        className="quiet"
        disabled={busy}
        onClick={() => void run()}
        type="button"
      >
        {busy
          ? "Checking…"
          : report
            ? "Refresh diagnostics"
            : "Run diagnostics"}
      </button>
      {problem ? <p className="caution">{problem}</p> : null}
      {report ? (
        <details className="detail-of" open>
          <summary>Local diagnostics</summary>
          <pre>{report}</pre>
        </details>
      ) : null}
    </div>
  );
}

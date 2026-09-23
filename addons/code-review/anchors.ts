import { createHash } from "node:crypto";

import {
  LIMITS,
  ReviewError,
  type AnchorProjection,
  type AnchorSide,
  type OriginalAnchor,
} from "./contracts.ts";

const MAX_SELECTION_BYTES = LIMITS.commentBytes;
const CONTEXT_LINES = LIMITS.contextLines;

export function createAnchor(
  snapshotFileId: string,
  side: AnchorSide,
  text: string,
  range?: { startLine: number; endLine: number },
): OriginalAnchor {
  const blobSha256 = sha256Utf8(text);

  if (range == null) {
    return {
      snapshotFileId,
      scope: "file",
      side,
      startLine: null,
      endLine: null,
      blobSha256,
      selectedText: "",
      contextBefore: [],
      contextAfter: [],
    };
  }

  const lines = splitDocumentLines(text);
  validateRange(range, lines.length);

  const selectedLines = lines.slice(range.startLine - 1, range.endLine);
  const selectedText = selectedLines.join("\n");
  validateSelectionSize(selectedText);

  return {
    snapshotFileId,
    scope: "range",
    side,
    startLine: range.startLine,
    endLine: range.endLine,
    blobSha256,
    selectedText,
    contextBefore: lines.slice(
      Math.max(0, range.startLine - 1 - CONTEXT_LINES),
      range.startLine - 1,
    ),
    contextAfter: lines.slice(range.endLine, range.endLine + CONTEXT_LINES),
  };
}

export function projectAnchor(
  anchor: OriginalAnchor,
  text: string,
  options?: { sameFile?: boolean },
): AnchorProjection {
  if (options?.sameFile === false) {
    return missingProjection();
  }

  if (sha256Utf8(text) === anchor.blobSha256) {
    return {
      status: "exact",
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      method: "same-snapshot",
    };
  }

  if (anchor.scope === "file") {
    return missingProjection();
  }

  const selectedLines = splitStoredSelection(anchor.selectedText);
  if (selectedLines.length === 0) {
    return missingProjection();
  }

  const currentLines = splitDocumentLines(text);
  const occurrences = findOccurrences(currentLines, selectedLines).map(
    (startIndex) => ({
      startLine: startIndex + 1,
      endLine: startIndex + selectedLines.length,
      score: contextScore(anchor, currentLines, startIndex),
    }),
  );

  if (occurrences.length === 0) {
    return missingProjection();
  }

  const hasStoredContext =
    anchor.contextBefore.length > 0 || anchor.contextAfter.length > 0;

  if (occurrences.length === 1) {
    const [match] = occurrences;
    if (match.score > 0 || !hasStoredContext) {
      return {
        status: "moved",
        startLine: match.startLine,
        endLine: match.endLine,
        method: "unique-context",
      };
    }
    return missingProjection();
  }

  const maxScore = Math.max(...occurrences.map((match) => match.score));
  const bestMatches = occurrences.filter((match) => match.score === maxScore);

  if (maxScore === 0 || bestMatches.length !== 1) {
    return {
      status: "ambiguous",
      startLine: null,
      endLine: null,
      method: "unmapped",
    };
  }

  const [match] = bestMatches;
  return {
    status: "moved",
    startLine: match.startLine,
    endLine: match.endLine,
    method: "unique-context",
  };
}

function validateRange(
  range: { startLine: number; endLine: number },
  lineCount: number,
): void {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) {
    throw new ReviewError(
      "invalid_anchor_range",
      "Anchor range must use whole 1-based line numbers.",
    );
  }
  if (range.startLine < 1 || range.endLine < 1) {
    throw new ReviewError(
      "invalid_anchor_range",
      "Anchor range must start at line 1 or later.",
    );
  }
  if (range.startLine > range.endLine) {
    throw new ReviewError(
      "invalid_anchor_range",
      "Anchor range start must be less than or equal to end.",
    );
  }
  if (range.endLine > lineCount) {
    throw new ReviewError(
      "invalid_anchor_range",
      "Anchor range must stay within the captured file.",
    );
  }
}

function validateSelectionSize(selectedText: string): void {
  if (Buffer.byteLength(selectedText, "utf8") > MAX_SELECTION_BYTES) {
    throw new ReviewError(
      "anchor_selection_too_large",
      `Anchor selection must be at most ${MAX_SELECTION_BYTES} UTF-8 bytes.`,
    );
  }
}

function splitDocumentLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (endsWithLineBreak(text)) {
    lines.pop();
  }
  return lines;
}

function splitStoredSelection(selectedText: string): string[] {
  return selectedText.split("\n");
}

function endsWithLineBreak(text: string): boolean {
  return text.endsWith("\n") || text.endsWith("\r");
}

function findOccurrences(
  lines: readonly string[],
  selectedLines: readonly string[],
): number[] {
  const lastStart = lines.length - selectedLines.length;
  if (lastStart < 0) return [];

  const starts: number[] = [];
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let offset = 0; offset < selectedLines.length; offset += 1) {
      if (lines[start + offset] !== selectedLines[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      starts.push(start);
    }
  }
  return starts;
}

function contextScore(
  anchor: OriginalAnchor,
  lines: readonly string[],
  startIndex: number,
): number {
  return (
    countMatchingBefore(anchor.contextBefore, lines, startIndex) +
    countMatchingAfter(
      anchor.contextAfter,
      lines,
      startIndex + anchorLength(anchor),
    )
  );
}

function countMatchingBefore(
  expectedBefore: readonly string[],
  lines: readonly string[],
  startIndex: number,
): number {
  let score = 0;
  for (
    let expectedIndex = expectedBefore.length - 1, lineIndex = startIndex - 1;
    expectedIndex >= 0 && lineIndex >= 0;
    expectedIndex -= 1, lineIndex -= 1
  ) {
    if (expectedBefore[expectedIndex] !== lines[lineIndex]) {
      break;
    }
    score += 1;
  }
  return score;
}

function countMatchingAfter(
  expectedAfter: readonly string[],
  lines: readonly string[],
  startIndex: number,
): number {
  let score = 0;
  for (
    let offset = 0;
    offset < expectedAfter.length && startIndex + offset < lines.length;
    offset += 1
  ) {
    if (expectedAfter[offset] !== lines[startIndex + offset]) {
      break;
    }
    score += 1;
  }
  return score;
}

function anchorLength(anchor: OriginalAnchor): number {
  if (anchor.startLine == null || anchor.endLine == null) {
    return 0;
  }
  return anchor.endLine - anchor.startLine + 1;
}

function missingProjection(): AnchorProjection {
  return {
    status: "missing",
    startLine: null,
    endLine: null,
    method: "unmapped",
  };
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

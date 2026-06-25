/**
 * Card-aware message splitter.
 *
 * Splits long messages into chunks that fit within WeChat's message size limit,
 * while preserving markdown formatting (code blocks, tables, lists, etc.).
 *
 * Strategy:
 * 1. Split at paragraph boundaries (double newlines) to keep cards/blocks intact
 * 2. For oversized single blocks, find safe split points (newline > sentence > space)
 * 3. When a split point falls inside a code block, extend to the code block's closing
 *    fence and add fence markers to both chunks so each renders correctly
 * 4. Each chunk <= maxLen characters
 */

const DEFAULT_MAX_LEN = 4000;

/** Split text into blocks at paragraph boundaries (double newlines). */
function parseBlocks(text: string): string[] {
  return text.split(/\n\n+/).filter(block => block.length > 0);
}

/**
 * Find a safe split point that won't break markdown formatting.
 * Tries (in order): newline, sentence-ending punctuation, space, hard cut.
 */
function findSafeSplitPoint(text: string, maxLen: number): number {
  // Try newline first (preserves list items, paragraphs)
  let idx = text.lastIndexOf('\n', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Try sentence-ending punctuation
  const sentenceEnd = /[。！？.!?]$/;
  for (let i = maxLen; i >= maxLen * 0.5; i--) {
    if (sentenceEnd.test(text.slice(i - 1, i))) return i;
  }

  // Try space (won't split mid-word or mid-markdown)
  idx = text.lastIndexOf(' ', maxLen);
  if (idx >= maxLen * 0.3) return idx;

  // Last resort: hard cut
  return maxLen;
}

/**
 * Find the index of the closing code fence (```) after a given position.
 * Returns the index right after the closing fence line, or -1 if not found.
 */
function findClosingFence(text: string, afterPos: number): number {
  // Look for a line that is just ``` (possibly with trailing whitespace)
  const lines = text.slice(afterPos).split('\n');
  let offset = afterPos;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```\s*$/.test(lines[i])) {
      return offset + lines[i].length + 1; // +1 for the newline
    }
    offset += lines[i].length + 1; // +1 for the newline
  }
  return -1;
}

/**
 * Detect the language tag from a code fence opening line.
 * E.g. "```typescript" → "typescript", "```" → ""
 */
function extractFenceLang(line: string): string {
  const match = line.match(/^```(\w*)/);
  return match ? match[1] : '';
}

/**
 * Find the opening code fence line that contains `pos`.
 * Returns { lineStart, lang } or null if `pos` is not inside a code block.
 */
function findOpeningFence(text: string, pos: number): { lineStart: number; lang: string } | null {
  // Scan backwards from pos to find the most recent ``` that starts a code block
  const before = text.slice(0, pos);
  const lines = before.split('\n');
  let inCode = false;
  let lastOpen: { lineStart: number; lang: string } | null = null;

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```\s*$/.test(line)) {
      if (inCode) {
        inCode = false;
        lastOpen = null;
      } else {
        inCode = true;
        lastOpen = { lineStart: offset, lang: '' };
      }
    } else if (/^\s*```\w/.test(line) && !inCode) {
      inCode = true;
      lastOpen = { lineStart: offset, lang: extractFenceLang(line) };
    }
    offset += line.length + 1;
  }

  return inCode ? lastOpen : null;
}

/** Fallback: split a single oversized block at safe boundaries,
 *  with code block awareness. */
function splitByNewline(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = findSafeSplitPoint(remaining, maxLen);

    // Check if split point falls inside a code block
    const openingFence = findOpeningFence(remaining, splitIdx);
    if (openingFence) {
      // We're inside a code block — find the closing fence
      const closeIdx = findClosingFence(remaining, splitIdx);
      if (closeIdx > 0 && closeIdx <= remaining.length) {
        // Split AFTER the closing fence, so the code block stays complete in this chunk
        splitIdx = closeIdx;
      }
      // If no closing fence found (malformed markdown), just cut at the safe point
    }

    const chunk = remaining.slice(0, splitIdx);

    // Check if this chunk opens a code block but doesn't close it
    // (this happens when a code block is very long and we split inside it)
    const chunkFences = (chunk.match(/```/g) || []).length;
    if (chunkFences % 2 !== 0) {
      // Odd number of fences — chunk opens a code block but doesn't close it.
      // We couldn't extend past the closing fence (too far), so:
      // 1. Add a closing ``` to this chunk
      // 2. Add an opening ``` with the same lang to the next chunk
      const lang = openingFence?.lang || '';
      chunks.push(chunk + '\n```');
      remaining = '```' + (lang ? lang : '') + '\n' + remaining.slice(splitIdx).replace(/^\n+/, '');
    } else {
      chunks.push(chunk);
      remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
    }
  }

  return chunks;
}

/**
 * Card-aware message splitter.
 *
 * Splits at paragraph boundaries (double newlines) to keep cards intact,
 * falls back to newline-based splitting for oversized single blocks.
 * When a split falls inside a code block, adds fence markers to both chunks.
 *
 * @param text - The full message text to split
 * @param maxLen - Maximum characters per chunk (default 4000)
 * @returns Array of message chunks, each <= maxLen (soft limit; code block
 *          preservation may cause slight overshoot)
 */
export function splitMessage(text: string, maxLen: number = DEFAULT_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const blocks = parseBlocks(text);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Can this block fit into the current chunk?
    if (current.length === 0) {
      if (block.length <= maxLen) {
        current = block;
      } else {
        // Single block exceeds maxLen — split it
        chunks.push(...splitByNewline(block, maxLen));
      }
    } else if (current.length + 2 + block.length <= maxLen) {
      // Fits with a paragraph separator
      current += '\n\n' + block;
    } else {
      // Current chunk is complete, start a new one
      chunks.push(current);
      if (block.length <= maxLen) {
        current = block;
      } else {
        chunks.push(...splitByNewline(block, maxLen));
        current = '';
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

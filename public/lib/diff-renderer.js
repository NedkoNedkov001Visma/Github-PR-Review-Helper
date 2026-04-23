/**
 * diff-renderer.js
 *
 * Parses GitHub unified diffs and renders them as HTML tables with inline
 * review comment threads.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe insertion into HTML.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/**
 * Format an ISO timestamp into a short human-readable string.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Render a single inline review-comment thread as a DOM element.
 *
 * Produces a lightweight representation (author, timestamp, body) that is
 * suitable for embedding directly inside the diff table.  Full-featured
 * rendering (reactions, resolve buttons, etc.) is left to ui.js.
 *
 * @param {{ root: Object, replies: Object[] }} thread
 * @returns {HTMLElement}
 */
function renderInlineThread(thread) {
  const wrapper = document.createElement("div");
  wrapper.className = "inline-thread";

  const comments = [thread.root, ...(thread.replies || [])];

  for (const comment of comments) {
    const item = document.createElement("div");
    item.className = "inline-thread-comment";

    const header = document.createElement("div");
    header.className = "inline-thread-header";

    const avatar = document.createElement("img");
    avatar.className = "inline-thread-avatar";
    avatar.width = 20;
    avatar.height = 20;
    avatar.src = comment.user?.avatar_url || "";
    avatar.alt = "";

    const author = document.createElement("strong");
    author.className = "inline-thread-author";
    author.textContent = comment.user?.login || "unknown";

    const time = document.createElement("span");
    time.className = "inline-thread-time";
    time.textContent = formatTimestamp(comment.created_at);

    header.appendChild(avatar);
    header.appendChild(author);
    header.appendChild(time);

    const body = document.createElement("div");
    body.className = "inline-thread-body";
    body.textContent = comment.body || "";

    item.appendChild(header);
    item.appendChild(body);
    wrapper.appendChild(item);
  }

  return wrapper;
}

// ---------------------------------------------------------------------------
// parsePatch
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DiffLine
 * @property {'context'|'addition'|'deletion'} type
 * @property {string}  content   - The line content (without the leading +/-/space marker).
 * @property {number|null} oldLineNo
 * @property {number|null} newLineNo
 */

/**
 * @typedef {Object} Hunk
 * @property {number}    oldStart
 * @property {number}    oldCount
 * @property {number}    newStart
 * @property {number}    newCount
 * @property {string}    header   - The raw @@ header line.
 * @property {DiffLine[]} lines
 */

/**
 * Parse a GitHub unified diff patch string into structured hunks.
 *
 * @param {string|undefined} patch - The raw unified diff string. May be
 *   undefined for binary files.
 * @returns {Hunk[]}
 */
export function parsePatch(patch) {
  if (!patch) return [];

  const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)/;

  const rawLines = patch.split("\n");
  const hunks = [];
  let currentHunk = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of rawLines) {
    // Ignore the "no newline" marker.
    if (raw.startsWith("\\ No newline at end of file")) {
      continue;
    }

    const hunkMatch = raw.match(HUNK_RE);

    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        header: raw,
        lines: [],
      };
      hunks.push(currentHunk);
      oldNo = oldStart;
      newNo = newStart;
      continue;
    }

    if (!currentHunk) continue;

    const marker = raw[0];
    const content = raw.substring(1);

    if (marker === "+") {
      currentHunk.lines.push({
        type: "addition",
        content,
        oldLineNo: null,
        newLineNo: newNo,
      });
      newNo++;
    } else if (marker === "-") {
      currentHunk.lines.push({
        type: "deletion",
        content,
        oldLineNo: oldNo,
        newLineNo: null,
      });
      oldNo++;
    } else {
      // Context line (leading space) or any other prefix.
      currentHunk.lines.push({
        type: "context",
        content: marker === " " ? content : raw,
        oldLineNo: oldNo,
        newLineNo: newNo,
      });
      oldNo++;
      newNo++;
    }
  }

  return hunks;
}

// ---------------------------------------------------------------------------
// buildCommentPositionMap
// ---------------------------------------------------------------------------

/**
 * Map review comment threads to diff line positions for a single file.
 *
 * @param {{ root: Object, replies: Object[] }[]} threads
 * @param {string} filePath
 * @returns {Map<string, { root: Object, replies: Object[] }[]>}
 *   Keyed by `"RIGHT:lineNo"` or `"LEFT:lineNo"`.
 */
export function buildCommentPositionMap(threads, filePath) {
  /** @type {Map<string, { root: Object, replies: Object[] }[]>} */
  const map = new Map();

  for (const thread of threads) {
    const root = thread.root;
    if (root.path !== filePath) continue;

    const line = root.line;
    if (line == null) continue;

    const side = root.side || "RIGHT";
    const key = `${side}:${line}`;

    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(thread);
  }

  return map;
}

// ---------------------------------------------------------------------------
// renderDiffTable
// ---------------------------------------------------------------------------

/**
 * Render a single file's diff as an HTML `<table>` element.
 *
 * @param {Hunk[]} hunks
 * @param {Map<string, { root: Object, replies: Object[] }[]>} commentMap
 *   Keyed by `"RIGHT:lineNo"` or `"LEFT:lineNo"`.
 * @returns {HTMLTableElement}
 */
export function renderDiffTable(hunks, commentMap) {
  const table = document.createElement("table");
  table.className = "diff-table";

  for (const hunk of hunks) {
    // Hunk header row.
    const hunkRow = document.createElement("tr");
    hunkRow.className = "diff-hunk-header";

    const hunkCell = document.createElement("td");
    hunkCell.colSpan = 3;
    hunkCell.textContent = hunk.header;
    hunkRow.appendChild(hunkCell);
    table.appendChild(hunkRow);

    // Diff lines.
    for (const line of hunk.lines) {
      const tr = document.createElement("tr");
      tr.className = `diff-line ${line.type}`;

      // Old line number.
      const oldTd = document.createElement("td");
      oldTd.className = "line-no old";
      oldTd.textContent = line.oldLineNo != null ? line.oldLineNo : "";
      tr.appendChild(oldTd);

      // New line number.
      const newTd = document.createElement("td");
      newTd.className = "line-no new";
      newTd.textContent = line.newLineNo != null ? line.newLineNo : "";
      tr.appendChild(newTd);

      // Content cell.
      const contentTd = document.createElement("td");
      contentTd.className = "diff-content";

      const markerSpan = document.createElement("span");
      markerSpan.className = "diff-marker";
      if (line.type === "addition") {
        markerSpan.textContent = "+";
      } else if (line.type === "deletion") {
        markerSpan.textContent = "-";
      } else {
        markerSpan.textContent = " ";
      }

      contentTd.appendChild(markerSpan);
      contentTd.appendChild(document.createTextNode(line.content));
      tr.appendChild(contentTd);
      table.appendChild(tr);

      // Check for comment threads attached to this line.
      if (commentMap) {
        const keys = [];
        if (line.newLineNo != null) keys.push(`RIGHT:${line.newLineNo}`);
        if (line.oldLineNo != null) keys.push(`LEFT:${line.oldLineNo}`);

        for (const key of keys) {
          const threads = commentMap.get(key);
          if (!threads) continue;

          for (const thread of threads) {
            const commentRow = document.createElement("tr");
            commentRow.className = "diff-comment-row";

            const commentCell = document.createElement("td");
            commentCell.colSpan = 3;
            commentCell.appendChild(renderInlineThread(thread));

            commentRow.appendChild(commentCell);
            table.appendChild(commentRow);
          }
        }
      }
    }
  }

  return table;
}

// ---------------------------------------------------------------------------
// renderDiffPanel
// ---------------------------------------------------------------------------

/**
 * Return a human-readable label for a file status string from the GitHub API.
 *
 * @param {string} status
 * @returns {string}
 */
function statusLabel(status) {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "modified":
    default:
      return "modified";
  }
}

/**
 * Render all file diffs into a container element.
 *
 * @param {string} containerId - The id of the DOM element to render into.
 * @param {Array}  files       - File objects from the GitHub API.  Each has
 *   `filename`, `status`, `additions`, `deletions`, and `patch`.
 * @param {Array}  reviewComments - Raw review comments array.
 * @param {Map<string, { root: Object, replies: Object[] }[]>} threadMap
 *   A pre-built map from `groupReviewCommentThreads` (keyed by root comment
 *   id).  Used here to derive per-file comment position maps.
 */
export function renderDiffPanel(containerId, files, reviewComments, threadMap) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";

  // Build a flat array of all threads from the threadMap.
  const allThreads = threadMap ? Array.from(threadMap.values()) : [];

  // Determine which files have review comments so we can default them to
  // expanded.
  const filesWithComments = new Set();
  for (const thread of allThreads) {
    if (thread.root?.path) {
      filesWithComments.add(thread.root.path);
    }
  }

  for (const file of files) {
    const section = document.createElement("div");
    section.className = "diff-file";

    // ----- File header -----------------------------------------------------
    const header = document.createElement("div");
    header.className = "diff-file-header";

    const badge = document.createElement("span");
    badge.className = `diff-status-badge status-${statusLabel(file.status)}`;
    badge.textContent = statusLabel(file.status);

    const filename = document.createElement("span");
    filename.className = "diff-filename";
    filename.textContent = file.filename;

    const stats = document.createElement("span");
    stats.className = "diff-stats";

    if (file.additions > 0) {
      const addSpan = document.createElement("span");
      addSpan.className = "diff-stat-add";
      addSpan.textContent = `+${file.additions}`;
      stats.appendChild(addSpan);
    }
    if (file.deletions > 0) {
      const delSpan = document.createElement("span");
      delSpan.className = "diff-stat-del";
      delSpan.textContent = `-${file.deletions}`;
      stats.appendChild(delSpan);
    }

    header.appendChild(badge);
    header.appendChild(filename);
    header.appendChild(stats);

    // ----- Diff body -------------------------------------------------------
    const body = document.createElement("div");
    body.className = "diff-file-body";

    if (file.patch) {
      const hunks = parsePatch(file.patch);
      const commentMap = buildCommentPositionMap(allThreads, file.filename);
      const table = renderDiffTable(hunks, commentMap);
      body.appendChild(table);
    } else if (file.status === "removed") {
      const placeholder = document.createElement("div");
      placeholder.className = "diff-placeholder";
      placeholder.textContent = "Binary file or file removed without diff";
      body.appendChild(placeholder);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "diff-placeholder";
      placeholder.textContent =
        file.binary ? "Binary file" : "No changes to display";
      body.appendChild(placeholder);
    }

    // ----- Expand / collapse -----------------------------------------------
    const hasComments = filesWithComments.has(file.filename);
    if (!hasComments) {
      body.hidden = true;
    }

    header.addEventListener("click", () => {
      body.hidden = !body.hidden;
    });

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  }
}

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

    // Prefer `line`/`side`; fall back to `original_*` for outdated comments
    // where the referenced code has moved or been removed.
    let line = root.line;
    let side = root.side || "RIGHT";
    if (line == null) {
      line = root.original_line;
      side = root.original_side || root.side || "RIGHT";
    }
    if (line == null) continue;

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
            if (thread.root && thread.root.id) {
              commentRow.id = `thread-${thread.root.id}`;
            }

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
export function renderDiffPanel(containerId, files, reviewComments, threadMap, prInfo) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";

  // Build a flat array of all threads from the threadMap.
  const allThreads = threadMap ? Array.from(threadMap.values()) : [];

  // Files with comments → default to expanded.
  const filesWithComments = new Set();
  for (const thread of allThreads) {
    if (thread.root?.path) filesWithComments.add(thread.root.path);
  }

  // Per-PR persistent state (hide/show, body expand/collapse, folder
  // collapse, viewed-file shas)
  const state = loadFileState(prInfo);
  const hiddenFiles = new Set(state.hidden);
  const expandedFiles = new Set(state.expanded);
  const collapsedFiles = new Set(state.collapsed);
  const collapsedFolders = new Set(state.collapsedFolders);
  const viewedShas = { ...state.viewed }; // { filename: sha-when-viewed }
  const save = () =>
    saveFileState(prInfo, {
      hidden: [...hiddenFiles],
      expanded: [...expandedFiles],
      collapsed: [...collapsedFiles],
      collapsedFolders: [...collapsedFolders],
      viewed: viewedShas,
    });

  // Helpers that classify viewed state against the current file's sha
  const viewedStatus = (file) => {
    const seenSha = viewedShas[file.filename];
    if (!seenSha) return "unviewed";
    if (seenSha === file.sha) return "viewed";
    return "changed"; // was viewed but content has changed
  };
  const setViewed = (file, isViewed) => {
    if (isViewed) viewedShas[file.filename] = file.sha;
    else delete viewedShas[file.filename];
    save();
  };

  // Two-pane layout: file tree on the left, diff content on the right
  const layout = document.createElement("div");
  layout.className = "files-changed-layout";

  const tree = document.createElement("aside");
  tree.className = "file-tree";

  const content = document.createElement("div");
  content.className = "diff-content";

  // Bulk-action header that sits above the file diffs
  const contentHeader = document.createElement("div");
  contentHeader.className = "diff-content-header";
  content.appendChild(contentHeader);

  layout.appendChild(tree);
  layout.appendChild(content);
  container.appendChild(layout);

  // Render each file's diff section into content.
  // Body visibility logic:
  //   1. If user explicitly expanded → expanded
  //   2. If user explicitly collapsed → collapsed
  //   3. Otherwise: expanded if file has comments, collapsed otherwise
  const fileSections = new Map();
  // Called whenever a viewed state toggles — re-syncs tree row styling
  // so the tree and the diff section stay in lockstep.
  const onViewedChange = (filename) => {
    const status = viewedShas[filename]
      ? viewedShas[filename] === files.find((f) => f.filename === filename)?.sha
        ? "viewed"
        : "changed"
      : "unviewed";
    updateTreeRowViewed(tree, filename, status);
  };
  for (const file of files) {
    const section = renderFileSection(
      file,
      allThreads,
      filesWithComments,
      expandedFiles,
      collapsedFiles,
      save,
      viewedStatus(file),
      (isViewed) => {
        setViewed(file, isViewed);
        onViewedChange(file.filename);
      }
    );
    fileSections.set(file.filename, section);
    if (hiddenFiles.has(file.filename)) section.hidden = true;
    content.appendChild(section);
  }

  // Bulk actions for file bodies
  const expandAllFiles = () => {
    for (const file of files) {
      const body = fileSections.get(file.filename)?.querySelector(".diff-file-body");
      if (body) body.hidden = false;
      expandedFiles.add(file.filename);
      collapsedFiles.delete(file.filename);
    }
    save();
  };
  const collapseAllFiles = () => {
    for (const file of files) {
      const body = fileSections.get(file.filename)?.querySelector(".diff-file-body");
      if (body) body.hidden = true;
      collapsedFiles.add(file.filename);
      expandedFiles.delete(file.filename);
    }
    save();
  };
  const setAllHidden = (hidden) => {
    if (hidden) {
      for (const f of files) hiddenFiles.add(f.filename);
    } else {
      hiddenFiles.clear();
    }
    for (const [filename, section] of fileSections) {
      section.hidden = hiddenFiles.has(filename);
    }
    // Update tree row styling
    for (const row of document.querySelectorAll(".tree-file[data-tree-file]")) {
      row.classList.toggle("file-hidden", hiddenFiles.has(row.dataset.treeFile));
    }
    save();
  };

  renderDiffContentHeader(contentHeader, files, {
    hiddenFiles,
    expandAllFiles,
    collapseAllFiles,
    setAllHidden,
  });

  // Build and render the file tree
  renderFileTree(
    tree,
    files,
    fileSections,
    hiddenFiles,
    collapsedFolders,
    save,
    viewedStatus,
    (file, isViewed) => {
      setViewed(file, isViewed);
      // Reflect the change in the diff section too
      const section = fileSections.get(file.filename);
      updateSectionViewed(section, isViewed ? "viewed" : "unviewed");
    }
  );
}

/** Update the tree row's viewed-state class without re-rendering. */
function updateTreeRowViewed(treeContainer, filename, status) {
  const row = treeContainer?.querySelector(
    `.tree-file[data-tree-file="${CSS.escape(filename)}"]`
  );
  if (!row) return;
  row.classList.remove("file-viewed", "file-changed-since-viewed");
  if (status === "viewed") row.classList.add("file-viewed");
  else if (status === "changed") row.classList.add("file-changed-since-viewed");
  // Keep the checkbox state in sync
  const cb = row.querySelector('input[type="checkbox"].file-viewed-toggle');
  if (cb) cb.checked = status === "viewed";
}

/** Update a diff file section's viewed-state class + checkbox. */
function updateSectionViewed(section, status) {
  if (!section) return;
  section.classList.remove("file-viewed", "file-changed-since-viewed");
  if (status === "viewed") section.classList.add("file-viewed");
  else if (status === "changed")
    section.classList.add("file-changed-since-viewed");
  const cb = section.querySelector('input[type="checkbox"].file-viewed-toggle');
  if (cb) cb.checked = status === "viewed";
}

/**
 * Render the bulk-action header shown above the diff list on the right side.
 */
function renderDiffContentHeader(container, files, api) {
  container.innerHTML = "";

  const count = document.createElement("span");
  count.className = "diff-content-count";
  count.textContent = `${files.length} file${files.length !== 1 ? "s" : ""} changed`;
  container.appendChild(count);

  const actions = document.createElement("div");
  actions.className = "file-tree-actions";
  container.appendChild(actions);

  const makeBtn = (label, title, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tree-action-btn";
    b.title = title;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };

  actions.appendChild(makeBtn("Expand all", "Expand all file diffs", api.expandAllFiles));
  actions.appendChild(makeBtn("Collapse all", "Collapse all file diffs", api.collapseAllFiles));

  const hideBtn = makeBtn("Hide all", "Hide every file from the diff view", () => {
    const allHidden = api.hiddenFiles.size === files.length;
    api.setAllHidden(!allHidden);
    updateHideLabel();
  });
  const updateHideLabel = () => {
    hideBtn.textContent = api.hiddenFiles.size === files.length ? "Show all" : "Hide all";
  };
  updateHideLabel();
  actions.appendChild(hideBtn);
}

/** Render one .diff-file section. Pulled out so the tree and main loop stay clean. */
function renderFileSection(
  file,
  allThreads,
  filesWithComments,
  expandedFiles,
  collapsedFiles,
  save,
  initialViewedStatus,
  onViewedToggle
) {
  const section = document.createElement("div");
  section.className = "diff-file";
  section.dataset.filename = file.filename;
  if (initialViewedStatus === "viewed") section.classList.add("file-viewed");
  else if (initialViewedStatus === "changed")
    section.classList.add("file-changed-since-viewed");

  const header = document.createElement("div");
  header.className = "diff-file-header";

  const badge = document.createElement("span");
  badge.className = `diff-status-badge status-${statusLabel(file.status)}`;
  badge.textContent = statusLabel(file.status);

  const filename = document.createElement("span");
  filename.className = "diff-filename";
  filename.textContent = file.filename;

  // "Changed since viewed" pill — only shown when applicable
  const changedPill = document.createElement("span");
  changedPill.className = "file-changed-pill";
  changedPill.textContent = "Changed since viewed";
  changedPill.hidden = initialViewedStatus !== "changed";

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

  // Viewed checkbox on the far right of the header
  const viewedLabel = document.createElement("label");
  viewedLabel.className = "file-viewed-label";
  viewedLabel.title = "Mark this file as viewed (tracked locally)";
  const viewedCheckbox = document.createElement("input");
  viewedCheckbox.type = "checkbox";
  viewedCheckbox.className = "file-viewed-toggle";
  viewedCheckbox.checked = initialViewedStatus === "viewed";
  viewedLabel.appendChild(viewedCheckbox);
  viewedLabel.appendChild(document.createTextNode(" Viewed"));
  // Clicks on the checkbox/label shouldn't expand/collapse the diff body
  viewedLabel.addEventListener("click", (e) => e.stopPropagation());
  viewedCheckbox.addEventListener("change", () => {
    const now = viewedCheckbox.checked;
    section.classList.remove("file-viewed", "file-changed-since-viewed");
    if (now) section.classList.add("file-viewed");
    changedPill.hidden = true;
    onViewedToggle?.(now);
  });

  header.appendChild(badge);
  header.appendChild(filename);
  header.appendChild(changedPill);
  header.appendChild(stats);
  header.appendChild(viewedLabel);

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

  // Initial body visibility: user's explicit choice wins, else default
  const fn = file.filename;
  if (expandedFiles && expandedFiles.has(fn)) {
    body.hidden = false;
  } else if (collapsedFiles && collapsedFiles.has(fn)) {
    body.hidden = true;
  } else {
    body.hidden = !filesWithComments.has(fn);
  }

  header.addEventListener("click", () => {
    body.hidden = !body.hidden;
    // Record explicit user choice so it persists
    if (body.hidden) {
      expandedFiles?.delete(fn);
      collapsedFiles?.add(fn);
    } else {
      collapsedFiles?.delete(fn);
      expandedFiles?.add(fn);
    }
    save?.();
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

/** Build a nested tree from flat filenames. */
function buildFileTree(files) {
  const root = { name: "", children: new Map(), file: null, isFile: false };
  for (const file of files) {
    const parts = file.filename.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          children: new Map(),
          file: null,
          isFile: false,
        });
      }
      node = node.children.get(part);
      if (isLeaf) {
        node.file = file;
        node.isFile = true;
      }
    }
  }
  return root;
}

function renderFileTree(
  container,
  files,
  fileSections,
  hiddenFiles,
  collapsedFolders,
  save,
  viewedStatus,
  onViewedToggle
) {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "file-tree-header";
  const count = document.createElement("span");
  count.className = "file-tree-count";
  count.textContent = `${files.length} file${files.length !== 1 ? "s" : ""}`;
  header.appendChild(count);

  const actions = document.createElement("div");
  actions.className = "file-tree-actions";
  header.appendChild(actions);

  // Expand all folders in the tree
  const expandFoldersBtn = document.createElement("button");
  expandFoldersBtn.type = "button";
  expandFoldersBtn.className = "tree-action-btn";
  expandFoldersBtn.title = "Expand all folders";
  expandFoldersBtn.textContent = "Expand";
  expandFoldersBtn.addEventListener("click", () => {
    for (const folder of listEl.querySelectorAll(".tree-folder")) {
      folder.classList.remove("collapsed");
      const child = folder.querySelector(":scope > .file-tree-list");
      if (child) child.hidden = false;
    }
    collapsedFolders.clear();
    save();
  });
  actions.appendChild(expandFoldersBtn);

  // Collapse all folders in the tree
  const collapseFoldersBtn = document.createElement("button");
  collapseFoldersBtn.type = "button";
  collapseFoldersBtn.className = "tree-action-btn";
  collapseFoldersBtn.title = "Collapse all folders";
  collapseFoldersBtn.textContent = "Collapse";
  collapseFoldersBtn.addEventListener("click", () => {
    for (const folder of listEl.querySelectorAll(".tree-folder")) {
      folder.classList.add("collapsed");
      const child = folder.querySelector(":scope > .file-tree-list");
      if (child) child.hidden = true;
      if (folder.dataset.folderPath) collapsedFolders.add(folder.dataset.folderPath);
    }
    save();
  });
  actions.appendChild(collapseFoldersBtn);

  container.appendChild(header);

  const treeRoot = buildFileTree(files);
  const listEl = document.createElement("ul");
  listEl.className = "file-tree-root";
  container.appendChild(listEl);

  // Helper to toggle a file's visibility via the eye icon in a row
  const setFileHidden = (filename, hidden) => {
    if (hidden) hiddenFiles.add(filename);
    else hiddenFiles.delete(filename);
    save();
    const section = fileSections.get(filename);
    if (section) section.hidden = hidden;
    const row = listEl.querySelector(
      `[data-tree-file="${CSS.escape(filename)}"]`
    );
    if (row) row.classList.toggle("file-hidden", hidden);
    // Refresh the "Hide all / Show all" label in the diff-content header
    const diffHideBtn = document.querySelector(".diff-content-header .tree-action-btn:last-child");
    if (diffHideBtn) {
      const total = fileSections.size;
      diffHideBtn.textContent = hiddenFiles.size === total ? "Show all" : "Hide all";
    }
  };

  // Recursive render. Returns the created <li>.
  // `pathSoFar` is the cumulative folder path used as a stable key for
  // persisting collapse state.
  function renderNode(node, pathSoFar) {
    if (node.isFile && node.children.size === 0) {
      return renderFileNode(node.file);
    }

    // Compact chain of single-child folders ("a/b/c") into one label.
    let displayName = node.name;
    let current = node;
    while (
      current.children.size === 1 &&
      !current.isFile
    ) {
      const [childName, childNode] = [...current.children.entries()][0];
      if (childNode.isFile && childNode.children.size === 0) break; // keep file separate
      displayName = displayName ? `${displayName}/${childName}` : childName;
      current = childNode;
      if (current.isFile) break;
    }

    // Stable key: full path from root (same displayName content)
    const folderPath = pathSoFar ? `${pathSoFar}/${displayName}` : displayName;

    const li = document.createElement("li");
    li.className = "tree-folder";
    li.dataset.folderPath = folderPath;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle";
    const chevron = document.createElement("span");
    chevron.className = "folder-chevron";
    chevron.textContent = "\u25BC";
    const folderIcon = document.createElement("span");
    folderIcon.className = "folder-icon";
    folderIcon.textContent = "\uD83D\uDCC1";
    const folderName = document.createElement("span");
    folderName.className = "folder-name";
    folderName.textContent = displayName;
    toggle.appendChild(chevron);
    toggle.appendChild(folderIcon);
    toggle.appendChild(folderName);
    li.appendChild(toggle);

    const childList = document.createElement("ul");
    childList.className = "file-tree-list";
    li.appendChild(childList);

    // Restore persisted collapsed state
    if (collapsedFolders && collapsedFolders.has(folderPath)) {
      li.classList.add("collapsed");
      childList.hidden = true;
    }

    // Stable order: folders first, then files, alphabetical
    const entries = [...current.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const child of entries) {
      childList.appendChild(renderNode(child, folderPath));
    }

    toggle.addEventListener("click", () => {
      const collapsed = li.classList.toggle("collapsed");
      childList.hidden = collapsed;
      if (collapsed) collapsedFolders?.add(folderPath);
      else collapsedFolders?.delete(folderPath);
      save?.();
    });

    return li;
  }

  function renderFileNode(file) {
    const li = document.createElement("li");
    li.className = "tree-file";
    li.dataset.treeFile = file.filename;
    if (hiddenFiles.has(file.filename)) li.classList.add("file-hidden");

    const vStatus = viewedStatus ? viewedStatus(file) : "unviewed";
    if (vStatus === "viewed") li.classList.add("file-viewed");
    else if (vStatus === "changed")
      li.classList.add("file-changed-since-viewed");

    // Viewed checkbox, on the far left so it's easy to scan down the column
    const viewedCb = document.createElement("input");
    viewedCb.type = "checkbox";
    viewedCb.className = "file-viewed-toggle";
    viewedCb.title = "Mark this file as viewed";
    viewedCb.checked = vStatus === "viewed";
    viewedCb.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    viewedCb.addEventListener("change", () => {
      const now = viewedCb.checked;
      li.classList.remove("file-viewed", "file-changed-since-viewed");
      if (now) li.classList.add("file-viewed");
      onViewedToggle?.(file, now);
    });
    li.appendChild(viewedCb);

    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "file-visibility";
    eye.title = "Hide/show this file";
    eye.innerHTML = `
      <svg class="icon-eye" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.932 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"></path></svg>
      <svg class="icon-eye-slash" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.832.88 9.577.43 8.9a1.619 1.619 0 0 1 0-1.797c.36-.543 1.053-1.492 2.014-2.404L.31 3.357A.75.75 0 0 1 .143 2.31Zm1.536 5.622A.12.12 0 0 0 1.657 8c0 .021.006.045.022.068.412.621 1.242 1.75 2.366 2.717C5.175 11.758 6.527 12.5 8 12.5c1.195 0 2.31-.489 3.29-1.191l-1.8-1.303A2.5 2.5 0 0 1 5.993 7.18Zm4.24 4.4.612-.608a4.0 4.0 0 0 0-4.823-4.823l-.608.612Z"></path></svg>
    `;
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowHidden = !hiddenFiles.has(file.filename);
      setFileHidden(file.filename, nowHidden);
    });
    li.appendChild(eye);

    const statusBadge = document.createElement("span");
    statusBadge.className = `tree-file-status status-${statusLabel(file.status)}`;
    statusBadge.textContent = statusLabel(file.status).charAt(0).toUpperCase();
    statusBadge.title = statusLabel(file.status);
    li.appendChild(statusBadge);

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "tree-file-name";
    nameBtn.textContent = file.filename.split("/").pop();
    nameBtn.title = file.filename;
    nameBtn.addEventListener("click", () => {
      // Scroll to the file section and expand it
      const section = fileSections.get(file.filename);
      if (!section) return;
      if (hiddenFiles.has(file.filename)) setFileHidden(file.filename, false);
      const body = section.querySelector(".diff-file-body");
      if (body && body.hidden) body.hidden = false;
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      section.classList.add("jump-flash");
      setTimeout(() => section.classList.remove("jump-flash"), 2000);
    });
    li.appendChild(nameBtn);

    const stats = document.createElement("span");
    stats.className = "tree-file-stats";
    if (file.additions > 0) {
      const a = document.createElement("span");
      a.className = "diff-stat-add";
      a.textContent = `+${file.additions}`;
      stats.appendChild(a);
    }
    if (file.deletions > 0) {
      const d = document.createElement("span");
      d.className = "diff-stat-del";
      d.textContent = `-${file.deletions}`;
      stats.appendChild(d);
    }
    li.appendChild(stats);

    return li;
  }

  // Render top-level children of root
  const topEntries = [...treeRoot.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const child of topEntries) {
    listEl.appendChild(renderNode(child, ""));
  }
}

/**
 * Per-PR persisted UI state for the Files Changed tab.
 *
 * Shape in localStorage:
 *   {
 *     hidden: string[],            // filenames hidden via eye toggle
 *     expanded: string[],          // filenames whose body user explicitly expanded
 *     collapsed: string[],         // filenames whose body user explicitly collapsed
 *     collapsedFolders: string[],  // folder paths collapsed in the tree
 *   }
 *
 * Also migrates the legacy `pr-reviewer-hidden-files:*` key on read.
 */
function stateKey(prInfo) {
  return prInfo
    ? `pr-reviewer-file-state:${prInfo.owner}/${prInfo.repo}/${prInfo.number}`
    : null;
}

function legacyHiddenKey(prInfo) {
  return prInfo
    ? `pr-reviewer-hidden-files:${prInfo.owner}/${prInfo.repo}/${prInfo.number}`
    : null;
}

function loadFileState(prInfo) {
  const key = stateKey(prInfo);
  const empty = {
    hidden: [],
    expanded: [],
    collapsed: [],
    collapsedFolders: [],
    viewed: {},
  };
  if (!key) return empty;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
        expanded: Array.isArray(parsed.expanded) ? parsed.expanded : [],
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : [],
        collapsedFolders: Array.isArray(parsed.collapsedFolders)
          ? parsed.collapsedFolders
          : [],
        viewed:
          parsed.viewed && typeof parsed.viewed === "object"
            ? parsed.viewed
            : {},
      };
    }
    // Legacy migration: read old hidden-only key, if present
    const legacy = legacyHiddenKey(prInfo);
    if (legacy) {
      const rawLegacy = localStorage.getItem(legacy);
      if (rawLegacy) {
        const arr = JSON.parse(rawLegacy);
        if (Array.isArray(arr)) {
          localStorage.removeItem(legacy);
          return { ...empty, hidden: arr };
        }
      }
    }
  } catch {
    /* fall through to empty */
  }
  return empty;
}

function saveFileState(prInfo, state) {
  const key = stateKey(prInfo);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* quota exceeded or disabled — ignore */
  }
}

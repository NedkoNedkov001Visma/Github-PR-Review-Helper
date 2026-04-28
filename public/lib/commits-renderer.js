import { formatTimestamp } from "./ui.js";

const COMMIT_SORT_KEY = "pr-reviewer-commit-sort";

function loadCommitSortDir() {
  try {
    const raw = localStorage.getItem(COMMIT_SORT_KEY);
    if (raw === "asc" || raw === "desc") return raw;
  } catch {
    /* fall through */
  }
  return "asc"; // GitHub's natural order: oldest first
}

function saveCommitSortDir(dir) {
  try {
    localStorage.setItem(COMMIT_SORT_KEY, dir);
  } catch {
    /* ignore */
  }
}

function commitDate(c) {
  return c.commit?.author?.date || c.commit?.committer?.date || null;
}

/**
 * Render the Commits panel for the current PR.
 *
 * Each commit shows:
 *  - Avatar + login of the GitHub author (falls back to commit.author.name)
 *  - The first line of the commit message (subject)
 *  - The body (collapsed by default if non-empty)
 *  - Authored-on relative timestamp
 *  - 7-char SHA, linking to the commit on GitHub
 *
 * Commits come back from GitHub in chronological order (oldest first).
 */
export function renderCommitsPanel(containerId, commits = [], prInfo = null) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  if (!commits.length) {
    const empty = document.createElement("div");
    empty.className = "commits-empty";
    empty.textContent = "No commits in this PR.";
    container.appendChild(empty);
    return;
  }

  // Mutate-safe copy so re-sorts don't depend on the input order
  const baseCommits = commits.slice();

  const header = document.createElement("div");
  header.className = "commits-header";
  const count = document.createElement("span");
  count.className = "commits-count";
  count.textContent = `${commits.length} commit${commits.length !== 1 ? "s" : ""}`;
  header.appendChild(count);

  // Sort control — direction toggle (asc / desc by date)
  let sortDir = loadCommitSortDir();
  const sortGroup = document.createElement("div");
  sortGroup.className = "commits-sort";
  const sortLabel = document.createElement("span");
  sortLabel.className = "commits-sort-label";
  sortLabel.textContent = "Sort by date:";
  sortGroup.appendChild(sortLabel);

  const dirBtn = document.createElement("button");
  dirBtn.type = "button";
  dirBtn.className = "commits-sort-dir";
  const updateDirBtn = () => {
    if (sortDir === "asc") {
      dirBtn.title = "Oldest first — click for newest first";
      dirBtn.innerHTML = `<span class="commits-sort-text">Oldest first</span><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.22 10.53a.749.749 0 0 1 0-1.06L7.47 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8 6.81l-3.72 3.72a.749.749 0 0 1-1.06 0Z"></path></svg>`;
    } else {
      dirBtn.title = "Newest first — click for oldest first";
      dirBtn.innerHTML = `<span class="commits-sort-text">Newest first</span><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z"></path></svg>`;
    }
  };
  updateDirBtn();
  dirBtn.addEventListener("click", () => {
    sortDir = sortDir === "asc" ? "desc" : "asc";
    saveCommitSortDir(sortDir);
    updateDirBtn();
    redrawList();
  });
  sortGroup.appendChild(dirBtn);
  header.appendChild(sortGroup);

  container.appendChild(header);

  const list = document.createElement("ol");
  list.className = "commits-list";
  container.appendChild(list);

  function redrawList() {
    list.innerHTML = "";
    const sorted = baseCommits.slice().sort((a, b) => {
      const ta = new Date(commitDate(a) || 0).getTime();
      const tb = new Date(commitDate(b) || 0).getTime();
      return sortDir === "asc" ? ta - tb : tb - ta;
    });

    // Group consecutive commits by their authored date (YYYY-MM-DD) so the
    // list reads like a timeline. The label sits on its own row above each
    // group, similar to GitHub's PR commits view.
    let lastDateKey = null;
    for (const c of sorted) {
      const authored = commitDate(c);
      const dateKey = authored ? authored.slice(0, 10) : "unknown";
      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        const groupLabel = document.createElement("li");
        groupLabel.className = "commits-group-label";
        groupLabel.textContent = formatGroupDate(authored);
        list.appendChild(groupLabel);
      }

      list.appendChild(renderCommitItem(c, prInfo));
    }
  }

  redrawList();
}

function renderCommitItem(c, prInfo) {
  const li = document.createElement("li");
  li.className = "commit-item";

  // Resolve author info — prefer the linked GitHub user
  const ghUser = c.author; // can be null if committer is not on GitHub
  const commitAuthorName =
    c.commit?.author?.name || ghUser?.login || "unknown";
  const avatarUrl = ghUser?.avatar_url || null;
  const authorLogin = ghUser?.login || null;

  const avatar = document.createElement("div");
  avatar.className = "commit-avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = authorLogin || commitAuthorName;
    img.width = 24;
    img.height = 24;
    avatar.appendChild(img);
  } else {
    avatar.classList.add("commit-avatar-fallback");
    avatar.textContent = (commitAuthorName[0] || "?").toUpperCase();
  }
  li.appendChild(avatar);

  const main = document.createElement("div");
  main.className = "commit-main";

  // Subject + (optional) expand toggle
  const message = c.commit?.message || "";
  const newline = message.indexOf("\n");
  const subject = newline === -1 ? message : message.slice(0, newline);
  const body = newline === -1 ? "" : message.slice(newline + 1).trim();

  const subjectRow = document.createElement("div");
  subjectRow.className = "commit-subject-row";

  // Subject is a link to the commit detail page in this app.
  const subjectEl = prInfo
    ? document.createElement("a")
    : document.createElement("div");
  subjectEl.className = "commit-subject";
  subjectEl.textContent = subject;
  if (prInfo) {
    subjectEl.href = `#${prInfo.owner}/${prInfo.repo}/commit/${c.sha}`;
    subjectEl.title = "Open commit details";
  }
  subjectRow.appendChild(subjectEl);

  if (body) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "commit-body-toggle";
    toggle.title = "Toggle commit body";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 5a1 1 0 0 1 1.7-.7L8 10.6l6.3-6.3a1 1 0 1 1 1.4 1.4l-7 7a1 1 0 0 1-1.4 0l-7-7A1 1 0 0 1 0 5Z"></path></svg>`;
    subjectRow.appendChild(toggle);
  }
  main.appendChild(subjectRow);

  // Meta: author + relative time
  const meta = document.createElement("div");
  meta.className = "commit-meta";
  if (authorLogin) {
    const a = document.createElement("a");
    a.href = `https://github.com/${encodeURIComponent(authorLogin)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "commit-author-link";
    a.textContent = authorLogin;
    meta.appendChild(a);
  } else {
    const span = document.createElement("span");
    span.className = "commit-author-name";
    span.textContent = commitAuthorName;
    meta.appendChild(span);
  }
  meta.appendChild(document.createTextNode(" committed "));
  const ts = document.createElement("span");
  ts.className = "commit-time";
  const dateIso = c.commit?.author?.date || c.commit?.committer?.date;
  if (dateIso) {
    ts.textContent = formatTimestamp(dateIso);
    ts.title = new Date(dateIso).toLocaleString();
  }
  meta.appendChild(ts);
  main.appendChild(meta);

  // Optional expandable body
  if (body) {
    const bodyEl = document.createElement("pre");
    bodyEl.className = "commit-body";
    bodyEl.hidden = true;
    bodyEl.textContent = body;
    main.appendChild(bodyEl);

    const toggle = subjectRow.querySelector(".commit-body-toggle");
    toggle.addEventListener("click", () => {
      const open = bodyEl.hidden;
      bodyEl.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.classList.toggle("is-open", open);
    });
  }

  li.appendChild(main);

  // SHA chip (opens the commit inside this app)
  const shortSha = (c.sha || "").slice(0, 7);
  if (shortSha) {
    const shaLink = document.createElement("a");
    shaLink.className = "commit-sha";
    shaLink.textContent = shortSha;
    shaLink.title = `Open ${shortSha} in PR Reviewer`;
    if (prInfo) {
      shaLink.href = `#${prInfo.owner}/${prInfo.repo}/commit/${c.sha}`;
    } else {
      shaLink.href = `#commit/${c.sha}`;
    }
    li.appendChild(shaLink);
  }

  return li;
}

function formatGroupDate(iso) {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  // e.g. "Mon, Apr 28, 2026"
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

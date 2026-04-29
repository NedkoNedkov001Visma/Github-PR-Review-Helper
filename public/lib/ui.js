import {
  addComment,
  replyToReviewComment,
  resolveThread,
  unresolveThread,
} from "./api.js";
import { parsePatch } from "./diff-renderer.js";

// ---------------------------------------------------------------------------
// Markdown rendering (regex-based GFM subset)
// ---------------------------------------------------------------------------

// Safe HTML tags that we allow through from GitHub markdown bodies.
// These are restored after escaping so they render natively.
const SAFE_TAGS = [
  "details", "summary", "br", "hr", "sub", "sup", "kbd", "abbr",
  "dl", "dt", "dd", "ruby", "rt", "rp",
];
const SAFE_TAG_RE = new RegExp(
  `&lt;(/?(?:${SAFE_TAGS.join("|")}))(\\s[^&]*?)?&gt;`, "gi"
);

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {{owner: string, repo: string}} [opts.repoCtx]
 *   Used to auto-link bare commit SHAs (e.g. "cbf28e4") to
 *   https://github.com/{owner}/{repo}/commit/{sha}.
 */
export function renderMarkdown(text, opts = {}) {
  if (!text) return "";

  // HTML-escape to prevent XSS
  let src = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Restore safe HTML tags that GitHub markdown supports
  src = src.replace(SAFE_TAG_RE, (_, tag, attrs) => `<${tag}${attrs || ""}>`);

  // Extract fenced code blocks first so inner transforms don't touch them
  const codeBlocks = [];
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const cls = lang ? ` class="language-${lang}"` : "";
    codeBlocks.push(`<pre><code${cls}>${code}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // Extract inline code so inner transforms don't touch them
  const inlineCodes = [];
  src = src.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00INLINE_${idx}\x00`;
  });

  // --- Tables ---
  // Detect runs of pipe-delimited lines (header | separator | body rows).
  // The separator line has cells like :---, ---:, :---:, or just ---.
  const tables = [];
  src = src.replace(
    /(^\|.+\|\s*\n)(^\|[\s:|-]+\|\s*\n)((?:^\|.+\|\s*\n?)*)/gm,
    (_match, headerLine, _sepLine, bodyBlock) => {
      const parseRow = (line) =>
        line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

      const headers = parseRow(headerLine);
      const bodyRows = bodyBlock
        .trim()
        .split("\n")
        .filter((l) => l.trim())
        .map(parseRow);

      let html = "<table><thead><tr>";
      for (const h of headers) html += `<th>${h}</th>`;
      html += "</tr></thead><tbody>";
      for (const row of bodyRows) {
        html += "<tr>";
        for (const cell of row) html += `<td>${cell}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";

      const idx = tables.length;
      tables.push(html);
      return `\x00TABLE_${idx}\x00`;
    }
  );

  // Headers
  src = src.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  src = src.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  src = src.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  src = src.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  src = src.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  src = src.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Images (before links so ![alt](url) is not caught by link regex)
  src = src.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1">'
  );

  // Links
  src = src.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank">$1</a>'
  );

  // Auto-link bare commit SHAs (7-40 hex chars). Skip text already inside
  // an <a>...</a> we just produced. Also skip <img> attributes by checking
  // we're not inside any tag (the regex rejects matches preceded by `=` or
  // inside an `<a ... >...</a>` block via the alternation).
  if (opts.repoCtx && opts.repoCtx.owner && opts.repoCtx.repo) {
    const { owner, repo } = opts.repoCtx;
    src = src.replace(
      /(<a\s[^>]*>[\s\S]*?<\/a>)|(<[^>]+>)|\b([0-9a-f]{7,40})\b/g,
      (match, anchorBlock, otherTag, sha) => {
        if (anchorBlock) return anchorBlock; // leave existing links untouched
        if (otherTag) return otherTag; // leave other tag attributes alone
        // Open the commit inside this app instead of github.com.
        const short = sha.slice(0, 7);
        return `<a href="#${owner}/${repo}/commit/${sha}" class="commit-mention" title="Open commit ${sha} in PR Reviewer"><code>${short}</code></a>`;
      }
    );
  }

  // Bold (before italic)
  src = src.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic (single *, not preceded/followed by *)
  src = src.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

  // Blockquotes — collect consecutive > lines
  src = src.replace(
    /(^&gt;\s.+(?:\n&gt;\s.+)*)/gm,
    (block) => {
      const inner = block.replace(/^&gt;\s/gm, "");
      return `<blockquote>${inner}</blockquote>`;
    }
  );

  // Task lists (must come before regular list handling)
  src = src.replace(
    /^[-*]\s+\[x\]\s+(.+)$/gm,
    '<li class="task-item"><input type="checkbox" checked disabled> $1</li>'
  );
  src = src.replace(
    /^[-*]\s+\[\s\]\s+(.+)$/gm,
    '<li class="task-item"><input type="checkbox" disabled> $1</li>'
  );

  // Unordered lists — wrap consecutive <li> or bare `- ` / `* ` lines
  src = src.replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>");
  src = src.replace(
    /((?:<li(?:\s[^>]*)?>.*<\/li>\n?)+)/g,
    (block) => {
      const tag = block.includes('class="task-item"') ? "ul" : "ul";
      return `<${tag}>${block}</${tag}>`;
    }
  );

  // Ordered lists
  src = src.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");
  src = src.replace(
    /((?:<li>.*<\/li>\n?){2,})/g,
    (block) => {
      if (block.startsWith("<ul>") || block.startsWith("<ol>")) return block;
      return `<ol>${block}</ol>`;
    }
  );

  // Paragraphs — double newline
  src = src.replace(/\n\n+/g, "</p><p>");
  src = `<p>${src}</p>`;

  // Clean up empty paragraphs around block elements
  const blockTags = "h1|h2|h3|h4|h5|h6|pre|blockquote|ul|ol|table|details";
  src = src.replace(
    new RegExp(`<p>\\s*(<(?:${blockTags})[>\\s])`, "g"),
    "$1"
  );
  src = src.replace(
    new RegExp(`(</(?:${blockTags})>)\\s*</p>`, "g"),
    "$1"
  );

  // Line breaks — single newline inside paragraphs
  src = src.replace(/\n/g, "<br>");

  // Restore inline code
  src = src.replace(/\x00INLINE_(\d+)\x00/g, (_m, idx) => inlineCodes[idx]);

  // Restore tables
  src = src.replace(/\x00TABLE_(\d+)\x00/g, (_m, idx) => tables[idx]);

  // Restore code blocks
  src = src.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, idx) => codeBlocks[idx]);

  return src;
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

export function formatTimestamp(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;

  // Older than ~30 days — show absolute date
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

export function showTab(tabName) {
  document.querySelectorAll("[role='tab']").forEach((btn) => {
    const selected = btn.dataset.tab === tabName;
    btn.setAttribute("aria-selected", String(selected));
    if (selected) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  document.querySelectorAll("[role='tabpanel']").forEach((panel) => {
    panel.hidden = panel.id !== `panel-${tabName}`;
  });
}

// ---------------------------------------------------------------------------
// Helper: create an element with optional classes and text
// ---------------------------------------------------------------------------

function el(tag, classNames, textContent) {
  const node = document.createElement(tag);
  if (classNames) {
    const list = Array.isArray(classNames) ? classNames : [classNames];
    for (const entry of list) {
      // Allow space-separated class strings like "foo bar baz"
      for (const c of String(entry).split(/\s+/).filter(Boolean)) {
        node.classList.add(c);
      }
    }
  }
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

// ---------------------------------------------------------------------------
// PR Header
// ---------------------------------------------------------------------------

/**
 * Compute the latest review state per reviewer and the overall approval
 * status. Returns { approvedBy, changesRequestedBy, isApproved,
 * hasChangesRequested, status }.
 *
 * `status` is one of: "approved", "changes_requested", "review_required",
 * "no_reviews".
 */
export function computeApprovalState(reviews = [], prAuthorLogin = null) {
  // Latest non-COMMENTED review per reviewer (PENDING reviews are drafts —
  // ignore them). COMMENTED reviews don't change approval state, so we
  // skip them when picking the "latest decision".
  const latestByReviewer = new Map();
  for (const r of reviews) {
    if (!r || !r.user || !r.user.login) continue;
    const login = r.user.login;
    // Skip the PR author's own self-reviews — GitHub doesn't count them.
    if (prAuthorLogin && login === prAuthorLogin) continue;
    if (r.state === "PENDING" || r.state === "COMMENTED") continue;
    const ts = r.submitted_at || r.created_at;
    const prev = latestByReviewer.get(login);
    if (!prev || new Date(ts) > new Date(prev.submitted_at || prev.created_at)) {
      latestByReviewer.set(login, r);
    }
  }
  const approvedBy = [];
  const changesRequestedBy = [];
  for (const [login, r] of latestByReviewer) {
    if (r.state === "APPROVED") approvedBy.push(login);
    else if (r.state === "CHANGES_REQUESTED") changesRequestedBy.push(login);
  }
  const hasChangesRequested = changesRequestedBy.length > 0;
  const isApproved = approvedBy.length > 0 && !hasChangesRequested;
  let status;
  if (hasChangesRequested) status = "changes_requested";
  else if (isApproved) status = "approved";
  else if (latestByReviewer.size === 0 && reviews.length === 0)
    status = "no_reviews";
  else status = "review_required";

  return { approvedBy, changesRequestedBy, isApproved, hasChangesRequested, status };
}

/**
 * @param {object} pr        The PR object from the API.
 * @param {string} containerId
 * @param {object} [opts]
 * @param {Array}  [opts.reviews]       Used to compute approval state.
 * @param {object} [opts.currentUser]   { login } — gates the Approve button.
 * @param {Function} [opts.onApprove]   Called when the Approve button is clicked.
 * @param {Function} [opts.onMerge]     Called when the Merge button is clicked.
 */
export function renderPRHeader(pr, containerId = "pr-header", opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  const reviews = opts.reviews || [];
  const currentUser = opts.currentUser || null;
  const approval = computeApprovalState(reviews, pr.user?.login);

  // Breadcrumb: owner / repo — clickable back to the repo PR list
  const repoFull = pr.base?.repo?.full_name;
  if (repoFull) {
    const [owner, repo] = repoFull.split("/");
    const crumb = el("div", "pr-breadcrumb");

    // Owner navigates to the in-app PR list for this repo (we don't
    // have an owner-level page, and jumping out to github.com from
    // here is rarely what the user wants).
    const ownerLink = document.createElement("a");
    ownerLink.href = `#repo=${encodeURIComponent(repoFull)}`;
    ownerLink.className = "breadcrumb-link";
    ownerLink.textContent = owner;
    ownerLink.title = `Back to ${repoFull} PRs`;
    crumb.appendChild(ownerLink);

    crumb.appendChild(document.createTextNode(" / "));

    const repoLink = document.createElement("a");
    repoLink.href = `#repo=${encodeURIComponent(repoFull)}`;
    repoLink.className = "breadcrumb-link breadcrumb-repo";
    repoLink.textContent = repo;
    repoLink.title = `Back to ${repoFull} PRs`;
    crumb.appendChild(repoLink);

    container.appendChild(crumb);
  }

  // Title + number — number is a link to the PR on GitHub
  const heading = el("h2", "pr-title");
  heading.appendChild(document.createTextNode(`${pr.title} `));
  if (pr.html_url) {
    const numberLink = document.createElement("a");
    numberLink.href = pr.html_url;
    numberLink.target = "_blank";
    numberLink.rel = "noopener";
    numberLink.className = "pr-number-link";
    numberLink.textContent = `#${pr.number}`;
    numberLink.title = "Open this PR on GitHub";
    heading.appendChild(numberLink);
  } else {
    heading.appendChild(document.createTextNode(`#${pr.number}`));
  }
  container.appendChild(heading);

  // State badge
  const badge = el("span", "state-badge");
  if (pr.merged) {
    badge.textContent = "Merged";
    badge.classList.add("state-merged");
  } else if (pr.state === "closed") {
    badge.textContent = "Closed";
    badge.classList.add("state-closed");
  } else {
    badge.textContent = "Open";
    badge.classList.add("state-open");
  }
  container.appendChild(badge);

  // Author
  const authorWrap = el("span", "pr-author");
  if (pr.user && pr.user.avatar_url) {
    const avatar = document.createElement("img");
    avatar.src = pr.user.avatar_url;
    avatar.alt = pr.user.login;
    avatar.width = 20;
    avatar.height = 20;
    avatar.classList.add("avatar-small");
    authorWrap.appendChild(avatar);
  }
  if (pr.user) {
    const login = el("strong", null, pr.user.login);
    authorWrap.appendChild(login);
  }
  container.appendChild(authorWrap);

  // Branch info
  const branches = el("span", "pr-branches");
  const baseBranch = el("code", "branch-name", pr.base && pr.base.ref);
  const arrow = document.createTextNode(" \u2190 ");
  const headBranch = el("code", "branch-name", pr.head && pr.head.ref);
  branches.appendChild(baseBranch);
  branches.appendChild(arrow);
  branches.appendChild(headBranch);
  container.appendChild(branches);

  // Line stats
  if (pr.additions !== undefined || pr.deletions !== undefined) {
    const stats = el("span", "pr-stats");
    const plus = el("span", "stat-additions", `+${pr.additions || 0}`);
    const minus = el("span", "stat-deletions", `-${pr.deletions || 0}`);
    stats.appendChild(plus);
    stats.appendChild(document.createTextNode(" / "));
    stats.appendChild(minus);
    container.appendChild(stats);
  }

  // Approval status badge — only meaningful for open PRs
  if (pr.state === "open" && !pr.merged) {
    const reviewBadge = el("span", "review-state-badge");
    if (approval.status === "approved") {
      reviewBadge.classList.add("review-approved");
      reviewBadge.title = `Approved by: ${approval.approvedBy.join(", ")}`;
      reviewBadge.appendChild(checkIcon());
      reviewBadge.appendChild(
        document.createTextNode(
          approval.approvedBy.length > 1
            ? `Approved by ${approval.approvedBy.length} reviewers`
            : `Approved`
        )
      );
    } else if (approval.status === "changes_requested") {
      reviewBadge.classList.add("review-changes");
      reviewBadge.title = `Changes requested by: ${approval.changesRequestedBy.join(", ")}`;
      reviewBadge.appendChild(xIcon());
      reviewBadge.appendChild(document.createTextNode("Changes requested"));
    } else {
      reviewBadge.classList.add("review-pending");
      reviewBadge.appendChild(dotIcon());
      reviewBadge.appendChild(document.createTextNode("Review required"));
    }
    container.appendChild(reviewBadge);
  }

  // Action buttons — Approve + Merge. Only on open, non-merged PRs.
  if (pr.state === "open" && !pr.merged) {
    const actions = el("div", "pr-header-actions");

    // The current user may approve if they're a reviewer (assigned or
    // already reviewed) AND not the PR author.
    const isAuthor = currentUser && pr.user && currentUser.login === pr.user.login;
    const requestedReviewerLogins = new Set(
      (pr.requested_reviewers || []).map((u) => u.login)
    );
    const reviewerLogins = new Set(
      (reviews || []).map((r) => r.user && r.user.login).filter(Boolean)
    );
    const isReviewer =
      currentUser &&
      (requestedReviewerLogins.has(currentUser.login) ||
        reviewerLogins.has(currentUser.login));

    // Has the current user already approved? (latest review by them)
    const myLatestState = (() => {
      if (!currentUser) return null;
      const mine = (reviews || [])
        .filter((r) => r.user && r.user.login === currentUser.login)
        .filter((r) => r.state !== "PENDING" && r.state !== "COMMENTED")
        .sort(
          (a, b) =>
            new Date(b.submitted_at || b.created_at) -
            new Date(a.submitted_at || a.created_at)
        )[0];
      return mine ? mine.state : null;
    })();

    if (currentUser && isReviewer && !isAuthor) {
      const approveBtn = document.createElement("button");
      approveBtn.type = "button";
      approveBtn.className = "pr-action-btn pr-action-approve";
      const alreadyApproved = myLatestState === "APPROVED";
      approveBtn.disabled = alreadyApproved;
      approveBtn.title = alreadyApproved
        ? "You have already approved this PR"
        : "Approve this PR";
      approveBtn.appendChild(checkIcon());
      approveBtn.appendChild(
        document.createTextNode(alreadyApproved ? "Approved" : "Approve")
      );
      approveBtn.addEventListener("click", () => {
        if (typeof opts.onApprove === "function") opts.onApprove(approveBtn);
      });
      actions.appendChild(approveBtn);
    }

    // Merge: split button. Main click uses the last-chosen method for
    // this repo (default: "merge"). Caret opens a popover with the three
    // GitHub-supported methods so the user can pick another — useful
    // when the repo doesn't allow merge commits, only squash/rebase.
    let mergeDisabledReason = null;
    if (!approval.isApproved) {
      mergeDisabledReason = approval.hasChangesRequested
        ? "Changes have been requested"
        : "Waiting for an approval from a reviewer";
    } else if (pr.mergeable === false) {
      mergeDisabledReason = "Merge conflicts — resolve before merging";
    } else if (pr.draft) {
      mergeDisabledReason = "PR is in draft";
    }

    const repoFull = pr.base?.repo?.full_name || "";
    const methodKey = `pr-reviewer-merge-method:${repoFull}`;
    const allowedMethods = ["merge", "squash", "rebase"];
    let savedMethod = "merge";
    try {
      const v = localStorage.getItem(methodKey);
      if (allowedMethods.includes(v)) savedMethod = v;
    } catch {
      /* ignore */
    }

    const METHOD_LABELS = {
      merge: "Create merge commit",
      squash: "Squash and merge",
      rebase: "Rebase and merge",
    };
    const SHORT_LABELS = {
      merge: "Merge",
      squash: "Squash",
      rebase: "Rebase",
    };

    const wrap = el("div", "pr-action-merge-wrap");
    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "pr-action-btn pr-action-merge pr-action-merge-main";
    mainBtn.appendChild(mergeIcon());
    const mainLabel = document.createTextNode(SHORT_LABELS[savedMethod]);
    mainBtn.appendChild(mainLabel);
    mainBtn.disabled = !!mergeDisabledReason;
    mainBtn.title = mergeDisabledReason
      ? mergeDisabledReason
      : METHOD_LABELS[savedMethod];

    // Caret is always clickable — even when merge is blocked, the user
    // should be able to pre-select their preferred method.
    const caretBtn = document.createElement("button");
    caretBtn.type = "button";
    caretBtn.className = "pr-action-btn pr-action-merge pr-action-merge-caret";
    caretBtn.title = "Choose a merge method";
    caretBtn.setAttribute("aria-label", "Choose a merge method");
    caretBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.749.749 0 1 1 1.06-1.06L8 9.94l3.72-3.72a.749.749 0 0 1 1.06 0Z"></path></svg>`;

    const menu = el("div", "pr-action-merge-menu");
    menu.hidden = true;
    for (const m of allowedMethods) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pr-action-merge-menu-item";
      item.dataset.method = m;
      item.textContent = METHOD_LABELS[m];
      item.addEventListener("click", () => {
        savedMethod = m;
        try { localStorage.setItem(methodKey, m); } catch { /* ignore */ }
        mainLabel.textContent = SHORT_LABELS[m];
        mainBtn.title = mergeDisabledReason || METHOD_LABELS[m];
        menu.hidden = true;
        wrap.classList.remove("is-open");
        // Only fire the merge when the main button isn't blocked —
        // otherwise the click is just "save preference" so the user
        // can pre-pick before approval comes in.
        if (!mergeDisabledReason && typeof opts.onMerge === "function") {
          opts.onMerge(mainBtn, m);
        }
      });
      menu.appendChild(item);
    }

    mainBtn.addEventListener("click", () => {
      if (typeof opts.onMerge === "function") opts.onMerge(mainBtn, savedMethod);
    });
    caretBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      wrap.classList.toggle("is-open", willOpen);
    });
    // Click outside / Escape to dismiss
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !wrap.contains(e.target)) {
        menu.hidden = true;
        wrap.classList.remove("is-open");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        menu.hidden = true;
        wrap.classList.remove("is-open");
      }
    });

    wrap.appendChild(mainBtn);
    wrap.appendChild(caretBtn);
    wrap.appendChild(menu);
    actions.appendChild(wrap);

    container.appendChild(actions);
  }
}

// Inline SVG helpers used by the header badge / buttons
function checkIcon() {
  const span = el("span", "icon-inline");
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>`;
  return span;
}
function xIcon() {
  const span = el("span", "icon-inline");
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path></svg>`;
  return span;
}
function dotIcon() {
  // Plain CSS dot — the SVG version had a tiny circle inside a 16x16
  // viewBox, which left empty space around it and looked off-center.
  return el("span", "icon-dot");
}
function mergeIcon() {
  const span = el("span", "icon-inline");
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8-9a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"></path></svg>`;
  return span;
}

// ---------------------------------------------------------------------------
// Issue comment
// ---------------------------------------------------------------------------

/**
 * Make a header toggle visibility of all sibling elements that follow it
 * within the same parent. Adds a chevron indicator.
 */
/**
 * Make a header toggle visibility of all sibling elements that follow it.
 * If `opts` is passed with { id, collapsedSet, save, initiallyCollapsed },
 * the toggle state is persisted and restored.
 */
function makeCollapsible(header, opts = {}) {
  header.classList.add("collapsible-header");
  const chevron = el("span", "collapse-chevron", "\u25BC");
  header.insertBefore(chevron, header.firstChild);

  const applyCollapsed = (collapsed) => {
    header.classList.toggle("collapsed", collapsed);
    let sibling = header.nextElementSibling;
    while (sibling) {
      sibling.hidden = collapsed;
      sibling = sibling.nextElementSibling;
    }
  };

  // Initial state
  if (opts.initiallyCollapsed) {
    applyCollapsed(true);
  }

  header.addEventListener("click", () => {
    const nowCollapsed = !header.classList.contains("collapsed");
    applyCollapsed(nowCollapsed);
    if (opts.id && opts.collapsedSet) {
      if (nowCollapsed) opts.collapsedSet.add(opts.id);
      else opts.collapsedSet.delete(opts.id);
      opts.save?.();
    }
  });

  // Expose helpers so bulk actions can toggle without re-firing click handlers
  header._setCollapsed = applyCollapsed;
}

export function renderIssueComment(comment, collapseCtx, seenCtx, prInfo = null) {
  const item = el("div", "timeline-item");
  const commentId = `ic-${comment.id}`;
  item.dataset.commentId = commentId;

  // Avatar column
  const avatarWrap = el("div", "timeline-item-avatar");
  if (comment.user && comment.user.avatar_url) {
    const img = document.createElement("img");
    img.src = comment.user.avatar_url;
    img.alt = comment.user.login;
    img.width = 32;
    img.height = 32;
    img.classList.add("avatar");
    avatarWrap.appendChild(img);
  }
  item.appendChild(avatarWrap);

  // Content column
  const content = el("div", "timeline-item-content");

  // Header
  const header = el("div", "comment-header");
  const author = el("strong", null, comment.user ? comment.user.login : "unknown");
  header.appendChild(author);
  const ts = el("span", "timestamp", " " + formatTimestamp(comment.created_at));
  header.appendChild(ts);
  markNewIfUnseen(header, commentId, seenCtx);
  content.appendChild(header);

  // Body
  const body = el("div", "comment-body");
  const inner = el("div", "comment-body-inner");
  inner.innerHTML = renderMarkdown(comment.body, { repoCtx: prInfo });
  body.appendChild(inner);
  content.appendChild(body);

  makeCollapsible(header, {
    id: commentId,
    collapsedSet: collapseCtx?.collapsedComments,
    save: collapseCtx?.save,
    initiallyCollapsed: collapseCtx?.collapsedComments?.has(commentId),
  });

  item.appendChild(content);
  return item;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

const REVIEW_STATE_LABELS = {
  APPROVED: { text: "Approved", cls: "review-approved" },
  CHANGES_REQUESTED: { text: "Changes requested", cls: "review-changes-requested" },
  COMMENTED: { text: "Commented", cls: "review-commented" },
  DISMISSED: { text: "Dismissed", cls: "review-dismissed" },
};

export function renderReview(review, threads, prInfo, collapseCtx, seenCtx) {
  const item = el("div", ["timeline-item", "review-item"]);
  const commentId = `rv-${review.id}`;
  item.dataset.commentId = commentId;

  // Avatar
  const avatarWrap = el("div", "timeline-item-avatar");
  if (review.user && review.user.avatar_url) {
    const img = document.createElement("img");
    img.src = review.user.avatar_url;
    img.alt = review.user.login;
    img.width = 32;
    img.height = 32;
    img.classList.add("avatar");
    avatarWrap.appendChild(img);
  }
  item.appendChild(avatarWrap);

  const content = el("div", "timeline-item-content");

  // Review header
  const header = el("div", "comment-header");
  const author = el("strong", null, review.user ? review.user.login : "unknown");
  header.appendChild(author);

  const stateInfo = REVIEW_STATE_LABELS[review.state] || {
    text: review.state,
    cls: "review-other",
  };
  const stateBadge = el("span", ["review-state-badge", stateInfo.cls], stateInfo.text);
  header.appendChild(document.createTextNode(" "));
  header.appendChild(stateBadge);

  const ts = el("span", "timestamp", " " + formatTimestamp(review.submitted_at || review.created_at));
  header.appendChild(ts);
  markNewIfUnseen(header, commentId, seenCtx);
  content.appendChild(header);

  // Review body
  if (review.body && review.body.trim()) {
    const body = el("div", "comment-body");
    const inner = el("div", "comment-body-inner");
    inner.innerHTML = renderMarkdown(review.body, { repoCtx: prInfo });
    body.appendChild(inner);
    content.appendChild(body);
  }

  // Threads belonging to this review
  if (threads && threads.length) {
    const threadsContainer = el("div", "review-threads");
    for (const thread of threads) {
      threadsContainer.appendChild(renderReviewThread(thread, prInfo, seenCtx));
    }
    content.appendChild(threadsContainer);
  }

  makeCollapsible(header, {
    id: commentId,
    collapsedSet: collapseCtx?.collapsedComments,
    save: collapseCtx?.save,
    initiallyCollapsed: collapseCtx?.collapsedComments?.has(commentId),
  });

  item.appendChild(content);
  return item;
}

// ---------------------------------------------------------------------------
// Jump from a review thread header to its inline location in Files Changed
// ---------------------------------------------------------------------------

function jumpToDiffComment(path, rootId) {
  showTab("files-changed");

  // Expand the file section if it's currently collapsed.
  const fileSection = document.querySelector(
    `.diff-file[data-filename="${CSS.escape(path)}"]`
  );
  if (fileSection) {
    const body = fileSection.querySelector(".diff-file-body");
    if (body && body.hidden) body.hidden = false;
  }

  // Find the comment row, scroll to it, and flash it.
  // If the specific thread row isn't in the current diff (outdated comment),
  // fall back to scrolling/flashing the file section itself.
  requestAnimationFrame(() => {
    const target =
      document.getElementById(`thread-${rootId}`) || fileSection;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("jump-flash");
    setTimeout(() => target.classList.remove("jump-flash"), 2000);
  });
}

// ---------------------------------------------------------------------------
// Review thread (inline comment thread)
// ---------------------------------------------------------------------------

export function renderReviewThread(thread, prInfo, seenCtx) {
  const container = el("div", "review-thread-container");

  // If the root has a file path + id, the path badge and diff hunk
  // open a preview modal with the file's full diff. The actual click
  // handling is delegated globally in app.js — we just mark elements
  // as clickable and stash the keys it needs.
  const canPreview =
    thread.root && thread.root.path && thread.root.id != null;
  if (canPreview) {
    container.dataset.filename = thread.root.path;
    container.dataset.rootCommentId = String(thread.root.id);
  }

  // ── Header row: collapse toggle, file path, optional "Resolved" pill
  const summary = el("div", "thread-summary");

  // Collapse chevron — clicking expands/collapses the body. Initial
  // state mirrors `thread.isResolved` (resolved threads start collapsed).
  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "thread-collapse-toggle";
  collapseBtn.setAttribute("aria-label", "Toggle thread");
  collapseBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.749.749 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.749.749 0 0 1 1.06 0Z"></path></svg>`;
  summary.appendChild(collapseBtn);

  // File path badge (+ line number) — sits in the summary row.
  // Clicking it toggles collapse along with the rest of the summary;
  // the file diff preview is still reachable by clicking the diff
  // hunk inside the body.
  if (thread.root && thread.root.path) {
    const pathBadge = el("span", "file-path-badge");
    const pathText = thread.root.path;
    const lineNo = thread.root.line ?? thread.root.original_line;
    pathBadge.textContent = lineNo ? `${pathText}:${lineNo}` : pathText;
    pathBadge.title = "Click to expand/collapse this thread";
    summary.appendChild(pathBadge);
  }

  // "Resolved" / "Outdated" status pills
  if (thread.isResolved) {
    summary.appendChild(el("span", "thread-status-pill thread-status-resolved", "Resolved"));
  }
  if (thread.isOutdated) {
    summary.appendChild(el("span", "thread-status-pill thread-status-outdated", "Outdated"));
  }
  // Reply count summary — shown when collapsed so the user can see
  // how many comments live in the thread without expanding it.
  const totalReplies = (thread.replies?.length || 0) + 1;
  if (totalReplies > 1) {
    summary.appendChild(
      el(
        "span",
        "thread-reply-count",
        `${totalReplies} comments`
      )
    );
  }
  container.appendChild(summary);

  // ── Body: hunk + comments + reply form + resolve button ────────
  const body = el("div", "thread-body");

  // Diff hunk — rendered as a table with old/new line numbers
  if (thread.root && thread.root.diff_hunk) {
    const hunkTable = renderDiffHunkTable(thread.root.diff_hunk);
    if (canPreview) {
      hunkTable.classList.add("clickable");
      hunkTable.title = "Preview this file's diff";
    }
    body.appendChild(hunkTable);
  }

  // Root comment
  if (thread.root) {
    body.appendChild(buildCommentBlock(thread.root, seenCtx, prInfo));
  }

  // Replies
  if (thread.replies && thread.replies.length) {
    for (const reply of thread.replies) {
      const replyEl = buildCommentBlock(reply, seenCtx, prInfo);
      replyEl.classList.add("thread-reply");
      body.appendChild(replyEl);
    }
  }

  // Reply form
  const replyForm = el("div", "thread-reply-form");
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Reply\u2026";
  textarea.rows = 2;
  replyForm.appendChild(textarea);

  const replyBtn = el("button", "btn-reply", "Reply");
  replyBtn.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return;
    replyBtn.disabled = true;
    replyBtn.textContent = "Sending\u2026";
    try {
      const newComment = await replyToReviewComment(
        prInfo.owner,
        prInfo.repo,
        prInfo.number,
        thread.root.id,
        text
      );
      // Append new reply into the thread
      const newEl = buildCommentBlock(newComment, seenCtx, prInfo);
      newEl.classList.add("thread-reply");
      body.insertBefore(newEl, replyForm);
      textarea.value = "";
    } catch (err) {
      console.error("Reply failed:", err);
      alert("Failed to post reply: " + err.message);
    } finally {
      replyBtn.disabled = false;
      replyBtn.textContent = "Reply";
    }
  });
  replyForm.appendChild(replyBtn);
  body.appendChild(replyForm);

  // Resolve / Unresolve button — needs the GraphQL THREAD node id
  // (a `PullRequestReviewThread` ID, not a comment node id). The
  // classifier attaches this from the GraphQL `reviewThreads` payload.
  let resolved = !!thread.isResolved;
  let resolvedPill = summary.querySelector(".thread-status-resolved");

  if (thread.threadNodeId) {
    const resolveBtn = el(
      "button",
      "btn-resolve",
      resolved ? "Unresolve" : "Resolve"
    );

    resolveBtn.addEventListener("click", async () => {
      resolveBtn.disabled = true;
      try {
        if (resolved) {
          await unresolveThread(prInfo.owner, prInfo.repo, prInfo.number, thread.threadNodeId);
          resolved = false;
          thread.isResolved = false;
          resolveBtn.textContent = "Resolve";
          container.classList.remove("thread-resolved");
          if (resolvedPill) {
            resolvedPill.remove();
            resolvedPill = null;
          }
          // Auto-expand on unresolve so the comments are visible
          setCollapsed(false);
        } else {
          await resolveThread(prInfo.owner, prInfo.repo, prInfo.number, thread.threadNodeId);
          resolved = true;
          thread.isResolved = true;
          resolveBtn.textContent = "Unresolve";
          container.classList.add("thread-resolved");
          if (!resolvedPill) {
            resolvedPill = el("span", "thread-status-pill thread-status-resolved", "Resolved");
            // Insert after the file path badge / before any reply count
            const replyCount = summary.querySelector(".thread-reply-count");
            summary.insertBefore(resolvedPill, replyCount || null);
          }
          // Auto-collapse on resolve to match the default
          setCollapsed(true);
        }
      } catch (err) {
        console.error("Resolve/unresolve failed:", err);
        alert("Action failed: " + err.message);
      } finally {
        resolveBtn.disabled = false;
      }
    });
    body.appendChild(resolveBtn);
  }

  container.appendChild(body);

  // ── Collapse mechanics ─────────────────────────────────────────
  const setCollapsed = (collapsed) => {
    body.hidden = collapsed;
    container.classList.toggle("is-collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  };
  // Resolved → start collapsed
  setCollapsed(resolved);
  if (resolved) container.classList.add("thread-resolved");

  collapseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setCollapsed(!body.hidden ? true : false);
  });
  // Clicking anywhere on the summary toggles collapse. The chevron
  // has its own handler (with stopPropagation) so we don't double-fire.
  summary.addEventListener("click", (e) => {
    if (e.target.closest(".thread-collapse-toggle")) return; // already handled
    setCollapsed(!body.hidden ? true : false);
  });

  return container;
}

// ---------------------------------------------------------------------------
// Standalone thread (thread shown outside its parent review)
// ---------------------------------------------------------------------------

export function renderStandaloneThread(thread, reviewMeta, prInfo, collapseCtx, seenCtx) {
  const wrapper = el("div", "standalone-thread");
  const commentId = `st-${thread.root?.id}`;
  wrapper.dataset.commentId = commentId;

  // Small header identifying which review it belongs to.
  // This header is always present — we use it as the collapse handle.
  const metaHeader = el("div", "standalone-thread-meta");
  if (reviewMeta) {
    const reviewAuthor = el("strong", null, reviewMeta.user ? reviewMeta.user.login : "unknown");
    metaHeader.appendChild(document.createTextNode("From review by "));
    metaHeader.appendChild(reviewAuthor);
    if (reviewMeta.state) {
      const stateInfo = REVIEW_STATE_LABELS[reviewMeta.state] || {
        text: reviewMeta.state,
        cls: "review-other",
      };
      const badge = el("span", ["review-state-badge", stateInfo.cls], stateInfo.text);
      metaHeader.appendChild(document.createTextNode(" "));
      metaHeader.appendChild(badge);
    }
  } else {
    // Fall back to the path + line if no review meta
    const pathLabel = el(
      "span",
      null,
      thread.root?.path
        ? `${thread.root.path}${thread.root.line ? ":" + thread.root.line : ""}`
        : "Review thread"
    );
    metaHeader.appendChild(pathLabel);
  }
  markNewIfUnseen(metaHeader, commentId, seenCtx);
  wrapper.appendChild(metaHeader);

  wrapper.appendChild(renderReviewThread(thread, prInfo, seenCtx));

  makeCollapsible(metaHeader, {
    id: commentId,
    collapsedSet: collapseCtx?.collapsedComments,
    save: collapseCtx?.save,
    initiallyCollapsed: collapseCtx?.collapsedComments?.has(commentId),
  });

  return wrapper;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function renderTimeline(containerId, entries, prInfo) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  // Per-PR persisted state: collapsed items + seen items.
  // Both contexts are shared across the Conversation + AI Comments tabs.
  const collapseCtx = prInfo ? getCollapseContext(prInfo) : null;
  const seenCtx = prInfo ? getSeenContext(prInfo) : null;

  // Load global sort preference + per-PR filter preference
  const sortPref = loadSortPref();
  const filterPref = loadFilterPref(prInfo);

  // Validate filterPref.authors against the actual authors in this PR.
  // (Stale logins from a previous load shouldn't keep filtering.)
  const allAuthors = collectEntryAuthors(entries);
  filterPref.authors = filterPref.authors.filter((a) => allAuthors.has(a));

  // Bulk-action header above the timeline
  const actionBar = el("div", "timeline-action-bar");
  const countLabel = el("span", "timeline-action-count");
  actionBar.appendChild(countLabel);

  // ── Filter controls ─────────────────────────────────────────────
  const filterGroup = el("div", "timeline-filters");

  // Authors multi-select popover
  const authorsBtn = document.createElement("button");
  authorsBtn.type = "button";
  authorsBtn.className = "timeline-filter-btn";
  const authorsBadge = document.createElement("span");
  authorsBadge.className = "filter-badge";
  const updateAuthorsBtn = () => {
    authorsBtn.firstChild?.remove();
    authorsBtn.prepend(document.createTextNode("Authors "));
    if (filterPref.authors.length) {
      authorsBadge.textContent = filterPref.authors.length;
      authorsBadge.hidden = false;
      authorsBtn.classList.add("active");
    } else {
      authorsBadge.hidden = true;
      authorsBtn.classList.remove("active");
    }
  };
  authorsBtn.appendChild(authorsBadge);
  filterGroup.appendChild(authorsBtn);

  const authorsPopover = el("div", "filter-popover");
  authorsPopover.hidden = true;
  for (const author of [...allAuthors].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  )) {
    const row = document.createElement("label");
    row.className = "filter-popover-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = author;
    cb.checked = filterPref.authors.includes(author);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!filterPref.authors.includes(author)) filterPref.authors.push(author);
      } else {
        filterPref.authors = filterPref.authors.filter((a) => a !== author);
      }
      saveFilterPref(prInfo, filterPref);
      updateAuthorsBtn();
      renderEntries();
    });
    const labelText = document.createElement("span");
    labelText.textContent = author;
    row.appendChild(cb);
    row.appendChild(labelText);
    authorsPopover.appendChild(row);
  }
  if (allAuthors.size === 0) {
    const empty = document.createElement("div");
    empty.className = "filter-popover-empty";
    empty.textContent = "No authors";
    authorsPopover.appendChild(empty);
  }
  filterGroup.appendChild(authorsPopover);

  // Toggle the popover; close on outside click / Escape
  authorsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    authorsPopover.hidden = !authorsPopover.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!authorsPopover.hidden && !filterGroup.contains(e.target)) {
      authorsPopover.hidden = true;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") authorsPopover.hidden = true;
  });

  // Reply filter
  const replySelect = document.createElement("select");
  replySelect.className = "timeline-filter-replies";
  for (const opt of [
    { value: "any", label: "All comments" },
    { value: "with", label: "With replies" },
    { value: "without", label: "Without replies" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === filterPref.replies) o.selected = true;
    replySelect.appendChild(o);
  }
  replySelect.addEventListener("change", () => {
    filterPref.replies = replySelect.value;
    saveFilterPref(prInfo, filterPref);
    renderEntries();
  });
  filterGroup.appendChild(replySelect);

  // Clear-filters button (only shown when something is filtered)
  const clearFiltersBtn = document.createElement("button");
  clearFiltersBtn.type = "button";
  clearFiltersBtn.className = "timeline-filter-clear";
  clearFiltersBtn.title = "Clear all filters";
  clearFiltersBtn.textContent = "Clear";
  const updateClearBtn = () => {
    clearFiltersBtn.hidden =
      filterPref.authors.length === 0 && filterPref.replies === "any";
  };
  clearFiltersBtn.addEventListener("click", () => {
    filterPref.authors = [];
    filterPref.replies = "any";
    for (const cb of authorsPopover.querySelectorAll("input[type='checkbox']")) {
      cb.checked = false;
    }
    replySelect.value = "any";
    saveFilterPref(prInfo, filterPref);
    updateAuthorsBtn();
    updateClearBtn();
    renderEntries();
  });
  filterGroup.appendChild(clearFiltersBtn);

  actionBar.appendChild(filterGroup);
  updateAuthorsBtn();
  updateClearBtn();

  // Sort controls (field selector + direction toggle)
  const sortGroup = el("div", "timeline-sort");
  const sortLabel = el("span", "timeline-sort-label", "Sort:");
  sortGroup.appendChild(sortLabel);
  const sortSelect = document.createElement("select");
  sortSelect.className = "timeline-sort-select";
  for (const opt of [
    { value: "time", label: "Time created" },
    { value: "updated", label: "Last updated" },
    { value: "author", label: "Author" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === sortPref.field) o.selected = true;
    sortSelect.appendChild(o);
  }
  sortGroup.appendChild(sortSelect);

  const dirBtn = document.createElement("button");
  dirBtn.type = "button";
  dirBtn.className = "timeline-sort-dir";
  const updateDirBtn = () => {
    if (sortPref.direction === "asc") {
      dirBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.47 7.78a.75.75 0 0 1 0-1.06l4-4a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1-1.06 1.06L8.75 4.81V12.75a.75.75 0 0 1-1.5 0V4.81L4.53 7.78a.75.75 0 0 1-1.06 0Z"/></svg>`;
      dirBtn.title = "Ascending — click to switch to descending";
    } else {
      dirBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12.53 8.22a.75.75 0 0 1 0 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06l2.72 2.97V3.25a.75.75 0 0 1 1.5 0v7.94l2.72-2.97a.75.75 0 0 1 1.06 0Z"/></svg>`;
      dirBtn.title = "Descending — click to switch to ascending";
    }
  };
  updateDirBtn();
  sortGroup.appendChild(dirBtn);
  actionBar.appendChild(sortGroup);

  const actions = el("div", "file-tree-actions");
  const expandAllBtn = el("button", "tree-action-btn", "Expand all");
  expandAllBtn.type = "button";
  expandAllBtn.title = "Expand all comments";
  const collapseOldBtn = el("button", "tree-action-btn", "Collapse old");
  collapseOldBtn.type = "button";
  collapseOldBtn.title = "Collapse everything except items marked New";
  const collapseAllBtn = el("button", "tree-action-btn", "Collapse all");
  collapseAllBtn.type = "button";
  collapseAllBtn.title = "Collapse all comments";
  actions.appendChild(expandAllBtn);
  actions.appendChild(collapseOldBtn);
  actions.appendChild(collapseAllBtn);
  actionBar.appendChild(actions);
  container.appendChild(actionBar);

  // Sub-container for the items, so re-sort can replace it without
  // touching the action bar or the new-comment form.
  const itemsContainer = el("div", "timeline-items");
  container.appendChild(itemsContainer);

  /** Render entries into itemsContainer based on current filters + sort. */
  const renderEntries = () => {
    itemsContainer.innerHTML = "";
    const filtered = filterEntries(entries, filterPref);
    const sorted = sortEntries(filtered, sortPref);
    countLabel.textContent =
      filtered.length === entries.length
        ? `${entries.length} item${entries.length !== 1 ? "s" : ""}`
        : `${filtered.length} of ${entries.length} item${entries.length !== 1 ? "s" : ""}`;
    updateClearBtn();
    for (const entry of sorted) {
      let commentId = null;
      switch (entry.type) {
        case "issue_comment":
          itemsContainer.appendChild(renderIssueComment(entry.data, collapseCtx, seenCtx, prInfo));
          commentId = `ic-${entry.data.id}`;
          break;
        case "review":
          itemsContainer.appendChild(
            renderReview(entry.data, entry.threads || [], prInfo, collapseCtx, seenCtx)
          );
          commentId = `rv-${entry.data.id}`;
          break;
        case "review_thread":
          itemsContainer.appendChild(
            renderStandaloneThread(entry.data, entry.reviewMeta, prInfo, collapseCtx, seenCtx)
          );
          commentId = `st-${entry.data.root?.id}`;
          break;
        default:
          break;
      }
      if (commentId) seenCtx?.markSeen(commentId);
    }

    // Bubble "New" badges up: if any nested reply is new, the parent
    // timeline item's own header also gets a badge so the activity is
    // visible at the top level.
    for (const parent of itemsContainer.querySelectorAll(
      ":scope > .timeline-item, :scope > .standalone-thread"
    )) {
      const ownHeader = parent.querySelector(
        ":scope > .timeline-item-content > .comment-header, :scope > .standalone-thread-meta"
      );
      if (!ownHeader || ownHeader.querySelector(":scope > .new-comment-badge")) {
        continue;
      }
      if (parent.querySelector(".new-comment-badge")) {
        const badge = el("span", "new-comment-badge", "New");
        ownHeader.appendChild(badge);
      }
    }
  };

  renderEntries();

  // Wire sort controls to re-render when the user changes them
  sortSelect.addEventListener("change", () => {
    sortPref.field = sortSelect.value;
    saveSortPref(sortPref);
    renderEntries();
  });
  dirBtn.addEventListener("click", () => {
    sortPref.direction = sortPref.direction === "asc" ? "desc" : "asc";
    saveSortPref(sortPref);
    updateDirBtn();
    renderEntries();
  });

  // Persist the updated seen set (drops "New" badges on the next load)
  seenCtx?.save();

  // Bulk collapse / expand handlers — operate on this timeline's items
  expandAllBtn.addEventListener("click", () => {
    for (const header of itemsContainer.querySelectorAll(".collapsible-header.collapsed")) {
      header._setCollapsed?.(false);
      const idEl = header.closest("[data-comment-id]");
      if (idEl) collapseCtx?.collapsedComments.delete(idEl.dataset.commentId);
    }
    collapseCtx?.save();
  });
  collapseAllBtn.addEventListener("click", () => {
    for (const header of itemsContainer.querySelectorAll(
      ".collapsible-header:not(.collapsed)"
    )) {
      header._setCollapsed?.(true);
      const idEl = header.closest("[data-comment-id]");
      if (idEl) collapseCtx?.collapsedComments.add(idEl.dataset.commentId);
    }
    collapseCtx?.save();
  });
  // Collapse everything EXCEPT items that carry the "New" badge
  collapseOldBtn.addEventListener("click", () => {
    for (const header of itemsContainer.querySelectorAll(
      ".collapsible-header:not(.collapsed)"
    )) {
      const idEl = header.closest("[data-comment-id]");
      if (!idEl) continue;
      if (idEl.querySelector(".new-comment-badge")) continue; // skip new items
      header._setCollapsed?.(true);
      collapseCtx?.collapsedComments.add(idEl.dataset.commentId);
    }
    collapseCtx?.save();
  });

  // New comment form at the bottom of the conversation panel
  const formWrap = el("div", "new-comment-form");
  const formHeading = el("h4", null, "New comment");
  formWrap.appendChild(formHeading);

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Leave a comment\u2026";
  textarea.rows = 4;
  formWrap.appendChild(textarea);

  const submitBtn = el("button", "btn-comment", "Comment");
  submitBtn.addEventListener("click", async () => {
    const body = textarea.value.trim();
    if (!body) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Posting\u2026";
    try {
      const newComment = await addComment(
        prInfo.owner,
        prInfo.repo,
        prInfo.number,
        body
      );
      // Append the new comment to the items list
      itemsContainer.appendChild(renderIssueComment(newComment, collapseCtx, seenCtx, prInfo));
      textarea.value = "";
    } catch (err) {
      console.error("Comment failed:", err);
      alert("Failed to post comment: " + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Comment";
    }
  });
  formWrap.appendChild(submitBtn);
  container.appendChild(formWrap);
}

// ---------------------------------------------------------------------------
// Internal helper: build a single comment block (used in threads)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mini diff hunk table (used inside review threads, Conversation + AI tabs)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sort preference (global, applies to Conversation + AI Comments)
// ---------------------------------------------------------------------------

const SORT_KEY = "pr-reviewer-sort";

function loadSortPref() {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const field = ["time", "updated", "author"].includes(parsed.field)
        ? parsed.field
        : "time";
      const direction = ["asc", "desc"].includes(parsed.direction) ? parsed.direction : "asc";
      return { field, direction };
    }
  } catch {
    /* fall through */
  }
  return { field: "time", direction: "asc" };
}

function saveSortPref(pref) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(pref));
  } catch {
    /* ignore */
  }
}

/** Pull a sortable author name out of a timeline entry. */
function entryAuthor(entry) {
  if (!entry) return "";
  if (entry.type === "issue_comment" || entry.type === "review") {
    return (entry.data?.user?.login || "").toLowerCase();
  }
  if (entry.type === "review_thread") {
    return (entry.data?.root?.user?.login || entry.reviewMeta?.user?.login || "").toLowerCase();
  }
  return "";
}

/**
 * Most-recent activity timestamp for an entry, including any nested replies.
 * Used by the "Last updated" sort so a reply to an old thread bumps the
 * whole entry to the top.
 */
function entryLastUpdatedMs(entry) {
  const t = (s) => (s ? new Date(s).getTime() : 0);
  let latest = t(entry?.timestamp);
  if (!entry) return latest;
  if (entry.type === "issue_comment") {
    const c = entry.data || {};
    latest = Math.max(latest, t(c.updated_at), t(c.created_at));
    return latest;
  }
  if (entry.type === "review") {
    const r = entry.data || {};
    latest = Math.max(latest, t(r.submitted_at), t(r.updated_at), t(r.created_at));
    for (const thread of entry.threads || []) {
      const root = thread.root;
      if (root) latest = Math.max(latest, t(root.updated_at), t(root.created_at));
      for (const reply of thread.replies || []) {
        latest = Math.max(latest, t(reply.updated_at), t(reply.created_at));
      }
    }
    return latest;
  }
  if (entry.type === "review_thread") {
    const root = entry.data?.root;
    if (root) latest = Math.max(latest, t(root.updated_at), t(root.created_at));
    for (const reply of entry.data?.replies || []) {
      latest = Math.max(latest, t(reply.updated_at), t(reply.created_at));
    }
    return latest;
  }
  return latest;
}

/** Return a new array sorted by the given pref without mutating input. */
function sortEntries(entries, pref) {
  const dir = pref.direction === "desc" ? -1 : 1;
  const copy = [...entries];
  if (pref.field === "author") {
    copy.sort((a, b) => {
      const aa = entryAuthor(a);
      const bb = entryAuthor(b);
      if (aa === bb) {
        // Tie-break by time (always ascending) so same-author items
        // stay chronologically grouped
        return new Date(a.timestamp) - new Date(b.timestamp);
      }
      return aa < bb ? -1 * dir : 1 * dir;
    });
  } else if (pref.field === "updated") {
    copy.sort((a, b) => (entryLastUpdatedMs(a) - entryLastUpdatedMs(b)) * dir);
  } else {
    // field === "time" (created)
    copy.sort((a, b) => (new Date(a.timestamp) - new Date(b.timestamp)) * dir);
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Filter preference (per-PR: author multi-select + replies dropdown)
// ---------------------------------------------------------------------------

function filterStorageKey(prInfo) {
  return prInfo
    ? `pr-reviewer-filters:${prInfo.owner}/${prInfo.repo}/${prInfo.number}`
    : null;
}

function loadFilterPref(prInfo) {
  const empty = { authors: [], replies: "any" };
  const key = filterStorageKey(prInfo);
  if (!key) return empty;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      authors: Array.isArray(parsed.authors) ? parsed.authors : [],
      replies: ["any", "with", "without"].includes(parsed.replies)
        ? parsed.replies
        : "any",
    };
  } catch {
    return empty;
  }
}

function saveFilterPref(prInfo, pref) {
  const key = filterStorageKey(prInfo);
  if (!key) return;
  try {
    // Don't save the empty default — keeps localStorage clean
    if (pref.authors.length === 0 && pref.replies === "any") {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(pref));
  } catch {
    /* ignore */
  }
}

/** Unique author logins across every entry (top-level authors only). */
function collectEntryAuthors(entries) {
  const set = new Set();
  for (const entry of entries) {
    const a = entryAuthor(entry);
    if (a) set.add(a);
  }
  return set;
}

/** True when an entry has at least one nested reply. */
function entryHasReplies(entry) {
  if (!entry) return false;
  if (entry.type === "review") {
    for (const t of entry.threads || []) {
      if (t?.replies && t.replies.length > 0) return true;
    }
    return false;
  }
  if (entry.type === "review_thread") {
    return !!(entry.data?.replies && entry.data.replies.length > 0);
  }
  // issue_comment has no nested replies in our model
  return false;
}

function filterEntries(entries, pref) {
  if (!pref) return entries;
  const authorSet = new Set(pref.authors);
  return entries.filter((entry) => {
    if (authorSet.size > 0) {
      // Compare against the author getter (which lowercases). The list
      // comes straight from collectEntryAuthors, so no case mismatch.
      if (!authorSet.has(entryAuthor(entry))) return false;
    }
    if (pref.replies === "with" && !entryHasReplies(entry)) return false;
    if (pref.replies === "without" && entryHasReplies(entry)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Per-PR collapsed-comment persistence
// ---------------------------------------------------------------------------
//
// Comments/reviews/standalone threads each get a stable id in the form
// `ic-<id>` / `rv-<id>` / `st-<rootId>`. The ids of currently-collapsed
// items are stored in localStorage so the state survives reloads and tab
// switches.

function collapseStorageKey(prInfo) {
  return prInfo
    ? `pr-reviewer-collapsed-comments:${prInfo.owner}/${prInfo.repo}/${prInfo.number}`
    : null;
}

/** Returns a { collapsedComments: Set<string>, save(): void } context. */
function getCollapseContext(prInfo) {
  const key = collapseStorageKey(prInfo);
  let initial = [];
  if (key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) initial = parsed;
      }
    } catch {
      /* ignore */
    }
  }
  const collapsedComments = new Set(initial);
  const save = () => {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify([...collapsedComments]));
    } catch {
      /* ignore */
    }
  };
  return { collapsedComments, save };
}

// ---------------------------------------------------------------------------
// Per-PR "seen comments" persistence
// ---------------------------------------------------------------------------
//
// Tracks which comments the user has already seen so we can show a "New"
// label next to any comment added since the last visit.
//
// Behavior:
// - First visit (no stored key): silently mark every comment as seen — no
//   "New" labels. The user hasn't had a chance to see anything yet.
// - Subsequent visits: any ID not in the stored set gets a "New" badge,
//   then the set is updated to include every visible ID.

function seenStorageKey(prInfo) {
  return prInfo
    ? `pr-reviewer-seen-comments:${prInfo.owner}/${prInfo.repo}/${prInfo.number}`
    : null;
}

// Per-PR cache. Conversation and AI Comments both render from renderTimeline
// sequentially — they must share one context so the first saves don't flip
// the second's "first visit" detection.
const _seenContextCache = new Map();

function getSeenContext(prInfo) {
  const key = seenStorageKey(prInfo);
  if (!key) return null;
  if (_seenContextCache.has(key)) return _seenContextCache.get(key);

  const hadKey = localStorage.getItem(key) !== null;
  let stored = [];
  if (hadKey) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (Array.isArray(parsed)) stored = parsed;
    } catch {
      /* ignore */
    }
  }
  const seenComments = new Set(stored);
  const ctx = {
    isFirstVisit: !hadKey,
    isNew: (id) => hadKey && !seenComments.has(id),
    markSeen: (id) => seenComments.add(id),
    save: () => {
      try {
        localStorage.setItem(key, JSON.stringify([...seenComments]));
      } catch {
        /* ignore */
      }
    },
  };
  _seenContextCache.set(key, ctx);
  return ctx;
}

/** Reset cached contexts — called on PR navigation. */
export function resetCommentStateCaches() {
  _seenContextCache.clear();
}

/**
 * Append a "New" badge to a header element when the given id is unseen.
 * Call this from each renderer right after adding the timestamp.
 */
function markNewIfUnseen(header, id, seenCtx) {
  if (seenCtx && seenCtx.isNew(id)) {
    const badge = el("span", "new-comment-badge", "New");
    header.appendChild(badge);
  }
}

function renderDiffHunkTable(diffHunkStr) {
  const hunks = parsePatch(diffHunkStr);
  const table = document.createElement("table");
  table.className = "diff-table diff-hunk-table";

  if (hunks.length === 0) {
    // Fallback: render as pre-formatted text if parsing fails
    const pre = document.createElement("pre");
    pre.className = "diff-hunk";
    pre.textContent = diffHunkStr;
    return pre;
  }

  for (const hunk of hunks) {
    // Hunk header row (the @@ line with function context)
    const headerRow = document.createElement("tr");
    headerRow.className = "diff-hunk-header";
    const headerCell = document.createElement("td");
    headerCell.colSpan = 3;
    headerCell.textContent = hunk.header;
    headerRow.appendChild(headerCell);
    table.appendChild(headerRow);

    for (const line of hunk.lines) {
      const tr = document.createElement("tr");
      tr.className = `diff-line ${line.type}`;

      const oldTd = document.createElement("td");
      oldTd.className = "line-no old";
      oldTd.textContent = line.oldLineNo != null ? line.oldLineNo : "";
      tr.appendChild(oldTd);

      const newTd = document.createElement("td");
      newTd.className = "line-no new";
      newTd.textContent = line.newLineNo != null ? line.newLineNo : "";
      tr.appendChild(newTd);

      const contentTd = document.createElement("td");
      contentTd.className = "diff-content";
      const marker = document.createElement("span");
      marker.className = "diff-marker";
      marker.textContent =
        line.type === "addition" ? "+" : line.type === "deletion" ? "-" : " ";
      contentTd.appendChild(marker);
      contentTd.appendChild(document.createTextNode(line.content));
      tr.appendChild(contentTd);

      table.appendChild(tr);
    }
  }

  return table;
}

function buildCommentBlock(comment, seenCtx, prInfo = null) {
  const block = el("div", "thread-comment");
  // Stable id so seen-tracking and the Collapse old button can find replies
  const commentId = `rc-${comment.id}`;
  block.dataset.commentId = commentId;

  const header = el("div", "comment-header");
  if (comment.user && comment.user.avatar_url) {
    const img = document.createElement("img");
    img.src = comment.user.avatar_url;
    img.alt = comment.user.login;
    img.width = 20;
    img.height = 20;
    img.classList.add("avatar-small");
    header.appendChild(img);
  }
  const author = el("strong", null, comment.user ? comment.user.login : "unknown");
  header.appendChild(author);

  const ts = el("span", "timestamp", " " + formatTimestamp(comment.created_at || comment.updated_at));
  header.appendChild(ts);
  markNewIfUnseen(header, commentId, seenCtx);
  block.appendChild(header);

  const body = el("div", "comment-body");
  const inner = el("div", "comment-body-inner");
  inner.innerHTML = renderMarkdown(comment.body, { repoCtx: prInfo });
  body.appendChild(inner);
  block.appendChild(body);

  // Mark this individual comment as seen for next visit
  seenCtx?.markSeen(commentId);

  return block;
}

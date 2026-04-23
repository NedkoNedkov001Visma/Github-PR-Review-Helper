import {
  addComment,
  replyToReviewComment,
  resolveThread,
  unresolveThread,
} from "./api.js";

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

export function renderMarkdown(text) {
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
    (Array.isArray(classNames) ? classNames : [classNames]).forEach((c) =>
      node.classList.add(c)
    );
  }
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

// ---------------------------------------------------------------------------
// PR Header
// ---------------------------------------------------------------------------

export function renderPRHeader(pr, containerId = "pr-header") {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  // Title + number
  const heading = el("h2", "pr-title");
  heading.textContent = `${pr.title} #${pr.number}`;
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
}

// ---------------------------------------------------------------------------
// Issue comment
// ---------------------------------------------------------------------------

/**
 * Make a header toggle visibility of all sibling elements that follow it
 * within the same parent. Adds a chevron indicator.
 */
function makeCollapsible(header) {
  header.classList.add("collapsible-header");
  const chevron = el("span", "collapse-chevron", "\u25BC");
  header.insertBefore(chevron, header.firstChild);

  header.addEventListener("click", () => {
    const collapsed = header.classList.toggle("collapsed");
    // Hide every sibling after the header in the same parent
    let sibling = header.nextElementSibling;
    while (sibling) {
      sibling.hidden = collapsed;
      sibling = sibling.nextElementSibling;
    }
  });
}

export function renderIssueComment(comment) {
  const item = el("div", "timeline-item");

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
  content.appendChild(header);

  // Body
  const body = el("div", "comment-body");
  const inner = el("div", "comment-body-inner");
  inner.innerHTML = renderMarkdown(comment.body);
  body.appendChild(inner);
  content.appendChild(body);

  makeCollapsible(header);

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

export function renderReview(review, threads, prInfo) {
  const item = el("div", ["timeline-item", "review-item"]);

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
  content.appendChild(header);

  // Review body
  if (review.body && review.body.trim()) {
    const body = el("div", "comment-body");
    const inner = el("div", "comment-body-inner");
    inner.innerHTML = renderMarkdown(review.body);
    body.appendChild(inner);
    content.appendChild(body);
  }

  // Threads belonging to this review
  if (threads && threads.length) {
    const threadsContainer = el("div", "review-threads");
    for (const thread of threads) {
      threadsContainer.appendChild(renderReviewThread(thread, prInfo));
    }
    content.appendChild(threadsContainer);
  }

  makeCollapsible(header);

  item.appendChild(content);
  return item;
}

// ---------------------------------------------------------------------------
// Review thread (inline comment thread)
// ---------------------------------------------------------------------------

export function renderReviewThread(thread, prInfo) {
  const container = el("div", "review-thread-container");

  // File path badge
  if (thread.root && thread.root.path) {
    const pathBadge = el("span", "file-path-badge", thread.root.path);
    container.appendChild(pathBadge);
  }

  // Diff hunk
  if (thread.root && thread.root.diff_hunk) {
    const pre = document.createElement("pre");
    pre.classList.add("diff-hunk");
    const code = document.createElement("code");

    // Colour diff lines
    const lines = thread.root.diff_hunk.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const span = document.createElement("span");
      span.textContent = line;
      if (line.startsWith("+")) {
        span.classList.add("diff-add");
      } else if (line.startsWith("-")) {
        span.classList.add("diff-remove");
      }
      code.appendChild(span);
      if (i < lines.length - 1) code.appendChild(document.createTextNode("\n"));
    }
    pre.appendChild(code);
    container.appendChild(pre);
  }

  // Root comment
  if (thread.root) {
    container.appendChild(buildCommentBlock(thread.root));
  }

  // Replies
  if (thread.replies && thread.replies.length) {
    for (const reply of thread.replies) {
      const replyEl = buildCommentBlock(reply);
      replyEl.classList.add("thread-reply");
      container.appendChild(replyEl);
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
    const body = textarea.value.trim();
    if (!body) return;
    replyBtn.disabled = true;
    replyBtn.textContent = "Sending\u2026";
    try {
      const newComment = await replyToReviewComment(
        prInfo.owner,
        prInfo.repo,
        prInfo.number,
        thread.root.id,
        body
      );
      // Append new reply into the thread
      const newEl = buildCommentBlock(newComment);
      newEl.classList.add("thread-reply");
      container.insertBefore(newEl, replyForm);
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
  container.appendChild(replyForm);

  // Resolve / Unresolve button
  if (thread.root && thread.root.pull_request_review_id && thread.root.node_id) {
    const resolveBtn = el(
      "button",
      "btn-resolve",
      thread.isResolved ? "Unresolve" : "Resolve"
    );
    let resolved = !!thread.isResolved;

    resolveBtn.addEventListener("click", async () => {
      resolveBtn.disabled = true;
      try {
        if (resolved) {
          await unresolveThread(prInfo.owner, prInfo.repo, prInfo.number, thread.root.node_id);
          resolved = false;
          resolveBtn.textContent = "Resolve";
        } else {
          await resolveThread(prInfo.owner, prInfo.repo, prInfo.number, thread.root.node_id);
          resolved = true;
          resolveBtn.textContent = "Unresolve";
        }
      } catch (err) {
        console.error("Resolve/unresolve failed:", err);
        alert("Action failed: " + err.message);
      } finally {
        resolveBtn.disabled = false;
      }
    });
    container.appendChild(resolveBtn);
  }

  return container;
}

// ---------------------------------------------------------------------------
// Standalone thread (thread shown outside its parent review)
// ---------------------------------------------------------------------------

export function renderStandaloneThread(thread, reviewMeta, prInfo) {
  const wrapper = el("div", "standalone-thread");

  // Small header identifying which review it belongs to
  if (reviewMeta) {
    const metaHeader = el("div", "standalone-thread-meta");
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
    wrapper.appendChild(metaHeader);
  }

  wrapper.appendChild(renderReviewThread(thread, prInfo));

  return wrapper;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function renderTimeline(containerId, entries, prInfo) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  for (const entry of entries) {
    switch (entry.type) {
      case "issue_comment":
        container.appendChild(renderIssueComment(entry.data));
        break;
      case "review":
        container.appendChild(renderReview(entry.data, entry.threads || [], prInfo));
        break;
      case "review_thread":
        container.appendChild(renderStandaloneThread(entry.data, entry.reviewMeta, prInfo));
        break;
      default:
        // Unknown entry type — skip
        break;
    }
  }

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
      // Insert the new comment right before the form
      container.insertBefore(renderIssueComment(newComment), formWrap);
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

function buildCommentBlock(comment) {
  const block = el("div", "thread-comment");

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
  block.appendChild(header);

  const body = el("div", "comment-body");
  const inner = el("div", "comment-body-inner");
  inner.innerHTML = renderMarkdown(comment.body);
  body.appendChild(inner);
  block.appendChild(body);

  return block;
}

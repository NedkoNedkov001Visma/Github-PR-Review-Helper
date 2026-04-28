import { formatTimestamp, renderMarkdown } from "./ui.js";
import { renderDiffPanel } from "./diff-renderer.js";

/**
 * Render the commit detail view: a header card with metadata + the file
 * diffs underneath. Reuses renderDiffPanel for file diffs (passing empty
 * threads since commits don't carry review threads in this app).
 *
 * @param {object} commit
 * @param {object} ctx     { owner, repo }
 * @param {object} [opts]  { headerId, filesId } — override default DOM ids.
 */
export function renderCommitDetail(commit, ctx, opts = {}) {
  const headerId = opts.headerId || "commit-header";
  const filesId = opts.filesId || "commit-files";
  renderCommitHeader(headerId, commit, ctx);
  // Reuse the full file-changes UI. We pass `{owner, repo, number: sha}`
  // as the "prInfo"-shaped argument so per-file state (collapse, viewed)
  // is keyed by commit, not by PR.
  renderDiffPanel(
    filesId,
    commit.files || [],
    [],
    null,
    { owner: ctx.owner, repo: ctx.repo, number: commit.sha }
  );
}

function renderCommitHeader(containerId, commit, ctx) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  // Breadcrumb: owner / repo (clickable back to PR list)
  const crumb = document.createElement("div");
  crumb.className = "pr-breadcrumb";
  const ownerLink = document.createElement("a");
  ownerLink.href = `https://github.com/${encodeURIComponent(ctx.owner)}`;
  ownerLink.target = "_blank";
  ownerLink.rel = "noopener";
  ownerLink.className = "breadcrumb-link";
  ownerLink.textContent = ctx.owner;
  crumb.appendChild(ownerLink);
  crumb.appendChild(document.createTextNode(" / "));
  const repoLink = document.createElement("a");
  repoLink.href = `#repo=${encodeURIComponent(`${ctx.owner}/${ctx.repo}`)}`;
  repoLink.className = "breadcrumb-link breadcrumb-repo";
  repoLink.textContent = ctx.repo;
  crumb.appendChild(repoLink);
  container.appendChild(crumb);

  // Subject + (optional) message body
  const message = commit.commit?.message || "";
  const newline = message.indexOf("\n");
  const subject = newline === -1 ? message : message.slice(0, newline);
  const body = newline === -1 ? "" : message.slice(newline + 1).trim();

  const heading = document.createElement("h2");
  heading.className = "pr-title commit-detail-title";
  heading.textContent = subject;
  container.appendChild(heading);

  if (body) {
    const bodyEl = document.createElement("pre");
    bodyEl.className = "commit-detail-body";
    bodyEl.textContent = body;
    container.appendChild(bodyEl);
  }

  // Meta row: author + relative time + SHA + parents + back-to-GitHub link
  const meta = document.createElement("div");
  meta.className = "commit-detail-meta";

  const ghUser = commit.author;
  if (ghUser?.avatar_url) {
    const img = document.createElement("img");
    img.src = ghUser.avatar_url;
    img.alt = ghUser.login;
    img.width = 24;
    img.height = 24;
    img.className = "avatar-small";
    meta.appendChild(img);
  }
  const authorName =
    ghUser?.login || commit.commit?.author?.name || "unknown";
  if (ghUser?.login) {
    const a = document.createElement("a");
    a.href = `https://github.com/${encodeURIComponent(ghUser.login)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = authorName;
    a.className = "commit-detail-author";
    meta.appendChild(a);
  } else {
    const span = document.createElement("strong");
    span.textContent = authorName;
    meta.appendChild(span);
  }

  meta.appendChild(document.createTextNode(" committed "));
  const ts = document.createElement("span");
  ts.className = "timestamp";
  const dateIso =
    commit.commit?.author?.date || commit.commit?.committer?.date;
  if (dateIso) {
    ts.textContent = formatTimestamp(dateIso);
    ts.title = new Date(dateIso).toLocaleString();
  }
  meta.appendChild(ts);

  // SHA chip
  const shaWrap = document.createElement("span");
  shaWrap.className = "commit-detail-sha-row";
  const shaLabel = document.createElement("span");
  shaLabel.className = "muted";
  shaLabel.textContent = "commit ";
  shaWrap.appendChild(shaLabel);
  const shaCode = document.createElement("code");
  shaCode.className = "commit-detail-sha";
  shaCode.textContent = commit.sha;
  shaWrap.appendChild(shaCode);
  meta.appendChild(shaWrap);

  // Parent commits (link to in-app commit view)
  if (Array.isArray(commit.parents) && commit.parents.length) {
    const parentsWrap = document.createElement("span");
    parentsWrap.className = "commit-detail-parents";
    parentsWrap.appendChild(document.createTextNode(` parent${commit.parents.length === 1 ? "" : "s"}: `));
    commit.parents.forEach((p, i) => {
      if (i > 0) parentsWrap.appendChild(document.createTextNode(", "));
      const a = document.createElement("a");
      a.href = `#${ctx.owner}/${ctx.repo}/commit/${p.sha}`;
      a.className = "commit-mention";
      const code = document.createElement("code");
      code.textContent = p.sha.slice(0, 7);
      a.appendChild(code);
      parentsWrap.appendChild(a);
    });
    meta.appendChild(parentsWrap);
  }

  // Open on GitHub
  if (commit.html_url) {
    const ext = document.createElement("a");
    ext.href = commit.html_url;
    ext.target = "_blank";
    ext.rel = "noopener";
    ext.className = "commit-detail-external";
    ext.title = "Open this commit on GitHub";
    ext.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path></svg>`;
    meta.appendChild(ext);
  }

  container.appendChild(meta);

  // Stats (additions / deletions / files)
  if (commit.stats) {
    const stats = document.createElement("div");
    stats.className = "commit-detail-stats";
    const addsCount = commit.stats.additions || 0;
    const delsCount = commit.stats.deletions || 0;
    const fileCount = (commit.files || []).length;
    stats.innerHTML = `
      <span class="stat-additions">+${addsCount}</span>
      <span class="stat-deletions">-${delsCount}</span>
      <span class="muted">across ${fileCount} file${fileCount === 1 ? "" : "s"}</span>
    `;
    container.appendChild(stats);
  }

  // Avoid "unused import" warnings — renderMarkdown is intentionally
  // available for future commit comments/notes support but unused here.
  void renderMarkdown;
}

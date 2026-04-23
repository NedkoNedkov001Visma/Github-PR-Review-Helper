import { fetchPR, fetchPulls, fetchRepoUsers, fetchActions } from "./lib/api.js";
import { renderActionsPanel } from "./lib/actions-renderer.js";
import { buildTimeline } from "./lib/timeline.js";
import { classifyTimeline, groupReviewCommentThreads } from "./lib/classifier.js";
import { renderDiffPanel } from "./lib/diff-renderer.js";
import {
  renderPRHeader,
  renderTimeline,
  showTab,
  formatTimestamp,
  resetCommentStateCaches,
} from "./lib/ui.js";

// --- State ---

let currentPR = null; // { owner, repo, number }

// --- URL parsing ---

function parsePRInput(input) {
  input = input.trim();
  // Full URL: https://github.com/owner/repo/pull/123
  const urlMatch = input.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3] };

  // Shorthand: owner/repo#123
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch)
    return { owner: shortMatch[1], repo: shortMatch[2], number: shortMatch[3] };

  // Path-style: owner/repo/pull/123
  const pathMatch = input.match(/^([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (pathMatch)
    return { owner: pathMatch[1], repo: pathMatch[2], number: pathMatch[3] };

  return null;
}

function parseRepoInput(input) {
  input = input.trim();
  const match = input.match(
    /(?:github\.com\/)?([^/]+)\/([^/\s#]+)/
  );
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

// --- Loading / Error UI ---

function setLoading(on) {
  document.getElementById("loading").hidden = !on;
}

function showError(msg) {
  const el = document.getElementById("error");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 8000);
}

function clearError() {
  document.getElementById("error").hidden = true;
}

// --- Index tab ---

const RECENT_KEY = "pr-reviewer-recent-repos";
let currentRepo = null; // { owner, repo }
let currentFilter = "open";

// User suggestions for the filter dropdowns
const knownUsers = new Map(); // login -> { login, avatar_url }
let lastUsersRepo = "";

function getRecentRepos() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRecentRepo(owner, repo) {
  const key = `${owner}/${repo}`;
  let recent = getRecentRepos().filter((r) => r !== key);
  recent.unshift(key);
  recent = recent.slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  renderRecentRepos();
}

function renderRecentRepos() {
  const container = document.getElementById("recent-repos");
  const recent = getRecentRepos();
  if (recent.length === 0) {
    container.innerHTML = "";
    return;
  }
  const chips = recent
    .map(
      (r) =>
        `<button class="chip" data-repo="${r}">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"></path></svg>
          ${r}
        </button>`
    )
    .join("");
  container.innerHTML = `<h3 class="section-title">Recent repositories</h3><div class="recent-chips">${chips}</div>`;

  container.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("repo-input").value = btn.dataset.repo;
      loadRepoPRs(btn.dataset.repo);
    });
  });
}

function getUserFilters() {
  return {
    author: document.getElementById("filter-author")?.value.trim() || "",
    reviewer: document.getElementById("filter-reviewer")?.value.trim() || "",
  };
}

async function loadRepoPRs(repoStr, state) {
  const parsed = parseRepoInput(repoStr);
  if (!parsed) {
    showError("Invalid repo format. Use owner/repo");
    return;
  }
  const { owner, repo } = parsed;
  // Reset user suggestions if switching repos
  if (!currentRepo || currentRepo.owner !== owner || currentRepo.repo !== repo) {
    knownUsers.clear();
    lastUsersRepo = "";
  }
  currentRepo = { owner, repo };
  if (state) currentFilter = state;
  clearError();
  setLoading(true);

  try {
    const { author, reviewer } = getUserFilters();
    const pulls = await fetchPulls(owner, repo, currentFilter, author, reviewer);
    saveRecentRepo(owner, repo);
    document.getElementById("pr-list-controls").hidden = false;
    renderPRList(pulls, owner, repo);
    // Populate suggestions: from PR authors + separate contributors fetch
    updateUserSuggestions(owner, repo, pulls);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

async function updateUserSuggestions(owner, repo, pulls) {
  // Add every user we see in the loaded PRs
  for (const pr of pulls) {
    if (pr.user && pr.user.login && pr.user.type !== "Bot") {
      knownUsers.set(pr.user.login, {
        login: pr.user.login,
        avatar_url: pr.user.avatar_url,
      });
    }
  }

  // Fetch contributors + assignees once per repo (broader list)
  const repoKey = `${owner}/${repo}`;
  if (lastUsersRepo !== repoKey) {
    lastUsersRepo = repoKey;
    try {
      const users = await fetchRepoUsers(owner, repo);
      for (const u of users) {
        if (!knownUsers.has(u.login)) knownUsers.set(u.login, u);
      }
    } catch {
      /* ignore — suggestions stay partial */
    }
  }

  renderUserSuggestions();
}

function renderUserSuggestions() {
  const list = document.getElementById("user-suggestions");
  if (!list) return;
  const sorted = [...knownUsers.values()].sort((a, b) =>
    a.login.localeCompare(b.login, undefined, { sensitivity: "base" })
  );
  list.innerHTML = sorted
    .map((u) => `<option value="${u.login}"></option>`)
    .join("");
}

function initFilterButtons() {
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      if (currentRepo) {
        loadRepoPRs(`${currentRepo.owner}/${currentRepo.repo}`, btn.dataset.state);
      }
    });
  });

  // Author / reviewer inputs — only reload on dropdown selection,
  // clearing the field, or explicit commit (Enter / blur).
  const reloadPRs = () => {
    if (currentRepo) {
      loadRepoPRs(`${currentRepo.owner}/${currentRepo.repo}`);
    }
  };
  ["filter-author", "filter-reviewer"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;

    // Track the last value we searched for so `change` (blur/Enter)
    // doesn't re-fire for an unchanged value.
    input.dataset.lastValue = input.value;

    input.addEventListener("input", (e) => {
      // `insertReplacementText` fires when a datalist option is picked.
      // An empty value means the user cleared the filter — reload too.
      const isDropdownPick = e.inputType === "insertReplacementText";
      const isCleared = input.value === "";
      if (isDropdownPick || isCleared) {
        input.dataset.lastValue = input.value;
        reloadPRs();
      }
    });

    // Enter / blur — commit typed values without reloading on every keystroke.
    input.addEventListener("change", () => {
      if (input.value !== input.dataset.lastValue) {
        input.dataset.lastValue = input.value;
        reloadPRs();
      }
    });
  });
}

function renderCurrentRepoHeader(owner, repo) {
  const el = document.getElementById("current-repo-header");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `
    <div class="current-repo-inner">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" class="repo-icon">
        <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"></path>
      </svg>
      <a href="https://github.com/${encodeURIComponent(owner)}" target="_blank" rel="noopener" class="repo-owner">${escapeHtml(owner)}</a>
      <span class="repo-sep">/</span>
      <a href="https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}" target="_blank" rel="noopener" class="repo-name">${escapeHtml(repo)}</a>
      <a href="https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}" target="_blank" rel="noopener" class="repo-external-link" title="Open on GitHub">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"></path></svg>
      </a>
    </div>
  `;
}

function renderPRList(pulls, owner, repo) {
  renderCurrentRepoHeader(owner, repo);
  const container = document.getElementById("pr-list");
  const summary = document.getElementById("pr-list-summary");
  summary.textContent = `${pulls.length} pull request${pulls.length !== 1 ? "s" : ""}`;

  if (pulls.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 16 16" fill="var(--fg-muted)"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"></path></svg>
      <p>No ${currentFilter === "all" ? "" : currentFilter} pull requests found.</p>
    </div>`;
    return;
  }

  container.innerHTML = "";
  for (const pr of pulls) {
    const card = document.createElement("div");
    card.className = "pr-card";

    const stateIcon = pr.merged_at
      ? `<svg class="pr-icon merged" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8-9a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"></path></svg>`
      : pr.state === "closed"
        ? `<svg class="pr-icon closed" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-1.143-5.017A.25.25 0 0 1 12 1.854v1.646h1a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75V1.854a.25.25 0 0 1 .393-.207l1.464.975ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"></path></svg>`
        : `<svg class="pr-icon open" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"></path></svg>`;

    const labels = (pr.labels || [])
      .slice(0, 3)
      .map(
        (l) =>
          `<span class="pr-label" style="background:#${l.color}20;color:#${l.color};border:1px solid #${l.color}40">${escapeHtml(l.name)}</span>`
      )
      .join("");

    // Reviewers (currently-requested reviewers from the pulls endpoint).
    // Search-API responses don't include this field, so it'll be empty there.
    const reviewers = (pr.requested_reviewers || []).filter((r) => r && r.login);
    const reviewerAvatars = reviewers.length
      ? `<div class="pr-card-reviewers" title="Requested reviewers: ${reviewers.map((r) => escapeHtml(r.login)).join(", ")}">
          ${reviewers
            .slice(0, 4)
            .map(
              (r) =>
                `<img src="${r.avatar_url}" alt="${escapeHtml(r.login)}" width="20" height="20" class="reviewer-avatar" title="${escapeHtml(r.login)}" />`
            )
            .join("")}
          ${reviewers.length > 4 ? `<span class="reviewer-more">+${reviewers.length - 4}</span>` : ""}
        </div>`
      : "";

    card.innerHTML = `
      <div class="pr-card-icon">${stateIcon}</div>
      <div class="pr-card-main">
        <div class="pr-card-title">
          <span class="pr-card-name">${escapeHtml(pr.title)}</span>
          ${labels}
        </div>
        <div class="pr-card-meta">
          #${pr.number}
          opened ${formatTimestamp(pr.created_at)}
          by <img src="${pr.user.avatar_url}" width="16" height="16" class="avatar-inline" />${escapeHtml(pr.user.login)}
          ${pr.draft ? '<span class="badge draft">Draft</span>' : ""}
        </div>
      </div>
      ${reviewerAvatars}
      <div class="pr-card-stats">
        <span class="pr-card-comments" title="Comments">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Z"></path></svg>
          ${pr.comments || 0}
        </span>
        <span class="pr-card-updated">${formatTimestamp(pr.updated_at)}</span>
      </div>
    `;

    card.addEventListener("click", () => navigateToPR(owner, repo, pr.number));
    container.appendChild(card);
  }
}

// --- PR loading ---

async function navigateToPR(owner, repo, number) {
  location.hash = `${owner}/${repo}/${number}`;
  await loadPR(owner, repo, number);
}

async function loadPR(owner, repo, number) {
  currentPR = { owner, repo, number };
  // Reset per-PR memoization so a fresh render reads current localStorage.
  resetCommentStateCaches();
  clearError();
  setLoading(true);
  document.getElementById("index-panel").hidden = true;
  document.getElementById("pr-panel").hidden = true;

  try {
    const data = await fetchPR(owner, repo, number);
    const timeline = buildTimeline(data);
    const threadMap = groupReviewCommentThreads(data.reviewComments);
    const { conversation, aiComments } = classifyTimeline(
      timeline,
      data.reviewComments
    );

    // Render PR header
    renderPRHeader(data.pr, "pr-header");

    // Render tabs
    renderTimeline("panel-conversation", conversation, currentPR);
    renderTimeline("panel-ai-comments", aiComments, currentPR);
    renderDiffPanel(
      "panel-files-changed",
      data.files,
      data.reviewComments,
      threadMap,
      currentPR
    );

    // Update counters
    document.getElementById("conv-count").textContent = String(
      conversation.length
    );
    document.getElementById("ai-count").textContent = String(
      aiComments.length
    );
    document.getElementById("files-count").textContent = String(
      data.files.length
    );

    // Show PR panel with conversation tab active
    document.getElementById("pr-panel").hidden = false;
    showTab("conversation");
    document.title = `#${number} ${data.pr.title} - PR Reviewer`;

    // Fetch Actions data in the background (doesn't block PR view)
    loadActionsForCurrentPR();
    startActionsAutoRefresh();
  } catch (err) {
    showError(err.message);
    document.getElementById("index-panel").hidden = false;
  } finally {
    setLoading(false);
  }
}

// --- Actions tab ---

/**
 * Adaptive polling for the Actions tab.
 *
 * - While ANY workflow run is queued or in_progress → poll every 5s
 * - Otherwise → poll every 60s so newly-created runs are still picked up
 * - Background tabs are skipped (resumed on visibility change)
 * - Between polls, compare against the previous snapshot; when a run
 *   transitions out of queued/in_progress we flash the card and show a
 *   toast (+ optional browser notification)
 */
const ACTIONS_POLL_FAST = 5000;
const ACTIONS_POLL_SLOW = 60000;
let actionsRefreshTimer = null;
let actionsPollingInFlight = false;
let prevActionsState = null; // Map<runId, { status, conclusion, name, url }>

async function loadActionsForCurrentPR(opts = {}) {
  if (!currentPR) return;
  const panel = document.getElementById("panel-actions");
  const isInitial = opts.isInitial ?? !prevActionsState;
  if (isInitial) {
    panel.innerHTML = '<div class="actions-loading">Loading workflow runs...</div>';
  } else {
    setActionsRefreshing(true);
  }
  actionsPollingInFlight = true;

  try {
    const { owner, repo, number } = currentPR;
    const data = await fetchActions(owner, repo, number);

    // Detect state transitions BEFORE re-rendering so we know which
    // cards deserve a flash.
    const justFinished = detectFinishedRuns(prevActionsState, data.workflowRuns || []);

    renderActionsPanel("panel-actions", data, currentPR);

    const externalChecks = (data.checkRuns || []).filter(
      (c) => !c.app || c.app.slug !== "github-actions"
    );
    const count = (data.workflowRuns?.length || 0) + externalChecks.length;
    document.getElementById("actions-count").textContent = String(count);

    // Flash cards that just finished + show toast / browser notification
    for (const finished of justFinished) {
      flashFinishedWorkflow(finished);
      notifyFinished(finished);
    }

    // Snapshot current state for the next diff
    prevActionsState = snapshotRuns(data.workflowRuns || []);

    // Schedule next poll with adaptive cadence
    scheduleNextActionsPoll(data.workflowRuns || []);
  } catch (err) {
    if (isInitial) {
      panel.innerHTML = `<div class="actions-error">Failed to load actions: ${escapeHtml(err.message)}</div>`;
    }
    // On error, retry with the slow interval
    scheduleNextActionsPoll([]);
  } finally {
    actionsPollingInFlight = false;
    setActionsRefreshing(false);
  }
}

function snapshotRuns(runs) {
  const m = new Map();
  for (const r of runs) {
    m.set(r.id, {
      status: r.status,
      conclusion: r.conclusion,
      name: r.name || r.display_title || "Workflow",
      url: r.html_url,
    });
  }
  return m;
}

function detectFinishedRuns(prev, currentRuns) {
  if (!prev) return [];
  const finished = [];
  for (const r of currentRuns) {
    const before = prev.get(r.id);
    if (!before) continue;
    const wasActive = before.status === "queued" || before.status === "in_progress" || before.status === "waiting";
    const isDone = r.status === "completed";
    if (wasActive && isDone) {
      finished.push({
        id: r.id,
        name: r.name || r.display_title || "Workflow",
        conclusion: r.conclusion,
        url: r.html_url,
      });
    }
  }
  return finished;
}

function hasActiveRuns(runs) {
  return runs.some(
    (r) => r.status === "queued" || r.status === "in_progress" || r.status === "waiting"
  );
}

function scheduleNextActionsPoll(runs) {
  if (actionsRefreshTimer) clearTimeout(actionsRefreshTimer);
  const delay = hasActiveRuns(runs) ? ACTIONS_POLL_FAST : ACTIONS_POLL_SLOW;
  actionsRefreshTimer = setTimeout(() => {
    if (!currentPR) return;
    if (document.hidden) {
      // Page is hidden; push the next attempt until it's visible again
      scheduleNextActionsPoll(runs);
      return;
    }
    loadActionsForCurrentPR({ isInitial: false });
  }, delay);
}

function startActionsAutoRefresh() {
  stopActionsAutoRefresh();
  // First poll runs via loadActionsForCurrentPR; it schedules follow-ups.
}

function stopActionsAutoRefresh() {
  if (actionsRefreshTimer) {
    clearTimeout(actionsRefreshTimer);
    actionsRefreshTimer = null;
  }
  prevActionsState = null;
}

function setActionsRefreshing(on) {
  const panel = document.getElementById("panel-actions");
  if (!panel) return;
  panel.classList.toggle("actions-is-refreshing", on);
}

function flashFinishedWorkflow(finished) {
  // Cards are grouped by name; find the one with matching title
  const cards = document.querySelectorAll("#panel-actions .workflow-card");
  for (const card of cards) {
    const title = card.querySelector(".workflow-card-title strong")?.textContent;
    if (title === finished.name) {
      card.classList.add("workflow-just-finished");
      setTimeout(() => card.classList.remove("workflow-just-finished"), 3000);
      break;
    }
  }
}

function notifyFinished({ name, conclusion, url }) {
  const state = conclusion === "success" ? "succeeded" : conclusion === "failure" ? "failed" : (conclusion || "finished");
  showToast(`${name} ${state}`, conclusion === "success" ? "success" : "failure", url);

  // Browser notification (best-effort; permission requested on first successful run)
  if ("Notification" in window) {
    if (Notification.permission === "granted") {
      try {
        const n = new Notification(`${name} ${state}`, {
          body: `PR #${currentPR?.number} · ${currentPR?.owner}/${currentPR?.repo}`,
          icon: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23238636'><path d='M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Z'/></svg>",
        });
        if (url) n.onclick = () => window.open(url, "_blank");
      } catch {
        /* some browsers require interaction; ignore */
      }
    } else if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }
}

/** Simple stacked toast container */
function showToast(message, kind = "success", url = null) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View";
    link.className = "toast-link";
    toast.appendChild(link);
  }
  container.appendChild(toast);
  setTimeout(() => toast.classList.add("toast-leaving"), 5000);
  setTimeout(() => toast.remove(), 5500);
}

// --- Tab switching ---

function initTabs() {
  document.getElementById("tab-nav").addEventListener("click", (e) => {
    const btn = e.target.closest("[role='tab']");
    if (!btn) return;
    showTab(btn.dataset.tab);
  });
}

// --- Navigation ---

function handleHash() {
  const hash = location.hash.slice(1);
  if (!hash) {
    document.getElementById("index-panel").hidden = false;
    document.getElementById("pr-panel").hidden = true;
    document.getElementById("current-repo-header").hidden = true;
    document.title = "PR Reviewer";
    return;
  }
  // Repo hash: #repo=owner/repo → show PR list for that repo
  const repoMatch = hash.match(/^repo=(.+)$/);
  if (repoMatch) {
    document.getElementById("pr-panel").hidden = true;
    document.getElementById("index-panel").hidden = false;
    const repoStr = decodeURIComponent(repoMatch[1]);
    document.getElementById("repo-input").value = repoStr;
    loadRepoPRs(repoStr);
    return;
  }
  // PR hash: owner/repo/number
  const match = hash.match(/^([^/]+)\/([^/]+)\/(\d+)$/);
  if (match) {
    loadPR(match[1], match[2], match[3]);
  }
}

// --- Theme ---

const THEME_KEY = "pr-reviewer-theme";

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });
}

// Apply saved theme immediately (before rendering) to prevent flash.
// Default is light — we only switch to dark when the user has explicitly
// chosen it. System preference is ignored so the default stays light
// regardless of the OS setting.
(function applySavedTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark") applyTheme("dark");
})();

// --- Clear data modal ---

/**
 * Inspect localStorage and return a summary of what the app has stored,
 * grouped by category. Each category has a label, a summary line shown
 * in the UI, and a list of keys that should be removed to clear it.
 */
function inventoryStoredData() {
  const categories = [
    {
      id: "recent-repos",
      label: "Recent repositories",
      summary: "",
      keys: [],
    },
    {
      id: "theme",
      label: "Theme preference",
      summary: "",
      keys: [],
    },
    {
      id: "file-state",
      label: "Per-PR file state",
      summary: "",
      keys: [],
    },
  ];

  // Recent repos
  try {
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    if (recent.length) {
      categories[0].keys.push(RECENT_KEY);
      categories[0].summary = `${recent.length} repo${recent.length !== 1 ? "s" : ""} in history`;
    } else {
      categories[0].summary = "Nothing stored";
    }
  } catch {
    categories[0].summary = "Nothing stored";
  }

  // Theme
  const theme = localStorage.getItem(THEME_KEY);
  if (theme) {
    categories[1].keys.push(THEME_KEY);
    categories[1].summary = `Currently: ${theme === "dark" ? "Dark" : "Light"}`;
  } else {
    categories[1].summary = "Using system preference";
  }

  // Per-PR UI state (hidden files, expand/collapse, collapsed comments)
  const prKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (
      key.startsWith("pr-reviewer-file-state:") ||
      key.startsWith("pr-reviewer-hidden-files:") ||
      key.startsWith("pr-reviewer-collapsed-comments:") ||
      key.startsWith("pr-reviewer-seen-comments:")
    ) {
      prKeys.push(key);
    }
  }
  // Count unique PRs
  const uniquePrs = new Set(
    prKeys.map((k) => k.split(":").slice(1).join(":"))
  );
  categories[2].keys = prKeys;
  categories[2].summary = uniquePrs.size
    ? `UI state for ${uniquePrs.size} PR${uniquePrs.size !== 1 ? "s" : ""}`
    : "Nothing stored";

  return categories;
}

function initClearDataModal() {
  const btn = document.getElementById("clear-data-btn");
  const modal = document.getElementById("clear-data-modal");
  if (!btn || !modal) return;

  const optsContainer = document.getElementById("clear-data-options");
  const confirmBtn = document.getElementById("clear-data-confirm");

  const renderOptions = () => {
    const cats = inventoryStoredData();
    optsContainer.innerHTML = "";
    for (const cat of cats) {
      const isEmpty = cat.keys.length === 0;
      const row = document.createElement("label");
      row.className = "clear-data-option";
      if (isEmpty) row.classList.add("is-empty");
      row.innerHTML = `
        <input type="checkbox" data-category="${cat.id}" ${isEmpty ? "disabled" : "checked"}>
        <div class="clear-data-option-body">
          <strong>${cat.label}</strong>
          <span class="muted">${cat.summary}</span>
        </div>
      `;
      optsContainer.appendChild(row);
    }
  };

  const openModal = () => {
    renderOptions();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  };

  const closeModal = () => {
    modal.hidden = true;
    document.body.style.overflow = "";
  };

  btn.addEventListener("click", openModal);

  // Any element with data-close dismisses the modal
  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal();
  });

  // Escape key closes it
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });

  confirmBtn.addEventListener("click", () => {
    const selected = [
      ...optsContainer.querySelectorAll("input[type='checkbox']:checked"),
    ].map((cb) => cb.dataset.category);
    if (selected.length === 0) {
      closeModal();
      return;
    }

    const cats = inventoryStoredData();
    let keysRemoved = 0;
    for (const cat of cats) {
      if (!selected.includes(cat.id)) continue;
      for (const key of cat.keys) {
        try {
          localStorage.removeItem(key);
          keysRemoved++;
        } catch {
          /* ignore */
        }
      }
    }

    closeModal();

    // Apply immediate side effects of clearing
    if (selected.includes("theme")) {
      // Revert to the default (light) after clearing the stored preference
      document.documentElement.removeAttribute("data-theme");
    }
    if (selected.includes("file-state")) {
      resetCommentStateCaches();
    }

    // Send the user back to a clean home (Index) view so the reset is obvious.
    location.hash = "";
    document.getElementById("pr-panel").hidden = true;
    document.getElementById("index-panel").hidden = false;
    document.getElementById("current-repo-header").hidden = true;
    document.getElementById("pr-list-controls").hidden = true;
    document.getElementById("pr-list").innerHTML = "";
    currentRepo = null;
    currentPR = null;
    document.title = "PR Reviewer";
    renderRecentRepos();
  });
}

// --- Init ---

function init() {
  // PR form
  document.getElementById("pr-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("pr-input").value;
    const parsed = parsePRInput(input);
    if (!parsed) {
      showError("Invalid PR URL. Use https://github.com/owner/repo/pull/123 or owner/repo#123");
      return;
    }
    navigateToPR(parsed.owner, parsed.repo, parsed.number);
  });

  // Repo form
  document.getElementById("repo-form").addEventListener("submit", (e) => {
    e.preventDefault();
    loadRepoPRs(document.getElementById("repo-input").value);
  });

  // Logo link → back to index
  document.getElementById("logo-link").addEventListener("click", (e) => {
    e.preventDefault();
    location.hash = "";
    document.getElementById("pr-panel").hidden = true;
    document.getElementById("index-panel").hidden = false;
    document.getElementById("current-repo-header").hidden = true;
    document.getElementById("pr-list-controls").hidden = true;
    document.getElementById("pr-list").innerHTML = "";
    currentRepo = null;
    currentPR = null;
    stopActionsAutoRefresh();
    document.title = "PR Reviewer";
  });

  initTabs();
  initFilterButtons();
  initThemeToggle();
  initClearDataModal();
  renderRecentRepos();

  // When the browser tab becomes visible again, refresh actions data
  // immediately if a PR is loaded — otherwise scheduled polls may be
  // waiting on the slow interval.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentPR && !actionsPollingInFlight) {
      loadActionsForCurrentPR({ isInitial: false });
    }
  });

  // After a Re-run button succeeds, the actions-renderer dispatches this
  // event. Give GitHub a couple seconds to register the rerun, then poll.
  document.addEventListener("actions:request-refresh", () => {
    if (!currentPR || actionsPollingInFlight) return;
    if (actionsRefreshTimer) clearTimeout(actionsRefreshTimer);
    actionsRefreshTimer = setTimeout(
      () => loadActionsForCurrentPR({ isInitial: false }),
      2000
    );
  });

  // Handle initial hash
  window.addEventListener("hashchange", handleHash);
  handleHash();
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init();

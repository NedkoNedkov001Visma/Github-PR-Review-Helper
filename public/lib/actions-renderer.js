import {
  fetchWorkflowJobs,
  rerunWorkflow,
  rerunFailedJobs,
} from "./api.js";

/**
 * Render / patch the Actions panel.
 *
 * On first call this builds the full layout. On subsequent calls with the
 * same container it patches only the parts that changed — existing cards
 * are reused, their class/icon/meta updated in place, action buttons are
 * only rebuilt when status or conclusion changed, and expanded <details>
 * sections are preserved (scroll position sticks, too).
 */
export function renderActionsPanel(containerId, data, prInfo) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // --- Error / missing data -------------------------------------------
  if (!data || data.error) {
    container.innerHTML = "";
    const err = document.createElement("div");
    err.className = "actions-error";
    err.textContent = data?.error || "Failed to load actions.";
    container.appendChild(err);
    return;
  }

  const workflowRuns = data.workflowRuns || [];
  const checkRuns = data.checkRuns || [];

  // --- Acquire or create stable scaffolding ---------------------------
  let header = container.querySelector(":scope > .actions-header");
  let list = container.querySelector(":scope > .actions-list");
  let emptyEl = container.querySelector(":scope > .actions-empty");
  let extTitle = container.querySelector(":scope > .actions-section-title");
  let extList = container.querySelector(":scope > .actions-external-list");

  if (!header) {
    container.innerHTML = "";
    header = document.createElement("div");
    header.className = "actions-header";
    container.appendChild(header);
    list = document.createElement("div");
    list.className = "actions-list";
    container.appendChild(list);
  }

  updateActionsHeader(header, data);

  // --- Group workflow runs by workflow name (newest first) ------------
  const byWorkflow = new Map();
  for (const run of workflowRuns) {
    const name =
      run.name || run.display_title || `Workflow ${run.workflow_id}`;
    if (!byWorkflow.has(name)) byWorkflow.set(name, []);
    byWorkflow.get(name).push(run);
  }

  const externalChecks = checkRuns.filter(
    (c) => !c.app || c.app.slug !== "github-actions"
  );

  // --- Empty state ----------------------------------------------------
  if (byWorkflow.size === 0 && externalChecks.length === 0) {
    list.innerHTML = "";
    if (!emptyEl) {
      emptyEl = document.createElement("div");
      emptyEl.className = "actions-empty";
      emptyEl.textContent =
        "No workflow runs or check runs found on the PR's head commit.";
      container.appendChild(emptyEl);
    }
    removeExternalSection(container);
    return;
  } else if (emptyEl) {
    emptyEl.remove();
  }

  // --- Patch workflow cards in place ---------------------------------
  patchWorkflowCards(list, byWorkflow, prInfo);

  // --- Patch external checks section ---------------------------------
  patchExternalChecks(container, externalChecks);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function updateActionsHeader(header, data) {
  const workflowRuns = data.workflowRuns || [];
  const totalRuns = workflowRuns.length;
  const failedRuns = workflowRuns.filter(
    (r) =>
      r.conclusion === "failure" ||
      r.conclusion === "cancelled" ||
      r.conclusion === "timed_out"
  ).length;

  let summary = header.querySelector(".actions-summary");
  if (!summary) {
    summary = document.createElement("span");
    summary.className = "actions-summary";
    header.appendChild(summary);
  }
  summary.innerHTML =
    `<strong>${totalRuns}</strong> workflow run${totalRuns !== 1 ? "s" : ""}` +
    (failedRuns > 0
      ? ` · <span class="actions-failed-count">${failedRuns} failed</span>`
      : "");

  let sha = header.querySelector(".actions-sha");
  if (data.sha) {
    if (!sha) {
      sha = document.createElement("code");
      sha.className = "actions-sha";
      header.appendChild(sha);
    }
    sha.textContent = data.sha.substring(0, 7);
    sha.title = `HEAD commit ${data.sha}`;
  } else if (sha) {
    sha.remove();
  }
}

// ---------------------------------------------------------------------------
// Workflow cards — incremental patch
// ---------------------------------------------------------------------------

function patchWorkflowCards(list, byWorkflow, prInfo) {
  // Existing cards, keyed by workflow name
  const existing = new Map();
  for (const card of list.querySelectorAll(":scope > [data-workflow-name]")) {
    existing.set(card.dataset.workflowName, card);
  }

  // Track the running insertion point so we can keep the order in sync with
  // the API response. We only physically move cards when their position
  // doesn't already match.
  let anchor = list.firstElementChild;

  for (const [name, runs] of byWorkflow) {
    let card = existing.get(name);
    if (!card) {
      card = createWorkflowCard(name, prInfo);
    }
    updateWorkflowCard(card, name, runs, prInfo);

    if (card !== anchor) {
      list.insertBefore(card, anchor);
    } else {
      anchor = card.nextElementSibling;
    }

    existing.delete(name);
  }

  // Any existing cards not in the new set are gone from GitHub — remove them
  for (const card of existing.values()) card.remove();
}

function createWorkflowCard(workflowName, prInfo) {
  const card = document.createElement("div");
  card.className = "workflow-card";
  card.dataset.workflowName = workflowName;

  const header = document.createElement("div");
  header.className = "workflow-card-header";
  card.appendChild(header);

  const statusIcon = document.createElement("span");
  statusIcon.className = "workflow-status-icon";
  header.appendChild(statusIcon);

  const main = document.createElement("div");
  main.className = "workflow-card-main";
  header.appendChild(main);

  const title = document.createElement("div");
  title.className = "workflow-card-title";
  const nameEl = document.createElement("strong");
  nameEl.className = "workflow-name";
  title.appendChild(nameEl);
  main.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "workflow-card-meta";
  main.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "workflow-card-actions";
  header.appendChild(actions);

  // Expandable details (jobs list)
  const details = document.createElement("details");
  details.className = "workflow-card-details";
  const summary = document.createElement("summary");
  summary.textContent = "Show jobs";
  details.appendChild(summary);
  const jobsContainer = document.createElement("div");
  jobsContainer.className = "jobs-list";
  const placeholder = document.createElement("div");
  placeholder.className = "jobs-placeholder";
  placeholder.textContent = "Click to load jobs...";
  jobsContainer.appendChild(placeholder);
  details.appendChild(jobsContainer);
  card.appendChild(details);

  // Lazy-load jobs on first expand OR re-load if the run id changed
  details.addEventListener("toggle", async () => {
    if (!details.open) return;
    const currentRunId = card.dataset.latestRunId;
    if (card.dataset.loadedJobsForRun === currentRunId) return;
    card.dataset.loadedJobsForRun = currentRunId;
    placeholder.textContent = "Loading jobs...";
    jobsContainer.innerHTML = "";
    jobsContainer.appendChild(placeholder);
    try {
      const jobs = await fetchWorkflowJobs(
        prInfo.owner,
        prInfo.repo,
        currentRunId
      );
      jobsContainer.innerHTML = "";
      if (!jobs.length) {
        const empty = document.createElement("div");
        empty.className = "jobs-placeholder";
        empty.textContent = "No jobs reported for this run.";
        jobsContainer.appendChild(empty);
        return;
      }
      for (const job of jobs) jobsContainer.appendChild(renderJobRow(job));
    } catch (e) {
      delete card.dataset.loadedJobsForRun;
      placeholder.textContent = "Failed to load jobs: " + e.message;
    }
  });

  return card;
}

function updateWorkflowCard(card, workflowName, runs, prInfo) {
  const latest = runs[0];
  const state = getOverallState(latest);

  // Replace status-* class only if it actually changed
  const prevState = card.dataset.state;
  if (prevState !== state) {
    for (const cls of [...card.classList]) {
      if (cls.startsWith("status-")) card.classList.remove(cls);
    }
    card.classList.add(`status-${state}`);
    card.dataset.state = state;
  }

  // Status icon — only update if state changed
  const iconEl = card.querySelector(":scope > .workflow-card-header > .workflow-status-icon");
  if (prevState !== state) iconEl.innerHTML = statusIconSvg(state);

  // Title — name + optional run count badge
  const titleEl = card.querySelector(".workflow-card-title");
  const nameEl = titleEl.querySelector(".workflow-name");
  if (nameEl.textContent !== workflowName) nameEl.textContent = workflowName;

  let countBadge = titleEl.querySelector(".workflow-run-count");
  if (runs.length > 1) {
    if (!countBadge) {
      countBadge = document.createElement("span");
      countBadge.className = "workflow-run-count";
      titleEl.appendChild(countBadge);
    }
    const txt = `${runs.length} runs`;
    if (countBadge.textContent !== txt) countBadge.textContent = txt;
  } else if (countBadge) {
    countBadge.remove();
  }

  // Meta row (state + updated time + event)
  const metaEl = card.querySelector(".workflow-card-meta");
  const metaText =
    describeState(latest) +
    " · " +
    formatRelativeTime(latest.updated_at || latest.run_started_at) +
    (latest.event ? ` · ${latest.event}` : "");
  if (metaEl.textContent !== metaText) metaEl.textContent = metaText;

  // Action buttons — rebuild only if the set of applicable buttons could
  // have changed (state/conclusion change, or brand-new card).
  const prevSignature = card.dataset.actionsSignature || "";
  const signature = `${latest.status}|${latest.conclusion}|${latest.html_url || ""}|${latest.id}`;
  if (prevSignature !== signature) {
    rebuildActionButtons(card, latest, prInfo);
    card.dataset.actionsSignature = signature;
  }

  // Track the latest run id so the details section can reload jobs when
  // a new run replaces the previous one.
  const prevRunId = card.dataset.latestRunId;
  card.dataset.latestRunId = String(latest.id);
  if (prevRunId && prevRunId !== String(latest.id)) {
    // Invalidate any cached jobs load so next expand re-fetches
    delete card.dataset.loadedJobsForRun;
    // If the details panel is currently open, refresh it silently
    const details = card.querySelector(":scope > .workflow-card-details");
    if (details?.open) details.dispatchEvent(new Event("toggle"));
  }
}

function rebuildActionButtons(card, latest, prInfo) {
  const actions = card.querySelector(":scope > .workflow-card-header > .workflow-card-actions");
  actions.innerHTML = "";

  if (latest.html_url) {
    const viewBtn = document.createElement("a");
    viewBtn.className = "btn-sm btn-secondary";
    viewBtn.href = latest.html_url;
    viewBtn.target = "_blank";
    viewBtn.rel = "noopener";
    viewBtn.textContent = "View";
    actions.appendChild(viewBtn);
  }

  const isCompleted = latest.status === "completed";
  const isFailed = ["failure", "cancelled", "timed_out"].includes(
    latest.conclusion
  );

  if (isCompleted && isFailed) {
    actions.appendChild(
      makeRerunButton("Re-run failed jobs", () =>
        rerunFailedJobs(prInfo.owner, prInfo.repo, latest.id)
      )
    );
  }
  if (isCompleted) {
    actions.appendChild(
      makeRerunButton(
        isFailed ? "Re-run all" : "Re-run",
        () => rerunWorkflow(prInfo.owner, prInfo.repo, latest.id),
        "btn-secondary"
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Job rows (inside a workflow card)
// ---------------------------------------------------------------------------

function renderJobRow(job) {
  const row = document.createElement("div");
  row.className = "job-row";
  const state = getOverallState(job);
  row.classList.add(`status-${state}`);

  const icon = document.createElement("span");
  icon.className = "job-status-icon";
  icon.innerHTML = statusIconSvg(state);
  row.appendChild(icon);

  const name = document.createElement("span");
  name.className = "job-name";
  name.textContent = job.name;
  row.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "job-meta";
  meta.textContent = describeState(job);
  row.appendChild(meta);

  if (job.html_url) {
    const link = document.createElement("a");
    link.className = "job-link";
    link.href = job.html_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Logs";
    row.appendChild(link);
  }

  return row;
}

// ---------------------------------------------------------------------------
// External checks section — patched the same way
// ---------------------------------------------------------------------------

function patchExternalChecks(container, externalChecks) {
  let title = container.querySelector(":scope > .actions-section-title");
  let list = container.querySelector(":scope > .actions-external-list");

  if (externalChecks.length === 0) {
    title?.remove();
    list?.remove();
    return;
  }

  if (!title) {
    title = document.createElement("h3");
    title.className = "actions-section-title";
    title.textContent = "External checks";
    container.appendChild(title);
  }
  if (!list) {
    list = document.createElement("div");
    list.className = "actions-list actions-external-list";
    container.appendChild(list);
  }

  const existing = new Map();
  for (const card of list.querySelectorAll(":scope > [data-check-id]")) {
    existing.set(card.dataset.checkId, card);
  }
  let anchor = list.firstElementChild;
  for (const cr of externalChecks) {
    const id = String(cr.id);
    let card = existing.get(id);
    if (!card) {
      card = createCheckRunCard();
      card.dataset.checkId = id;
    }
    updateCheckRunCard(card, cr);
    if (card !== anchor) list.insertBefore(card, anchor);
    else anchor = card.nextElementSibling;
    existing.delete(id);
  }
  for (const card of existing.values()) card.remove();
}

function removeExternalSection(container) {
  container.querySelector(":scope > .actions-section-title")?.remove();
  container.querySelector(":scope > .actions-external-list")?.remove();
}

function createCheckRunCard() {
  const card = document.createElement("div");
  card.className = "workflow-card";
  const header = document.createElement("div");
  header.className = "workflow-card-header";
  const icon = document.createElement("span");
  icon.className = "workflow-status-icon";
  header.appendChild(icon);
  const main = document.createElement("div");
  main.className = "workflow-card-main";
  const title = document.createElement("div");
  title.className = "workflow-card-title";
  const name = document.createElement("strong");
  name.className = "workflow-name";
  title.appendChild(name);
  main.appendChild(title);
  const meta = document.createElement("div");
  meta.className = "workflow-card-meta";
  main.appendChild(meta);
  header.appendChild(main);
  const actions = document.createElement("div");
  actions.className = "workflow-card-actions";
  header.appendChild(actions);
  card.appendChild(header);
  return card;
}

function updateCheckRunCard(card, cr) {
  const state = getOverallState(cr);
  const prevState = card.dataset.state;
  if (prevState !== state) {
    for (const cls of [...card.classList]) {
      if (cls.startsWith("status-")) card.classList.remove(cls);
    }
    card.classList.add(`status-${state}`);
    card.dataset.state = state;
  }
  const iconEl = card.querySelector(".workflow-status-icon");
  if (prevState !== state) iconEl.innerHTML = statusIconSvg(state);

  const nameEl = card.querySelector(".workflow-name");
  const name = cr.name || "Check";
  if (nameEl.textContent !== name) nameEl.textContent = name;

  const titleEl = card.querySelector(".workflow-card-title");
  let appBadge = titleEl.querySelector(".workflow-run-count");
  if (cr.app && cr.app.name) {
    if (!appBadge) {
      appBadge = document.createElement("span");
      appBadge.className = "workflow-run-count";
      titleEl.appendChild(appBadge);
    }
    if (appBadge.textContent !== cr.app.name) appBadge.textContent = cr.app.name;
  } else if (appBadge) {
    appBadge.remove();
  }

  const metaEl = card.querySelector(".workflow-card-meta");
  const metaText = describeState(cr);
  if (metaEl.textContent !== metaText) metaEl.textContent = metaText;

  const actions = card.querySelector(".workflow-card-actions");
  const prevSig = card.dataset.actionsSignature || "";
  const sig = cr.html_url || "";
  if (prevSig !== sig) {
    actions.innerHTML = "";
    if (cr.html_url) {
      const view = document.createElement("a");
      view.className = "btn-sm btn-secondary";
      view.href = cr.html_url;
      view.target = "_blank";
      view.rel = "noopener";
      view.textContent = "View";
      actions.appendChild(view);
    }
    card.dataset.actionsSignature = sig;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getOverallState(runOrCheck) {
  const s = runOrCheck.status;
  const c = runOrCheck.conclusion;
  if (s === "queued") return "queued";
  if (s === "in_progress") return "in_progress";
  if (s === "waiting") return "queued";
  if (c === "success") return "success";
  if (c === "failure") return "failure";
  if (c === "cancelled") return "cancelled";
  if (c === "timed_out") return "failure";
  if (c === "skipped") return "skipped";
  if (c === "neutral") return "neutral";
  if (c === "action_required") return "failure";
  return "other";
}

function describeState(runOrCheck) {
  const s = runOrCheck.status;
  const c = runOrCheck.conclusion;
  if (s === "queued") return "Queued";
  if (s === "waiting") return "Waiting";
  if (s === "in_progress") return "In progress";
  if (c === "success") return "Succeeded";
  if (c === "failure") return "Failed";
  if (c === "cancelled") return "Cancelled";
  if (c === "timed_out") return "Timed out";
  if (c === "skipped") return "Skipped";
  if (c === "neutral") return "Neutral";
  if (c === "action_required") return "Action required";
  return s || c || "Unknown";
}

function statusIconSvg(state) {
  switch (state) {
    case "success":
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`;
    case "failure":
    case "cancelled":
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`;
    case "in_progress":
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="spin"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 0 0 0 13A6.5 6.5 0 0 0 8 1.5Zm0 2a.75.75 0 0 1 .75.75v3.69l2.28 2.28a.75.75 0 1 1-1.06 1.06L7.47 8.78A.75.75 0 0 1 7.25 8.25V4.25A.75.75 0 0 1 8 3.5Z"/></svg>`;
    case "queued":
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z"/></svg>`;
    case "skipped":
    case "neutral":
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.25 7.25a.75.75 0 0 1 0 1.5H1.5a.75.75 0 0 1 0-1.5h1.75Zm3.5 0a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5h1.75ZM11 7.25a.75.75 0 0 1 0 1.5H9.25a.75.75 0 0 1 0-1.5H11Zm3.5 0a.75.75 0 0 1 0 1.5h-1.75a.75.75 0 0 1 0-1.5h1.75Z"/></svg>`;
    default:
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
  }
}

function makeRerunButton(label, fn, extraClass = "btn-primary") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn-sm ${extraClass}`;
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Working...";
    try {
      await fn();
      btn.textContent = "Triggered ✓";

      // Optimistically flip the card to "In progress" while we wait for
      // GitHub to reflect the new run. The next poll will confirm (or
      // correct) the state.
      const card = btn.closest(".workflow-card");
      if (card) markCardOptimisticallyQueued(card);

      // Ask the app to poll now instead of waiting on the timer
      document.dispatchEvent(new CustomEvent("actions:request-refresh"));

      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 2500);
    } catch (e) {
      alert("Action failed: " + e.message);
      btn.textContent = orig;
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Optimistically flip a workflow card to an "in progress / queued" state
 * while waiting for GitHub's API to reflect a fresh rerun.
 */
function markCardOptimisticallyQueued(card) {
  // Swap status-* class
  for (const cls of [...card.classList]) {
    if (cls.startsWith("status-")) card.classList.remove(cls);
  }
  card.classList.add("status-in_progress", "status-optimistic");
  card.dataset.state = "in_progress";

  // Update status icon
  const iconEl = card.querySelector(
    ":scope > .workflow-card-header > .workflow-status-icon"
  );
  if (iconEl) iconEl.innerHTML = statusIconSvg("in_progress");

  // Update meta text
  const metaEl = card.querySelector(".workflow-card-meta");
  if (metaEl) metaEl.textContent = "Queued · just now · re-run";

  // Disable any other rerun buttons on this card (can't re-run a running job)
  const actions = card.querySelector(
    ":scope > .workflow-card-header > .workflow-card-actions"
  );
  if (actions) {
    for (const actionBtn of actions.querySelectorAll("button")) {
      actionBtn.disabled = true;
    }
  }

  // Bump the actions signature so the next legitimate patch knows to
  // rebuild buttons even if status/conclusion happens to match
  card.dataset.actionsSignature = "__optimistic__";
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

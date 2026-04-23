export async function fetchPR(owner, repo, number) {
  const res = await fetch(`/api/pr/${owner}/${repo}/${number}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Failed to fetch PR: ${res.status}`);
  }
  return res.json();
}

export async function fetchRepoUsers(owner, repo) {
  const res = await fetch(`/api/repos/${owner}/${repo}/users`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchPulls(owner, repo, state = "open", author = "", reviewer = "") {
  const params = new URLSearchParams({ state });
  if (author) params.set("author", author);
  if (reviewer) params.set("reviewer", reviewer);
  const res = await fetch(
    `/api/repos/${owner}/${repo}/pulls?${params}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Failed to fetch pulls: ${res.status}`);
  }
  return res.json();
}

export async function addComment(owner, repo, number, body) {
  const res = await fetch(`/api/pr/${owner}/${repo}/${number}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to add comment");
  }
  return res.json();
}

export async function replyToReviewComment(owner, repo, number, commentId, body) {
  const res = await fetch(
    `/api/pr/${owner}/${repo}/${number}/review-comments/${commentId}/replies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to reply");
  }
  return res.json();
}

export async function resolveThread(owner, repo, number, nodeId) {
  const res = await fetch(
    `/api/pr/${owner}/${repo}/${number}/threads/${nodeId}/resolve`,
    { method: "PUT" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to resolve thread");
  }
  return res.json();
}

// --- Actions / workflow runs ---

export async function fetchActions(owner, repo, number) {
  const res = await fetch(`/api/pr/${owner}/${repo}/${number}/actions`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to fetch actions");
  }
  return res.json();
}

export async function fetchWorkflowJobs(owner, repo, runId) {
  const res = await fetch(`/api/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to fetch jobs");
  }
  return res.json();
}

export async function rerunWorkflow(owner, repo, runId) {
  const res = await fetch(
    `/api/repos/${owner}/${repo}/actions/runs/${runId}/rerun`,
    { method: "POST" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to rerun workflow");
  }
  return res.json();
}

export async function rerunFailedJobs(owner, repo, runId) {
  const res = await fetch(
    `/api/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed`,
    { method: "POST" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to rerun failed jobs");
  }
  return res.json();
}

export async function unresolveThread(owner, repo, number, nodeId) {
  const res = await fetch(
    `/api/pr/${owner}/${repo}/${number}/threads/${nodeId}/unresolve`,
    { method: "PUT" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || "Failed to unresolve thread");
  }
  return res.json();
}

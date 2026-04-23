export async function fetchPR(owner, repo, number) {
  const res = await fetch(`/api/pr/${owner}/${repo}/${number}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Failed to fetch PR: ${res.status}`);
  }
  return res.json();
}

export async function fetchPulls(owner, repo, state = "open") {
  const res = await fetch(
    `/api/repos/${owner}/${repo}/pulls?state=${state}`
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

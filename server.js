import express from "express";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const GH_API = "https://api.github.com";

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// --- GitHub token ---

let cachedToken = null;

function getToken() {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = execSync("gh auth token", { encoding: "utf-8" }).trim();
    return cachedToken;
  } catch {
    throw new Error("Failed to get GitHub token. Is `gh` CLI installed and authenticated?");
  }
}

function clearToken() {
  cachedToken = null;
}

// --- GitHub API helpers ---

async function ghFetch(path, token, options = {}) {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("GitHub token expired or invalid");
  }
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GitHub API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return { data: await res.json(), headers: res.headers };
}

async function ghFetchAll(path, token) {
  const results = [];
  let url = `${GH_API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (res.status === 401) {
      clearToken();
      throw new Error("GitHub token expired or invalid");
    }
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`GitHub API ${res.status}: ${body}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    results.push(...data);

    // Follow pagination
    const link = res.headers.get("link") || "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  return results;
}

async function ghGraphQL(query, variables, token) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GraphQL ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// --- Read endpoints ---

// Authenticated GitHub user — used by the UI to decide whether to show
// the Approve button (only PRs the current user is a reviewer on).
let cachedCurrentUser = null;
app.get("/api/user", async (req, res) => {
  try {
    if (cachedCurrentUser) {
      return res.json(cachedCurrentUser);
    }
    const token = getToken();
    const { data } = await ghFetch("/user", token);
    cachedCurrentUser = {
      login: data.login,
      id: data.id,
      avatar_url: data.avatar_url,
    };
    res.json(cachedCurrentUser);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Single commit detail (metadata + files + patch).
app.get("/api/repos/:owner/:repo/commits/:sha", async (req, res) => {
  try {
    const { owner, repo, sha } = req.params;
    const token = getToken();
    const { data } = await ghFetch(
      `/repos/${owner}/${repo}/commits/${sha}`,
      token
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/pr/:owner/:repo/:number", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const token = getToken();
    const base = `/repos/${owner}/${repo}`;

    const [prRes, issueComments, reviews, reviewComments, files, commits] =
      await Promise.all([
        ghFetch(`${base}/pulls/${number}`, token),
        ghFetchAll(`${base}/issues/${number}/comments`, token),
        ghFetchAll(`${base}/pulls/${number}/reviews`, token),
        ghFetchAll(`${base}/pulls/${number}/comments`, token),
        ghFetchAll(`${base}/pulls/${number}/files`, token),
        ghFetchAll(`${base}/pulls/${number}/commits`, token),
      ]);

    res.json({
      pr: prRes.data,
      issueComments,
      reviews,
      reviewComments,
      files,
      commits,
    });
  } catch (err) {
    console.error("Error fetching PR:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/repos/:owner/:repo/pulls", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const state = req.query.state || "open";
    const perPage = Math.min(parseInt(req.query.per_page) || 50, 100);
    const page = parseInt(req.query.page) || 1;
    const toArr = (v) =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .map((s) => String(s).trim())
        .filter(Boolean);
    const authors = toArr(req.query.author);
    const reviewers = toArr(req.query.reviewer);
    const participants = toArr(req.query.participant);
    const token = getToken();

    if (authors.length || reviewers.length || participants.length) {
      const normalize = (items) =>
        (items || []).map((it) => ({
          number: it.number,
          title: it.title,
          state: it.state,
          draft: it.draft,
          user: it.user,
          labels: it.labels,
          created_at: it.created_at,
          updated_at: it.updated_at,
          comments: it.comments,
          merged_at: it.pull_request && it.pull_request.merged_at,
          html_url: it.html_url,
        }));

      // Each search query carries the repo + state + ONE qualifier
      // clause. Multi-value filters fan out into multiple queries and
      // merge client-side, since GitHub's Search API can't OR these.
      const buildQuery = (clause) =>
        [
          `repo:${owner}/${repo}`,
          `is:pr`,
          state !== "all" ? `state:${state}` : null,
          clause,
        ]
          .filter(Boolean)
          .join(" ");

      const runSearch = async (q) => {
        const { data } = await ghFetch(
          `/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&sort=updated&order=desc`,
          token
        );
        return normalize(data.items);
      };

      // Map of PR number → PR object, populated by every query for dedup
      const allByNumber = new Map();
      const recordResult = (list, into) => {
        for (const pr of list) {
          if (!allByNumber.has(pr.number)) allByNumber.set(pr.number, pr);
          into.add(pr.number);
        }
      };

      // For each filter group, build the queries that represent its
      // OR-of-qualifiers. Run them in parallel, union into a Set of PR
      // numbers. Multiple groups intersect at the end.
      const groupSets = [];

      const runGroup = async (clauses) => {
        const lists = await Promise.all(clauses.map((c) => runSearch(buildQuery(c))));
        const set = new Set();
        for (const list of lists) recordResult(list, set);
        return set;
      };

      if (authors.length) {
        groupSets.push(await runGroup(authors.map((a) => `author:${a}`)));
      }
      if (reviewers.length) {
        const clauses = [];
        for (const r of reviewers) {
          clauses.push(`reviewed-by:${r}`);
          clauses.push(`review-requested:${r}`);
        }
        groupSets.push(await runGroup(clauses));
      }
      if (participants.length) {
        const clauses = [];
        for (const p of participants) {
          clauses.push(`author:${p}`);
          clauses.push(`reviewed-by:${p}`);
          clauses.push(`review-requested:${p}`);
          clauses.push(`assignee:${p}`);
        }
        groupSets.push(await runGroup(clauses));
      }

      // Intersect the groups (AND) — a PR must satisfy every active group
      let finalNumbers = groupSets[0] || new Set();
      for (let i = 1; i < groupSets.length; i++) {
        const next = groupSets[i];
        finalNumbers = new Set([...finalNumbers].filter((n) => next.has(n)));
      }

      const merged = [...finalNumbers]
        .map((n) => allByNumber.get(n))
        .filter(Boolean)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

      return res.json(merged);
    }

    // No user filters — use the faster /pulls endpoint
    const { data } = await ghFetch(
      `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`,
      token
    );
    res.json(data);
  } catch (err) {
    console.error("Error fetching pulls:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// List users associated with a repo (contributors + assignees).
// Used to populate the author/reviewer filter dropdowns.
app.get("/api/repos/:owner/:repo/users", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const token = getToken();
    const [contributors, assignees] = await Promise.allSettled([
      ghFetch(`/repos/${owner}/${repo}/contributors?per_page=100`, token),
      ghFetch(`/repos/${owner}/${repo}/assignees?per_page=100`, token),
    ]);
    const users = new Map();
    const add = (u) => {
      if (!u || !u.login) return;
      if (u.type === "Bot") return;
      if (!users.has(u.login)) {
        users.set(u.login, { login: u.login, avatar_url: u.avatar_url });
      }
    };
    if (contributors.status === "fulfilled") contributors.value.data.forEach(add);
    if (assignees.status === "fulfilled") assignees.value.data.forEach(add);
    res.json([...users.values()]);
  } catch (err) {
    console.error("Error fetching users:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Write endpoints ---

// Add conversation comment
app.post("/api/pr/:owner/:repo/:number/comments", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const token = getToken();
    const { data } = await ghFetch(
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      token,
      { method: "POST", body: JSON.stringify({ body: req.body.body }) }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Reply to a review comment
app.post(
  "/api/pr/:owner/:repo/:number/review-comments/:id/replies",
  async (req, res) => {
    try {
      const { owner, repo, number, id } = req.params;
      const token = getToken();
      const { data } = await ghFetch(
        `/repos/${owner}/${repo}/pulls/${number}/comments/${id}/replies`,
        token,
        { method: "POST", body: JSON.stringify({ body: req.body.body }) }
      );
      res.json(data);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// Resolve / unresolve a review thread (GraphQL)
app.put(
  "/api/pr/:owner/:repo/:number/threads/:nodeId/resolve",
  async (req, res) => {
    try {
      const token = getToken();
      const data = await ghGraphQL(
        `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`,
        { id: req.params.nodeId },
        token
      );
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.put(
  "/api/pr/:owner/:repo/:number/threads/:nodeId/unresolve",
  async (req, res) => {
    try {
      const token = getToken();
      const data = await ghGraphQL(
        `mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }`,
        { id: req.params.nodeId },
        token
      );
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Approve a PR — submits an APPROVE review on behalf of the current user.
// Optional body: { body: "review comment" }
app.post("/api/pr/:owner/:repo/:number/approve", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const token = getToken();
    const payload = { event: "APPROVE" };
    if (req.body && typeof req.body.body === "string" && req.body.body.trim()) {
      payload.body = req.body.body;
    }
    const { data } = await ghFetch(
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      token,
      { method: "POST", body: JSON.stringify(payload) }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Merge a PR. Body: { merge_method?: "merge" | "squash" | "rebase",
//                     commit_title?, commit_message? }
app.put("/api/pr/:owner/:repo/:number/merge", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const token = getToken();
    const payload = {};
    const allowedMethods = new Set(["merge", "squash", "rebase"]);
    if (req.body && allowedMethods.has(req.body.merge_method)) {
      payload.merge_method = req.body.merge_method;
    }
    if (req.body && typeof req.body.commit_title === "string") {
      payload.commit_title = req.body.commit_title;
    }
    if (req.body && typeof req.body.commit_message === "string") {
      payload.commit_message = req.body.commit_message;
    }
    const { data } = await ghFetch(
      `/repos/${owner}/${repo}/pulls/${number}/merge`,
      token,
      { method: "PUT", body: JSON.stringify(payload) }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Actions (GitHub Actions workflow runs + check runs) ---

// Fetch workflow runs + check runs for the PR's head commit
app.get("/api/pr/:owner/:repo/:number/actions", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const token = getToken();

    // Get the head SHA from the PR
    const { data: pr } = await ghFetch(
      `/repos/${owner}/${repo}/pulls/${number}`,
      token
    );
    const sha = pr.head && pr.head.sha;
    if (!sha) return res.json({ sha: null, workflowRuns: [], checkRuns: [] });

    const [wfRes, crRes] = await Promise.all([
      ghFetch(
        `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100`,
        token
      ).catch((e) => ({ data: { workflow_runs: [], error: e.message } })),
      ghFetch(
        `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
        token
      ).catch((e) => ({ data: { check_runs: [], error: e.message } })),
    ]);

    res.json({
      sha,
      workflowRuns: wfRes.data.workflow_runs || [],
      checkRuns: crRes.data.check_runs || [],
    });
  } catch (err) {
    console.error("Error fetching actions:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Fetch the jobs of a single workflow run (used to show per-job detail
// and enable per-job rerun for failed jobs).
app.get(
  "/api/repos/:owner/:repo/actions/runs/:runId/jobs",
  async (req, res) => {
    try {
      const { owner, repo, runId } = req.params;
      const token = getToken();
      const { data } = await ghFetch(
        `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
        token
      );
      res.json(data.jobs || []);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// Re-run an entire workflow run
app.post(
  "/api/repos/:owner/:repo/actions/runs/:runId/rerun",
  async (req, res) => {
    try {
      const { owner, repo, runId } = req.params;
      const token = getToken();
      await ghFetch(
        `/repos/${owner}/${repo}/actions/runs/${runId}/rerun`,
        token,
        { method: "POST" }
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// Re-run only the failed jobs of a workflow run
app.post(
  "/api/repos/:owner/:repo/actions/runs/:runId/rerun-failed",
  async (req, res) => {
    try {
      const { owner, repo, runId } = req.params;
      const token = getToken();
      await ghFetch(
        `/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`,
        token,
        { method: "POST" }
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// --- Start ---

app.listen(PORT, () => {
  console.log(`PR Reviewer running at http://localhost:${PORT}`);
  // Validate token at startup
  try {
    getToken();
    console.log("GitHub token OK");
  } catch (e) {
    console.error(e.message);
  }
});

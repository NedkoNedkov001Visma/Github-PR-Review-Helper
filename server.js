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

app.get("/api/pr/:owner/:repo/:number", async (req, res) => {
  try {
    const { owner, repo, number } = req.params;
    const token = getToken();
    const base = `/repos/${owner}/${repo}`;

    const [prRes, issueComments, reviews, reviewComments, files] =
      await Promise.all([
        ghFetch(`${base}/pulls/${number}`, token),
        ghFetchAll(`${base}/issues/${number}/comments`, token),
        ghFetchAll(`${base}/pulls/${number}/reviews`, token),
        ghFetchAll(`${base}/pulls/${number}/comments`, token),
        ghFetchAll(`${base}/pulls/${number}/files`, token),
      ]);

    res.json({
      pr: prRes.data,
      issueComments,
      reviews,
      reviewComments,
      files,
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
    const token = getToken();
    // Single page fetch — don't paginate the entire history
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

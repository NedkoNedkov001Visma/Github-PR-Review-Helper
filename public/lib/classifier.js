/**
 * classifier.js
 *
 * Classifies PR timeline items as "AI" or "human conversation".
 * Operates on structured GitHub API JSON, not the DOM.
 */

// ── Known AI bot logins ──────────────────────────────────────────────────────

const AI_BOTS = new Set([
  'claude',
  'copilot',
  'copilot-pull-request-reviewer',
  'copilot-swe-agent',
  'github-actions',
  'github-code-quality',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine whether a GitHub login belongs to a known AI bot.
 *
 * The function strips the common `[bot]` suffix and compares against the
 * AI_BOTS set in a case-insensitive manner.
 *
 * @param {string} login - GitHub username (e.g. "copilot[bot]").
 * @returns {boolean}
 */
export function isAIBot(login) {
  if (!login) return false;
  const normalised = login.replace(/\[bot\]$/i, '').toLowerCase();
  return AI_BOTS.has(normalised);
}

/**
 * Group an array of review comments into threads keyed by root comment id.
 *
 * Root comments are those whose `in_reply_to_id` is `null` / `undefined`.
 * Replies are attached to their root and sorted by `created_at` ascending.
 *
 * If `reviewThreads` (from the GraphQL `reviewThreads` connection) is
 * supplied, each grouped thread also gets:
 *   - `threadNodeId`  — the GraphQL ID needed for resolve/unresolve mutations
 *   - `isResolved`    — current resolved state from GitHub
 *   - `isOutdated`    — whether the thread targets stale code
 *
 * @param {Array} reviewComments - Raw review comments from the GitHub API.
 * @param {Array} [reviewThreads]
 * @returns {Map<number, { root: Object, replies: Object[], threadNodeId?: string, isResolved?: boolean, isOutdated?: boolean }>}
 */
export function groupReviewCommentThreads(reviewComments, reviewThreads) {
  /** @type {Map<number, { root: Object, replies: Object[] }>} */
  const threads = new Map();

  // First pass: identify root comments.
  for (const comment of reviewComments) {
    if (comment.in_reply_to_id == null) {
      threads.set(comment.id, { root: comment, replies: [] });
    }
  }

  // Second pass: attach replies.
  for (const comment of reviewComments) {
    if (comment.in_reply_to_id != null) {
      const thread = threads.get(comment.in_reply_to_id);
      if (thread) {
        thread.replies.push(comment);
      }
    }
  }

  // Sort replies by created_at ascending.
  for (const thread of threads.values()) {
    thread.replies.sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at),
    );
  }

  // Merge GraphQL thread metadata: match by any comment's databaseId.
  if (Array.isArray(reviewThreads) && reviewThreads.length) {
    for (const ghThread of reviewThreads) {
      // Find the REST root whose id appears in the thread's comment list
      let matched = null;
      for (const dbId of ghThread.commentDatabaseIds || []) {
        if (threads.has(dbId)) {
          matched = threads.get(dbId);
          break;
        }
      }
      if (!matched) continue;
      matched.threadNodeId = ghThread.id;
      matched.isResolved = !!ghThread.isResolved;
      matched.isOutdated = !!ghThread.isOutdated;
    }
  }

  return threads;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns true when every participant in a thread (root + replies) is an AI bot.
 *
 * @param {{ root: Object, replies: Object[] }} thread
 * @returns {boolean}
 */
function isThreadAIOnly(thread) {
  if (!isAIBot(thread.root.user?.login)) return false;
  return thread.replies.every((reply) => isAIBot(reply.user?.login));
}

// ── Main classification ──────────────────────────────────────────────────────

/**
 * Classify a merged timeline into human conversation items and AI comment items.
 *
 * @param {Array<{ type: string, data: Object, timestamp: string }>} timeline
 *        Output of `buildTimeline` from timeline.js.
 * @param {Array} reviewComments
 *        Raw review comments from the GitHub API (used for thread grouping).
 * @returns {{ conversation: Array, aiComments: Array }}
 */
export function classifyTimeline(timeline, reviewComments, reviewThreads) {
  const conversation = [];
  const aiComments = [];

  // Pre-group all review comment threads once.
  const allThreads = groupReviewCommentThreads(reviewComments, reviewThreads);

  for (const entry of timeline) {
    // ── Issue comments ──────────────────────────────────────────────────
    if (entry.type === 'issue_comment') {
      if (isAIBot(entry.data.user?.login)) {
        aiComments.push(entry);
      } else {
        conversation.push(entry);
      }
      continue;
    }

    // ── Reviews ─────────────────────────────────────────────────────────
    if (entry.type === 'review') {
      const review = entry.data;
      const reviewAuthorIsAI = isAIBot(review.user?.login);

      // Collect threads that belong to this review.
      const reviewThreads = [];
      for (const [, thread] of allThreads) {
        if (thread.root.pull_request_review_id === review.id) {
          reviewThreads.push(thread);
        }
      }

      const hasBody = review.body && review.body.trim();

      // --- No threads: classify by review author alone -----------------
      if (reviewThreads.length === 0) {
        if (reviewAuthorIsAI) {
          aiComments.push(entry);
        } else if (hasBody || review.state !== 'COMMENTED') {
          // Only show non-AI reviews that have a body or a meaningful state
          conversation.push(entry);
        }
        // else: empty human "COMMENTED" review with no threads — skip
        continue;
      }

      // --- Partition threads into AI-only vs human ---------------------
      const aiOnlyThreads = [];
      const humanThreads = [];

      for (const thread of reviewThreads) {
        if (isThreadAIOnly(thread)) {
          aiOnlyThreads.push(thread);
        } else {
          humanThreads.push(thread);
        }
      }

      const allThreadsAIOnly = humanThreads.length === 0;
      const allThreadsHaveHumans = aiOnlyThreads.length === 0;

      // --- All threads AI-only AND review author is AI → full AI -------
      if (allThreadsAIOnly && reviewAuthorIsAI) {
        aiComments.push({ ...entry, threads: reviewThreads });
        continue;
      }

      // --- All threads have human replies → full Conversation ----------
      if (allThreadsHaveHumans) {
        conversation.push({ ...entry, threads: reviewThreads });
        continue;
      }

      // --- All threads AI-only but review author is human -------------
      // Move all threads to AI tab. Only keep the review shell in
      // Conversation if it has a body or a meaningful state.
      if (allThreadsAIOnly) {
        if (hasBody || review.state !== 'COMMENTED') {
          conversation.push({ ...entry, threads: [] });
        }
        for (const thread of aiOnlyThreads) {
          aiComments.push({
            type: 'review_thread',
            data: thread,
            timestamp: thread.root.created_at,
            reviewMeta: { id: review.id, state: review.state, user: review.user },
          });
        }
        continue;
      }

      // --- Mixed: some AI-only, some human ----------------------------
      // Review header + human threads go to Conversation.
      conversation.push({ ...entry, threads: humanThreads });

      // AI-only threads become separate AI entries.
      for (const thread of aiOnlyThreads) {
        aiComments.push({
          type: 'review_thread',
          data: thread,
          timestamp: thread.root.created_at,
          reviewMeta: {
            id: review.id,
            state: review.state,
            user: review.user,
          },
        });
      }
      continue;
    }
  }

  return { conversation, aiComments };
}

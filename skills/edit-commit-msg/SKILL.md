---
name: edit-commit-msg
description: Write or improve Git's pending commit message by editing only COMMIT_EDITMSG. Use when asked to edit, rewrite, fix, improve, or craft a commit message without creating, amending, or advancing a commit or rebase.
---

# Edit Commit Message

Write the best supported message with the least necessary inspection. Change only Git's pending message file; never change history, workflow state, the index, or the worktree.

## 1. Fix the boundary

Resolve the file instead of assuming `.git` is a directory:

```bash
git rev-parse --git-path COMMIT_EDITMSG
```

The resolved `COMMIT_EDITMSG` must already exist. It is the only writable target. If it does not exist, stop; do not create a commit or start an amend or rebase to produce it.

All investigation must be read-only. Never run a command that creates, rewrites, or advances Git state, including `commit`, `commit --amend`, `rebase --continue`, `cherry-pick --continue`, `merge --continue`, `add`, `reset`, `restore`, `checkout`, or `switch`. Do not directly inspect or edit rebase, sequencer, ref, index, lock, hook, or configuration files.

## 2. Recover intent economically

Start with the cheapest evidence:

1. the user's requested meaning;
2. the existing `COMMIT_EDITMSG`;
3. repository commit guidance, if present;
4. current status and nearby commit subjects;
5. a summary of the change being described.

Choose the change source rather than assuming it:

- for a pending commit with staged changes, inspect `git diff --cached`;
- for rewording or editing an existing commit, inspect `git show HEAD`;
- when the operation is unclear, compare their summaries with the existing message and user request.

Read a stat or summary before a full diff. Expand only the source or files needed to establish what changed and why. Stop when the message's claims are supported; exhaustive reading is not a goal.

If the evidence points to different commits or cannot establish intent, report the ambiguity instead of inventing a coherent story.

## 3. Write for future readers

Follow, in order: explicit user requirements, repository rules, then nearby history. Conventional Commits, scopes, issue references, capitalization, punctuation, and line limits are conventions, not universal laws.

A strong message has:

- a specific subject naming this commit's outcome;
- an imperative form when local history offers no stronger pattern;
- a body only when motivation, constraints, consequences, or non-obvious context matter;
- facts supported by the inspected change;
- required trailers preserved exactly.

Prefer a scannable subject, often near 50 characters when practical, and body lines near 72 characters when useful in terminals. Explain what and why; omit a line-by-line account of how.

Apply lossless pressure. Remove words that add no meaning, merge only claims with the same scope, and replace indirect phrasing with concrete actors and actions. Do not shorten away behavior, motivation, compatibility impact, uncertainty, or required terminology.

## 4. Check both directions

Before writing, verify:

- every material change that the message claims exists in the evidence;
- every change important to understanding this commit appears in the message;
- the subject describes this commit, not the whole branch or task;
- the body adds rationale or consequence instead of repeating the subject or diff;
- certainty, causality, and scope are no stronger than the evidence;
- no editor instructions, process notes, or speculative claims remain.

A polished falsehood is worse than an incomplete draft. If compression exposes a contradiction or missing rationale, surface it; do not silently repair the commit's story.

## 5. Write once, then verify

Replace only the resolved `COMMIT_EDITMSG` with the final message, preferably ending with a newline. Exclude Git's editor guidance unless the user explicitly asks to preserve it.

Read the file back in full and compare it with the intended text. Do not run the Git operation afterward.

Report the final subject and that only the pending message file was edited. Never claim the commit was created, amended, rebased, or completed.

## When not to use

Do not use this skill to create a commit, amend history, squash commits, continue a rebase, or execute any other Git workflow step. It only prepares the message file for a separate process.

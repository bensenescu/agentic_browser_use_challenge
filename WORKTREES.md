# Worktree Cheatsheet (Reusable Slots)

## One-time setup

```bash
git worktree add ../browseruse-wt-main main
git worktree add ../browseruse-wt-1 -b slot-1 main
git worktree add ../browseruse-wt-2 -b slot-2 main
git worktree add ../browseruse-wt-3 -b slot-3 main
git worktree add ../browseruse-wt-4 -b slot-4 main
git worktree add ../browseruse-wt-5 -b slot-5 main
```

## Start new work in a slot (reuse folder, new branch)

```bash
cd ../browseruse-wt-1
git status
git switch main
git pull --ff-only
git switch -c feat/my-change
```

## Work + test

```bash
bun run agent -- --step 5
```

## Merge into main (do this only in browseruse-wt-main)

```bash
cd ../browseruse-wt-main
git pull --ff-only
git merge feat/my-change
```

## Refresh other active slots after merge

```bash
cd ../browseruse-wt-2
git merge main
```

## Recycle a slot after merge

```bash
cd ../browseruse-wt-1
git switch main
git pull --ff-only
git branch -d feat/my-change
```

## Hard reset a slot (if it is messy)

```bash
git worktree remove ../browseruse-wt-1
git worktree add ../browseruse-wt-1 main
```

## Optional conflict helper

```bash
git config rerere.enabled true
```

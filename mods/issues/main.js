// Your GitHub issues in a popup, in the look of the Linear mod: the ones
// assigned to you, the open issues of the shown space's repo, and the ones
// you filed. Open one for its state, labels, linked pull requests, body and
// comments. Close it or reopen it, assign it to you, one key to a worktree
// for it in a space of its own, or start it: yours, a worktree, and an agent
// in it told to work on it. File a new issue without leaving the window.
//
// The work is the GitHub CLI's: `gh` on this computer, signed in with
// `gh auth login`. Worktrees are made with git, on the machine of the space
// that has the repo's checkout.

import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { agents, panes, spaces, run, exec, theme, appHome, props, closeOverlay, openOverlay, nextCommand, knownAgents, readTextFile, checking } from "herdr";
import { tones, tint, countPill, issueLook, hue, icon, chip, words, key, ago, MONO } from "./look.js";

// ── gh ───────────────────────────────────────────────────────────────────

class GhError extends Error {
  constructor(message, signedOut = false) {
    super(message);
    this.signedOut = signedOut;
  }
}

// One gh command on this computer. If gh is not on the app's PATH (a shell
// profile adds it), the login shell runs it.
async function gh(args, timeout = 30000) {
  let r;
  try {
    r = await exec("gh", args, { timeout });
  } catch {
    r = await exec("sh", ["-lc", 'exec gh "$@"', "gh", ...args], { timeout });
  }
  if (r.code !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    const signedOut = /gh auth login|not logged in|authentication required|HTTP 401/i.test(err);
    throw new GhError(err.split("\n").filter(Boolean).pop() || `gh: exit ${r.code}`, signedOut);
  }
  return r.stdout ?? "";
}

const ghJson = async (args, timeout) => JSON.parse((await gh(args, timeout)).trim() || "null");

// The fields a list asks for; a repo's list adds the milestone, a search
// the repository.
const FIELDS = "number,title,labels,assignees,author,updatedAt,url,state";
const DETAIL = `${FIELDS},body,stateReason,milestone,comments,createdAt,closedByPullRequestsReferences`;

// ── issues ───────────────────────────────────────────────────────────────

// gh's issue (from a list, a search or a view) as the mod keeps it.
function norm(x, repo, me) {
  const r = repo ?? x.repository?.nameWithOwner ?? repoOfUrl(x.url) ?? "";
  const assignees = (x.assignees ?? []).map((a) => a.login);
  return {
    id: `${r.toLowerCase()}#${x.number}`,
    repo: r,
    number: x.number,
    title: x.title ?? "",
    url: x.url,
    open: String(x.state).toLowerCase() === "open",
    reason: x.stateReason || null,
    labels: (x.labels ?? []).map((l) => ({ name: l.name, color: l.color ? `#${l.color}` : null })),
    assignees,
    mine: Boolean(me) && assignees.includes(me),
    author: x.author?.login ?? "",
    updated: Date.parse(x.updatedAt ?? "") || 0,
    milestone: x.milestone?.title ?? null,
  };
}

const repoOfUrl = (url) => /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+/.exec(url ?? "")?.[1] ?? null;

// The branch for an issue, as `gh issue develop` names one: its number and
// its title in a few words.
function branchOf(is) {
  let words = (is.title ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // At most 40 characters, cut between words.
  if (words.length > 40) words = words.slice(0, 41).replace(/-[^-]*$/, "");
  return words ? `${is.number}-${words}` : `issue-${is.number}`;
}

// A folder name for a branch, as the worktree mod makes one.
const slug = (branch) => branch.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "issue";

// A GitHub remote's repo: git@host:owner/name, https://host/owner/name, ssh://.
function parseRemote(url) {
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m && /github/i.test(m[1]) ? `${m[2]}/${m[3]}` : null;
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout ? { timeout } : {}) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);

const TABS = [
  { id: "repo", label: "This repo", short: "Repo", icon: "project" },
  { id: "mine", label: "Assigned to me", short: "Mine", icon: "person" },
  { id: "created", label: "Created by me", short: "Created", icon: "calendar" },
];

// An issue typed in the filter: 12, #12, owner/repo#12 or its URL. Looked
// up on GitHub, not only in the list.
const ISSUE_REF = /^(?:https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)\S*|(?:([\w.-]+\/[\w.-]+))?#?(\d{1,7}))$/i;
function parseRef(q, repo) {
  const m = ISSUE_REF.exec(q.trim());
  if (!m) return null;
  const r = m[1] ?? m[3] ?? repo;
  return r ? { repo: r, number: Number(m[2] ?? m[4]) } : null;
}

// Where the lists are kept between openings.
const CACHE = `${appHome()}/issues-cache.json`;

const HEADING_H = 30;
const ROW_H = 36;
const LIST_H = 560;

// The order of a repo's groups: yours first, then the ones nobody has.
const REPO_GROUPS = ["Assigned to you", "Unassigned", "Assigned to others"];

export default class Issues extends View {
  init(_props, cx) {
    const p = props() ?? {};
    // Where esc goes back to, when another mod opened it on an issue.
    this.backTo = p.backTo ?? null;
    // With Herdr's github mod installed, an issue's pull requests open there.
    this.github = false;
    this.screen = "list";
    this.tab = localStorage.getItem("tab") ?? "repo";
    this.lists = {};
    this.found = null; // { query, issues } for an issue typed in the filter
    this.filter = "";
    this.at = 0;
    this.cur = null;
    this.detail = null;
    this.menu = null;
    this.flash = this.err = this.busy = "";
    this.me = localStorage.getItem("me") ?? "";
    this.repo = null; // the shown space's GitHub repo, "owner/name"
    this.checkouts = {}; // repo (lower case) → { main, machine }
    this.trees = JSON.parse(localStorage.getItem("trees") ?? "{}"); // issue id → { path, machine, branch }
    this.width = 900;

    this.keys = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Type to filter, or an issue's number or URL…  ← → to change tabs" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.lookUp(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.on("blur", (_e, cx) => {
      cx.timer.after(40, () => {
        if (this.screen === "list" && !this.signedOut && !this.closing) this.input.focus();
      });
    });
    this.title = InputState.new({ placeholder: "Title" });
    this.title.on("focus", () => (this.formField = "title"));
    this.title.on("submit", (_e, cx) => this.submit(cx));
    this.body = InputState.new({ placeholder: "Description (Markdown), optional" });
    this.body.on("focus", () => (this.formField = "body"));
    this.body.on("submit", (_e, cx) => this.submit(cx));
    this.input.focus();
    cx.timer.after(400, () => this.screen === "list" && this.input.focus());

    if (checking()) return;

    cx.spawn(async (cx) => {
      this.github = (await fs.readFile(`${appHome()}/mods/github/main.js`, "utf8").catch(() => null)) !== null;
      await this.readCache(cx);
      await this.start(cx);
      if (p.issue) await this.openByRef(p.issue, cx);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => this.screen === "list" && !this.busy && !this.signedOut && this.loadAll(cx));

    // Key bindings and `herdr-app do`: issues.escape, issues.tab,
    // issues.backtab, issues.next, issues.prev, issues.reload.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "escape") this.escape(cx);
        else if ((c === "tab" || c === "backtab") && this.screen === "create") {
          const next = this.formField === "title" ? this.body : this.title;
          cx.timer.after(0, () => next.focus());
        } else if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1, cx);
        else if (c === "reload") this.reload(cx);
        cx.notify();
      }
    });
  }

  // ── starting ───────────────────────────────────────────────────────────

  async start(cx) {
    this.err = "";
    this.signedOut = false;
    try {
      const login = (await gh(["api", "user", "--jq", ".login"])).trim();
      if (login !== this.me) {
        this.me = login;
        localStorage.setItem("me", login);
      }
    } catch (e) {
      this.signedOut = Boolean(e?.signedOut);
      this.err = this.signedOut ? "" : String(e?.message ?? e);
      if (this.signedOut) this.keys.focus();
      return cx.notify();
    }
    await this.findRepo();
    this.seed();
    this.loadAll(cx);
    // The checkouts of every repo with a space, for worktrees of issues
    // from other repos. In the background: it asks git once per space.
    cx.spawn(async (cx) => {
      await this.findCheckouts();
      cx.notify();
    });
  }

  // The repo of a folder: its GitHub remote, and its main checkout.
  async repoAt(folder, machine) {
    if (!folder) return null;
    const remote = await git(folder, ["remote", "get-url", "origin"], machine).catch(() => null);
    const repo = remote?.ok ? parseRemote(remote.out) : null;
    if (!repo) return null;
    const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], machine);
    if (!common.ok) return null;
    const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
    const k = repo.toLowerCase();
    if (!this.checkouts[k]) this.checkouts[k] = { main, machine: machine ?? null };
    return repo;
  }

  async findRepo() {
    const s = spaces().find((s) => s.active);
    this.repo = s ? await this.repoAt(place(s), s.machine ?? null).catch(() => null) : null;
  }

  async findCheckouts() {
    for (const s of spaces()) await this.repoAt(place(s), s.machine ?? null).catch(() => null);
  }

  // Signs in in a space of its own, on this computer, where the browser is.
  signIn() {
    this.dismiss();
    run("space.new", { name: "GitHub sign-in", argv: ["gh", "auth", "login", "--web"] });
  }

  // ── lists ──────────────────────────────────────────────────────────────

  listKey(tab = this.tab) {
    return tab === "repo" ? `repo:${(this.repo ?? "").toLowerCase()}` : tab;
  }

  loadAll(cx) {
    for (const t of TABS) this.load(t.id, cx);
  }

  async readCache(cx) {
    try {
      this.cache = JSON.parse((await fs.readFile(CACHE, "utf8").catch(() => null)) ?? "{}");
    } catch {
      this.cache = {};
    }
    this.seed();
    cx.notify();
  }

  // The lists as they were last time, shown at once while fresh ones load.
  seed() {
    const kept = this.cache?.lists ?? {};
    for (const t of TABS) {
      const k = this.listKey(t.id);
      const l = this.lists[k];
      if (kept[k] && !(l?.loaded && !l.cached)) this.lists[k] = { ...l, items: kept[k], loaded: true, cached: true, loading: l?.loading };
    }
  }

  keep(k, items) {
    const c = (this.cache ??= {});
    (c.lists ??= {})[k] = items;
    // The tabs load at the same time: one write at a time.
    this.saving = (this.saving ?? Promise.resolve()).then(() => fs.writeFile(CACHE, JSON.stringify(this.cache)).catch(() => {}));
  }

  async fetchList(tab) {
    const me = this.me;
    if (tab === "repo") {
      if (!this.repo) throw new Error("The shown space isn't a checkout of a GitHub repo.");
      const xs = await ghJson(["issue", "list", "--repo", this.repo, "--state", "open", "--limit", "200", "--json", `${FIELDS},milestone`]);
      const items = xs.map((x) => norm(x, this.repo, me));
      for (const is of items) is.group = is.mine ? REPO_GROUPS[0] : is.assignees.length ? REPO_GROUPS[2] : REPO_GROUPS[1];
      return items.sort((a, b) => REPO_GROUPS.indexOf(a.group) - REPO_GROUPS.indexOf(b.group) || b.updated - a.updated);
    }
    const who = tab === "mine" ? ["--assignee", "@me", "--state", "open", "--limit", "100"] : ["--author", "@me", "--limit", "60"];
    const xs = await ghJson(["search", "issues", ...who, "--sort", "updated", "--json", `${FIELDS},repository`]);
    const items = xs.map((x) => norm(x, null, me));
    if (tab === "mine") {
      // Grouped by repo: the shown one first.
      const here = (this.repo ?? "").toLowerCase();
      for (const is of items) is.group = is.repo;
      return items.sort((a, b) => (b.repo.toLowerCase() === here) - (a.repo.toLowerCase() === here) || a.repo.localeCompare(b.repo) || b.updated - a.updated);
    }
    for (const is of items) is.group = is.open ? "Open" : "Closed";
    return items.sort((a, b) => b.open - a.open || b.updated - a.updated);
  }

  load(tab, cx) {
    const k = this.listKey(tab);
    const l = (this.lists[k] ??= { items: [], loaded: false });
    if (l.loading) return;
    l.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        l.items = await this.fetchList(tab);
        l.error = "";
        l.cached = false;
        this.keep(k, l.items);
      } catch (e) {
        if (e?.signedOut) this.signedOut = true;
        l.error = String(e?.message ?? e);
      }
      l.loading = false;
      l.loaded = true;
      cx.notify();
    });
  }

  reload(cx) {
    if (this.screen === "issue") return this.loadDetail(cx);
    this.loadAll(cx);
  }

  // An issue typed in the filter: looked up shortly after you stop typing.
  lookUp(cx) {
    const q = this.filter.trim();
    const ref = parseRef(q, this.repo);
    if (!ref) {
      this.found = null;
      return;
    }
    cx.timer.after(300, (cx) => {
      if (this.filter.trim() !== q) return;
      cx.spawn(async (cx) => {
        try {
          const x = await ghJson(["issue", "view", String(ref.number), "--repo", ref.repo, "--json", FIELDS]);
          if (this.filter.trim() === q) this.found = { query: q, issues: [norm(x, ref.repo, this.me)] };
        } catch {
          if (this.filter.trim() === q) this.found = { query: q, issues: [] };
        }
        cx.notify();
      });
    });
  }

  step(d, cx) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.tab = TABS[(i + d + TABS.length) % TABS.length].id;
    localStorage.setItem("tab", this.tab);
    this.at = 0;
    this.lookUp(cx);
    cx.notify();
  }

  matches(is) {
    const hay = [`#${is.number}`, is.title, is.repo, is.author, is.milestone, ...is.assignees, ...is.labels.map((l) => l.name), is.open ? "open" : "closed"]
      .filter(Boolean).join(" ").toLowerCase();
    return this.filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  // The rows shown, each with the heading it goes under, each group's
  // together (the virtual list throws on a repeated heading key).
  shownRows() {
    const l = this.lists[this.listKey()];
    const ref = this.found && parseRef(this.filter, this.repo);
    const rows = (l?.items ?? []).filter((is) => this.matches(is) || (ref && is.number === ref.number && is.repo.toLowerCase() === ref.repo.toLowerCase()))
      .map((is) => ({ issue: is, group: is.group ?? "" }));
    if (ref) {
      const listed = new Set(rows.map((r) => r.issue.id));
      for (const is of this.found.issues) if (!listed.has(is.id)) rows.push({ issue: is, group: "Not in this list" });
    }
    const order = [];
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.group)) (by.set(r.group, []), order.push(r.group));
      by.get(r.group).push(r);
    }
    return order.flatMap((g) => by.get(g));
  }

  enter(cx) {
    const r = this.shown?.[this.at];
    if (r?.issue) this.openIssue(r.issue, cx);
  }

  // ── an issue ───────────────────────────────────────────────────────────

  focusKeys(cx) {
    cx.timer.after(30, () => this.keys.focus());
  }

  openIssue(is, cx, direct = false) {
    this.screen = "issue";
    this.cur = is;
    this.detail = null;
    this.menu = null;
    this.err = this.flash = "";
    this.direct = direct;
    this.loadDetail(cx);
    this.focusKeys(cx);
    cx.notify();
  }

  // From another mod: { repo, number }.
  async openByRef(ref, cx) {
    try {
      const x = await ghJson(["issue", "view", String(ref.number), "--repo", ref.repo, "--json", FIELDS]);
      this.openIssue(norm(x, ref.repo, this.me), cx, true);
    } catch (e) {
      this.say(String(e?.message ?? e), cx, true);
    }
  }

  loadDetail(cx) {
    const is = this.cur;
    cx.spawn(async (cx) => {
      try {
        const x = await ghJson(["issue", "view", String(is.number), "--repo", is.repo, "--json", DETAIL]);
        if (this.cur?.id !== is.id) return;
        const fresh = { ...norm(x, is.repo, this.me), group: is.group };
        this.detail = {
          body: x.body ?? "",
          created: Date.parse(x.createdAt ?? "") || 0,
          comments: (x.comments ?? []).map((c) => ({ author: c.author?.login ?? "", body: c.body ?? "", at: Date.parse(c.createdAt ?? "") || 0 })),
          prs: (x.closedByPullRequestsReferences ?? []).map((p) => ({ number: p.number, url: p.url, repo: repoOfUrl(p.url) ?? is.repo, title: p.title ?? "" })),
        };
        this.cur = fresh;
        this.replaceRow(fresh);
      } catch (e) {
        if (this.cur?.id === is.id) this.err = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  replaceRow(is) {
    for (const l of Object.values(this.lists)) {
      const i = l?.items.findIndex((x) => x.id === is.id) ?? -1;
      if (i >= 0) l.items[i] = { ...is, group: l.items[i].group };
    }
  }

  // The markdown under an issue: its body, then each comment under a line
  // with who wrote it and when.
  bodyText() {
    const d = this.detail;
    const parts = [d.body.trim() || "*No description.*"];
    for (const c of d.comments) parts.push(`---\n\n**${c.author}** · ${ago(c.at)}\n\n${c.body.trim()}`);
    return parts.join("\n\n");
  }

  // ── leaving ────────────────────────────────────────────────────────────

  back(cx) {
    if (this.direct && this.backTo) {
      this.dismiss();
      return openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} });
    }
    this.direct = false;
    const id = this.cur?.id;
    this.screen = "list";
    this.menu = null;
    this.err = this.flash = "";
    const i = this.shownRows().findIndex((r) => r.issue.id === id);
    if (i >= 0) this.at = i;
    cx.timer.after(30, () => this.input.focus());
    cx.notify();
  }

  escape(cx) {
    if (this.menu) {
      this.menu = null;
      return cx.notify();
    }
    if (this.screen !== "list") return this.back(cx);
    this.dismiss();
  }

  dismiss() {
    this.closing = true;
    closeOverlay(props().overlay);
  }

  open(url, cx) {
    if (url) cx.open_url(url);
  }

  copy(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.say(`Copied ${text}`, cx);
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  // ── changing it ────────────────────────────────────────────────────────

  // Runs a change, says what it did, and loads the issue and lists again.
  change(label, args, done, cx) {
    this.busy = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await gh(args);
        this.say(done, cx);
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
      this.busy = "";
      if (this.screen === "issue") this.loadDetail(cx);
      this.loadAll(cx);
    });
  }

  // The menu of changes: close or reopen, and assign or unassign you.
  changeMenu(cx) {
    const is = this.cur;
    if (!is) return;
    const ref = ["--repo", is.repo];
    const n = String(is.number);
    const items = [];
    if (is.open) {
      items.push({ label: "Close as completed", icon: "issue-done", color: "merged", run: (cx) => this.change(`Closing #${n}…`, ["issue", "close", n, ...ref, "--reason", "completed"], `Closed #${n}.`, cx) });
      items.push({ label: "Close as not planned", icon: "issue-skip", color: "dim", run: (cx) => this.change(`Closing #${n}…`, ["issue", "close", n, ...ref, "--reason", "not planned"], `Closed #${n} as not planned.`, cx) });
    } else {
      items.push({ label: "Reopen", icon: "issue-open", color: "review", run: (cx) => this.change(`Reopening #${n}…`, ["issue", "reopen", n, ...ref], `Reopened #${n}.`, cx) });
    }
    if (is.mine) items.push({ label: "Unassign me", icon: "person", run: (cx) => this.change(`Unassigning you from #${n}…`, ["issue", "edit", n, ...ref, "--remove-assignee", "@me"], `You're off #${n}.`, cx) });
    else items.push({ label: "Assign to me", icon: "person", run: (cx) => this.change(`Assigning #${n} to you…`, ["issue", "edit", n, ...ref, "--add-assignee", "@me"], `#${n} is yours.`, cx) });
    this.menu = { title: `${is.repo}#${n}`, items, at: 0 };
    cx.notify();
  }

  // An issue's pull request: on its screen in the GitHub mod, esc there
  // coming back to this issue; else in the browser. With several, which.
  openPR(pr, cx) {
    if (!pr) {
      const prs = this.detail?.prs ?? [];
      if (!prs.length) return this.say("No pull request is linked to it.", cx);
      if (prs.length > 1) {
        this.menu = { title: `#${this.cur.number}'s pull requests`, items: prs.map((p) => ({ label: `#${p.number} ${p.title}`, icon: "pr", run: (cx) => this.openPR(p, cx) })), at: 0 };
        return cx.notify();
      }
      pr = prs[0];
    }
    if (!this.github) return this.open(pr.url, cx);
    const is = this.cur;
    this.dismiss();
    openOverlay({ mod: "github", kind: "dialog", width: 0.8, height: 0.8, props: {
      pr: { host: "github.com", repo: pr.repo, number: pr.number },
      backTo: { mod: "issues", label: `#${is.number}`, props: { issue: { repo: is.repo, number: is.number }, backTo: this.backTo ?? undefined } },
    } });
  }

  // ── worktrees ──────────────────────────────────────────────────────────

  spaceAt(path, machine) {
    const inside = (p) => p === path || p?.startsWith(path + "/");
    return spaces().find((s) => (s.machine ?? null) === (machine ?? null) && inside(place(s)));
  }

  treeOf(is) {
    return this.trees[is.id] ?? null;
  }

  // The folder worktrees go in, on the machine (settings.json's
  // worktrees.directory, as the worktree mod reads it).
  async worktreeRoot(machine) {
    const raw = await readTextFile(`${appHome()}/settings.json`).catch(() => null);
    let dir = "~/.herdr/worktrees";
    try {
      dir = JSON.parse(raw ?? "{}")?.worktrees?.directory ?? dir;
    } catch {}
    if (dir === "~" || dir.startsWith("~/")) {
      const h = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
      dir = h.stdout.replace(/\/$/, "") + dir.slice(1);
    }
    return dir.replace(/\/+$/, "");
  }

  // Opens the worktree for an issue, made if there's none, from the
  // checkout of its repo that a space has. start: the issue must be open and
  // not someone else's; it's made yours, and an agent is started in a new
  // worktree, told to work on it.
  worktree(cx, start, is = this.cur) {
    if (!is) return;
    this.menu = null;
    this.busy = start ? `Starting #${is.number}…` : `Opening #${is.number}'s worktree…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const step = (label, p, ms = 45000) => {
          this.busy = label;
          cx.notify();
          return Promise.race([p, new Promise((_, no) => cx.timer.after(ms, () => no(new Error(`${label.replace(/…$/, "")} took too long`))))]);
        };
        if (start && !is.open) throw new Error(`#${is.number} is closed. Reopen it first (c), or press w for its worktree.`);
        if (start && is.assignees.length && !is.mine) throw new Error(`#${is.number} is assigned to ${is.assignees.join(", ")}. Press w for its worktree without starting it.`);
        if (!this.checkouts[is.repo.toLowerCase()]) await step("Looking for its repo's checkout…", this.findCheckouts());
        const co = this.checkouts[is.repo.toLowerCase()];
        if (!co) throw new Error(`No space has a checkout of ${is.repo}. Open one, then try again.`);
        const { main, machine } = co;
        const known = this.treeOf(is);
        const branch = known?.branch ?? branchOf(is);

        // A worktree that has the branch already, else a new one.
        const list = await git(main, ["worktree", "list", "--porcelain"], machine);
        let path = null;
        for (const block of list.out.split(/\n\n+/)) {
          const lines = block.split("\n");
          if (lines.includes(`branch refs/heads/${branch}`)) path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? null;
        }
        let created = false;
        if (!path) {
          await step("Fetching from GitHub…", git(main, ["fetch", "origin", "--quiet"], machine, 120000), 125000).catch(() => {});
          const root = await this.worktreeRoot(machine);
          path = `${root}/${main.split("/").pop()}/${slug(branch)}`;
          const has = async (ref) => (await git(main, ["rev-parse", "--verify", "--quiet", ref], machine)).ok;
          const add = (await has(`refs/heads/${branch}`)) ? ["worktree", "add", path, branch]
            : (await has(`refs/remotes/origin/${branch}`)) ? ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]
            : (await has("refs/remotes/origin/HEAD")) ? ["worktree", "add", "--no-track", "-b", branch, path, "origin/HEAD"]
            : ["worktree", "add", "-b", branch, path, "HEAD"];
          const r = await step(`Making its worktree on ${machine ?? "this computer"}…`, git(main, add, machine, 600000), 600000);
          if (!r.ok) throw new Error(r.err.split("\n").pop() || "git worktree add failed.");
          created = true;
        }
        this.trees[is.id] = { path, machine, branch };
        localStorage.setItem("trees", JSON.stringify(this.trees));

        let note = "";
        if (start && !is.mine) {
          try {
            await step(`Assigning #${is.number} to you…`, gh(["issue", "edit", String(is.number), "--repo", is.repo, "--add-assignee", "@me"]));
            note = `#${is.number} is yours`;
            this.loadAll(cx);
          } catch (e) {
            this.busy = "";
            return this.say(`The worktree is ready, but #${is.number} wasn't assigned to you: ${e?.message ?? e}`, cx, true);
          }
        }
        this.busy = "";
        const s = this.spaceAt(path, machine);
        if (s) {
          run("space.select", { id: s.id });
          if (start) return this.say(`${note ? note + ". " : ""}Its worktree already had a space, so no prompt was sent: its agent may be busy.`, cx);
          return this.dismiss();
        }
        // Unnamed, so the space follows its folder and nests under the repo.
        const spec = { folder: path };
        if (machine) spec.machine = machine;
        if (start) {
          const agentsKnown = await step("Finding the agent to start…", knownAgents({ on: machine })).catch(() => []);
          const agent = agentsKnown.find((a) => a.installed && a.key === "claude") ?? agentsKnown.find((a) => a.installed);
          if (agent) {
            spec.argv = agent.run;
            if (created || !known) spec.task = this.prompt(is, branch);
          }
        }
        this.busy = "Opening its space…";
        cx.notify();
        run("space.new", spec);
        this.busy = "";
        this.dismiss();
      } catch (e) {
        this.busy = "";
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  // The agent's first message.
  prompt(is, branch) {
    return [
      `Work on GitHub issue ${is.repo}#${is.number}: ${is.title}`,
      is.url,
      "",
      `Read it first, with its comments: gh issue view ${is.number} --repo ${is.repo} --comments`,
      `You are in a git worktree on the branch ${branch}. Do what the issue asks, test-first where it makes sense.`,
      `When it is done, commit with "Closes #${is.number}" in the message, and tell me what you changed.`,
    ].join("\n");
  }

  // The agents working on an issue: those in a pane on its branch.
  agentsOf(is) {
    if (!is) return [];
    const branch = this.treeOf(is)?.branch ?? branchOf(is);
    const ps = new Map(panes().map((p) => [p.pane, p]));
    return agents().filter((a) => ps.get(a.pane)?.branch === branch)
      .map((a) => ({ name: a.title || a.tab_name, status: a.status, machine: machineOf(a.address), address: a.address }));
  }

  // ── a new issue ────────────────────────────────────────────────────────

  // The form: title, description, labels, and whether it's yours. The repo
  // is the open issue's, else the shown space's.
  create(cx) {
    const repo = this.screen === "issue" ? this.cur?.repo : this.repo;
    if (!repo) return this.say("The shown space isn't a checkout of a GitHub repo, so there's no repo to file it in.", cx, true);
    this.form = { repo, labels: null, picked: new Set(), assignToMe: false };
    this.screen = "create";
    this.menu = null;
    this.err = this.flash = "";
    this.title.set_value("");
    this.body.set_value("");
    cx.spawn(async (cx) => {
      try {
        const ls = await ghJson(["label", "list", "--repo", repo, "--limit", "100", "--json", "name,color"]);
        if (this.form?.repo === repo) this.form.labels = ls.map((l) => ({ name: l.name, color: `#${l.color}` }));
      } catch {
        if (this.form?.repo === repo) this.form.labels = [];
      }
      cx.notify();
    });
    cx.timer.after(30, () => this.title.focus());
    cx.notify();
  }

  submit(cx) {
    const f = this.form;
    if (!f || this.busy) return;
    const title = this.title.value().trim();
    if (!title) return this.say("Give it a title first.", cx, true);
    this.busy = `Filing ${title}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["issue", "create", "--repo", f.repo, "--title", title, "--body", this.body.value()];
        for (const l of f.picked) args.push("--label", l);
        if (f.assignToMe) args.push("--assignee", "@me");
        const url = (await gh(args)).trim().split("\n").pop();
        const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
        this.busy = "";
        this.loadAll(cx);
        if (!number) return this.back(cx);
        const x = await ghJson(["issue", "view", String(number), "--repo", f.repo, "--json", FIELDS]);
        this.openIssue(norm(x, f.repo, this.me), cx);
        this.say(`Filed #${number} in ${f.repo}.`, cx);
      } catch (e) {
        this.busy = "";
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  // ── keys ───────────────────────────────────────────────────────────────

  menuKey(k, cx) {
    const m = this.menu;
    const n = m.items.length;
    if (k === "down") m.at = (m.at + 1) % n;
    else if (k === "up") m.at = (m.at + n - 1) % n;
    else if (k === "enter") this.choose(m.items[m.at], cx);
    else if (/^[1-9]$/.test(k) && Number(k) <= n) this.choose(m.items[Number(k) - 1], cx);
    else return false;
    return true;
  }

  choose(item, cx) {
    this.menu = null;
    item.run(cx);
    cx.notify();
  }

  issueKey(k, cx) {
    if (this.menu) return this.menuKey(k, cx);
    const is = this.cur;
    switch (k) {
      case "left":
      case "backspace":
        this.back(cx);
        break;
      case "w":
        this.worktree(cx, false);
        break;
      case "s":
        this.worktree(cx, true);
        break;
      case "c":
        this.changeMenu(cx);
        break;
      case "n":
        this.create(cx);
        break;
      case "o":
        this.open(is.url, cx);
        break;
      case "y":
        this.copy(`${is.repo}#${is.number}`, cx);
        break;
      case "b":
        this.copy(this.treeOf(is)?.branch ?? branchOf(is), cx);
        break;
      case "g":
        this.openPR(null, cx);
        break;
      case "r":
        this.loadDetail(cx);
        break;
      default:
        return false;
    }
    return true;
  }

  listKeyDown(k, cx) {
    if (this.signedOut) return false;
    const n = this.shown?.length ?? 0;
    const r = this.shown?.[this.at];
    if (k === "down" && n) (this.at = Math.min(n - 1, this.at + 1)), this.follow();
    else if (k === "up" && n) (this.at = Math.max(0, this.at - 1)), this.follow();
    else if (k === "pagedown" && n) (this.at = Math.min(n - 1, this.at + 12)), this.follow();
    else if (k === "pageup" && n) (this.at = Math.max(0, this.at - 12)), this.follow();
    else if (k === "right" && !this.filter) this.step(1, cx);
    else if (k === "left" && !this.filter) this.step(-1, cx);
    else if (k === "ctrl-s" && r) this.worktree(cx, true, r.issue);
    else if (k === "ctrl-w" && r) this.worktree(cx, false, r.issue);
    else if (k === "ctrl-o" && r) this.open(r.issue.url, cx);
    else if (k === "ctrl-n") this.create(cx);
    else return false;
    return true;
  }

  // ── drawing ────────────────────────────────────────────────────────────

  labelChip(o, id, l) {
    return chip(o, id, [div().w(7).h(7).rounded_full().bg(hue(o, l.color)), l.name]);
  }

  // An issue's row, one line: its state icon, number and title; then,
  // quietly, its first labels, its agents and worktree, its repo (when the
  // list has several), who has it, and when it last changed.
  issueCard(o, is, on) {
    const look = issueLook(o, is);
    const ag = this.agentsOf(is);
    const busy = ag.find((a) => a.status === "working");
    const wide = this.width >= 760;
    const meta = (text, ic, c) => h_flex().flex_none().gap(4).items_center().text_size(12).text_color(c ?? o.dim)
      .when(Boolean(ic), (el) => el.child(icon(ic, c ?? o.dim, 12))).child(div().child(text));
    const who = is.mine ? "you" : is.assignees[0] ?? "";
    return h_flex()
      .id(`is-${is.id}`)
      .flex_none()
      .h(34)
      .pl(10)
      .pr(12)
      .gap(10)
      .items_center()
      .rounded(7)
      .when(on, (el) => el.bg(o.raised).shadow_sm())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .child(div().flex_none().w(3).h(16).rounded(2).when(on, (el) => el.bg(look.color)))
      .child(icon(look.icon, look.color, 14))
      .child(div().flex_none().w(52).font_family(MONO).text_size(11.5).text_color(o.muted).truncate().child(`#${is.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(on, (el) => el.font_medium()).text_color(o.fg).child(is.title))
      .when(wide && is.labels.length > 0, (el) => el.children(is.labels.slice(0, 2).map((l, i) => this.labelChip(o, `rl-${is.id}-${i}`, l))))
      .when(ag.length > 0, (el) => el.child(busy
        ? h_flex().flex_none().gap(4).items_center().child(icon("work", o.work, 12).spin(1100)).child(div().text_size(12).text_color(o.work).child(ag.length === 1 ? "agent" : `${ag.length} agents`))
        : meta(ag.length === 1 ? "agent" : `${ag.length} agents`, "person")))
      .when(Boolean(this.treeOf(is)), (el) => el.child(icon("worktree", o.accent, 13)))
      .when(wide && this.tab === "created", (el) => el.child(div().flex_none().w(150).truncate().text_size(12).text_color(o.dim).child(is.repo)))
      .child(h_flex().flex_none().w(this.width >= 700 ? 110 : 80).justify_end().overflow_hidden()
        .child(who ? meta(who, "person", is.mine ? o.muted : o.dim) : meta("unassigned")))
      .when(wide, (el) => el.child(div().flex_none().w(64).text_size(12).text_color(o.dim).child(ago(is.updated))));
  }

  heading(o, label, n) {
    return h_flex().flex_none().h(HEADING_H).px(10).pt(8).gap(8).items_center().text_size(10.5)
      .child(div().font_semibold().text_color(o.dim).child(label.toUpperCase()))
      .child(div().font_medium().text_color(o.dim).child(String(n)))
      .child(div().flex_1().h(1).bg(o.line));
  }

  tabBar(t, o) {
    let bar = h_flex().flex_none().gap(4).items_center().children(TABS.map((tb) => {
      const on = tb.id === this.tab;
      const l = this.lists[this.listKey(tb.id)];
      return h_flex().id(`tab-${tb.id}`).flex_none().h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
        .when(on, (el) => el.bg(o.raised).shadow_sm())
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.tab = tb.id;
          localStorage.setItem("tab", tb.id);
          this.at = 0;
          this.lookUp(cx);
          cx.notify();
        })
        .child(l?.loading ? icon("work", o.accent, 12).spin(1100) : icon(tb.icon, on ? o.fg : o.dim, 12))
        .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(this.width < 700 ? tb.short ?? tb.label : tb.label))
        .child(countPill(o, l?.loaded && !l.error ? l.items.length : null, on));
    }));
    bar = bar.child(div().flex_1());
    // The shown space's repo, and who you are on GitHub.
    bar = bar.child(h_flex().flex_none().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(o.line)
      .child(icon("project", o.dim, 12))
      .child(div().text_size(12).text_color(this.repo ? o.muted : o.dim).child(this.repo ?? "No repo here"))
      .when(Boolean(this.me), (el) => el.child(div().font_family(MONO).text_size(11).text_color(o.dim).child(`@${this.me}`))));
    return bar;
  }

  note(o, text, color) {
    return div().px(14).py(10).text_size(12.8).text_color(color ?? o.dim).child(text);
  }

  listView(o) {
    const notes = [];
    const entries = [];
    this.entryOf = [];
    const l = this.lists[this.listKey()];
    const rows = this.shown;
    if (l?.error && !rows.length) notes.push(this.note(o, l.error, o.fix));
    else if (!rows.length) {
      const empty = this.err ? "" : !l?.loaded || l.loading ? "Loading…"
        : this.filter ? "Nothing matches. An issue's number (12, #12, owner/repo#12) or URL looks it up on GitHub."
        : this.tab === "created" ? "You haven't filed any issues." : this.tab === "mine" ? "No open issues are assigned to you." : "No open issues.";
      if (empty) notes.push(this.note(o, empty));
    }
    let last;
    rows.forEach((r, i) => {
      if (r.group && r.group !== last) {
        entries.push({ key: `h-${r.group}`, h: HEADING_H, el: () => this.heading(o, r.group, rows.filter((x) => x.group === r.group).length) });
      }
      last = r.group;
      this.entryOf[i] = entries.length;
      entries.push({ key: `r-${r.issue.id}`, row: i, h: ROW_H, el: () => div().h(ROW_H).pb(2).child(this.issueCard(o, r.issue, i === this.at)) });
    });
    return v_flex().flex_1().min_h(0).gap(2)
      .children(notes)
      .when(entries.length > 0, (el) => el.child(
        div().relative().h(Math.min(LIST_H, entries.reduce((h, e) => h + e.h, 0))).min_h(0).flex_shrink(1)
          .child(v_virtual_list("is-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
            (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
            .on_item_click((key, cx) => {
              const e = entries.find((x) => x.key === key);
              if (e?.row == null) return;
              if (e.row === this.at) return this.enter(cx);
              this.at = e.row;
              cx.notify();
            }))
          .child(Scrollbar.vertical("is-rows").absolute().inset_0())));
  }

  follow() {
    const e = this.entryOf?.[this.at];
    if (e == null) return;
    this.scroll.scroll_to_item(this.at === 0 ? 0 : e);
  }

  field(o, label, kids) {
    return h_flex().gap(10).items_center().min_h(24)
      .child(div().flex_none().w(72).text_size(12).text_color(o.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(6).flex_wrap().items_center().children([kids].flat().filter(Boolean)));
  }

  backButton(o, label) {
    return h_flex().id("back").flex_none().h(24).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
      .on_click((_e, cx) => this.back(cx))
      .child(icon("back", o.muted, 13))
      .child(div().text_size(12).text_color(o.muted).child(label));
  }

  fromLabel() {
    if (this.direct && this.backTo?.label) return this.backTo.label;
    const tb = TABS.find((x) => x.id === this.tab);
    return tb.short ?? tb.label;
  }

  issueView(o) {
    const is = this.cur;
    const d = this.detail;
    const look = issueLook(o, is);
    const tree = this.treeOf(is);
    const ag = this.agentsOf(is);
    const branch = tree?.branch ?? branchOf(is);
    const canStart = d && is.open && (is.mine || !is.assignees.length);
    const person = (login) => [icon("person", o.dim, 13), div().text_color(o.fg).child(login === this.me ? `${login} (you)` : login)];
    return v_flex().flex_1().min_h(0).gap(10)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(this.backButton(o, this.fromLabel()))
        .child(chip(o, "state", [icon(look.icon, look.color, 12), look.word], { color: look.color, click: (cx) => this.changeMenu(cx) }))
        .child(div().font_family(MONO).text_size(12.5).text_color(o.muted).child(`#${is.number}`))
        .child(div().text_size(12.5).text_color(o.dim).child(is.repo))
        .child(div().flex_1()))
      .child(div().flex_none().text_size(17).font_semibold().text_color(o.fg).line_height(1.35).child(is.title))
      .when(Boolean(d), (el) => el
        .child(this.field(o, "Assignees", is.assignees.length ? is.assignees.flatMap(person) : div().text_color(o.dim).child("unassigned")))
        .child(this.field(o, "Opened", [div().text_color(o.fg).child(`${ago(d.created)} by`), ...person(is.author)]))
        .when(is.labels.length > 0, (el) => el.child(this.field(o, "Labels", is.labels.map((l, i) => this.labelChip(o, `lb-${i}`, l)))))
        .when(Boolean(is.milestone), (el) => el.child(this.field(o, "Milestone", chip(o, "ms", [icon("calendar", o.dim, 12), is.milestone ?? ""]))))
        .when(d.prs.length > 0, (el) => el.child(this.field(o, "Pull requests", d.prs.map((p, i) =>
          chip(o, `pr-${i}`, [icon("pr", o.accent, 12), `#${p.number}`, p.title ? div().text_color(o.muted).child(p.title.length > 48 ? p.title.slice(0, 47) + "…" : p.title) : null], { color: o.accent, click: (cx) => this.openPR(p, cx) })))))
        .child(this.field(o, "Branch", [chip(o, "branch", [icon("branch", o.dim, 13), branch], { mono: true, click: (cx) => this.copy(branch, cx) }),
          tree ? chip(o, "tree", [icon("worktree", o.accent, 12), "worktree"], { color: o.accent }) : div().text_size(12).text_color(o.dim).child("no worktree yet")]))
        .when(Boolean(canStart) && ag.length === 0, (el) => el.child(h_flex().flex_none().gap(10).items_center().px(12).py(8).rounded(8).bg(tint(o.accent, 0.1))
          .child(icon("play", o.accent, 15))
          .child(div().flex_1().min_w(0).text_color(o.fg).child(`Start: ${is.mine ? "" : "yours, "}a worktree, and an agent in it working on it`))
          .child(h_flex().id("start-btn").flex_none().h(26).px(10).items_center().rounded(6).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.worktree(cx, true))
            .child(div().text_size(12).font_semibold().text_color(o.surface).child("Start"))))))
      .when(ag.length > 0, (el) => el.child(
        v_flex().flex_none().gap(1)
          .child(div().px(2).pb(2).text_size(10.5).font_semibold().text_color(o.dim).child(`AGENTS ${ag.length}`))
          .children(ag.slice(0, 4).map((a, i) => h_flex().id(`ag-${i}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
            .on_click(() => {
              this.dismiss();
              run("agent.focus", { terminal: a.address });
            })
            .child(a.status === "working" ? icon("work", o.work, 14).spin(1100) : a.status === "blocked" ? icon("need", o.need, 14) : icon("idle", o.dim, 14))
            .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(o.fg).child(a.name ?? ""))
            .child(h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(5).border_1().border_color(o.line).bg(o.sunk).font_family(MONO).text_size(10.5).text_color(o.fg)
              .child(icon(a.machine ? "server" : "laptop", o.muted, 11)).child(div().child(a.machine ?? "this computer")))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11.5).text_color(o.dim).child(a.status ?? ""))))))
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().h(1).bg(o.line))
        .when(Boolean(d?.comments.length), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(o.dim)
          .child(icon("comment", o.dim, 12)).child(div().child(String(d.comments.length))))))
      .child(v_flex().id("is-body").h(360).min_h(0).flex_shrink(1).overflow_y_scrollbar().pr(6)
        .child(d
          ? TextView.markdown(`md-${is.id}`, this.bodyText()).selectable(true).text_size(13).text_color(o.muted).on_link_click((url, cx) => this.open(url, cx))
          : div().text_size(12.8).text_color(this.err ? o.fix : o.dim).child(this.err || "Loading…")));
  }

  createView(o) {
    const f = this.form;
    const pick = (id, items, isOn, onPick) => h_flex().gap(6).flex_wrap().items_center().children(items.map((x, i) => {
      const on = isOn(x);
      return h_flex().id(`${id}-${i}`).flex_none().h(24).px(8).gap(5).items_center().rounded(6).cursor_pointer()
        .border_1().border_color(on ? o.accent : o.line).when(on, (el) => el.bg(tint(o.accent, 0.14))).when(!on, (el) => el.hover((s) => s.bg(o.raised)))
        .on_click((_e, cx) => {
          onPick(x, cx);
          cx.notify();
        })
        .children(x.parts.filter(Boolean).map((p) => (typeof p === "string" ? div().text_size(12).text_color(on ? o.fg : o.muted).child(p) : p)));
    }));
    const input = (state) => h_flex().h(36).flex_none().px(12).items_center().rounded(8).border_1().border_color(o.line).bg(o.sunk)
      .child(Input.new(state).flex_1().h_full().text_size(13).text_color(o.fg));
    return v_flex().flex_1().min_h(0).gap(12)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(this.backButton(o, this.fromLabel()))
        .child(div().text_size(14).font_semibold().text_color(o.fg).child(`New issue in ${f.repo}`)))
      .child(input(this.title))
      .child(input(this.body))
      .child(this.field(o, "Labels", f.labels == null ? div().text_color(o.dim).child("Loading…")
        : f.labels.length ? pick("lb", f.labels.map((l) => ({ ...l, parts: [div().w(7).h(7).rounded_full().bg(hue(o, l.color)), l.name] })), (l) => f.picked.has(l.name),
          (l) => (f.picked.has(l.name) ? f.picked.delete(l.name) : f.picked.add(l.name)))
        : div().text_color(o.dim).child("The repo has no labels.")))
      .child(this.field(o, "Assignee", pick("me", [{ me: true, parts: [icon("person", o.muted, 12), "Me"] }, { me: false, parts: ["Nobody"] }], (x) => x.me === f.assignToMe, (x) => (f.assignToMe = x.me))))
      .child(h_flex().flex_none().gap(10).items_center()
        .child(div().flex_1())
        .child(h_flex().id("create-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => this.submit(cx))
          .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("File issue"))));
  }

  menuView(o) {
    const m = this.menu;
    const color = (c) => (c ? o[c] ?? o.muted : o.muted);
    return v_flex().flex_none().gap(2).p(10).rounded(10).border_1().border_color(o.line).bg(o.raised).shadow_md()
      .child(div().px(6).pb(6).text_size(13).font_semibold().text_color(o.fg).child(m.title))
      .children(m.items.map((it, i) => {
        const on = i === m.at;
        return h_flex().id(`mi-${i}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(tint(o.accent, 0.18)))
          .when(!on, (el) => el.hover((s) => s.bg(o.sunk)))
          .on_click((_e, cx) => this.choose(it, cx))
          .child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(String(i + 1)))
          .when(Boolean(it.icon), (el) => el.child(icon(it.icon, color(it.color), 13)))
          .child(div().text_size(13).when(on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(it.label));
      }));
  }

  footer(o) {
    const k = (keys, label, fn, id) => key(o, keys, label, fn, id);
    if (this.menu) {
      return [k(["↑", "↓"], "choose", () => {}, "f-ch"), k(["enter"], "do it", (cx) => this.choose(this.menu.items[this.menu.at], cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.screen === "issue") {
      const is = this.cur;
      return [
        k(["w"], "worktree", (cx) => this.worktree(cx, false), "f-w"),
        k(["s"], "start", (cx) => this.worktree(cx, true), "f-s"),
        k(["c"], is.open ? "close / assign" : "reopen / assign", (cx) => this.changeMenu(cx), "f-c"),
        k(["n"], "new issue", (cx) => this.create(cx), "f-n"),
        k(["o"], "GitHub", (cx) => this.open(is.url, cx), "f-o"),
        k(["y"], "copy ref", (cx) => this.copy(`${is.repo}#${is.number}`, cx), "f-y"),
        k(["b"], "copy branch", (cx) => this.copy(this.treeOf(is)?.branch ?? branchOf(is), cx), "f-b"),
        ...((this.detail?.prs ?? []).length ? [k(["g"], "pull request", (cx) => this.openPR(null, cx), "f-g")] : []),
        k(["esc"], "back", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.screen === "create") {
      return [k(["tab"], "next field", () => {}, "f-tab"), k(["enter"], "file it", (cx) => this.submit(cx), "f-go"), k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc")];
    }
    if (this.signedOut) return [k(["esc"], "close", (cx) => this.escape(cx), "f-esc")];
    const sel = this.shown?.[this.at]?.issue;
    return [
      k(["↑", "↓"], "choose", () => {}, "f-ch"),
      k(["enter"], "open", (cx) => this.enter(cx), "f-go"),
      k(["^s"], "start", (cx) => sel && this.worktree(cx, true, sel), "f-s"),
      k(["^w"], "worktree", (cx) => sel && this.worktree(cx, false, sel), "f-w"),
      k(["^n"], "new issue", (cx) => this.create(cx), "f-n"),
      k(["^o"], "GitHub", (cx) => sel && this.open(sel.url, cx), "f-o"),
      k(["←", "→"], "tabs", (cx) => this.step(1, cx), "f-tab"),
      k(["esc"], "close", (cx) => this.escape(cx), "f-esc"),
    ];
  }

  signInView(o) {
    return v_flex().flex_none().gap(12).px(14).py(18).items_start()
      .child(div().text_size(15).font_semibold().text_color(o.fg).child("Sign in to GitHub"))
      .child(div().text_size(13).text_color(o.muted).line_height(1.5).child("The GitHub CLI (gh) isn't signed in on this computer. Signing in opens a space that runs `gh auth login`, which opens GitHub in your browser; then open this again."))
      .child(h_flex().id("signin-btn").flex_none().h(30).px(14).items_center().rounded(7).bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
        .on_click(() => this.signIn())
        .child(div().text_size(12.5).font_semibold().text_color(o.surface).child("Sign in")))
      .child(words(o, [[["Try again", o.accent, (cx) => this.start(cx)]]], "retry-link"));
  }

  render() {
    const t = theme();
    const o = tones(t);
    this.shown = this.shownRows();
    if (this.screen === "list") this.at = Math.max(0, Math.min(this.at, this.shown.length - 1));
    const note = this.busy || this.err || this.flash;
    const noteColor = this.busy ? o.accent : this.err ? o.fix : o.muted;
    const scr = this.screen;
    return v_flex()
      .id("issues")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .when((scr !== "list" && scr !== "create") || this.signedOut, (el) => el.track_focus(this.keys))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 20) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") this.escape(cx);
        else if (scr === "create") return;
        else if (!(scr === "issue" ? this.issueKey(k, cx) : this.menu ? this.menuKey(k, cx) : this.listKeyDown(k, cx))) return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(scr === "list" && !this.signedOut, (el) => el
        .child(h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
          .child(icon("search", o.dim, 15))
          .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg)))
        .child(this.tabBar(t, o))
        .child(this.listView(o)))
      .when(scr === "list" && Boolean(this.signedOut), (el) => el.child(this.signInView(o)))
      .when(scr === "issue", (el) => el.child(this.issueView(o)))
      .when(scr === "create", (el) => el.child(this.createView(o)))
      .when(Boolean(this.menu), (el) => el.child(this.menuView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}

// The fold's pure model: no herdr imports, so node can test it.
// machines → spaces (worktrees under their checkout) → agents (sub-agents under their parent) → saved sessions.

export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
export function kidStatus(k, listed) {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
}

// Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
export function subTree(all, addr, lead = []) {
  const kids = all.filter((k) => k.parent === addr && k.state === "live");
  return kids.flatMap((k, i) => {
    const last = i === kids.length - 1;
    return [{ t: k, lines: [...lead, last ? "└" : "├"] }, ...subTree(all, k.address, [...lead, last ? "" : "│"])];
  });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The pane that speaks for a tab: its agent, else the focused one, else the first.
export function lead(tab, ps) {
  const mine = ps.filter((p) => p.tab === tab.id && p.terminal);
  return mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
}

// A tab's title: the name someone gave it, else the agent's own title when it says something.
export function tabTitle(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}

// Under its space an agent reads by its tab's title. An automatic tab number says
// nothing, so the program's name stands in.
export function agentName(a, tabs, ps) {
  const tab = tabs.find((t) => t.id === a.tab);
  const label = tab ? tabTitle(tab, lead(tab, ps)) : a.title || a.program?.name || "";
  return /^\d+$/.test(label) ? a.program?.name || label : label;
}

// Spaces in order, each worktree space moved under its main checkout's.
// `gitOf(space)`: { name, branch, ahead, behind, repo, linked } | null; `shown`: ids ready to list.
export function orderedSpaces(sp, gitOf, shown) {
  const list = sp.map((w, i) => ({ w, i, g: gitOf(w) ?? null })).filter((r) => shown.has(r.w.id));
  const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
  const nested = (r) => r.g?.linked && mains.has(r.g.repo);
  const out = [];
  const placed = new Set();
  for (const r of list) {
    if (nested(r)) continue;
    out.push({ ...r, tree: null });
    if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
    placed.add(r.g.repo);
    const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
    kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
  }
  return out;
}

export function topStatus(statuses) {
  return statuses.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
}

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

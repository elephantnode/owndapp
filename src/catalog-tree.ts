import type { Project } from '../shared/types';

/**
 * A folder, or a project that may hold other projects below it. Folder chains with nothing else in them
 * are merged into one node ("web/react"), so the tree stays shallow.
 */
export interface TreeNode {
  /**
   * Absolute folder path, unique in the tree. Windows folders use "\" and the spelling seen first, so this
   * may differ from project.path in separators or case; project.path keeps the stored value.
   */
  path: string;
  /** Path relative to the parent node. */
  label: string;
  project?: Project;
  children: TreeNode[];
  /** Projects in this subtree, including the node's own project. */
  projects: Project[];
}

/**
 * Where a path lives. Windows drives ("C:\", "C:/") and UNC shares ("\\server\share") compare without case
 * and accept both separators. Anything else is POSIX, where "\" is part of a file name and case matters.
 */
interface Volume { windows: boolean; key: string; path: string; parts: string[] }

function volume(path: string): Volume {
  const drive = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  const unc = !drive && /^\\\\([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]|$)/.exec(path);
  if (drive) return { windows: true, key: drive[1].toLowerCase() + ':', path: `${drive[1]}:\\`, parts: path.slice(2).split(/[\\/]/).filter(Boolean) };
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}`;
    return { windows: true, key: root.toLowerCase(), path: root, parts: path.slice(unc[0].length).split(/[\\/]/).filter(Boolean) };
  }
  return { windows: false, key: '/', path: '/', parts: path.split('/').filter(Boolean) };
}

const same = (windows: boolean, a: string, b: string) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
const join = (windows: boolean, base: string, part: string) => {
  const sep = windows ? '\\' : '/';
  return base.endsWith(sep) ? base + part : base + sep + part;
};

/** The deepest folder holding every parent folder of `paths`, with the length of its own path parts. "" when they span volumes. */
function common(paths: string[]): { path: string; depth: number } {
  if (!paths.length) return { path: '/', depth: 0 };
  const first = volume(paths[0]);
  let parts = first.parts.slice(0, -1);
  for (const path of paths.slice(1)) {
    const next = volume(path);
    if (next.key !== first.key) return { path: '', depth: 0 };
    let i = 0;
    while (i < parts.length && i < next.parts.length - 1 && same(first.windows, parts[i], next.parts[i])) i++;
    parts = parts.slice(0, i);
  }
  return { path: parts.reduce((base, part) => join(first.windows, base, part), first.path), depth: parts.length };
}

/** The deepest folder containing every project's parent folder, or "" when projects are on different drives or shares. */
export function commonFolder(paths: string[]) {
  return common(paths).path;
}

/**
 * Whether `path` is `root` or inside it, for the UI only (not a filesystem boundary check). Windows paths match
 * without case and with either separator, never across drives or shares. "" is the virtual root holding everything.
 */
export function withinPath(root: string, path: string) {
  if (root === '') return true;
  const outer = volume(root), inner = volume(path);
  if (outer.windows !== inner.windows) return false;
  if (!outer.windows) return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
  return outer.key === inner.key && outer.parts.length <= inner.parts.length && outer.parts.every((part, i) => same(true, part, inner.parts[i]));
}

export function buildTree(projects: Project[]): { root: string; nodes: TreeNode[] } {
  const { path: root, depth } = common(projects.map(p => p.path));
  const top: TreeNode = { path: root, label: '', children: [], projects: [] };
  const windows = new Set<TreeNode>();
  // Keyed by volume and case-folded parts, so "C:\Users" and "c:/users" share a node.
  const byKey = new Map<string, TreeNode>();
  const branch = (parent: TreeNode, key: string, path: string, label: string, win: boolean) => {
    let node = byKey.get(key);
    if (!node) {
      node = { path, label, children: [], projects: [] };
      byKey.set(key, node); parent.children.push(node);
      if (win) windows.add(node);
    }
    return node;
  };
  for (const project of projects) {
    const { windows: win, key: volumeKey, path: volumePath, parts } = volume(project.path);
    // Across volumes the top is virtual and each drive, share or "/" becomes its own branch.
    let parent = root === '' ? branch(top, volumeKey, volumePath, volumePath, win) : top;
    let key = volumeKey;
    for (const part of parts.slice(0, depth)) key += `\0${win ? part.toLowerCase() : part}`;
    for (const part of parts.slice(depth)) {
      key += `\0${win ? part.toLowerCase() : part}`;
      parent = branch(parent, key, join(win, parent.path, part), part, win);
    }
    parent.project = project;
  }
  const finish = (node: TreeNode): TreeNode => {
    node.children = node.children.map(finish).sort((a, b) => a.label.localeCompare(b.label, 'ja', { numeric: true }));
    // A folder holding only one folder or one project is shown as one step ("react/dev/todo-app").
    while (!node.project && node !== top && node.children.length === 1) {
      const child = node.children[0];
      node.label = join(windows.has(node), node.label, child.label); node.path = child.path; node.children = child.children; node.project = child.project;
    }
    node.projects = [...(node.project ? [node.project] : []), ...node.children.flatMap(child => child.projects)];
    return node;
  };
  finish(top);
  return { root, nodes: top.children };
}

/** Every node path, for "expand all". */
export function allPaths(nodes: TreeNode[]): string[] {
  return nodes.flatMap(node => node.children.length ? [node.path, ...allPaths(node.children)] : []);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPaths, buildTree, commonFolder, withinPath, type TreeNode } from '../src/catalog-tree.js';
import type { Project } from '../shared/types.js';

const project = (path: string) => ({ id: path, name: path.split('/').pop()!, path }) as Project;
const shape = (nodes: TreeNode[]): unknown[] => nodes.map(n => [n.label, n.project ? 'P' : 'F', n.projects.length, ...(n.children.length ? [shape(n.children)] : [])]);

test('共通の親フォルダから、フォルダの階層とプロジェクトの入れ子を組み立てる', () => {
  const { root, nodes } = buildTree([
    project('/Users/developer/playground/web/chat/chatapi'),
    project('/Users/developer/playground/web/chat/chatapi/functions/upload'),
    project('/Users/developer/playground/web/chat/chatapi/webhook'),
    project('/Users/developer/playground/web/react/dev/todo-app'),
    project('/Users/developer/playground/lambda/app10'),
    project('/Users/developer/playground/lambda/app2'),
    project('/Users/developer/work/sample-app'),
  ]);
  assert.equal(root, '/Users/developer');
  assert.deepEqual(shape(nodes), [
    ['playground', 'F', 6, [
      ['lambda', 'F', 2, [['app2', 'P', 1], ['app10', 'P', 1]]],
      ['web', 'F', 4, [
        ['chat/chatapi', 'P', 3, [['functions/upload', 'P', 1], ['webhook', 'P', 1]]],
        ['react/dev/todo-app', 'P', 1],
      ]],
    ]],
    ['work/sample-app', 'P', 1],
  ]);
  // Merged folder chains keep the deepest folder's path, so expand state stays stable.
  assert.equal(nodes[0].children[1].children[0].path, '/Users/developer/playground/web/chat/chatapi');
  assert.deepEqual(allPaths(nodes), ['/Users/developer/playground', '/Users/developer/playground/lambda', '/Users/developer/playground/web', '/Users/developer/playground/web/chat/chatapi']);
});

test('1件だけ・共通の親がない・空の場合', () => {
  assert.deepEqual(shape(buildTree([project('/a/b/c')]).nodes), [['c', 'P', 1]]);
  assert.equal(buildTree([project('/a/b/c')]).root, '/a/b');
  assert.equal(commonFolder(['/x/one', '/y/two']), '/');
  assert.deepEqual(shape(buildTree([project('/x/one'), project('/y/two')]).nodes), [['x/one', 'P', 1], ['y/two', 'P', 1]]);
  assert.deepEqual(buildTree([]).nodes, []);
});

const windowsProject = (path: string) => ({ id: path, name: path.split(/[\\/]/).pop()!, path }) as Project;

test('Windowsのドライブは区切り両方・大文字小文字を同一視し、元のパスはプロジェクトに残す', () => {
  const projects = [
    windowsProject('C:\\Users\\developer\\dev\\app-a'),
    windowsProject('c:/users/DEVELOPER/dev/app-b'),
    windowsProject('C:\\Users\\developer\\dev\\app-a\\packages\\web'),
    windowsProject('C:\\Users\\developer\\labs\\one'),
  ];
  const { root, nodes } = buildTree(projects);
  assert.equal(root, 'C:\\Users\\developer');
  assert.deepEqual(shape(nodes), [
    ['dev', 'F', 3, [['app-a', 'P', 2, [['packages\\web', 'P', 1]]], ['app-b', 'P', 1]]],
    ['labs\\one', 'P', 1],
  ]);
  assert.equal(nodes[0].children[1].path, 'C:\\Users\\developer\\dev\\app-b');
  assert.equal(nodes[0].children[1].project!.path, 'c:/users/DEVELOPER/dev/app-b');
  assert.deepEqual(allPaths(nodes), ['C:\\Users\\developer\\dev', 'C:\\Users\\developer\\dev\\app-a']);
  assert.equal(commonFolder(['C:\\a\\one', 'C:\\b\\two']), 'C:\\');
});

test('別ドライブ・別UNC共有・POSIXは同じ親にまとめず、仮想の親の下に分ける', () => {
  assert.equal(commonFolder(['C:\\work\\a', 'D:\\work\\b']), '');
  assert.equal(commonFolder(['\\\\nas\\share\\x\\a', '\\\\nas\\other\\x\\b']), '');
  assert.equal(commonFolder(['\\\\NAS\\Share\\x\\a', '\\\\nas\\share\\x\\b']), '\\\\NAS\\Share\\x');
  assert.equal(commonFolder(['/work/a', 'C:\\work\\b']), '');
  const { root, nodes } = buildTree([
    windowsProject('C:\\work\\a'), windowsProject('D:\\work\\b'), windowsProject('d:\\work\\c'),
    windowsProject('\\\\nas\\share\\team\\x'), project('/Users/developer/y'),
  ]);
  assert.equal(root, '');
  assert.deepEqual(shape(nodes), [
    ['/Users/developer/y', 'P', 1],
    ['\\\\nas\\share\\team\\x', 'P', 1],
    ['C:\\work\\a', 'P', 1],
    ['D:\\work', 'F', 2, [['b', 'P', 1], ['c', 'P', 1]]],
  ]);
  assert.deepEqual(allPaths(nodes), ['D:\\work']);
});

test('POSIXのbackslashはファイル名として扱い、大文字小文字も区別する', () => {
  const { root, nodes } = buildTree([project('/srv/a\\b/one'), project('/srv/a\\b/two'), project('/srv/A\\B/three')]);
  assert.equal(root, '/srv');
  assert.deepEqual(shape(nodes), [['a\\b', 'F', 2, [['one', 'P', 1], ['two', 'P', 1]]], ['A\\B/three', 'P', 1]]);
  assert.equal(commonFolder(['/Users/developer/a', '/users/developer/b']), '/');
});

test('withinPathはWindowsで区切り・大文字小文字を問わず、別ドライブ・共有・前方一致だけの別フォルダを拒否', () => {
  assert.equal(withinPath('C:\\Users\\developer', 'C:\\Users\\developer'), true);
  assert.equal(withinPath('C:\\Users\\developer', 'c:/users/DEVELOPER/dev/app'), true);
  assert.equal(withinPath('C:/Users/developer/', 'C:\\Users\\developer\\dev'), true);
  assert.equal(withinPath('C:\\', 'C:\\anything\\below'), true);
  assert.equal(withinPath('C:\\Users\\developer', 'C:\\Users\\developerfa'), false);
  assert.equal(withinPath('C:\\Users\\developer', 'D:\\Users\\developer'), false);
  assert.equal(withinPath('C:\\Users\\developer\\dev', 'C:\\Users\\developer'), false);
  assert.equal(withinPath('\\\\nas\\share', '\\\\NAS\\Share\\team'), true);
  assert.equal(withinPath('\\\\nas\\share', '\\\\nas\\shared\\team'), false);
  assert.equal(withinPath('\\\\nas\\share\\team', '\\\\other\\share\\team'), false);
  assert.equal(withinPath('/Users/developer', 'C:\\Users\\developer'), false);
  assert.equal(withinPath('C:\\Users\\developer', '/Users/developer'), false);
});

test('withinPathはPOSIXで従来どおり区切りと大文字小文字を区別し、空のrootはすべてを含む', () => {
  assert.equal(withinPath('/Users/developer', '/Users/developer'), true);
  assert.equal(withinPath('/Users/developer', '/Users/developer/dev'), true);
  assert.equal(withinPath('/Users/developer/', '/Users/developer/dev'), true);
  assert.equal(withinPath('/', '/anything'), true);
  assert.equal(withinPath('/Users/developer', '/Users/developerfa'), false);
  assert.equal(withinPath('/Users/developer', '/users/developer/dev'), false);
  assert.equal(withinPath('/srv/a', '/srv/a\\b'), false);
  assert.equal(withinPath('', '/Users/developer'), true);
  assert.equal(withinPath('', 'D:\\work'), true);
});

import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('探索・追加・検索・編集・アーカイブ・復帰と狭い画面', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '最初のアプリを登録しましょう', exact: true, level: 1 })).toBeVisible();
  const mainNav = page.getByRole('navigation', { name: 'メインメニュー' });
  await expect(mainNav.getByRole('link')).toHaveCount(6);
  await expect(mainNav.getByRole('button')).toHaveCount(0);
  const openCatalog = async () => { await mainNav.getByRole('link', { name: '登録したアプリ', exact: true }).click(); };
  await expect(mainNav.getByRole('link', { name: 'ホーム', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: '最初のアプリを登録しましょう' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/home-first-run.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'フォルダからアプリを探す' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/home-first-run-narrow.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'フォルダからアプリを探す' }).click();
  // The test server substitutes the Finder dialog with the fixture folder (OWNDAPP_TEST_PICK_FOLDER).
  await page.getByRole('button', { name: 'フォルダを追加', exact: true }).click();
  await expect(page.getByText('探索完了', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '探索するフォルダ' })).toContainText(process.env.OWNDAPP_TEST_ROOT!.split('/').at(-1)!);
  // The scanned folder is registered and can be scanned again from the list.
  const folders = page.getByRole('list', { name: '登録した探索フォルダ' });
  await expect(folders.getByRole('listitem')).toHaveCount(1);
  await expect(folders).toContainText('候補4件（未登録4件）');
  await expect(folders.getByRole('button', { name: /を再探索$/ })).toBeVisible();
  await expect(page.getByText('4件の候補', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'photo-notesを登録候補に選択' }).check();
  await expect(page.getByRole('checkbox', { name: /表示中の新規候補をすべて選択/ })).toHaveAttribute('data-state', 'indeterminate');
  await page.getByRole('button', { name: '選択を解除' }).click();
  await expect(page.getByText('0件を選択')).toBeVisible();
  await page.getByRole('checkbox', { name: /表示中の新規候補をすべて選択/ }).click();
  await expect(page.getByText('4件を選択')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'image-workerを登録候補に選択' })).toBeChecked();
  // Registering only goes back to the added projects and sends nothing; 登録してチェック is covered by the next test.
  await expect(page.getByRole('button', { name: '登録してチェック' })).toBeEnabled();
  await page.getByRole('button', { name: '選択した候補を登録' }).click();
  await expect(page.getByText('今回追加したアプリを表示しています')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('依存情報は自動で読み取ります');
  // The purpose comes from the README's first paragraph, once the background reading has finished.
  await expect(page.getByText('社内のお知らせと予定をまとめて表示するポータル。')).toBeVisible();
  await page.getByRole('link', { name: 'personal-portal', exact: true }).click();
  await expect(page.getByText('README.mdから自動入力しました')).toBeVisible();
  await page.getByRole('button', { name: '一覧に戻る' }).click();
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  // The test server never touches Finder; the buttons must still succeed without an error.
  await page.getByRole('button', { name: 'photo-notesをFinderで表示' }).click();
  await page.getByRole('link', { name: 'photo-notes', exact: true }).click();
  await page.getByRole('button', { name: 'Finderで表示', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const guard = page.getByRole('region', { name: 'Takumi Guardの設定' });
  await expect(guard.getByRole('button', { name: 'Guardを設定…' })).toBeVisible();
  await guard.getByRole('button', { name: 'Guardを設定…' }).click();
  const guardDialog = page.getByRole('dialog');
  await expect(guardDialog).toContainText('https://npm.flatt.tech/');
  await guardDialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(guard.getByRole('button', { name: 'Guardを設定…' })).toBeVisible();
  await guard.getByRole('button', { name: 'Guardを設定…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'この設定を適用' }).click();
  await expect(guard.getByRole('button', { name: 'Guardを設定…' })).toHaveCount(0);
  await expect(guard).toContainText('設定しました。');
  await guard.getByRole('button', { name: '設定を再確認' }).click();
  await expect(guard).toContainText('設定済み');
  await guard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/owndapp-guard-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await guard.scrollIntoViewIfNeeded();
  await expect(guard.getByRole('button', { name: '設定を再確認' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/owndapp-guard-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('textbox', { name: '用途', exact: true }).fill('写真と日記をまとめる個人用アプリ');
  await page.getByLabel('管理状態', { exact: true }).selectOption('maintained');
  await page.getByRole('textbox', { name: 'タグ', exact: true }).fill('個人開発, 写真');
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  // The save toast is shown where the save button was pressed, not only at the top of the page.
  await expect(page.getByRole('status')).toBeInViewport();
  await page.screenshot({ path: 'docs/screenshots/detail-saved.png', animations: 'disabled' });
  await page.getByRole('button', { name: '一覧に戻る' }).click();
  await page.getByRole('textbox', { name: 'アプリを検索' }).fill('写真');
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'personal-portal', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'アプリを検索' }).fill('');
  await page.getByRole('link', { name: 'photo-notes', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '用途', exact: true })).toHaveValue('写真と日記をまとめる個人用アプリ');
  // Archiving is a checkbox; the lifecycle select no longer offers it and is locked while archived.
  await expect(page.getByLabel('管理状態', { exact: true }).locator('option[value="archived"]')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'アーカイブする' }).check();
  await expect(page.getByLabel('管理状態', { exact: true })).toBeDisabled();
  await expect(page.getByText('チェックを外すと管理状態は「運用中」に戻ります')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'アーカイブの理由（任意）' })).not.toHaveAttribute('required');
  await page.getByRole('textbox', { name: 'アーカイブの理由（任意）' }).fill('試作を終了。再開時の参考に保存');
  await page.getByRole('checkbox', { name: 'アーカイブする' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/detail-archive.png', animations: 'disabled' });
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('link', { name: 'アーカイブ', exact: true }).click();
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'photo-notes', exact: true }).click();
  // Clearing the box restores the lifecycle it had before archiving, which can then be changed.
  await page.getByRole('checkbox', { name: 'アーカイブする' }).uncheck();
  await expect(page.getByLabel('管理状態', { exact: true })).toHaveValue('maintained');
  await page.getByLabel('管理状態', { exact: true }).selectOption('on_hold');
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByRole('status')).toContainText('保存しました');
  await page.getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('checkbox', { name: 'このページをすべて選択' }).check();
  await page.getByRole('button', { name: 'タグを追加', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'タグ' }).fill('確認対象');
  await page.getByRole('dialog').getByRole('button', { name: 'タグを追加', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('タグを追加しました');
  await page.getByRole('button', { name: '選択解除' }).click();
  await page.getByRole('checkbox', { name: 'personal-portalを選択' }).check();
  await page.getByRole('checkbox', { name: 'image-workerを選択' }).check();
  await page.getByRole('button', { name: '管理状態を変更' }).click();
  await page.getByRole('dialog').getByLabel('変更後の管理状態').selectOption('archived');
  await page.getByRole('dialog').getByRole('textbox', { name: 'アーカイブの理由（任意）' }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/catalog-bulk-lifecycle.png', animations: 'disabled' });
  // The reason is optional.
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'アーカイブの理由（任意）' })).not.toHaveAttribute('required');
  await page.getByRole('dialog').getByLabel('変更後の管理状態').selectOption('active');
  await page.getByRole('dialog').getByRole('button', { name: '2件を変更' }).click();
  await expect(page.getByRole('status')).toContainText('2件の管理状態を「開発中」にしました');
  await expect(page.getByRole('table').getByText('開発中', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: '通知を閉じる' }).click();
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  mkdirSync('docs/screenshots', { recursive: true });
  await page.screenshot({ path: 'docs/screenshots/catalog-desktop.png', fullPage: true, animations: 'disabled' });
  for (const width of [900, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
    // The menu keeps its text labels on narrow windows, and the project tabs stay reachable.
    for (const label of ['ホーム', 'アプリを追加', '登録したアプリ', '脆弱性と対応', '依存検索', '設定・使い方']) await expect(mainNav.getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '登録したアプリの表示' }).getByRole('link', { name: 'アーカイブ', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.screenshot({ path: 'docs/screenshots/catalog-narrow.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('textbox', { name: 'アプリを検索' })).toBeFocused();
  await page.getByRole('link', { name: 'アプリを追加', exact: true }).click();
  await page.getByRole('button', { name: '登録済み', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'photo-notesを登録候補に選択' })).toBeDisabled();
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/discovery-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('link', { name: 'photo-notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'メモ', exact: true }).fill('保存前のメモ');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('保存前のメモ');
  // A second tab changes the same record. The first tab must keep its draft and show a conflict.
  const second = await page.context().newPage();
  await second.goto(page.url());
  await second.getByRole('textbox', { name: 'メモ', exact: true }).fill('別タブで保存したメモ');
  await second.getByRole('button', { name: '変更を保存' }).click();
  await expect(second.getByRole('status')).toContainText('保存しました');
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByRole('alert')).toContainText('別の画面で変更');
  await expect(page.getByRole('textbox', { name: 'メモ', exact: true })).toHaveValue('保存前のメモ');
  await page.getByRole('button', { name: '入力を保持して最新の内容を確認' }).click();
  await expect(page.getByText('メモ: 別タブで保存したメモ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '入力内容を優先する', exact: true }).click();
  await page.getByRole('button', { name: '変更を保存' }).click();
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible();
  await second.close();
  // A registered folder is moved away: the catalog flags it and removes it only after confirmation.
  renameSync(join(process.env.OWNDAPP_TEST_ROOT!, 'log-tool'), join(process.env.OWNDAPP_TEST_ROOT!, 'log-tool-moved'));
  await page.getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('button', { name: '存在を再確認' }).click();
  await expect(page.getByRole('status')).toContainText('見つからないアプリが1件');
  await expect(page.getByText('フォルダが見つかりません', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'example.com/log-toolをFinderで表示' })).toBeDisabled();
  // 脆弱性と対応 lists it under its own kind, with the same list/tree switch as the catalog.
  await page.getByRole('link', { name: '脆弱性と対応', exact: true }).click();
  const missingSection = page.getByRole('region', { name: /フォルダが見つからない/ });
  await expect(missingSection.getByRole('link', { name: 'example.com/log-tool', exact: true })).toBeVisible();
  await expect(missingSection.getByRole('button', { name: 'カタログから外す…' })).toBeVisible();
  await page.getByRole('button', { name: 'フォルダ別', exact: true }).click();
  const missingTree = page.getByRole('region', { name: 'フォルダが見つからないのフォルダ別' });
  await expect(missingTree.getByRole('link', { name: 'example.com/log-tool', exact: true })).toBeVisible();
  await expect(missingTree.getByRole('checkbox')).toHaveCount(0);
  await page.screenshot({ path: 'docs/screenshots/attention-tree.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '一覧', exact: true }).click();
  await openCatalog();
  await page.getByRole('button', { name: 'カタログから外す…' }).click();
  await expect(page.getByRole('dialog')).toContainText('example.com/log-tool');
  await page.getByRole('dialog').getByRole('button', { name: '1件を外す' }).click();
  await expect(page.getByRole('status')).toContainText('1件をカタログから外しました');
  await expect(page.getByRole('link', { name: 'example.com/log-tool', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  // Excluding a candidate's folder hides it from the current result at once and lists it as an exclusion.
  const portal = join(realpathSync(process.env.OWNDAPP_TEST_ROOT!), 'personal-portal');
  await page.getByRole('link', { name: 'アプリを追加', exact: true }).click();
  await page.getByRole('button', { name: 'すべて', exact: true }).click();
  await page.getByRole('button', { name: 'personal-portalのフォルダを探索から除外' }).click();
  const exclusions = page.getByRole('group', { name: '除外するフォルダ' });
  await expect(exclusions).toContainText('1件');
  await expect(exclusions.getByText(portal, { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'personal-portalを登録候補に選択' })).toHaveCount(0);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/discovery-exclusions.png', animations: 'disabled' });
  await page.getByRole('button', { name: `${portal}の除外を解除` }).click();
  await expect(exclusions).toContainText('0件');
  await expect(page.getByRole('checkbox', { name: 'personal-portalを登録候補に選択' })).toBeVisible();
  // Excluding a registered project's folder leads to the catalog, where it can be removed after confirmation.
  await page.getByRole('button', { name: 'image-workerのフォルダを探索から除外' }).click();
  await expect(exclusions.getByRole('status')).toContainText('登録済みのアプリが1件');
  await exclusions.getByRole('link', { name: 'カタログで確認して外す' }).click();
  await expect(page.getByText('除外設定のフォルダにあります', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'image-worker', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/catalog-excluded.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'カタログから外す…' }).click();
  await expect(page.getByRole('dialog')).toContainText('除外設定のフォルダにあるアプリ');
  await page.getByRole('dialog').getByRole('button', { name: '1件を外す' }).click();
  await expect(page.getByRole('status')).toContainText('1件をカタログから外しました');
  await expect(page.getByRole('link', { name: 'image-worker', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  // Register an editor in settings, then open a project with it from the list and the detail page.
  await expect(page.getByRole('button', { name: 'photo-notesをTestAppで開く' })).toHaveCount(0);
  await page.getByRole('link', { name: '設定・使い方', exact: true }).click();
  const editor = page.getByRole('group', { name: 'エディタ' });
  await expect(editor).toContainText('未登録');
  await editor.getByRole('button', { name: 'アプリを選ぶ' }).click();
  await expect(editor).toContainText('TestApp');
  await expect(page.getByRole('group', { name: 'ターミナル' })).toContainText('未登録');
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/settings-apps.png', animations: 'disabled' });
  await openCatalog();
  await page.getByRole('button', { name: 'photo-notesをTestAppで開く' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('link', { name: 'photo-notes', exact: true }).click();
  await page.getByRole('button', { name: 'TestAppで開く', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '開くアプリを追加' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/detail-open-with.png', animations: 'disabled' });
  // Read a project's lockfile from the list, find it by package name, and follow the result to its detail page.
  // Registering read the dependencies already. Reading all non-archived projects again runs in the background.
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('link', { name: '依存検索', exact: true }).click();
  await expect(page.getByText(/依存の読み取りを実施 2件 \/ 登録 2件/)).toBeVisible();
  await page.getByRole('button', { name: /アーカイブ以外をすべて読み取る（2件）/ }).click();
  await expect(page.getByRole('status')).toContainText('アーカイブ以外の2件の依存情報を読み取ります');
  await expect(page.getByRole('button', { name: /アーカイブ以外をすべて読み取る/ })).toBeEnabled();
  await page.getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('checkbox', { name: 'photo-notesを選択' }).check();
  await page.getByRole('button', { name: '依存情報を読む' }).click();
  await expect(page.getByRole('status')).toContainText('1件の依存情報を読み取りました（完了1件）');
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await page.getByRole('link', { name: '依存検索', exact: true }).click();
  await page.getByLabel('パッケージ名').fill('vue');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  const results = page.getByRole('region', { name: '検索結果' });
  await expect(results).toContainText('vue@3.5.13');
  await expect(results).toContainText('npm · 直接（^3.5.0） · 本番 · npm公開');
  await page.getByLabel('パッケージ名').fill('@vue/shared');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(results).toContainText('間接');
  await page.getByLabel('パッケージ名').fill('react');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByRole('heading', { name: '読み取り済み2件の範囲では見つかりません' })).toBeVisible();
  // The overview lists every recorded package. Picking one searches it.
  const overview = page.getByRole('region', { name: '記録されているパッケージ' });
  await expect(overview).toContainText('2種類');
  await overview.getByRole('textbox', { name: 'パッケージを絞り込み' }).fill('SHARED');
  await expect(overview.getByRole('button', { name: 'vue', exact: true })).toHaveCount(0);
  await overview.getByRole('button', { name: '@vue/shared' }).click();
  await expect(results).toContainText('@vue/shared@3.5.13');
  await expect(page.getByLabel('パッケージ名')).toHaveValue('@vue/shared');
  await overview.getByRole('textbox', { name: 'パッケージを絞り込み' }).fill('');
  await overview.getByRole('button', { name: 'vue', exact: true }).click();
  await expect(results).toContainText('vue@3.5.13');
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/dependency-search.png', fullPage: true, animations: 'disabled' });
  await results.getByRole('link', { name: 'photo-notes', exact: true }).click();
  const panel = page.getByRole('region', { name: '依存関係' });
  await expect(panel).toContainText('読み取り済み');
  await expect(panel).toContainText('2件（直接1件）');
  await panel.getByText('直接依存 1件').click();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/detail-dependencies.png', animations: 'disabled' });
  // Check the read dependencies against OSV (an offline fixture here). The dialog states what leaves this Mac first.
  const vulnerabilities = page.getByRole('region', { name: '既知の脆弱性は未照会です' });
  await vulnerabilities.getByRole('button', { name: '脆弱性を照会' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('https://api.osv.dev');
  await expect(confirm).toContainText('ecosystem・パッケージ名・版 2種類');
  await expect(confirm).toContainText('npm 2');
  await expect(confirm).toContainText('フォルダのパス、アプリ名、ソース、lockファイル');
  await page.screenshot({ path: 'docs/screenshots/vulnerability-confirm.png', animations: 'disabled' });
  await expect(confirm).toContainText('裏側で進め、画面上部に進み具合を出します');
  await confirm.getByRole('button', { name: '1件を照会' }).click();
  await expect(page.getByRole('status')).toContainText('既知の脆弱性があるアプリは1件です');
  // The right column summarises by dependency; every advisory is listed in the wide column.
  const found = page.getByRole('region', { name: '既知の脆弱性 1件' });
  await expect(found).toContainText('@vue/shared@3.5.13');
  await expect(found).toContainText('修正版 3.5.14');
  await expect(found).not.toContainText('GHSA-test-0000-0001');
  await found.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/detail-vulnerabilities.png', animations: 'disabled' });
  // The fix memo, the same as the response queue's, goes straight to the clipboard for working in the project.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await found.getByRole('button', { name: '対策メモをコピー' }).click();
  await expect(found).toContainText('対策メモをコピーしました');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/# 脆弱性の対策メモ: photo-notes[\s\S]*## @vue\/shared@3\.5\.13（間接依存[\s\S]*GHSA-test-0000-0001/);
  // Reduced motion jumps instead of scrolling smoothly, so the screenshot is not taken mid-scroll.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await found.getByRole('button', { name: '全1件の詳細を見る' }).click();
  const list = page.getByRole('region', { name: /既知の脆弱性の詳細/ });
  await expect(list.getByRole('heading', { name: /既知の脆弱性の詳細/ })).toBeFocused();
  await expect(list.getByRole('heading', { name: /既知の脆弱性の詳細/ })).toBeInViewport();
  await expect(list).toContainText('GHSA-test-0000-0001');
  await expect(list).toContainText('@vue/shared@3.5.13（間接・本番）→ 修正版 3.5.14');
  await page.screenshot({ path: 'docs/screenshots/detail-vulnerability-list.png', animations: 'disabled' });
  await page.getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await expect(page.getByText('既知の脆弱性 1件（最大: 中）')).toBeVisible();
  // The catalog totals count projects outside the archive, in projects.
  const totals = page.getByRole('region', { name: '集計（アーカイブ以外）' });
  await expect(totals).toContainText('既知の脆弱性あり1アプリ');
  await expect(totals).toContainText('アーカイブの0件は含みません');
  // 脆弱性と対応: the queue is the main list. The found advisory is open work; exposure alone does not lower its priority, the status is recorded, a fix memo is ready.
  await page.getByRole('link', { name: '脆弱性と対応', exact: true }).click();
  await expect(page).toHaveURL(/#attention$/);
  const queue = page.getByRole('list', { name: 'アプリごとの脆弱性' });
  await expect(queue).toContainText('photo-notes');
  // Listed once: the queue replaces the former 既知の脆弱性 list of 要対応.
  await expect(page.getByRole('main').getByRole('link', { name: 'photo-notes', exact: true })).toHaveCount(1);
  await expect(page.getByRole('region', { name: '既知の脆弱性への対応' })).toContainText('未対応 1件');
  // The registered editor opens the project from the queue.
  await queue.getByRole('button', { name: 'photo-notesをTestAppで開く' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Checking again from the queue shows what leaves this Mac before anything is sent.
  await queue.getByRole('button', { name: 'photo-notesを再チェック' }).click();
  await expect(page.getByRole('dialog')).toContainText('https://api.osv.dev');
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(queue).toContainText('優先度中 1');
  await page.getByRole('combobox', { name: 'photo-notesの公開状況' }).selectOption('local');
  await expect(page.getByRole('status')).toContainText('公開状況を「ローカルのみ」にしました');
  await expect(queue).toContainText('優先度中 1');
  await queue.getByRole('button', { name: 'photo-notesを開く' }).click();
  await expect(queue).toContainText('GHSA-test-0000-0001');
  await expect(queue).toContainText('@vue/shared@3.5.13（間接） → 修正版 3.5.14');
  await queue.getByRole('checkbox', { name: 'photo-notesのGHSA-test-0000-0001を選択' }).check();
  await page.getByRole('button', { name: '対応状況を変更' }).click();
  const responseDialog = page.getByRole('dialog');
  await expect(responseDialog.getByLabel('対応状況').locator('option[value="resolved"]')).toHaveCount(0);
  await responseDialog.getByLabel('対応状況').selectOption('not-applicable');
  await responseDialog.getByRole('button', { name: '1件を変更' }).click();
  await expect(responseDialog.getByRole('alert')).toContainText('根拠');
  await responseDialog.getByLabel('対応状況').selectOption('investigating');
  await responseDialog.getByLabel('メモ（任意）').fill('vue の更新で解消するか確認');
  await responseDialog.getByRole('button', { name: '1件を変更' }).click();
  // investigating is stored as before and shown under the 対応中 stage.
  await expect(page.getByRole('status')).toContainText('1件の対応状況を「対応中（調査中）」にしました');
  await expect(queue).toContainText('対応中（調査中）');
  await expect(page.getByRole('region', { name: '既知の脆弱性への対応' })).toContainText('対応中 1件（調査中1）');
  await expect(queue).toContainText('メモ: vue の更新で解消するか確認');
  await page.getByRole('button', { name: '対策メモ' }).click();
  await expect(page.getByRole('textbox', { name: '対策メモ' })).toHaveValue(/# 脆弱性の対策メモ: photo-notes[\s\S]*## @vue\/shared@3\.5\.13（間接依存/);
  await page.screenshot({ path: 'docs/screenshots/queue-memo.png', animations: 'disabled' });
  await page.getByRole('dialog').getByRole('button', { name: '閉じる' }).first().click();
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/queue.png', fullPage: true, animations: 'disabled' });
  for (const [width, height] of [[1280, 800], [768, 1024], [375, 812]]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole('navigation', { name: 'メインメニュー' }).getByText('脆弱性と対応', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'photo-notesを再チェック', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `docs/screenshots/workflow-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'アドバイザリごと' }).click();
  await expect(page.getByRole('list', { name: 'アドバイザリごとの影響' })).toContainText('1アプリ · @vue/shared');
  // Untriaged projects are a small line under what is not checked yet, not a list of their own.
  await expect(page.getByRole('main')).toContainText('整理（任意）: 用途が未入力');
  await expect(page.getByRole('main')).toContainText('管理状態が未設定');
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/attention.png', fullPage: true, animations: 'disabled' });
  // #queue, the former 対応キュー address, opens the same screen under #attention.
  await openCatalog();
  await page.evaluate(() => { location.hash = 'queue'; });
  await expect(page).toHaveURL(/#attention$/);
  await expect(page.getByRole('heading', { name: '脆弱性と対応', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'アプリごとの脆弱性' })).toContainText('photo-notes');
  await openCatalog();
  // Switch the catalog to the folder tree. The choice is remembered after a reload.
  await page.getByRole('button', { name: 'フォルダ別', exact: true }).click();
  const tree = page.getByRole('region', { name: 'アプリのフォルダ別' });
  await expect(tree).toContainText('以下 · 2件');
  await expect(tree.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  await expect(tree.getByText('既知の脆弱性 1件（最大: 中）')).toBeVisible();
  await tree.getByRole('checkbox', { name: 'photo-notesを選択' }).check();
  await expect(page.getByText('1件を選択中')).toBeVisible();
  await page.getByRole('button', { name: '選択解除' }).click();
  await page.getByRole('textbox', { name: 'アプリを検索' }).fill('portal');
  await expect(tree).toContainText('検索・絞り込み中はすべて開いて表示します');
  await expect(tree.getByRole('link', { name: 'photo-notes', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'アプリを検索' }).fill('');
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: 'docs/screenshots/catalog-tree.png', animations: 'disabled' });
  await page.reload();
  await expect(page.getByRole('region', { name: 'アプリのフォルダ別' })).toBeVisible();
  for (const width of [768, 360]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '一覧', exact: true }).click();
  await expect(page.getByRole('region', { name: 'アプリのフォルダ別' })).toHaveCount(0);
  // Registered projects and folders can be excluded later: from a tree folder row, the selection bar, or the detail page.
  await page.getByRole('button', { name: 'フォルダ別', exact: true }).click();
  await page.getByRole('region', { name: 'アプリのフォルダ別' }).getByRole('checkbox', { name: 'photo-notesを選択' }).check();
  await page.getByRole('button', { name: '探索から除外' }).click();
  await expect(page.getByRole('dialog')).toContainText(/このフォルダを探索から除外[\s\S]*photo-notes[\s\S]*登録済みのアプリ 1件/);
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();
  await page.getByRole('button', { name: '選択解除' }).click();
  await page.getByRole('button', { name: '一覧', exact: true }).click();
  await page.getByRole('link', { name: 'personal-portal', exact: true }).click();
  await page.getByRole('button', { name: '探索から除外' }).click();
  const exclude = page.getByRole('dialog');
  await expect(exclude).toContainText('登録済みのアプリ 1件が含まれます');
  await exclude.getByRole('button', { name: '除外する' }).click();
  await expect(page.getByText('探索から除外しました')).toBeVisible();
  await expect(page.getByText(/除外設定のフォルダにあります。今後の探索では読み取りません/)).toBeVisible();
  await expect(page.getByRole('button', { name: '探索から除外' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Runs after the test above on the same server, or alone on an empty catalog. It adds its own sample to the fixture folder.
test('登録してチェック・送信前の確認・同じ内容の読み直しでは古くならない', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const folder = join(process.env.OWNDAPP_TEST_ROOT!, 'ledger-app');
  const lock = (version: string) => JSON.stringify({ name: 'ledger-app', lockfileVersion: 3, packages: {
    '': { name: 'ledger-app', dependencies: { vue: '^3.5.0' } },
    'node_modules/vue': { version, resolved: `https://registry.npmjs.org/vue/-/vue-${version}.tgz`, dependencies: { '@vue/shared': version } },
    'node_modules/@vue/shared': { version, resolved: `https://registry.npmjs.org/@vue/shared/-/shared-${version}.tgz` },
  } });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'ledger-app', dependencies: { vue: '^3.5.0' } }));
  writeFileSync(join(folder, 'package-lock.json'), lock('3.5.13'));
  const stale = page.getByText('依存内容が変わったため再照会が必要');

  await page.goto('/#discover');
  await page.getByRole('button', { name: 'フォルダを追加', exact: true }).click();
  const candidate = page.getByRole('checkbox', { name: 'ledger-appを登録候補に選択' });
  await expect(candidate).toBeVisible();
  // The folder and exclusion lists fold away; the shown result can still be scanned again.
  const folders = page.getByRole('list', { name: '登録した探索フォルダ' });
  await expect(folders).toBeVisible();
  await page.getByRole('button', { name: '探索フォルダと除外の一覧を隠す' }).click();
  await expect(folders).toBeHidden();
  await expect(page.getByRole('group', { name: '除外するフォルダ' })).toBeHidden();
  await expect(page.getByText('表示中の結果')).toBeVisible();
  await expect(page.getByRole('button', { name: /を再探索$/ })).toBeVisible();
  await page.getByRole('button', { name: '探索フォルダと除外の一覧を表示' }).click();
  await expect(folders).toBeVisible();

  await candidate.check();
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '登録してチェック' }).click();
  // Registered, back on the added projects, and nothing is sent until the confirmation is accepted.
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('今回登録した1件の依存');
  await page.screenshot({ path: 'docs/screenshots/register-check-confirm.png', animations: 'disabled' });
  await expect(confirm).toContainText('https://api.osv.dev');
  await expect(confirm).toContainText('フォルダのパス、アプリ名、ソース、lockファイル');
  await expect(page.getByText('今回追加したアプリを表示しています')).toBeVisible();
  await confirm.getByRole('button', { name: '1件を照会' }).click();
  await expect(page.getByRole('status')).toContainText('既知の脆弱性があるアプリは1件です');
  await expect(page.getByRole('heading', { name: '脆弱性と対応', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '登録したアプリ', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'ledger-app', exact: true }) });
  await expect(row).toContainText('既知の脆弱性 1件（最大: 中）');
  await expect(row).toContainText('時点');

  // Reading the same lock again keeps the result current. The background read after registering may also finish here.
  await expect(page.getByText(/依存情報を読み取り中/)).toHaveCount(0);
  await row.getByRole('checkbox', { name: 'ledger-appを選択' }).check();
  await page.getByRole('button', { name: '依存情報を読む' }).click();
  await expect(page.getByRole('status')).toContainText('1件の依存情報を読み取りました（完了1件）');
  await expect(row).toContainText('時点');
  await expect(stale).toHaveCount(0);
  await page.getByRole('link', { name: '脆弱性と対応', exact: true }).click();
  const queue = page.getByRole('list', { name: 'アプリごとの脆弱性' });
  await expect(queue).toContainText('ledger-app');
  await expect(stale).toHaveCount(0);
  await expect(page.getByRole('region', { name: /結果が古い/ })).toHaveCount(0);

  // The head of 脆弱性と対応 checks every project outside the archive, through the same confirmation.
  await page.getByRole('button', { name: /^監視対象\d+件をチェック$/ }).click();
  await expect(page.getByRole('dialog')).toContainText('監視対象（アーカイブ以外）の');
  await expect(page.getByRole('dialog')).toContainText('https://api.osv.dev');
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.screenshot({ path: 'docs/screenshots/stage2-workflow.png', fullPage: true, animations: 'disabled' });
  // A changed lock does make the result out of date, worded apart from a partial check.
  writeFileSync(join(folder, 'package-lock.json'), lock('3.5.14'));
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '登録したアプリ', exact: true }).click();
  await row.getByRole('checkbox', { name: 'ledger-appを選択' }).check();
  await page.getByRole('button', { name: '依存情報を読む' }).click();
  await expect(page.getByRole('status')).toContainText('1件の依存情報を読み取りました（完了1件）');
  await expect(row).toContainText('依存内容が変わったため再照会が必要');
  await expect(row).not.toContainText('一部を照会できていません');
  expect(errors).toEqual([]);
});


test('Swift未対応をlockなしや用途の未入力と混同しない', async ({ page }) => {
  const folder = join(process.env.OWNDAPP_TEST_ROOT!, 'unhandled-swift');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'Package.swift'), '// swift-tools-version: 6.0');
  await page.goto('/#discover');
  await page.getByRole('button', { name: 'フォルダを追加', exact: true }).click();
  await page.getByRole('checkbox', { name: 'unhandled-swiftを登録候補に選択' }).check();
  await page.getByRole('button', { name: '選択した候補を登録', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'unhandled-swift', exact: true }) });
  await expect(row).toContainText('依存解析は未対応');
  await row.getByRole('link', { name: 'unhandled-swift', exact: true }).click();
  await expect(page.getByText('依存解析は未対応', { exact: true })).toBeVisible();
  await expect(page.getByText(/SwiftPM の依存解析は未対応/)).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/unsupported-swift.png', animations: 'disabled' });
});

test('保存した探索を再開し、候補をDBから絞り込み、探索記録だけを削除できる', async ({ page, request }) => {
  const root = process.env.OWNDAPP_TEST_ROOT! + '-durable';
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < 240; i++) {
    const folder = join(root, `tool-${String(i).padStart(3, '0')}`); mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: `tool-${String(i).padStart(3, '0')}` }));
  }
  const session = await request.get('/api/session', { headers: { 'x-owndapp-client': 'web' } });
  const { token } = await session.json();
  const headers = { 'x-owndapp-client': 'web', 'x-owndapp-token': token };
  const created = await request.post('/api/scans', { headers, data: { root } });
  expect(created.status()).toBe(202); const { scan } = await created.json();
  await request.post(`/api/scans/${scan.id}/pause`, { headers, data: {} });
  await expect.poll(async () => (await (await request.get(`/api/scans/${scan.id}?limit=1`, { headers })).json()).scan.status).toBe('paused');
  await page.goto('/#discover');
  await expect(page.getByText('一時停止中', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '続きから再開' })).toBeVisible();
  await page.screenshot({ path: '/tmp/owndapp-discovery-paused-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '続きから再開' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/owndapp-discovery-paused-mobile.png' });
  await page.getByRole('button', { name: '続きから再開' }).click();
  await expect(page.getByText('探索完了', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('240件の候補', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /を登録候補に選択$/ })).toHaveCount(30);
  await page.getByRole('textbox', { name: '候補を絞り込み' }).fill('tool-239');
  await expect(page.getByRole('checkbox', { name: 'tool-239を登録候補に選択' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /を登録候補に選択$/ })).toHaveCount(1);
  await page.getByRole('checkbox', { name: 'tool-239を登録候補に選択' }).check();
  await page.getByRole('button', { name: '選択した候補を登録', exact: true }).click();
  await expect(page.getByRole('link', { name: 'tool-239', exact: true })).toBeVisible();
  await page.goto('/#discover');
  await page.getByRole('button', { name: '探索記録を削除…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '探索記録を削除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const catalog = await (await request.get('/api/projects', { headers })).json();
  expect(catalog.projects.some((p: { name: string }) => p.name === 'tool-239')).toBe(true);
});

test('探索・除外フォルダをパス入力で追加し、無効な入力を保持して修正できる', async ({ page }) => {
  const root = process.env.OWNDAPP_TEST_ROOT! + '-path input 日本語';
  mkdirSync(join(root, 'ignored folder'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"path-input"}');
  await page.goto('/#discover');
  await page.getByRole('button', { name: '探索フォルダをパスで追加', exact: true }).click();
  const dialog = page.getByRole('dialog'); const input = dialog.getByRole('textbox', { name: 'フォルダのパス' });
  await expect(dialog.getByRole('button', { name: '追加して探索' })).toBeDisabled();
  await input.fill(join(root, 'not-found'));
  await input.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('フォルダが見つからない');
  await expect(input).toHaveValue(join(root, 'not-found'));
  await input.fill(root);
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('探索完了', { exact: true })).toBeVisible();
  const expand = page.getByRole('button', { name: '探索フォルダと除外の一覧を表示' });
  if (await expand.count()) await expand.click();
  await expect(page.getByRole('list', { name: '登録した探索フォルダ' })).toContainText(root);
  await expect(page.getByRole('list', { name: '登録した探索フォルダ' }).getByRole('listitem').filter({ hasText: 'path input 日本語' })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: '除外フォルダをパスで追加', exact: true }).click();
  await input.fill(join(root, 'ignored folder'));
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/owndapp-folder-path-mobile.png' });
  await page.route('**/api/scans/*', route => route.request().method() === 'GET' ? route.fulfill({ status: 503, json: { error: 'テスト用の再表示失敗' } }) : route.continue());
  await dialog.getByRole('button', { name: '除外フォルダを追加', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: '除外するフォルダ', exact: true })).toContainText('ignored folder');
  await expect(page.getByRole('alert')).toContainText('除外設定は保存しましたが');
  await page.unroute('**/api/scans/*');
});

test('重大度不明は要確認として絞り込め、緊急を先に表示する', async ({ page, request }) => {
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const { projects } = await (await request.get('/api/projects', { headers: { ...headers, 'x-owndapp-token': token } })).json();
  const project = projects.find((p: any) => p.lifecycle !== 'archived');
  expect(project).toBeTruthy();
  const advisories = Object.fromEntries(['unknown', 'critical'].map(severity => [severity, { id: `GHSA-ui-${severity}`, aliases: [], summary: `表示テスト ${severity}`, severity, severitySource: severity === 'critical' ? 'CVSS v3.1' : null, severityScore: severity === 'critical' ? 9.8 : null, cvss: null, fixed: null, published: null, modified: null, references: [], detailsAvailable: severity === 'critical' }]));
  const items = ['unknown', 'critical'].map(severity => ({ projectId: project.id, advisoryId: advisories[severity].id, advisoryKey: severity, dependencies: [{ ecosystem: 'npm', name: 'fixture-package', version: '1.0.0', requested: null, direct: true, scope: 'dev', file: 'package-lock.json', component: '' }], status: 'open', note: '', reviewBy: null, updatedAt: null, resolvedAt: null, priority: severity === 'critical' ? 'high' : 'review', needsReview: severity === 'unknown', priorityReason: severity === 'critical' ? '緊急の脆弱性が報告されています。' : '重大度を判定できません。' }));
  await page.route('**/api/queue', route => route.fulfill({ json: { advisories, items, projects: { [project.id]: { checkedAt: '2026-10-26T00:00:00Z', stale: false } } } }));
  await page.goto('/#attention');
  const queue = page.getByRole('list', { name: 'アプリごとの脆弱性' });
  await expect(queue).toContainText('優先度要確認 1');
  await queue.getByRole('button', { name: `${project.name}を開く`, exact: true }).click();
  await expect(queue).toContainText('重大度・詳細情報の確認が必要');
  expect(await queue.getByText(/GHSA-ui-/).allTextContents()).toEqual(expect.arrayContaining(['GHSA-ui-critical', 'GHSA-ui-unknown']));
  const text = await queue.innerText();
  expect(text.indexOf('GHSA-ui-critical')).toBeLessThan(text.indexOf('GHSA-ui-unknown'));
  await page.getByRole('combobox', { name: '優先度で絞り込み' }).selectOption('review');
  await expect(queue).toContainText('GHSA-ui-unknown');
  await expect(queue).not.toContainText('GHSA-ui-critical');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/severity-review-narrow.png', fullPage: true, animations: 'disabled' });
});

test('詳細のプロジェクト全体の対応を変更し、個別記録を保持して一覧と同期する', async ({ page, request }) => {
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const auth = { ...headers, 'x-owndapp-token': token };
  const { projects } = await (await request.get('/api/projects', { headers: auth })).json();
  const project = projects.find((p: any) => p.name === 'photo-notes');
  expect(project).toBeTruthy();
  let fail = true;
  await page.route('**/api/queue?project=*', route => {
    if (fail) return route.fulfill({ status: 503, json: { error: 'テスト用の取得失敗' } });
    return route.continue();
  });
  await page.goto(`/#project/${project.id}`);
  const detail = page.getByRole('region', { name: 'プロジェクト全体の対応状況', exact: true });
  await expect(page.getByRole('region', { name: /既知の脆弱性の詳細/ }).getByRole('button', { name: /対応状況/ })).toHaveCount(0);
  await expect(detail.getByRole('alert')).toContainText('対応状況を取得できませんでした');
  await expect(detail.getByRole('button', { name: /の対応状況を変更/ })).toHaveCount(0);
  fail = false;
  await detail.getByRole('button', { name: '対応状況を再取得' }).click();
  await expect(detail).toContainText('対応状況: 対応中（調査中）');
  await detail.getByRole('button', { name: 'プロジェクトの対応状況を変更' }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('対応状況')).toHaveValue('investigating');
  await expect(dialog).toContainText('photo-notes');
  await expect(dialog.getByLabel('メモ（任意）')).toHaveCount(0);
  await expect(dialog.getByLabel('対応状況').locator('option[value="resolved"]')).toHaveCount(0);
  await dialog.getByLabel('対応状況').selectOption('not-applicable');
  await dialog.getByLabel('プロジェクト全体を対象外にする根拠').fill('成果物に含まれないことを確認したテスト記録');
  await dialog.getByLabel('見直す日（任意）').fill('2027-01-31');
  await page.route('**/api/projects/*/response', route => route.fulfill({ status: 409, json: { error: '照会結果が変わりました' } }));
  await dialog.getByRole('button', { name: 'プロジェクト全体を変更' }).click();
  await expect(dialog.getByRole('alert')).toContainText('照会結果が変わりました');
  await expect(dialog.getByLabel('見直す日（任意）')).toHaveValue('2027-01-31');
  await page.unroute('**/api/projects/*/response');
  await dialog.getByRole('button', { name: 'プロジェクト全体を変更' }).click();
  await expect(detail).toContainText('対応状況: 対象外');
  await detail.getByRole('button', { name: 'プロジェクトの対応状況を変更' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('プロジェクト全体を対象外にする根拠')).toHaveValue('成果物に含まれないことを確認したテスト記録');
  await expect(dialog.getByLabel('見直す日（任意）')).toHaveValue('2027-01-31');
  await dialog.getByLabel('対応状況').selectOption('fixing');
  fail = true;
  await dialog.getByRole('button', { name: 'プロジェクト全体を変更' }).click();
  await expect(detail.getByRole('alert')).toContainText('変更は保存しましたが、表示を更新できませんでした');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  fail = false;
  await detail.getByRole('button', { name: '対応状況を再取得' }).click();
  await expect(detail).toContainText('対応状況: 対応中');
  await page.setViewportSize({ width: 390, height: 844 });
  await detail.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/detail-response-narrow.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('link', { name: '脆弱性と対応', exact: true }).click();
  const queue = page.getByRole('list', { name: 'アプリごとの脆弱性' });
  await queue.getByRole('button', { name: 'photo-notesを開く', exact: true }).click();
  await expect(queue).toContainText('メモ: 成果物に含まれないことを確認したテスト記録');
  // A completed recheck's empty finding list must still allow the saved resolved response to be read.
  const wire = await (await request.get(`/api/queue?project=${project.id}`, { headers: auth })).json();
  wire.items.forEach((item: any) => { item.status = 'resolved'; });
  await page.unroute('**/api/queue?project=*');
  await page.route('**/api/queue?project=*', route => route.fulfill({ json: wire }));
  const data = await (await request.get(`/api/projects/${project.id}/vulnerabilities`, { headers: auth })).json();
  data.check.findings = [];
  await page.route(`**/api/projects/${project.id}/vulnerabilities`, route => route.fulfill({ json: data }));
  await page.goto(`/#project/${project.id}`);
  await expect(detail).toContainText('対応状況: 完了');
  await expect(detail.getByRole('button', { name: /の対応状況を変更/ })).toHaveCount(0);
  await page.unroute(`**/api/projects/${project.id}/vulnerabilities`);
  let recordFailure = true;
  await page.route(`**/api/projects/${project.id}/vulnerabilities`, route => recordFailure ? route.fulfill({ status: 503, json: { error: 'テスト用の記録取得失敗' } }) : route.fulfill({ json: data }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('脆弱性の記録を取得できませんでした');
  await expect(page.getByText('既知の脆弱性は未照会です', { exact: true })).toHaveCount(0);
  recordFailure = false;
  await page.getByRole('button', { name: '脆弱性の記録を再取得' }).click();
  await expect(detail).toContainText('対応状況: 完了');
});

test('ホームで次の作業と取得失敗を区別し、使い方とフォルダ設定へ進める', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const { projects } = await (await request.get('/api/projects', { headers: { ...headers, 'x-owndapp-token': token } })).json();
  const active = projects.filter((p: any) => p.lifecycle !== 'archived').slice(0, 2);
  let fail = false, malformed = false;
  await page.route('**/api/queue', route => fail ? route.fulfill({ status: 503, json: { error: 'ホームの取得失敗テスト' } }) : route.fulfill({ json: malformed ? { items: [], advisories: null } : {
    advisories: { critical: { severity: 'critical' }, unknown: { severity: 'unknown' } },
    items: active.map((p: any, i: number) => ({ projectId: p.id, advisoryId: `GHSA-home-${i}`, advisoryKey: i ? 'unknown' : 'critical', status: 'open', priority: i ? 'review' : 'high' })),
  } }));
  await page.goto('/#home');
  await expect(page.getByRole('heading', { name: '次にやること', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: '次にやること' })).toContainText('優先度 高 1件');
  await expect(page.getByRole('button', { name: '重大なものから対応する' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/home-maintenance.png', fullPage: true, animations: 'disabled' });
  fail = true;
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('ホームの取得失敗テスト');
  await expect(page.getByText('未完了の対応記録はありません', { exact: true })).toHaveCount(0);
  fail = false; malformed = true;
  await page.getByRole('button', { name: 'もう一度読み込む' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  malformed = false;
  await page.getByRole('button', { name: 'もう一度読み込む' }).click();
  await expect(page.getByRole('button', { name: '重大なものから対応する' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const nav = page.getByRole('navigation', { name: 'メインメニュー' });
  for (const label of ['ホーム', 'アプリを追加', '登録したアプリ', '脆弱性と対応', '依存検索', '設定・使い方']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/home-maintenance-narrow.png', fullPage: true, animations: 'disabled' });
  await nav.getByRole('link', { name: '設定・使い方', exact: true }).click();
  const guide = page.getByRole('region', { name: '使い方', exact: true });
  await expect(guide.getByRole('heading', { level: 3 })).toHaveCount(6);
  await guide.getByText('インストールと更新', { exact: true }).click();
  await expect(guide).toContainText('npm ci --ignore-scripts');
  await page.getByRole('button', { name: '探索・除外フォルダを管理' }).click();
  await expect(page.getByRole('heading', { name: 'アプリを追加', level: 1, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('登録後の次の操作を案内し、除外とカタログ登録解除を一度に選べる', async ({ page, request }) => {
  const root = process.env.OWNDAPP_TEST_ROOT! + '-cleanup';
  mkdirSync(root, { recursive: true });
  const manifest = join(root, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: 'cleanup-demo' }));
  await page.goto('/#discover');
  await page.getByRole('button', { name: '探索フォルダをパスで追加' }).click();
  await page.getByRole('dialog').getByLabel('フォルダのパス').fill(root);
  await page.getByRole('dialog').getByRole('button', { name: '追加して探索' }).click();
  await expect(page.getByText('探索完了', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'cleanup-demoを登録候補に選択' }).check();
  await page.getByRole('button', { name: '選択した候補を登録', exact: true }).click();
  const next = page.getByRole('region', { name: '登録後の次のステップ' });
  await expect(next.getByRole('button', { name: '登録したアプリの脆弱性をチェック' })).toBeVisible();
  await expect(next).toContainText('用途・タグの入力は任意');
  await page.getByRole('checkbox', { name: 'cleanup-demoを選択' }).check();
  await page.getByRole('button', { name: '探索から除外', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const choice = dialog.getByRole('checkbox', { name: 'このフォルダ内の登録済みアプリもカタログから外す' });
  await expect(choice).not.toBeChecked();
  await choice.check();
  await expect(dialog).toContainText('元のソースファイルは削除しません');
  await page.route('**/api/projects/remove-excluded', route => route.fulfill({ status: 503, json: { error: '登録解除の取得失敗テスト' } }));
  await dialog.getByRole('button', { name: '除外する', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('除外設定は保存済み');
  await expect(choice).toBeChecked();
  await page.unroute('**/api/projects/remove-excluded');
  await dialog.getByRole('button', { name: '除外する', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('1件をカタログから外しました');
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const { projects } = await (await request.get('/api/projects', { headers: { ...headers, 'x-owndapp-token': token } })).json();
  expect(projects.some((p: any) => p.name === 'cleanup-demo')).toBeFalsy();
  await expect(page.getByRole('link', { name: 'photo-notes', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '登録後の次のステップ' })).toHaveCount(0);
  expect(JSON.parse(readFileSync(manifest, 'utf8')).name).toBe('cleanup-demo');
});


test('メインメニューから依存検索を開き、部分名でスコープ付きパッケージを探せる', async ({ page }) => {
  await page.goto('/#home');
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '依存検索', exact: true }).click();
  await expect(page.getByRole('heading', { name: '依存検索', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByLabel('名前の一致方法')).toHaveValue('contains');
  await page.getByLabel('パッケージ名', { exact: true }).fill('SHARED');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByRole('region', { name: '検索結果', exact: true })).toContainText('@vue/shared');
  await page.getByLabel('名前の一致方法').selectOption('exact');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByRole('heading', { name: /の範囲では見つかりません/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/dependency-search-narrow.png', fullPage: true, animations: 'disabled' });
});

test('複数の脆弱性があっても詳細の対応操作はプロジェクトに1つだけ', async ({ page, request }) => {
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const auth = { ...headers, 'x-owndapp-token': token };
  const { projects } = await (await request.get('/api/projects', { headers: auth })).json();
  const project = projects.find((p: any) => p.name === 'photo-notes');
  const wire = await (await request.get(`/api/queue?project=${project.id}`, { headers: auth })).json();
  const first = wire.items.find((item: any) => item.status !== 'resolved');
  const secondKey = 'project-response-second';
  const secondId = 'GHSA-project-second';
  wire.advisories[secondKey] = { ...wire.advisories[first.advisoryKey], id: secondId };
  first.status = 'open'; first.note = '個別メモA';
  wire.items = [first, { ...first, advisoryId: secondId, advisoryKey: secondKey, status: 'fixing', note: '個別メモB' }];
  await page.route('**/api/queue?project=*', route => route.fulfill({ json: wire }));
  const data = await (await request.get(`/api/projects/${project.id}/vulnerabilities`, { headers: auth })).json();
  data.check.findings[0].advisories.push({ ...data.check.findings[0].advisories[0], id: secondId });
  await page.route(`**/api/projects/${project.id}/vulnerabilities`, route => route.fulfill({ json: data }));
  let posted = false;
  await page.route(`**/api/projects/${project.id}/response`, route => {
    const body = route.request().postDataJSON();
    expect(body.ids.sort()).toEqual([first.advisoryId, secondId].sort());
    expect(body.status).toBe('fixing'); expect(body.note).toBeUndefined();
    posted = true;
    wire.items.forEach((item: any) => { item.status = 'fixing'; });
    return route.fulfill({ json: { updated: 2 } });
  });
  await page.goto(`/#project/${project.id}`);
  const panel = page.getByRole('region', { name: 'プロジェクト全体の対応状況', exact: true });
  await expect(panel).toContainText('対応状況: 未対応');
  await expect(panel.getByRole('list', { name: '対応の内訳' })).toContainText('未対応 1件');
  await expect(panel.getByRole('button', { name: 'プロジェクトの対応状況を変更' })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'プロジェクトの対応状況を変更' })).toBeInViewport();
  await expect(page.getByRole('region', { name: /既知の脆弱性の詳細/ }).getByRole('button', { name: /対応状況/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'プロジェクトの対応状況を変更' }).click();
  await page.getByRole('dialog').getByLabel('対応状況').selectOption('fixing');
  await page.getByRole('dialog').getByRole('button', { name: 'プロジェクト全体を変更' }).click();
  await expect(panel).toContainText('対応状況: 対応中');
  await expect(panel.getByRole('list', { name: '対応の内訳' })).toContainText('対応中 2件');
  expect(posted).toBeTruthy();
  expect(wire.items.map((item: any) => item.note)).toEqual(['個別メモA', '個別メモB']);
});


test('RustのBrotliを部分名検索でき、未対応形式の範囲を表示する', async ({ page }) => {
  const root = process.env.OWNDAPP_TEST_ROOT! + '-rust';
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="rust-brotli-demo"\nversion="0.1.0"\n[dependencies]\nbrotli="3"\n');
  writeFileSync(join(root, 'Cargo.lock'), 'version=3\n[[package]]\nname="rust-brotli-demo"\nversion="0.1.0"\ndependencies=["brotli"]\n[[package]]\nname="brotli"\nversion="3.3.4"\nsource="registry+https://github.com/rust-lang/crates.io-index"\ndependencies=["brotli-decompressor"]\n[[package]]\nname="brotli-decompressor"\nversion="2.3.4"\nsource="registry+https://github.com/rust-lang/crates.io-index"\n');
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version: 6.0\n');
  await page.goto('/#discover');
  await page.getByRole('button', { name: '探索フォルダをパスで追加', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'フォルダのパス' }).fill(root);
  await page.getByRole('dialog').getByRole('button', { name: '追加して探索' }).click();
  await expect(page.getByText('探索完了', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'rust-brotli-demoを登録候補に選択' }).check();
  await page.getByRole('button', { name: '選択した候補を登録', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'rust-brotli-demo', exact: true }) });
  await expect(row).toContainText('一部');
  await page.goto('/#dependencies');
  await page.getByLabel('パッケージ名', { exact: true }).fill('Brotli');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  const results = page.getByRole('region', { name: '検索結果', exact: true });
  await expect(results).toContainText('rust-brotli-demo');
  await expect(results).toContainText('brotli-decompressor');
  await expect(results).toContainText('3.3.4');
  await expect(results).toContainText('Rust');
  await expect(page.getByText(/未対応の依存形式を含む/)).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/dependency-search-cargo.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

// Generated catalog responses isolate selection/pagination/failure behavior from the user's DB.
test('検索範囲を絞り込み、ページ内で選択し、アーカイブを明示して対象だけ再読取する', async ({ page, request }) => {
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const { projects: existing } = await (await request.get('/api/projects', { headers: { ...headers, 'x-owndapp-token': token } })).json();
  const base = existing[0];
  const projects: any[] = Array.from({ length: 30 }, (_, i) => ({ ...base, id: `coverage-${i}`, name: `coverage-${String(i).padStart(2, '0')}`, path: `/fixture/未確認/${i}`, lifecycle: 'maintained', missing: false, excluded: false, dependencyStatus: undefined, dependencyUnsupported: 0, dependenciesReadAt: undefined, vulnerabilities: undefined }));
  projects.push({ ...projects[0], id: 'coverage-archive', name: 'coverage-archive', lifecycle: 'archived' });
  projects.push({ ...projects[0], id: 'coverage-missing', name: 'coverage-missing', missing: true });
  projects.push({ ...projects[0], id: 'coverage-excluded', name: 'coverage-excluded', excluded: true });
  projects.push({ ...projects[0], id: 'coverage-unsupported', name: 'coverage-unsupported', dependencyStatus: 'failed', dependencyUnsupported: 1 });
  await page.route('**/api/projects', route => route.fulfill({ json: { projects } }));
  await page.route('**/api/dependencies/progress', route => route.fulfill({ json: { running: false, done: 0, total: 0 } }));
  let fail = true; const sent: string[][] = [];
  await page.route('**/api/dependencies/read', async route => {
    const { ids } = route.request().postDataJSON(); sent.push(ids);
    if (fail) return route.fulfill({ status: 503, json: { error: 'テスト用の読み取り失敗' } });
    for (const id of ids) { const p = projects.find(p => p.id === id)!; p.dependencyStatus = 'complete' as any; p.dependenciesReadAt = '2026-10-26T12:00:00Z' as any; }
    return route.fulfill({ json: { results: ids.map((id: string) => ({ id, name: id, status: 'complete' })) } });
  });
  await page.goto('/#dependencies');
  const panel = page.getByRole('region', { name: '依存の検索範囲', exact: true });
  await panel.getByText('検索対象外・未確認のアプリを確認', { exact: true }).click();
  const selectAll = panel.getByRole('checkbox', { name: '表示中の読み取り可能なアプリをすべて選択', exact: true });
  await selectAll.check();
  await expect(panel.getByRole('button', { name: '選択した25件の依存を読み取る', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '次へ', exact: true }).click();
  await expect(panel.getByRole('button', { name: '選択した0件の依存を読み取る', exact: true })).toBeDisabled();
  await expect(panel.getByRole('checkbox', { name: 'coverage-missingの依存を読み取る対象に選択', exact: true })).toBeDisabled();
  await expect(panel.getByRole('checkbox', { name: 'coverage-excludedの依存を読み取る対象に選択', exact: true })).toBeDisabled();
  await panel.getByLabel('アプリ名・パスで絞り込み', { exact: true }).fill('archive');
  await expect(panel.getByRole('link', { name: 'coverage-archive', exact: true })).toHaveCount(0);
  await panel.getByRole('checkbox', { name: 'アーカイブも含める', exact: true }).check();
  await expect(panel.getByRole('link', { name: 'coverage-archive', exact: true })).toBeVisible();
  await selectAll.check();
  await panel.getByRole('button', { name: '選択した1件の依存を読み取る', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('テスト用の読み取り失敗');
  await expect(panel.getByRole('checkbox', { name: 'coverage-archiveの依存を読み取る対象に選択', exact: true })).toBeChecked();
  fail = false;
  await panel.getByRole('button', { name: '選択した1件の依存を読み取る', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('完了1件');
  expect(sent).toEqual([['coverage-archive'], ['coverage-archive']]);
  await panel.getByLabel('アプリ名・パスで絞り込み', { exact: true }).fill('unsupported');
  await panel.getByLabel('読み取り状態', { exact: true }).selectOption('unsupported');
  await expect(panel.getByRole('link', { name: 'coverage-unsupported', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/dependency-coverage-narrow.png', fullPage: true, animations: 'disabled' });
});

test('同じ件数の依存を読み直しても、最後に実行した検索とパッケージ一覧を更新する', async ({ page, request }) => {
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const { projects } = await (await request.get('/api/projects', { headers: { ...headers, 'x-owndapp-token': token } })).json();
  const project = { ...projects[0], id: 'coverage-refresh', name: 'coverage-refresh', lifecycle: 'maintained', missing: false, excluded: false, dependencyStatus: 'complete', dependencyUnsupported: 0, dependenciesReadAt: '2026-10-25T00:00:00Z', vulnerabilities: undefined };
  let updated = false; const searches: string[] = [];
  await page.route('**/api/projects', route => route.fulfill({ json: { projects: [project] } }));
  await page.route('**/api/dependencies/progress', route => route.fulfill({ json: { running: false, done: 0, total: 0 } }));
  const dependency = { ecosystem: 'crates.io', name: 'brotli', version: '3.3.4', requested: '3', direct: true, scope: 'prod', source: 'registry', file: 'Cargo.lock', component: '' };
  await page.route('**/api/dependencies/search?*', route => {
    searches.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { coverage: { read: 1, total: 1, withLock: 1, unsupported: 0 }, matches: updated ? [{ project, readAt: project.dependenciesReadAt, status: 'complete', dependencies: [dependency] }] : [] } });
  });
  await page.route('**/api/dependencies/packages?*', route => route.fulfill({ json: { total: 1, packages: [{ ecosystem: 'crates.io', name: updated ? 'brotli' : 'old-package', projects: 1, directProjects: 1, versions: ['3.3.4'] }] } }));
  await page.route('**/api/dependencies/read', route => {
    expect(route.request().postDataJSON().ids).toEqual([project.id]);
    updated = true; project.dependenciesReadAt = '2026-10-26T12:00:00Z';
    return route.fulfill({ json: { results: [{ id: project.id, name: project.name, status: 'complete' }] } });
  });
  await page.goto('/#dependencies');
  await page.getByLabel('パッケージ名', { exact: true }).fill('Brotli');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await expect(page.getByRole('heading', { name: /の範囲では見つかりません/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'old-package', exact: true })).toBeVisible();
  // Editing the form is not a new search. Refresh must use the submitted query and matching mode.
  await page.getByLabel('パッケージ名', { exact: true }).fill('not-submitted');
  await page.getByLabel('名前の一致方法').selectOption('exact');
  const panel = page.getByRole('region', { name: '依存の検索範囲', exact: true });
  await panel.getByText('検索対象外・未確認のアプリを確認', { exact: true }).click();
  await panel.getByLabel('読み取り状態', { exact: true }).selectOption('all');
  await panel.getByRole('checkbox', { name: 'coverage-refreshの依存を読み取る対象に選択', exact: true }).check();
  await panel.getByRole('button', { name: '選択した1件の依存を読み取る', exact: true }).click();
  await expect(page.getByRole('region', { name: '検索結果', exact: true })).toContainText('brotli@3.3.4');
  await expect(page.getByRole('button', { name: 'brotli', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'old-package', exact: true })).toHaveCount(0);
  expect(searches).toHaveLength(2);
  expect(searches.every(search => search.includes('name=Brotli') && search.includes('match=contains'))).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/dependency-coverage.png', fullPage: true, animations: 'disabled' });
});

test('生成したCargo.lockの変更を選択読取で実際に取り込み、検索へ反映する', async ({ page, request }) => {
  const root = process.env.OWNDAPP_TEST_ROOT! + '-rust';
  const lock = join(root, 'Cargo.lock');
  writeFileSync(lock, readFileSync(lock, 'utf8').replaceAll('3.3.4', '3.3.5'));
  let reads = 0; const externalChecks: string[] = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().endsWith('/api/dependencies/read')) reads++;
    if (req.method() === 'POST' && req.url().includes('/api/vulnerabilities/')) externalChecks.push(req.url());
  });
  await page.goto('/#dependencies');
  await page.getByLabel('パッケージ名', { exact: true }).fill('Brotli');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  const results = page.getByRole('region', { name: '検索結果', exact: true });
  await expect(results).toContainText('brotli@3.3.4');
  const panel = page.getByRole('region', { name: '依存の検索範囲', exact: true });
  await panel.getByText('検索対象外・未確認のアプリを確認', { exact: true }).click();
  await panel.getByLabel('アプリ名・パスで絞り込み', { exact: true }).fill('rust-brotli-demo');
  await panel.getByRole('checkbox', { name: 'rust-brotli-demoの依存を読み取る対象に選択', exact: true }).check();
  await panel.getByRole('button', { name: '選択した1件の依存を読み取る', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('一部失敗1件');
  await expect(results).toContainText('brotli@3.3.5');
  await expect(results).not.toContainText('brotli@3.3.4');
  expect(reads).toBe(1); expect(externalChecks).toEqual([]);
  expect(readFileSync(lock, 'utf8')).toContain('3.3.5');
  const headers = { 'x-owndapp-client': 'web' };
  const { token } = await (await request.get('/api/session', { headers })).json();
  const response = await request.get('/api/dependencies/search?name=brotli&match=exact', { headers: { ...headers, 'x-owndapp-token': token } });
  expect((await response.json()).matches[0].dependencies[0].version).toBe('3.3.5');
});

test('Windowsの機能情報ではパス入力を案内し、macOS専用操作を表示しない', async ({ page }) => {
  const native: string[] = [];
  page.on('request', req => { if (/\/api\/(folder-picker|apps\/pick|projects\/[^/]+\/(open|reveal))$/.test(req.url())) native.push(req.url()); });
  await page.route('**/api/session', async route => {
    const response = await route.fetch(); const data = await response.json();
    return route.fulfill({ json: { ...data, capabilities: { platform: 'win32', folderPicker: false, revealFolder: false, externalApps: false } } });
  });
  await page.goto('/#discover');
  await expect(page.getByRole('button', { name: 'フォルダを追加', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '除外するフォルダを追加', exact: true })).toHaveCount(0);
  await expect(page.getByText('フォルダのパスを直接入力して追加します。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '探索フォルダをパスで追加', exact: true }).click();
  const dialog = page.getByRole('dialog'); const input = dialog.getByRole('textbox', { name: 'フォルダのパス' });
  await expect(input).toHaveAttribute('placeholder', String.raw`C:\Users\名前\Projects`);
  const path = String.raw`C:\Users\名前\My Projects`;
  let posted = '';
  await page.route('**/api/scans', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posted = route.request().postDataJSON().root;
    return route.fulfill({ status: 400, json: { error: 'Windowsパス受け取りテスト：実Windowsのファイルシステムは使用していません' } });
  });
  await input.fill(path); await dialog.getByRole('button', { name: '追加して探索' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Windowsパス受け取りテスト');
  expect(posted).toBe(path); await expect(input).toHaveValue(path);
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await page.getByRole('navigation', { name: 'メインメニュー' }).getByRole('link', { name: '設定・使い方', exact: true }).click();
  await expect(page.getByText(/このOSではエディタ・ターミナルの登録と起動は利用できません/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'アプリを選ぶ', exact: true })).toHaveCount(0);
  await page.goto('/#catalog');
  await expect(page.getByRole('button', { name: /Finderで表示/ })).toHaveCount(0);
  const first = page.getByRole('table').getByRole('link').first();
  const href = await first.getAttribute('href'); await page.goto('/' + href);
  await expect(page.getByRole('button', { name: 'Finderで表示', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'エディタ・ターミナルを登録', exact: true })).toHaveCount(0);
  expect(native).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/windows-path-only.png', fullPage: true, animations: 'disabled' });
});

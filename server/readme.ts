import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { readSafe } from './scanner.js';

// Derives a project's purpose from its own files, on this Mac only. Nothing is sent anywhere and no file is written.
const readmeLimit = 512 * 1024;
const maxLength = 200;

// Sentences that project generators put in every README. They say how the project was made, not what it is for.
const boilerplate = [
  /bootstrapped with \[?create[- ]react[- ]app/i, /bootstrapped with \[?`?create-next-app/i, /this template (should help|provides a minimal setup)/i,
  /^getting started with create react app/i, /look at the \[?nuxt/i, /^a new flutter (project|module|package|plugin)/i, /^this project was generated with \[?angular cli/i,
  /^laravel is a web application framework/i, /^welcome to your new (app|project)/i, /^this is a \[?next\.js\]? project/i, /^vue 3 \+ (vite|typescript)/i,
  /^manifest\.json description$/i, /^react \+ (typescript \+ )?vite/i, /^a few resources to get you started/i, /^to learn more about/i, /^you can start editing/i, /^to install dependencies:?$/i, /^(an? )?(sam|aws sam) (application|project) that/i, /^this project contains source code and supporting files for a serverless application/i,
];
const isBoilerplate = (text: string) => boilerplate.some(pattern => pattern.test(text.trim()));
// Generator READMEs. Text from one of these markers on is the generator's, so only a description written above it counts.
const templateMarkers = [
  /create[- ]react[- ]app/i, /create-next-app/i, /starting point for a flutter (application|project)/i, /a new flutter (project|module|package|plugin)/i,
  /get(ting)? you started (developing|with) vue/i, /\bvolar\b/i, /supporting files for a serverless application/i, /\bsam cli\b/i,
  /generated with \[?angular cli/i, /nuxt (documentation|docs)/i, /laravel is a web application framework/i, /minimal setup to get react working in vite/i,
  /first, run the development server/i, /in the project directory, you can run/i, /the application uses several aws resources/i,
  /below is a brief explanation of what we have generated/i, /here is a short description of the plugin/i,
];
const isTemplate = (text: string) => templateMarkers.some(pattern => pattern.test(text));

/** Markdown inline syntax to plain text: links keep their label, images and HTML tags go. */
function plain(text: string) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keeps whole sentences up to the limit; cuts with an ellipsis only when the first sentence is already too long. */
function shorten(text: string) {
  if (text.length <= maxLength) return text;
  const sentences = text.match(/[^。．.!?！？]+[。．.!?！？]+(\s|$)|[^。．.!?！？]+$/g) || [text];
  let result = '';
  for (const sentence of sentences) {
    if ((result + sentence).trim().length > maxLength) break;
    result += sentence;
  }
  return result.trim() || `${text.slice(0, maxLength - 1).trim()}…`;
}

/** The first paragraph of prose in a README, skipping front matter, headings, badges, images, code, tables, lists and HTML blocks. */
export function purposeFromReadme(markdown: string): string | null {
  const lines = markdown.replace(/^﻿/, '').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  let fence = false; let paragraph: string[] = [];
  const candidates: string[] = [];
  const flush = () => { if (paragraph.length) candidates.push(plain(paragraph.join(' '))); paragraph = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fence = !fence; flush(); continue; }
    if (fence) continue;
    const skip = !line || /^#{1,6}\s/.test(line) || /^[=-]{3,}$/.test(line) || /^\|/.test(line) || /^(\*|-|\+|\d+\.)\s/.test(line) || /^>/.test(line) ||
      /^<\/?(p|div|h\d|img|a|br|picture|source|table|details|summary|center)\b/i.test(line) || /^\[!\[/.test(line) || /^!\[/.test(line) || /^\[[^\]]+\]:\s/.test(line) || /^ {4}/.test(raw) ||
      // WordPress readme.txt: "=== Name ===" headings and "Contributors: ..." header fields.
      /^=+ .* =+$/.test(line) || /^[A-Z][A-Za-z ]{1,30}:\s/.test(line);
    if (skip) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  for (const text of candidates) {
    if (isTemplate(text)) return null;
    // Prose needs some words: a line of links or symbols is not a description.
    if (text.replace(/[\s\p{P}\p{S}]/gu, '').length < 8 || isBoilerplate(text)) continue;
    return shorten(text);
  }
  return null;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** description fields of common manifests, in this order. */
const manifests: [string, (text: string) => unknown][] = [
  ['package.json', text => object(JSON.parse(text)).description],
  ['composer.json', text => object(JSON.parse(text)).description],
  ['pyproject.toml', text => object(object(parseToml(text)).project).description],
  ['Cargo.toml', text => object(object(parseToml(text)).package).description],
  ['pubspec.yaml', text => object(parseDocument(text).toJS()).description],
];

export interface PurposeSuggestion { text: string; source: string }

/** A README's first paragraph, or else a manifest description. null when neither says anything useful. */
export async function suggestPurpose(projectPath: string): Promise<PurposeSuggestion | null> {
  const names = await readdir(projectPath).catch(() => [] as string[]);
  const readmes = names.filter(name => /^readme(\.(md|markdown|txt|rst))?$/i.test(name)).sort((a, b) => Number(!/\.md$/i.test(a)) - Number(!/\.md$/i.test(b)));
  for (const name of readmes) {
    const text = await readSafe(projectPath, join(projectPath, name), readmeLimit).catch(() => null);
    const purpose = text && purposeFromReadme(text);
    if (purpose) return { text: purpose, source: name };
  }
  for (const [name, describe] of manifests) {
    if (!names.includes(name)) continue;
    try {
      const value = describe(await readSafe(projectPath, join(projectPath, name), 2 * 1024 * 1024));
      if (typeof value === 'string' && plain(value).replace(/[\s\p{P}\p{S}]/gu, '').length >= 4 && !isBoilerplate(value)) return { text: shorten(plain(value)), source: name };
    } catch { /* unreadable or invalid manifests suggest nothing */ }
  }
  return null;
}

/*!
 * pocket-convert.js: Pocket / Instapaper export -> Notion-ready CSV and a Markdown link list.
 * Pure functions: no DOM, no network. Works as a browser <script> (window.PocketConvert)
 * and as a CommonJS module (require('./pocket-convert.js')) for the tests.
 * MIT License, (c) binbuilds. https://github.com/binbuilds0/pocket-to-notion
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PocketConvert = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ parsing

  /** RFC 4180-style CSV parser: quotes, escaped quotes, CRLF, newlines inside quotes, BOM. */
  function parseCsv(text) {
    const s = text.replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else q = false;
        } else field += c;
        continue;
      }
      if (c === '"') q = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.some((x) => x !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((x) => x !== '')) rows.push(row);
    return rows;
  }

  /** Unix seconds, Unix milliseconds or a date string -> ISO string (or null). */
  function toIso(v) {
    if (!v) return null;
    const t = String(v).trim();
    if (/^\d{9,13}$/.test(t)) {
      const n = Number(t);
      return new Date(t.length > 10 ? n : n * 1000).toISOString();
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** "a|b", "a,b", "a;b" or a JSON array (Instapaper) -> ["a", "b"]. */
  function splitTags(v) {
    if (!v) return [];
    const t = String(v).trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) return arr.map((x) => String(typeof x === 'object' && x ? (x.name != null ? x.name : '') : x).trim()).filter(Boolean);
      } catch (e) {
        /* not JSON: fall through */
      }
    }
    return t.split(/[|,;]/).map((x) => x.trim()).filter(Boolean);
  }

  function validUrl(u) {
    if (!u) return null;
    try {
      const x = new URL(String(u).trim());
      return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : null;
    } catch (e) {
      return null;
    }
  }

  const decodeEntities = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/g, '&');

  /** Pocket's classic ril_export.html and any Netscape-style bookmarks file. Headings become folders. */
  function parseLinksHtml(html) {
    const out = [];
    const re = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>|<a\s([^>]*?)>([\s\S]*?)<\/a>/gi;
    let folder = null;
    let m;
    while ((m = re.exec(html))) {
      if (m[1] !== undefined) {
        folder = decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) || null;
        continue;
      }
      const attrs = m[2];
      const attr = (name) => {
        const a = attrs.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i')) || attrs.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'));
        return a ? decodeEntities(a[1]) : null;
      };
      const url = validUrl(attr('href'));
      if (!url) continue;
      const title = decodeEntities(m[3].replace(/<[^>]+>/g, '').trim()) || url;
      out.push({ url, title, tags: splitTags(attr('tags')), addedAt: toIso(attr('time_added') || attr('add_date')), folder });
    }
    return out;
  }

  /** 'pocket-csv' | 'pocket-html' | 'instapaper-csv' | 'generic-csv' | 'html-links' | 'unknown' */
  function detectSource(fileName, text) {
    const head = text.replace(/^﻿/, '').slice(0, 600).toLowerCase();
    if (/<a\s/i.test(text.slice(0, 50000)) && /<(html|ul|dl|!doctype|h1)/.test(head)) {
      return /pocket/i.test(head) || /time_added=/i.test(text.slice(0, 50000)) ? 'pocket-html' : 'html-links';
    }
    const firstLine = head.split(/\r?\n/)[0];
    if (/^url,title,selection,folder/.test(firstLine)) return 'instapaper-csv';
    if (/^title,url,time_added/.test(firstLine) || (firstLine.includes('time_added') && firstLine.includes('url'))) return 'pocket-csv';
    if (/(^|,)"?url"?(,|$)/.test(firstLine)) return 'generic-csv';
    if (/\.csv$/i.test(fileName)) return 'generic-csv';
    return 'unknown';
  }

  function fromCsv(rows) {
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => header.findIndex((h) => names.includes(h));
    const iUrl = col('url', 'link', 'href', 'given_url', 'resolved_url');
    const iTitle = col('title', 'name', 'given_title', 'resolved_title');
    const iTags = col('tags', 'tag', 'labels');
    const iTime = col('time_added', 'timestamp', 'date', 'created', 'added', 'saved_at', 'created_at');
    const iFolder = col('folder', 'status', 'collection');
    if (iUrl < 0) return [];
    const out = [];
    for (const r of rows.slice(1)) {
      const url = validUrl(r[iUrl]);
      if (!url) continue;
      out.push({
        url,
        title: ((iTitle >= 0 ? r[iTitle] : '') || '').trim() || url,
        tags: iTags >= 0 ? splitTags(r[iTags]) : [],
        addedAt: iTime >= 0 ? toIso(r[iTime]) : null,
        folder: iFolder >= 0 ? (r[iFolder] || '').trim() || null : null,
      });
    }
    return out;
  }

  /** Parse any supported export file. Items are de-duplicated by URL (first occurrence wins). */
  function parseImport(fileName, text) {
    const source = detectSource(fileName, text);
    let items = [];
    if (source === 'pocket-html' || source === 'html-links') items = parseLinksHtml(text);
    else if (source !== 'unknown') items = fromCsv(parseCsv(text));
    const seen = new Set();
    const uniq = [];
    for (const it of items) {
      const key = it.url.replace(/#.*$/, '').replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(it);
    }
    return { source, items: uniq, duplicates: items.length - uniq.length };
  }

  // ------------------------------------------------------------------ Notion output

  /** Notion's Free plan accepts CSV files up to 5 MB; stay a little under. */
  const NOTION_FREE_LIMIT = 4.5 * 1024 * 1024;
  const CSV_HEADER = ['Title', 'URL', 'Tags', 'Saved date', 'Status'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Same shape as Notion's own CSV export ("January 15, 2024 3:04 PM"), in UTC, so Notion reads it as a date. */
  function notionDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const h = d.getUTCHours();
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  }

  /** Pocket "archive" / "Read Archive", Instapaper "Archive" -> Archived; everything else -> Unread. */
  function toStatus(folder) {
    return folder && /archive/i.test(folder) ? 'Archived' : 'Unread';
  }

  const STD_FOLDERS = /^(unread|archive|read archive|home)$/i;
  /** Notion splits a multi-select cell on commas, so a tag may not contain one. */
  const cleanTag = (t) => t.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

  /** File name + file text -> { source, rows, duplicates }. */
  function convert(fileName, text) {
    const parsed = parseImport(fileName, text);
    const rows = parsed.items.map((it) => {
      const tags = it.tags.map(cleanTag).filter(Boolean);
      // Instapaper custom folders (and "Starred") carry meaning Notion has no column for: keep them as tags.
      if (parsed.source === 'instapaper-csv' && it.folder && !STD_FOLDERS.test(it.folder.trim())) tags.push(cleanTag(it.folder));
      return {
        title: it.title.replace(/\s+/g, ' ').trim(),
        url: it.url,
        tags: [...new Set(tags)],
        saved: notionDate(it.addedAt),
        savedIso: it.addedAt,
        status: toStatus(it.folder),
      };
    });
    return { source: parsed.source, rows, duplicates: parsed.duplicates };
  }

  function csvCell(v) {
    return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }
  const csvLine = (r) => [r.title, r.url, r.tags.join(', '), r.saved, r.status].map(csvCell).join(',');

  /** One CSV: Title, URL, Tags, Saved date, Status (CRLF line endings, UTF-8). */
  function toNotionCsv(rows) {
    return [CSV_HEADER.join(','), ...rows.map(csvLine)].join('\r\n') + '\r\n';
  }

  const utf8Len = (s) => new TextEncoder().encode(s).length;

  /** Split into several CSVs (each with the header) so every file stays under maxBytes. */
  function toNotionCsvParts(rows, maxBytes) {
    if (maxBytes == null) maxBytes = NOTION_FREE_LIMIT;
    const head = CSV_HEADER.join(',') + '\r\n';
    const parts = [];
    let cur = head;
    let size = utf8Len(head);
    for (const r of rows) {
      const line = csvLine(r) + '\r\n';
      const n = utf8Len(line);
      if (size + n > maxBytes && cur !== head) {
        parts.push(cur);
        cur = head;
        size = utf8Len(head);
      }
      cur += line;
      size += n;
    }
    parts.push(cur);
    return parts;
  }

  const mdText = (s) => s.replace(/([\\\[\]*_`<>])/g, '\\$1');
  const mdUrl = (u) => u.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');

  /** Markdown checklist grouped by status: "- [ ] [Title](url) · #tag · January 1, 2024". */
  function toMarkdown(rows, heading) {
    const out = [`# ${heading || 'Reading list'}`, ''];
    for (const status of ['Unread', 'Archived']) {
      const list = rows.filter((r) => r.status === status);
      if (!list.length) continue;
      out.push(`## ${status} (${list.length})`, '');
      for (const r of list) {
        const meta = [r.tags.length ? r.tags.map((t) => '#' + t.replace(/\s+/g, '-')).join(' ') : '', r.saved ? r.saved.replace(/ \d+:\d+ [AP]M$/, '') : '']
          .filter(Boolean)
          .join(' · ');
        out.push(`- [${status === 'Archived' ? 'x' : ' '}] [${mdText(r.title)}](${mdUrl(r.url)})${meta ? ' · ' + mdText(meta) : ''}`);
      }
      out.push('');
    }
    return out.join('\n');
  }

  const SOURCE_LABEL = {
    'pocket-csv': 'Pocket CSV export',
    'pocket-html': 'Pocket HTML export',
    'instapaper-csv': 'Instapaper CSV export',
    'generic-csv': 'CSV file with a URL column',
    'html-links': 'HTML bookmarks file',
    unknown: 'Unrecognised file',
  };

  return {
    parseCsv,
    parseLinksHtml,
    detectSource,
    parseImport,
    convert,
    notionDate,
    toStatus,
    toNotionCsv,
    toNotionCsvParts,
    toMarkdown,
    CSV_HEADER,
    NOTION_FREE_LIMIT,
    SOURCE_LABEL,
  };
});

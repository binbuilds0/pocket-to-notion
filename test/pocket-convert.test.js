// Run with: node --test   (Node 18+; no dependencies)
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const P = require('../pocket-convert.js');

const POCKET_CSV = [
  'title,url,time_added,tags,status',
  '"Why, and how",https://a.com/1,1700000000,reading|ai,unread',
  'Second,https://b.com/2,1600000000,,archive',
  'Dup,https://a.com/1,1700000001,,unread',
  'Bad,not-a-url,1,,unread',
].join('\n');

const POCKET_HTML = `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
<h1>Unread</h1><ul><li><a href="https://x.com/a?b=1&amp;c=2" time_added="1500000000" tags="dev,js">A &amp; [B]</a></li></ul>
<h1>Read Archive</h1><ul><li><a href="https://z.com/z" time_added="1400000000" tags="old">Z</a></li></ul></body></html>`;

const INSTA_CSV =
  'URL,Title,Selection,Folder,Timestamp,Tags\nhttps://i.com/1,One,,Unread,1650000000,"[""ml"",""papers""]"\nhttps://i.com/2,Two,,Archive,1650000001,\nhttps://i.com/3,Three,,Recipes,1650000002,\nhttps://i.com/4,Four,,Starred,1650000003,\n';

const iso = (ms) => new Date(ms).toISOString();

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, newlines in quotes and a BOM', () => {
    assert.deepEqual(P.parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",z\n\n'), [
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', 'z'],
    ]);
  });
});

describe('detectSource', () => {
  it('recognises every supported export', () => {
    assert.equal(P.detectSource('part_000000.csv', POCKET_CSV), 'pocket-csv');
    assert.equal(P.detectSource('ril_export.html', POCKET_HTML), 'pocket-html');
    assert.equal(P.detectSource('export.csv', INSTA_CSV), 'instapaper-csv');
    assert.equal(P.detectSource('links.csv', 'name,url\nA,https://a.com'), 'generic-csv');
    assert.equal(P.detectSource('bookmarks.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1><dl><a href="https://a.com" add_date="1">A</a></dl>'), 'html-links');
    assert.equal(P.detectSource('notes.txt', 'hello world'), 'unknown');
  });
});

describe('notionDate / toStatus', () => {
  it('formats like Notion exports, in UTC', () => {
    assert.equal(P.notionDate(iso(1700000000 * 1000)), 'November 14, 2023 10:13 PM');
    assert.equal(P.notionDate('2024-01-05T00:07:00Z'), 'January 5, 2024 12:07 AM');
    assert.equal(P.notionDate('2024-01-05T12:00:00Z'), 'January 5, 2024 12:00 PM');
    assert.equal(P.notionDate(null), '');
    assert.equal(P.notionDate('garbage'), '');
  });
  it('maps archive folders to Archived and everything else to Unread', () => {
    assert.equal(P.toStatus('archive'), 'Archived');
    assert.equal(P.toStatus('Read Archive'), 'Archived');
    assert.equal(P.toStatus('unread'), 'Unread');
    assert.equal(P.toStatus(null), 'Unread');
  });
});

describe('convert', () => {
  it('Pocket CSV: dedupes, drops bad URLs, converts dates, tags and status', () => {
    const c = P.convert('part_000000.csv', POCKET_CSV);
    assert.equal(c.source, 'pocket-csv');
    assert.equal(c.duplicates, 1);
    assert.deepEqual(c.rows, [
      { title: 'Why, and how', url: 'https://a.com/1', tags: ['reading', 'ai'], saved: 'November 14, 2023 10:13 PM', savedIso: '2023-11-14T22:13:20.000Z', status: 'Unread' },
      { title: 'Second', url: 'https://b.com/2', tags: [], saved: P.notionDate(iso(1600000000000)), savedIso: iso(1600000000000), status: 'Archived' },
    ]);
  });

  it('Pocket HTML: headings become status, entities are decoded', () => {
    const c = P.convert('ril_export.html', POCKET_HTML);
    assert.equal(c.source, 'pocket-html');
    assert.deepEqual(
      c.rows.map((r) => [r.title, r.url, r.tags, r.status]),
      [
        ['A & [B]', 'https://x.com/a?b=1&c=2', ['dev', 'js'], 'Unread'],
        ['Z', 'https://z.com/z', ['old'], 'Archived'],
      ],
    );
  });

  it('Instapaper CSV: JSON tags; custom folders and Starred become tags', () => {
    const c = P.convert('instapaper-export.csv', INSTA_CSV);
    assert.equal(c.source, 'instapaper-csv');
    assert.deepEqual(
      c.rows.map((r) => [r.title, r.tags, r.status]),
      [
        ['One', ['ml', 'papers'], 'Unread'],
        ['Two', [], 'Archived'],
        ['Three', ['Recipes'], 'Unread'],
        ['Four', ['Starred'], 'Unread'],
      ],
    );
  });

  it('unknown files give no rows', () => {
    const c = P.convert('notes.txt', 'hello world');
    assert.equal(c.source, 'unknown');
    assert.deepEqual(c.rows, []);
  });

  it('removes commas inside a tag so Notion multi-select does not split it', () => {
    const c = P.convert('x.csv', 'title,url,time_added,tags,status\nT,https://t.com,1700000000,"[""a, b"",""c""]",unread\n');
    assert.deepEqual(c.rows[0].tags, ['a b', 'c']);
  });

  it('converts the bundled example file', () => {
    const text = readFileSync(path.join(__dirname, '..', 'examples', 'pocket-sample.csv'), 'utf8');
    const c = P.convert('pocket-sample.csv', text);
    assert.equal(c.source, 'pocket-csv');
    assert.ok(c.rows.length >= 10);
    assert.ok(c.rows.every((r) => r.saved && /^https:\/\//.test(r.url)));
  });
});

describe('Notion CSV', () => {
  it('has the exact header and round-trips through the CSV parser', () => {
    const csv = P.toNotionCsv(P.convert('part_000000.csv', POCKET_CSV).rows);
    assert.equal(csv.split('\r\n')[0], 'Title,URL,Tags,Saved date,Status');
    assert.deepEqual(P.CSV_HEADER, ['Title', 'URL', 'Tags', 'Saved date', 'Status']);
    assert.deepEqual(P.parseCsv(csv), [
      ['Title', 'URL', 'Tags', 'Saved date', 'Status'],
      ['Why, and how', 'https://a.com/1', 'reading, ai', 'November 14, 2023 10:13 PM', 'Unread'],
      ['Second', 'https://b.com/2', '', P.notionDate(iso(1600000000000)), 'Archived'],
    ]);
  });

  it('escapes quotes', () => {
    const csv = P.toNotionCsv([{ title: 'He said "hi"', url: 'https://q.com/', tags: [], saved: '', savedIso: null, status: 'Unread' }]);
    assert.ok(csv.includes('"He said ""hi"""'));
  });

  it('splits into parts under the size limit, each with the header, keeping every row', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ title: `Article number ${i} `.repeat(5), url: `https://ex.com/${i}`, tags: ['t'], saved: 'January 1, 2024 1:00 AM', savedIso: null, status: 'Unread' }));
    const parts = P.toNotionCsvParts(rows, 20000);
    assert.ok(parts.length > 1);
    let total = 0;
    for (const p of parts) {
      assert.ok(new TextEncoder().encode(p).length <= 20000);
      const parsed = P.parseCsv(p);
      assert.deepEqual(parsed[0], P.CSV_HEADER);
      total += parsed.length - 1;
    }
    assert.equal(total, 500);
    assert.equal(P.toNotionCsvParts(rows).length, 1);
  });
});

describe('Markdown', () => {
  it('groups by status as a checklist and escapes link text', () => {
    const md = P.toMarkdown(P.convert('ril_export.html', POCKET_HTML).rows);
    assert.ok(md.includes('## Unread (1)'));
    assert.ok(md.includes('## Archived (1)'));
    assert.ok(md.includes('- [ ] [A & \\[B\\]](https://x.com/a?b=1&c=2) · #dev #js · July 14, 2017'));
    assert.match(md, /- \[x\] \[Z\]\(https:\/\/z\.com\/z\) · #old · May 13, 2014/);
  });
  it('encodes parentheses in URLs', () => {
    const md = P.toMarkdown([{ title: 'W', url: 'https://en.wikipedia.org/wiki/A_(b)', tags: [], saved: '', savedIso: null, status: 'Unread' }]);
    assert.ok(md.includes('(https://en.wikipedia.org/wiki/A_%28b%29)'));
  });
});

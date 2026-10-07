/*!
 * app.js: the page logic for index.html. Reads the file you drop with the File API and converts it
 * in this tab. It makes no network requests (the page's Content-Security-Policy sets connect-src 'none').
 * MIT License, (c) binbuilds.
 */
(function () {
  'use strict';
  const { convert, toNotionCsvParts, toMarkdown, SOURCE_LABEL, NOTION_FREE_LIMIT } = window.PocketConvert;

  const $ = (id) => document.getElementById(id);
  const MAX_FILE = 100 * 1024 * 1024;
  const fmt = (n) => n.toLocaleString('en-US');
  const links = (n) => `${fmt(n)} link${n === 1 ? '' : 's'}`;

  const drop = $('drop');
  const input = $('file');
  const status = $('status');
  const result = $('result');
  const summary = $('summary');
  const tbody = $('preview-rows');
  const more = $('preview-more');
  const csvBox = $('csv-downloads');
  const dlMd = $('dl-md');
  const copyMd = $('copy-md');
  const again = $('again');

  let markdown = '';
  let baseName = 'pocket';
  const urls = [];

  function download(text, name, type) {
    const u = URL.createObjectURL(new Blob([text], { type }));
    urls.push(u);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function say(msg, err) {
    status.textContent = msg;
    status.classList.toggle('err', !!err);
  }

  function reset() {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    result.hidden = true;
    input.value = '';
    say('');
  }

  function render(c, fileName) {
    const rows = c.rows;
    const unread = rows.filter((r) => r.status === 'Unread').length;
    const tagged = rows.filter((r) => r.tags.length).length;
    summary.textContent =
      `${SOURCE_LABEL[c.source]}: ${links(rows.length)} (${fmt(unread)} unread, ${fmt(rows.length - unread)} archived, ${fmt(tagged)} with tags)` +
      (c.duplicates ? `. ${fmt(c.duplicates)} duplicate URL${c.duplicates === 1 ? '' : 's'} skipped.` : '.');

    tbody.textContent = '';
    for (const r of rows.slice(0, 8)) {
      const tr = document.createElement('tr');
      for (const v of [r.title, r.tags.join(', '), r.saved.replace(/ \d+:\d+ [AP]M$/, ''), r.status]) {
        const td = document.createElement('td');
        td.textContent = v || '—';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    more.textContent = rows.length > 8 ? `Showing 8 of ${fmt(rows.length)} rows.` : '';

    baseName = fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'pocket';
    const parts = toNotionCsvParts(rows, NOTION_FREE_LIMIT);
    csvBox.textContent = '';
    parts.forEach((csv, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn primary';
      const name = parts.length > 1 ? `${baseName}-notion-part-${i + 1}.csv` : `${baseName}-notion.csv`;
      b.textContent = parts.length > 1 ? `Download CSV part ${i + 1} of ${parts.length}` : 'Download Notion CSV';
      b.addEventListener('click', () => download(csv, name, 'text/csv;charset=utf-8'));
      csvBox.appendChild(b);
    });
    if (parts.length > 1) {
      const p = document.createElement('p');
      p.className = 'small muted';
      p.textContent = 'Split into parts under 5 MB, the per-file limit on Notion’s Free plan. Import the first part, then use “Merge with CSV” for the rest.';
      csvBox.appendChild(p);
    }
    markdown = toMarkdown(rows);
    result.hidden = false;
    say(`Done. ${links(rows.length)} converted in your browser.`);
    result.focus();
  }

  async function handle(file) {
    if (!file) return;
    reset();
    if (file.size > MAX_FILE) return say('That file is larger than 100 MB. Is it the Pocket or Instapaper export?', true);
    if (/\.zip$/i.test(file.name)) return say('That is a .zip file. Unzip it first, then drop the .csv file inside (for Pocket, a file such as part_000000.csv).', true);
    say(`Reading ${file.name}…`);
    try {
      const text = await file.text();
      const c = convert(file.name, text);
      if (c.source === 'unknown') return say('This doesn’t look like a Pocket or Instapaper export. Drop the .csv or .html file from your export.', true);
      if (!c.rows.length) return say('No links found in this file. Check that it is the export file and that it contains saved items.', true);
      render(c, file.name);
    } catch (e) {
      say('Could not read this file. Try saving it again as UTF-8 CSV, or drop the original export.', true);
    }
  }

  input.addEventListener('change', () => handle(input.files && input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    handle(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  // Dropping next to the zone must not navigate away to the file.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  dlMd.addEventListener('click', () => download(markdown, `${baseName}-links.md`, 'text/markdown;charset=utf-8'));
  copyMd.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      copyMd.textContent = 'Copied';
    } catch (e) {
      copyMd.textContent = 'Copy failed, use Download';
    }
    setTimeout(() => (copyMd.textContent = 'Copy Markdown'), 2000);
  });
  again.addEventListener('click', () => {
    reset();
    input.focus();
  });

  // Exposed so a File object can be passed in from the console or an automated browser.
  window.PocketToNotion = { handle };
})();

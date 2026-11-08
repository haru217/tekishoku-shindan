const EXPECTED = 18725;
const INDEX_SHA256 = 'bafd3193c559c2b8dda9a2c6d14d08c1364f9b5c629a83fb90526948bf66bdb6';
const boundaries = [3, 11, 20, 28, 32, 43, 48, 51, 58, 63, 66, 81, 89, 94, 99];

export function mainClass(code) {
  const middle = Number(code.slice(0, 3));
  if (middle < 1) return '00';
  return String(boundaries.findIndex(last => middle <= last) + 1).padStart(2, '0');
}

function lines(items) {
  const text = items.filter(item => item.str?.trim());
  // Code and title can be separate PDF text objects or share one object.
  const rows = new Map();
  for (const item of text) {
    const [, , , , x, y] = item.transform;
    const key = Math.round(y * 2);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ x, value: item.str.trim() });
  }
  return [...rows.values()].map(row => row.sort((a, b) => a.x - b.x));
}

function readKanaIndex(items) {
  const result = [];
  for (const row of lines(items)) {
    // The typeset index has a stable two-column grid; both code columns follow
    // the title. The same PDF is checked before these coordinates are used.
    for (const [left, right] of [[65, 295], [300, 535]]) {
      const line = row.filter(item => item.x >= left && item.x < right).map(item => item.value).join(' ');
      const match = /^(.+?)\s*(\d{3}-\d{2})$/.exec(line);
      if (match) result.push([match[1].trim(), match[2], false]);
    }
  }
  return result;
}

function readRemainingCategories(items) {
  const result = [];
  for (const row of lines(items)) {
    const text = row.map(item => item.value).join(' ');
    const match = /^(\d{3}-99)\s+(.+)$/.exec(text);
    if (match) result.push([match[2], match[1], true]);
  }
  return result;
}

export function isCompleteIndex(rows) {
  return Array.isArray(rows) && rows.length === EXPECTED && rows.every(row =>
    Array.isArray(row) && typeof row[0] === 'string' && row[0].trim().length > 0 &&
    typeof row[1] === 'string' && /^\d{3}-\d{2}$/.test(row[1]) && mainClass(row[1]) !== '00' &&
    typeof row[2] === 'boolean') &&
    new Set(rows.map(row => row[1] + ':' + row[0])).size === EXPECTED;
}

export async function readOfficialIndex(file, onProgress = () => {}) {
  if (file.size !== 11132176) throw new Error('案内のリンクから第5回改定の公式PDFを選んでください。');
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hex !== INDEX_SHA256) throw new Error('案内のリンクから第5回改定の公式PDFを選んでください。');

  const { getDocument, GlobalWorkerOptions } = await import('./pdfjs/pdf.min.mjs');
  GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const task = getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  try {
    const doc = await task.promise;
    const index = [];
    // The kana index contains all ordinary names and 388 class titles.
    // The 52 miscellaneous class titles are in the classification tables.
    const pages = [...Array.from({ length: 190 }, (_, index) => index + 49),
      ...Array.from({ length: 27 }, (_, index) => index + 19)];
    for (let offset = 0; offset < pages.length; offset += 1) {
      const number = pages[offset];
      const page = await doc.getPage(number);
      const { items } = await page.getTextContent();
      index.push(...(number >= 49 ? readKanaIndex(items) : readRemainingCategories(items)));
      page.cleanup();
      if (offset % 12 === 0) onProgress(Math.round((offset + 1) / pages.length * 100));
    }
    if (!isCompleteIndex(index)) throw new Error('公式索引の照合件数が一致しません（' + index.length + '件）。');
    onProgress(100);
    return index;
  } finally {
    await task.destroy();
  }
}

export function makeIndexedCatalog(rows, jobTag, normalize) {
  const byName = new Map();
  const groups = new Map();
  const estimates = new Map();
  const empty = jobTag[0].values.map(() => null);

  for (const job of jobTag) {
    if (!job.values.some(value => value !== null)) continue;
    const names = new Set([job.title, ...job.title.split('、'), ...job.aliases].map(normalize));
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(job);
    }
    const groupKeys = new Set([job.code, ...job.classifications, ...job.classifications.map(code => code.slice(0, 3))]);
    for (const key of groupKeys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
  }

  function estimate(key) {
    if (estimates.has(key)) return estimates.get(key);
    const members = groups.get(key) || [];
    const width = key.length;
    const strength = width === 6 ? 0.82 : width === 3 ? 0.65 : 0.44;
    const level = width === 6 ? '小分類' : width === 3 ? '中分類' : '大分類';
    const values = empty.map((_, index) => {
      const observed = members.map(job => job.values[index]).filter(value => value !== null).sort((a, b) => a - b);
      if (!observed.length) return null;
      return (observed[Math.floor((observed.length - 1) / 2)] + observed[Math.floor(observed.length / 2)]) / 2;
    });
    const result = { values, confidence: strength, level, sampleCount: members.length };
    estimates.set(key, result);
    return result;
  }

  return rows.map(([title, classification], index) => {
    const code = mainClass(classification);
    const normalized = normalize(title);
    const possible = byName.get(normalized) || [];
    const exact = possible.filter(job => job.classifications.includes(classification));
    const middle = classification.slice(0, 3);
    const broad = possible.filter(job => job.classifications.includes(middle + '-00'));
    const linked = exact.length === 1 ? exact[0] : !exact.length && broad.length === 1 ? broad[0] : null;
    const common = { id: index + 10000, title, code, classification, searchText: normalized };
    if (linked) return { ...common, values: linked.values, description: linked.description, basis: 'direct',
      detailId: linked.detailId, confidence: 1, searchText: normalize([title, linked.title, ...linked.aliases].join(' ')) };
    const reference = [classification, middle, code].map(estimate).find(item => item.sampleCount);
    if (reference) return { ...common, ...reference, basis: 'estimated' };
    return { ...common, values: empty, confidence: 0, basis: 'none' };
  });
}

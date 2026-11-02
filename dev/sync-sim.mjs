/* Two devices, one gist: drive the real `extension/library-store.js` in two isolated contexts and
   check that library, history, progress and highlights converge — including deletes, which is the
   case a plain "local wins / remote wins" merge gets wrong.

    node dev/sync-sim.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = fs.readFileSync(path.resolve('extension/library-store.js'), 'utf8');

/* ------------------------------------------------------------------ fake GitHub */

function makeServer() {
  const gists = new Map();
  const stats = { created: 0, patches: 0, gets: 0 };
  let next = 0;

  const reply = (status, body, scopes = 'gist') => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'x-oauth-scopes' ? scopes : null) },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  const fileOf = (id) => ({ id, files: { 'schreader-sync.json': { content: gists.get(id) } } });

  async function fetchStub(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const p = u.pathname;

    if (p === '/user') return reply(200, { login: 'tester' });

    if (p === '/gists' && method === 'GET') {
      return reply(200, [...gists.keys()].map(fileOf));
    }
    if (p === '/gists' && method === 'POST') {
      const body = JSON.parse(init.body);
      const id = 'gist' + (++next);
      gists.set(id, body.files['schreader-sync.json'].content);
      stats.created += 1;
      return reply(201, fileOf(id));
    }
    const m = p.match(/^\/gists\/([^/]+)$/);
    if (m && method === 'GET') {
      stats.gets += 1;
      return gists.has(m[1]) ? reply(200, fileOf(m[1])) : reply(404, { message: 'Not Found' });
    }
    if (m && method === 'PATCH') {
      const body = JSON.parse(init.body);
      gists.set(m[1], body.files['schreader-sync.json'].content);
      stats.patches += 1;
      return reply(200, fileOf(m[1]));
    }
    return reply(404, { message: 'no route ' + method + ' ' + p });
  }

  return { fetchStub, gists, stats, content: () => JSON.parse([...gists.values()][0]) };
}

/* ------------------------------------------------------------------ one device */

function makeDevice(server, label) {
  const cells = new Map();
  const localStorage = {
    getItem: (k) => (cells.has(k) ? cells.get(k) : null),
    setItem: (k, v) => cells.set(k, String(v)),
    removeItem: (k) => cells.delete(k),
    key: (i) => [...cells.keys()][i] ?? null,
    get length() { return cells.size; },
  };
  const ctx = {
    console, JSON, Date, Math, Object, Array, String, Number, Set, Map, URL, URLSearchParams,
    Promise, AbortController, localStorage,
    fetch: server.fetchStub,
    /* the store debounces background pushes by 4 s; nothing here waits that long */
    setTimeout: (fn, ms) => (ms > 200 ? 0 : setTimeout(fn, ms)),
    clearTimeout: (t) => clearTimeout(t),
    label,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'library-store.js' });
  return ctx.SR_LIB;
}

/* ------------------------------------------------------------------ assertions */

let failures = 0;
const ok = (cond, what) => {
  if (cond) console.log('  ok   ' + what);
  else { failures += 1; console.log('  FAIL ' + what); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titleOf = (list, id) => (list.find((i) => i.id === id) || {}).title;

/* ------------------------------------------------------------------ the run */

const server = makeServer();
const A = makeDevice(server, 'A');
const B = makeDevice(server, 'B');

const entry = (id, title, extra = {}) => ({
  id, url: 'https://example.org/' + id, doi: '', title, authors: ['Ada Lovelace'],
  journal: 'Journal of Tests', year: '2024', addedAt: Date.now(), lastReadAt: Date.now(),
  tags: [], note: '', progress: null, ...extra,
});

console.log('device A connects');
const r1 = await A.sync.connect('token-a');
ok(r1 && r1.ok, 'first connect creates a gist and pushes (' + JSON.stringify(r1.error || r1.counts) + ')');
ok(server.stats.created === 1, 'exactly one gist created');

console.log('A adds a paper, B joins');
await A.upsert(entry('doi:10.1/a', 'Paper A'));
await A.sync.sync();
await sleep(5);
await B.sync.connect('token-b');
ok(server.stats.created === 1, 'B reuses the existing gist instead of making a second one');
ok((await B.list()).length === 1, 'B sees A\u2019s paper');
ok(titleOf(await B.list(), 'doi:10.1/a') === 'Paper A', 'title survived the round trip');

console.log('concurrent edits: tag on B, note on A');
await sleep(5);
await B.patch('doi:10.1/a', { tags: ['to-read'] });
await B.sync.sync();
await sleep(5);
await A.patch('doi:10.1/a', { note: 'worth the detour' });
await A.sync.sync();
await sleep(5);
await B.sync.sync();
const onA = (await A.list())[0];
const onB = (await B.list())[0];
ok((onA.tags || []).includes('to-read') && (onB.tags || []).includes('to-read'), 'tags merged on both sides');
ok(onA.note === 'worth the detour' && onB.note === 'worth the detour', 'note converged');
ok(onA.progress === null && onB.progress === null, 'progress still empty');

console.log('reading progress travels');
await sleep(5);
await A.patch('doi:10.1/a', { progress: { section: 3, scroll: 0.42 } });
await A.sync.sync();
await sleep(5);
await B.sync.sync();
const progB = (await B.list())[0].progress;
ok(progB && progB.section === 3, 'B received the reading position');

console.log('highlights travel and deletions stick');
await sleep(5);
await A.hlPut('sr-hl:doi:10.1/a', [{ id: 'h1', color: 'yellow', text: 'claim', prefix: '', suffix: '', ts: Date.now() }]);
await A.sync.sync();
await sleep(5);
await B.sync.sync();
const hlB = await B.hlAll();
ok((hlB['sr-hl:doi:10.1/a'] || []).length === 1, 'B sees A\u2019s highlight');
await sleep(5);
await B.hlPut('sr-hl:doi:10.1/a', []);
await B.sync.sync();
await sleep(5);
await A.sync.sync();
const hlA = await A.hlAll();
ok((hlA['sr-hl:doi:10.1/a'] || []).length === 0, 'A dropped the highlight B deleted');

console.log('history merges, and "clear history" propagates');
await sleep(5);
await A.pushHistory({ id: 'doi:10.1/h1', title: 'Read me', url: 'u', ts: Date.now() });
await A.sync.sync();
await sleep(5);
await B.sync.sync();
ok((await B.history()).length === 1, 'B sees the history entry');
await sleep(5);
await B.clearHistory();
await B.sync.sync();
await sleep(5);
await A.sync.sync();
ok((await A.history()).length === 0, 'A\u2019s history cleared too');

console.log('deletes propagate, edits made after the delete win');
await sleep(5);
await A.remove('doi:10.1/a');
await A.sync.sync();
await sleep(5);
await B.sync.sync();
ok((await A.list()).length === 0 && (await B.list()).length === 0, 'paper deleted on both devices');

await A.upsert(entry('doi:10.1/c', 'Paper C'));
await B.upsert(entry('doi:10.1/d', 'Paper D'));
await A.sync.sync();
await sleep(5);
await B.sync.sync();
await sleep(5);
await A.sync.sync();
const idsA = (await A.list()).map((i) => i.id).sort();
const idsB = (await B.list()).map((i) => i.id).sort();
ok(idsA.join() === 'doi:10.1/c,doi:10.1/d' && idsA.join() === idsB.join(), 'papers added on either side both survive');

console.log('the wordbook syncs, refreshes in place and forgets deletes');
await sleep(5);
const w1 = await A.addWord({
  term: 'Mitochondria', translation: '线粒体', example: 'The mitochondrion is the powerhouse of the cell.',
  from: 'en', to: 'zh-CN', articleId: 'doi:10.1/c', title: 'Paper C', url: 'https://example.org/c',
});
ok(w1.ok, 'A saved a word');
await A.sync.sync();
await sleep(5);
await B.sync.sync();
const wordsB = await B.words();
ok(wordsB.length === 1 && wordsB[0].translation === '线粒体', 'B sees the word and its translation');
ok(wordsB[0] && wordsB[0].example.indexOf('powerhouse') >= 0, 'the example sentence travelled too');
await sleep(5);
await B.addWord({
  term: 'mitochondria', translation: '线粒体（复数）', example: 'A second sentence.',
  articleId: 'doi:10.1/c', title: 'Paper C', url: 'https://example.org/c',
});
ok((await B.words()).length === 1, 'the same word in the same paper updates instead of duplicating');
await B.sync.sync();
await sleep(5);
await A.sync.sync();
const refreshed = (await A.words())[0];
ok(refreshed && refreshed.example === 'A second sentence.', 'the refreshed example reached A');
await sleep(5);
await B.removeWord((await B.words())[0].id);
await B.sync.sync();
await sleep(5);
await A.sync.sync();
ok((await A.words()).length === 0, 'A dropped the word B deleted');

console.log('a no-op sync writes nothing');
const before = server.stats.patches;
await sleep(5);
await A.sync.sync();
await sleep(5);
await B.sync.sync();
ok(server.stats.patches === before, 'no PATCH when nothing changed (' + before + ' -> ' + server.stats.patches + ')');

console.log('the gist holds exactly the merged state');
const snap = server.content();
ok(snap.v === 1 && Array.isArray(snap.lib) && snap.lib.length === 2, 'snapshot has both papers');
ok(Array.isArray(snap.words), 'snapshot carries a wordbook section');
ok(!JSON.stringify(snap).includes('Papered'), 'no stray payload');

console.log(failures ? `\n${failures} FAILED` : '\nall sync checks passed');
process.exit(failures ? 1 : 0);

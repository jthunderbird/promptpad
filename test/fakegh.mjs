// A tiny in-memory stand-in for the parts of the GitHub REST API (and device flow) that promptpad uses.
import http from 'node:http';
import crypto from 'node:crypto';

const sha1 = (s) => crypto.createHash('sha1').update('blob ' + Buffer.byteLength(s) + '\0' + s).digest('hex');

export function startFake(port = 4599) {
  const st = {
    users: { 'tok-alice': 'alice', 'tok-bob': 'bob' },
    repos: new Map(), // 'owner/name' -> { private, branches: Map(name -> { commits: [{message, parents, author}], files: Map(path -> {content, sha}) }) }
    down: false, // drop connections (offline)
    revoked: new Set(), // tokens answering 401
    puts: 0, gets: 0, notmod: 0, getsLog: [],
    devicePolls: 0, deviceToken: 'tok-alice', deviceAfter: 2,
    refs: [],
  };
  st.addRepo = (name, isPrivate = true) => st.repos.set(name, { private: isPrivate, branches: new Map() });
  st.file = (repo, branch, path) => st.repos.get(repo)?.branches.get(branch)?.files.get(path)?.content;
  st.commits = (repo, branch) => st.repos.get(repo)?.branches.get(branch)?.commits ?? [];
  const record = (b, path, content, author, date) => {
    b.history ??= new Map();
    if (!b.history.has(path)) b.history.set(path, []);
    b.history.get(path).push({ content, author, date: date ?? new Date().toISOString(), oid: sha1(content + author + Math.random()) });
  };
  st.setFile = (repo, branch, path, content, author = 'bob', date) => {
    const b = st.repos.get(repo).branches.get(branch);
    b.files.set(path, { content, sha: sha1(content) });
    b.commits.push({ message: 'external edit', parents: [1], author });
    record(b, path, content, author, date);
  };
  // line owners through the history (simple LCS diff between consecutive versions)
  const blame = (b, path) => {
    const hist = b.history?.get(path) ?? [];
    let prev = [], owners = [];
    for (const v of hist) {
      const lines = v.content.split('\n');
      const n = prev.length, m = lines.length;
      const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) for (let k = m - 1; k >= 0; k--) L[i][k] = prev[i] === lines[k] ? L[i + 1][k + 1] + 1 : Math.max(L[i + 1][k], L[i][k + 1]);
      const next = new Array(m).fill(null);
      let i = 0, k = 0;
      while (i < n && k < m) {
        if (prev[i] === lines[k]) { next[k] = owners[i]; i++; k++; }
        else if (L[i + 1][k] >= L[i][k + 1]) i++; else k++;
      }
      owners = next.map((o) => o ?? v);
      prev = lines;
    }
    return owners; // one history entry per line
  };


  const srv = http.createServer((req, res) => {
    if (st.down) return req.destroy();
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Expose-Headers': 'ETag',
    };
    const send = (code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors, ...extra }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch { /* ignore */ }

      // device flow (no auth)
      if (p === '/login/device/code') { st.deviceScope = j.scope; st.deviceClient = j.client_id; }
      if (p === '/login/device/code') return send(200, { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'http://localhost:' + port + '/login/device', interval: 1, expires_in: 60 });
      if (p === '/login/oauth/access_token') {
        st.devicePolls++;
        if (st.devicePolls === 1) return req.socket.destroy(); // connection drops once (phone switching apps)
        if (st.devicePolls <= st.deviceAfter) return send(200, { error: 'authorization_pending' });
        return send(200, { access_token: st.deviceToken, token_type: 'bearer' });
      }

      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = st.users[tok];
      if (!user || st.revoked.has(tok)) return send(401, { message: 'Bad credentials' });
      if (p === '/user') return send(200, { login: user });
      if (p === '/user/repos') return send(200, [...st.repos].map(([full_name, r]) => ({ full_name, private: r.private })));

      let m;
      if (p === '/graphql' && req.method === 'POST') {
        st.graphql = (st.graphql ?? 0) + 1;
        const v = j.variables || {};
        const b = st.repos.get(v.owner + '/' + v.name)?.branches.get(String(v.ref).replace('refs/heads/', ''));
        if (!b) return send(200, { data: { repository: { ref: null } } });
        const owners = blame(b, v.path);
        const ranges = [];
        owners.forEach((o, i) => {
          const last = ranges[ranges.length - 1];
          if (last && last.oid === o.oid) last.endingLine = i + 1;
          else ranges.push({ oid: o.oid, startingLine: i + 1, endingLine: i + 1, commit: { oid: o.oid, committedDate: o.date, author: { name: o.author, user: { login: o.author } } } });
        });
        return send(200, { data: { repository: { ref: { target: { blame: { ranges } } } } } });
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(p))) {
        const r = st.repos.get(m[1]); if (!r) return send(404, { message: 'Not Found' });
        return send(200, { full_name: m[1], private: r.private });
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/branches\/(.+)$/.exec(p))) {
        const b = st.repos.get(m[1])?.branches.get(m[2]); return b ? send(200, { name: m[2] }) : send(404, { message: 'Branch not found' });
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/(.+)$/.exec(p))) {
        const b = st.repos.get(m[1])?.branches.get(m[2]); if (!b) return send(404, { message: 'Not Found' });
        return send(200, { tree: [...b.files].map(([path, f]) => ({ path, type: 'blob', sha: f.sha })) });
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(p))) {
        const repo = st.repos.get(m[1]); if (!repo) return send(404, { message: 'Not Found' });
        const path = m[2];
        if (req.method === 'GET') {
          st.gets++;
          const b = repo.branches.get(url.searchParams.get('ref'));
          const f = b?.files.get(path);
          st.getsLog.push(user);
          if (!f) return send(404, { message: 'Not Found' });
          const etag = `"${f.sha}"`;
          if (req.headers['if-none-match'] === etag) { st.notmod++; res.writeHead(304, { ...cors, ETag: etag }); return res.end(); }
          return send(200, { sha: f.sha, content: Buffer.from(f.content).toString('base64').replace(/(.{60})/g, '$1\n'), encoding: 'base64' }, { ETag: etag });
        }
        if (req.method === 'PUT') {
          const b = repo.branches.get(j.branch);
          if (!b) return send(404, { message: 'Branch not found' });
          const cur = b.files.get(path);
          if (cur && j.sha !== cur.sha) return send(409, { message: `${path} does not match ${cur.sha}` });
          if (!cur && j.sha) return send(422, { message: 'sha supplied for missing file' });
          const content = Buffer.from(j.content, 'base64').toString('utf8');
          const f = { content, sha: sha1(content) };
          b.files.set(path, f);
          b.commits.push({ message: j.message, parents: [1], author: user });
          record(b, path, content, user);
          st.puts++;
          return send(cur ? 200 : 201, { content: { sha: f.sha } });
        }
      }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/(blobs|trees|commits|refs)$/.exec(p)) && req.method === 'POST') {
        const repo = st.repos.get(m[1]); if (!repo) return send(404, { message: 'Not Found' });
        repo.tmp ??= { blobs: new Map(), trees: new Map(), commits: new Map() };
        if (m[2] === 'blobs') { const content = Buffer.from(j.content, 'base64').toString('utf8'); const sha = sha1(content); repo.tmp.blobs.set(sha, content); return send(201, { sha }); }
        if (m[2] === 'trees') {
          const id = 'tree' + repo.tmp.trees.size; repo.tmp.trees.set(id, j.tree.map((e) => ({ path: e.path, sha: e.sha }))); return send(201, { sha: id });
        }
        if (m[2] === 'commits') { const id = 'commit' + repo.tmp.commits.size; repo.tmp.commits.set(id, { tree: j.tree, parents: j.parents, message: j.message }); return send(201, { sha: id }); }
        if (m[2] === 'refs') {
          const c = repo.tmp.commits.get(j.sha); const name = j.ref.replace('refs/heads/', '');
          if (repo.branches.has(name)) return send(422, { message: 'Reference already exists' });
          const files = new Map(); for (const e of repo.tmp.trees.get(c.tree)) files.set(e.path, { content: repo.tmp.blobs.get(e.sha), sha: e.sha });
          const nb = { commits: [{ message: c.message, parents: c.parents, author: user }], files };
          for (const [fp, f] of files) record(nb, fp, f.content, user);
          repo.branches.set(name, nb);
          return send(201, { ref: j.ref });
        }
      }
      send(404, { message: 'Not Found ' + p });
    });
  });
  return new Promise((resolve) => srv.listen(port, () => resolve({ st, close: () => srv.close() })));
}

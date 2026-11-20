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
  st.setFile = (repo, branch, path, content, author = 'bob') => {
    const b = st.repos.get(repo).branches.get(branch);
    b.files.set(path, { content, sha: sha1(content) });
    b.commits.push({ message: 'external edit', parents: [1], author });
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
      if (p === '/login/device/code') return send(200, { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'http://localhost:' + port + '/login/device', interval: 1, expires_in: 60 });
      if (p === '/login/oauth/access_token') {
        st.devicePolls++;
        if (st.devicePolls <= st.deviceAfter) return send(200, { error: 'authorization_pending' });
        return send(200, { access_token: st.deviceToken, token_type: 'bearer' });
      }

      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = st.users[tok];
      if (!user || st.revoked.has(tok)) return send(401, { message: 'Bad credentials' });
      if (p === '/user') return send(200, { login: user });
      if (p === '/user/repos') return send(200, [...st.repos].map(([full_name, r]) => ({ full_name, private: r.private })));

      let m;
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
          repo.branches.set(name, { commits: [{ message: c.message, parents: c.parents, author: user }], files });
          return send(201, { ref: j.ref });
        }
      }
      send(404, { message: 'Not Found ' + p });
    });
  });
  return new Promise((resolve) => srv.listen(port, () => resolve({ st, close: () => srv.close() })));
}

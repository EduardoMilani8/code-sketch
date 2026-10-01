#!/usr/bin/env node
// Smoke test: every example spec must build, and known-bad specs must be refused with the right message.
// Run with: npm test   (from skills/code-sketch/scripts)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const sketch = path.join(here, 'sketch.mjs');
const examples = path.join(here, '..', 'references', 'examples');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'code-sketch-'));
let failures = 0;

const run = (spec, extra = []) => spawnSync(process.execPath, [sketch, spec, '--out', out, ...extra], { encoding: 'utf8' });
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '\n     ' + detail}`); if (!ok) failures++; };

// 1. every example builds and produces a valid scene
for (const f of fs.readdirSync(examples).filter((x) => x.endsWith('.json'))) {
  const r = run(path.join(examples, f));
  const base = f.replace(/\.json$/, '');
  const scenePath = path.join(out, base + '.excalidraw');
  let valid = false;
  if (r.status === 0 && fs.existsSync(scenePath)) {
    const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    const ids = new Set(scene.elements.map((e) => e.id));
    valid = ids.size === scene.elements.length && scene.elements.every((e) =>
      (e.boundElements ?? []).every((b) => ids.has(b.id)) && [e.startBinding, e.endBinding].every((b) => !b || ids.has(b.elementId)) && (!e.containerId || ids.has(e.containerId)));
  }
  check(`example ${f} builds into a valid scene`, valid && fs.existsSync(path.join(out, base + '.png')), r.stderr || r.stdout);
}

// 2. bad specs are refused for the right reason
const bad = (name, spec, expect) => {
  const p = path.join(out, name + '.json');
  fs.writeFileSync(p, JSON.stringify(spec));
  const r = run(p);
  check(`refuses ${name}`, r.status === 2 && (r.stderr + r.stdout).includes(expect), r.stderr || r.stdout);
};
const many = (n) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: 'n' + i, label: 'N' + i })), edges: Array.from({ length: n - 1 }, (_, i) => ({ from: 'n' + i, to: 'n' + (i + 1) })) });
bad('too-many-nodes', many(13), 'Diagram too big');
bad('long-label', { nodes: [{ id: 'a', label: 'x'.repeat(40) }] }, 'Text too long');
bad('unknown-node', { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zzz' }] }, 'Invalid spec');
bad('two-way-pair', { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }, 'both');
bad('self-loop', { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'a' }] }, 'itself');

// 3. odd but valid inputs still build
const ok = (name, spec) => {
  const p = path.join(out, name + '.json');
  fs.writeFileSync(p, JSON.stringify(spec));
  const r = run(p);
  check(`builds ${name}`, r.status === 0 && fs.existsSync(path.join(out, name + '.excalidraw')), r.stderr || r.stdout);
};
ok('single-node', { nodes: [{ id: 'a', label: 'Only one' }] });
ok('no-arrows', { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
ok('non-latin-text', { title: '日本語のタイトル', nodes: [{ id: 'a', label: 'こんにちは', sub: 'ファイル:12' }, { id: 'b', label: 'Привет' }], edges: [{ from: 'a', to: 'b', label: '送信', at: 'x:1' }] });

fs.rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

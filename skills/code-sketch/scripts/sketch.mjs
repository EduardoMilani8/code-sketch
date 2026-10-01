#!/usr/bin/env node
// code-sketch: turn a small diagram spec (JSON) into an editable .excalidraw file
// plus a PNG preview the model can look at before handing the result to the user.
//
//   node sketch.mjs spec.json --out ./diagrams [--name my-diagram] [--no-png] [--no-limits]
//
// The model never writes Excalidraw JSON by hand. It writes a spec (nodes, edges, groups);
// this script does layout, sizing, arrow binding, size guardrails and rendering.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));

// ───────────────────────────── guardrails ─────────────────────────────
// A diagram only helps understanding while it fits in one glance. These limits are the
// "defense" against sprawling diagrams: when exceeded we refuse and tell the model how to shrink.
const LIMITS = {
  nodes: 12,
  edges: 14,
  groups: 4,
  label: 28,       // chars in a node label
  sub: 56,         // chars in a node sub-line (file:line, one-line role)
  edgeLabel: 28,
  takeaway: 120,
  title: 60,
  crossings: 2,    // edge crossings tolerated after layout
  fanOut: 3,       // arrows leaving one node
  canvas: 2200,    // px, either side
};

// ───────────────────────────── cli ─────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const specPath = args.find((a, i) => !a.startsWith('--') && (i === 0 || !['--out', '--name'].includes(args[i - 1])));
if (!specPath || flag('--help')) {
  console.log('usage: node sketch.mjs <spec.json> [--out dir] [--name file-base] [--no-png] [--no-limits]');
  process.exit(specPath ? 0 : 1);
}
const outDir = path.resolve(opt('--out', '.'));
const baseName = opt('--name', path.basename(specPath).replace(/\.json$/, ''));
const enforce = !flag('--no-limits');

async function loadDeps() {
  const tryLoad = async () => ({
    ELK: (await import('elkjs/lib/elk.bundled.js')).default,
    Resvg: (await import('@resvg/resvg-js')).Resvg,
  });
  try { return await tryLoad(); } catch {
    console.error('[code-sketch] first run: installing dependencies (elkjs, resvg) …');
    execSync('npm install --silent --no-audit --no-fund', { cwd: here, stdio: 'inherit' });
    return tryLoad();
  }
}

// ───────────────────────────── helpers ─────────────────────────────
const fail = (title, lines) => {
  console.error(`\n✗ ${title}`);
  for (const l of lines) console.error('  ' + l);
  process.exit(2);
};

const SHRINK_TIPS = [
  'One diagram = one question. Split into an OVERVIEW (≤ 8 nodes, one per module) and separate zoom-in diagrams.',
  'Collapse helper nodes into one node and list their names in its `sub` line.',
  'Spend fewer arrows: put related nodes in a `group` (containment says "belongs together" without any arrow).',
  'Drop nodes that do not change the explanation (utils, logging, DTOs, getters).',
];

function charW(c) {
  if ('il.,;:\'|!tfjr I()[]'.includes(c)) return 0.34;
  if ('mwMW@'.includes(c)) return 0.85;
  if (c >= 'A' && c <= 'Z') return 0.66;
  return 0.56;
}
const textW = (s, fs) => Math.ceil([...s].reduce((a, c) => a + charW(c), 0) * fs * 1.08);
const LH = 1.25;

function wrap(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
const measure = (lines, fs) => ({ w: Math.max(...lines.map((l) => textW(l, fs)), 1), h: Math.ceil(lines.length * fs * LH) });

function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const fracIndex = (i) => (i < 62 ? 'a' + B62[i] : 'b' + B62[Math.floor((i - 62) / 62)] + B62[(i - 62) % 62]);

// ───────────────────────────── theme ─────────────────────────────
const KINDS = {
  entry:    { bg: '#b2f2bb', stroke: '#2f9e44' },               // where execution/data starts
  process:  { bg: '#a5d8ff', stroke: '#1971c2' },               // a class / function / module doing work
  data:     { bg: '#d0bfff', stroke: '#6741d9' },               // state, DB, config, data object
  external: { bg: '#e9ecef', stroke: '#495057', dashed: true }, // outside this codebase: engine, API, user
  module:   { bg: '#c5f6fa', stroke: '#0b7285' },               // another module/assembly/package of this same project
  decision: { bg: '#ffec99', stroke: '#f08c00', diamond: true },
};
const INK = '#1e1e1e';
const SUBINK = '#495057';
const FOCUS = '#e8590c';

// ───────────────────────────── main ─────────────────────────────
const { ELK, Resvg } = await loadDeps();

let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch (e) { fail('Cannot read spec', [String(e.message)]); }

const nodes = spec.nodes ?? [];
const edges = spec.edges ?? [];
const groups = spec.groups ?? [];
const wantDir = spec.direction === 'TB' || spec.direction === 'LR' ? spec.direction : 'auto';
const numbered = spec.numbered !== false && edges.some((e) => e.label);

// ---- validate structure
const problems = [];
const ids = new Set();
for (const n of nodes) {
  if (!n.id || !n.label) problems.push(`node needs id and label: ${JSON.stringify(n)}`);
  if (ids.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
  ids.add(n.id);
  if (n.kind && !KINDS[n.kind]) problems.push(`node "${n.id}": unknown kind "${n.kind}" (use ${Object.keys(KINDS).join(', ')})`);
}
const gids = new Set(groups.map((g) => g.id));
for (const n of nodes) if (n.group && !gids.has(n.group)) problems.push(`node "${n.id}": unknown group "${n.group}"`);
const seenEdge = new Set();
for (const e of edges) {
  if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`edge ${e.from}→${e.to}: unknown node id`);
  const k = e.from + '>' + e.to;
  if (seenEdge.has(k)) problems.push(`duplicate edge ${k} (merge them into one label)`);
  seenEdge.add(k);
}
if (!nodes.length) problems.push('spec has no nodes');
if (problems.length) fail('Invalid spec', problems);

// ---- validate limits (text length is a spec typo-level fix; size needs a smaller diagram)
if (enforce) {
  const size = [], textual = [];
  if (nodes.length > LIMITS.nodes) size.push(`${nodes.length} nodes (max ${LIMITS.nodes})`);
  if (edges.length > LIMITS.edges) size.push(`${edges.length} arrows (max ${LIMITS.edges})`);
  if (groups.length > LIMITS.groups) size.push(`${groups.length} groups (max ${LIMITS.groups})`);
  for (const n of nodes) {
    if (n.label.length > LIMITS.label) textual.push(`label of "${n.id}" is ${n.label.length} chars (max ${LIMITS.label}); drop the package prefix, keep the name`);
    if ((n.sub ?? '').length > LIMITS.sub) textual.push(`sub of "${n.id}" is ${n.sub.length} chars (max ${LIMITS.sub}); keep file:line and 2-3 words`);
  }
  for (const e of edges) if ((e.label ?? '').length > LIMITS.edgeLabel) textual.push(`arrow label ${e.from}→${e.to} is ${e.label.length} chars (max ${LIMITS.edgeLabel}); say what travels, in few words`);
  if ((spec.title ?? '').length > LIMITS.title) textual.push(`title is ${spec.title.length} chars (max ${LIMITS.title})`);
  if ((spec.takeaway ?? '').length > LIMITS.takeaway) textual.push(`takeaway is ${spec.takeaway.length} chars (max ${LIMITS.takeaway}); one short sentence`);
  const out = new Map();
  for (const e of edges) out.set(e.from, (out.get(e.from) ?? 0) + 1);
  for (const [id, c] of out) if (c > LIMITS.fanOut) size.push(`"${id}" has ${c} outgoing arrows (max ${LIMITS.fanOut}); group its targets instead`);
  if (textual.length) fail('Text too long (just shorten it)', textual.map((o) => '• ' + o));
  if (size.length) fail('Diagram too big to stay readable', [...size.map((o) => '• ' + o), '', 'How to shrink it:', ...SHRINK_TIPS.map((t, i) => `${i + 1}. ${t}`)]);
}

// ---- measure nodes
const nodeBox = new Map();
for (const n of nodes) {
  const kind = KINDS[n.kind ?? 'process'];
  const labelLines = wrap(n.label, 20).slice(0, 2);
  const subLines = n.sub ? wrap(n.sub, 30).slice(0, 3) : [];
  const lm = measure(labelLines, 20);
  const sm = subLines.length ? measure(subLines, 14) : { w: 0, h: 0 };
  let w = Math.max(lm.w, sm.w) + 40;
  let h = lm.h + (subLines.length ? sm.h + 8 : 0) + 28;
  w = Math.max(w, 130);
  if (kind.diamond) { w = Math.round(w * 1.55); h = Math.round(h * 1.7); }
  nodeBox.set(n.id, { w, h, labelLines, subLines, lm, sm });
}

// ---- layout. Candidates: ELK left-to-right / top-down, plus a "snake" grid when the flow is a plain chain.
// The most compact one that fits the canvas cap wins. Group boxes are drawn after layout, around their members,
// so a group can never grow taller than what it contains.
const GROUP_LABEL_H = 30;
const GROUP_PAD = 14;
const MARGIN = 40;
const title = spec.title ?? baseName;
const edgeLabels = edges.map((e, i) => {
  const t = e.label ? (numbered ? `${i + 1}. ${e.label}` : e.label) : '';
  const lines = t ? wrap(t, 22).slice(0, 2) : [];
  return { lines, m: lines.length ? measure(lines, 16) : { w: 0, h: 0 } };
});
const takeLines = spec.takeaway ? wrap(spec.takeaway, 90) : [];
const titleM = measure([title], 28);
const takeM = takeLines.length ? measure(takeLines, 18) : { w: 0, h: 0 };
const headerH = titleM.h + (takeLines.length ? takeM.h + 10 : 0) + 34;
const hasGroups = groups.length > 0;

function groupBoxesFrom(pos) {
  const boxes = new Map();
  for (const gr of groups) {
    const ps = nodes.filter((n) => n.group === gr.id).map((n) => pos.get(n.id));
    if (!ps.length) continue;
    const x0 = Math.min(...ps.map((p) => p.x)), x1 = Math.max(...ps.map((p) => p.x + p.w));
    const y0 = Math.min(...ps.map((p) => p.y)), y1 = Math.max(...ps.map((p) => p.y + p.h));
    const minW = textW(gr.label ?? gr.id, 16) + 2 * GROUP_PAD + 8;
    const w = Math.max(x1 - x0 + 2 * GROUP_PAD, minW);
    boxes.set(gr.id, { x: (x0 + x1) / 2 - w / 2, y: y0 - GROUP_PAD - GROUP_LABEL_H, w, h: y1 - y0 + 2 * GROUP_PAD + GROUP_LABEL_H });
  }
  return boxes;
}

const rectsHit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectIn = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
function pathPoint(points, t) {
  const lens = points.slice(1).map((p, k) => Math.hypot(p.x - points[k].x, p.y - points[k].y));
  let rest = lens.reduce((a, b) => a + b, 0) * t, k = 0;
  while (k < lens.length - 1 && rest > lens[k]) rest -= lens[k++];
  const u = lens[k] ? rest / lens[k] : 0;
  return { x: points[k].x + (points[k + 1].x - points[k].x) * u, y: points[k].y + (points[k + 1].y - points[k].y) * u };
}
// Excalidraw centres an arrow's label at the path midpoint; we keep it there unless that spot sits on a node,
// straddles a group border or hits another label, in which case we slide it along the arrow to a free spot.
function placeLabels(routed, pos, groupBox) {
  const placed = [];
  routed.forEach((r, i) => {
    const m = edgeLabels[i].m;
    if (!edgeLabels[i].lines.length) { r.x = r.y = 0; return; }
    const offsets = [0];
    for (let d = 0.05; d <= 0.45; d += 0.05) offsets.push(-d, d);
    let best = null;
    for (const d of offsets) {
      const c = pathPoint(r.points, 0.5 + d);
      const rect = { x: c.x - m.w / 2 - 4, y: c.y - m.h / 2 - 2, w: m.w + 8, h: m.h + 4 };
      const ok = ![...pos.values()].some((p) => rectsHit(rect, p)) &&
        ![...groupBox.values()].some((g) => rectsHit(rect, g) && !rectIn(rect, g)) &&
        !placed.some((q) => rectsHit(rect, q));
      if (ok) { best = { c, rect }; break; }
    }
    best ??= (() => { const c = pathPoint(r.points, 0.5); return { c, rect: { x: c.x - m.w / 2, y: c.y - m.h / 2, w: m.w, h: m.h } }; })();
    r.x = best.c.x; r.y = best.c.y; placed.push(best.rect);
  });
}

function finish(name, pos, routed) {
  const groupBox = groupBoxesFrom(pos);
  placeLabels(routed, pos, groupBox);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y, w, h) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h); };
  for (const p of pos.values()) grow(p.x, p.y, p.w, p.h);
  for (const p of groupBox.values()) grow(p.x, p.y, p.w, p.h);
  routed.forEach((r, i) => { for (const pt of r.points) grow(pt.x, pt.y, 0, 0); if (edgeLabels[i].lines.length) grow(r.x - edgeLabels[i].m.w / 2, r.y - edgeLabels[i].m.h / 2, edgeLabels[i].m.w, edgeLabels[i].m.h); });
  const bodyW = maxX - minX, bodyH = maxY - minY;
  const inner = Math.max(bodyW, titleM.w, takeM.w);
  const overlaps = [];
  for (const [gid, box] of groupBox) for (const n of nodes) if (n.group !== gid && rectsHit(box, pos.get(n.id))) overlaps.push(`group "${gid}" box covers node "${n.id}"`);
  return {
    name, pos, groupBox, routed, overlaps,
    W: Math.ceil(inner + 2 * MARGIN), H: Math.ceil(bodyH + headerH + 2 * MARGIN),
    offX: MARGIN + (inner - bodyW) / 2 - minX, offY: MARGIN + headerH - minY,
  };
}

const elk = new ELK();
async function layoutElk({ dir, wrapping, partition }) {
  const opts = {
    'elk.algorithm': 'layered', 'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': hasGroups ? '84' : '50',
    'elk.layered.spacing.nodeNodeBetweenLayers': String((dir === 'LR' ? 70 : 36) + (hasGroups ? 36 : 0)),
    'elk.spacing.edgeNode': '24', 'elk.spacing.edgeLabel': '6',
    'elk.aspectRatio': '1.6', 'elk.layered.wrapping.strategy': wrapping, 'elk.layered.wrapping.correctionFactor': '2',
  };
  const root = { id: 'root', layoutOptions: opts, edges: [] };
  if (partition) opts['elk.partitioning.activate'] = 'true';
  root.children = nodes.map((n) => ({ id: n.id, width: nodeBox.get(n.id).w, height: nodeBox.get(n.id).h, ...(partition ? { layoutOptions: { 'elk.partitioning.partition': String(partition.get(n.id)) } } : {}) }));
  edges.forEach((e, i) => {
    const lb = edgeLabels[i];
    root.edges.push({ id: 'e' + i, sources: [e.from], targets: [e.to], labels: lb.lines.length ? [{ text: 'x', width: lb.m.w + 12, height: lb.m.h + 6 }] : [] });
  });
  const res = await elk.layout(root);
  const pos = new Map(res.children.map((k) => [k.id, { x: k.x, y: k.y, w: k.width, h: k.height }]));
  const routed = res.edges.map((e) => {
    const sec = e.sections[0];
    return { points: [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint], x: 0, y: 0 };
  });
  return finish(`elk-${dir}-${wrapping}${partition ? '-part' : ''}`, pos, routed);
}

// A plain chain (every node has at most one arrow in and one out) reads best as a snake: rows that alternate
// direction, so the picture is landscape instead of a skinny column.
function chainOrder() {
  if (nodes.length < 4 || edges.length !== nodes.length - 1) return null;
  const next = new Map(), hasIn = new Set();
  for (const e of edges) { if (next.has(e.from) || hasIn.has(e.to)) return null; next.set(e.from, e.to); hasIn.add(e.to); }
  const starts = nodes.filter((n) => !hasIn.has(n.id));
  if (starts.length !== 1) return null;
  const order = [];
  for (let id = starts[0].id; id; id = next.get(id)) { if (order.includes(id)) return null; order.push(id); }
  if (order.length !== nodes.length) return null;
  for (const gr of groups) { // members of a group must be consecutive in the chain
    const idx = order.map((id, i) => (nodes.find((n) => n.id === id).group === gr.id ? i : -1)).filter((i) => i >= 0);
    if (idx.length && idx[idx.length - 1] - idx[0] + 1 !== idx.length) return null;
  }
  return order;
}
function layoutSnake(order, k) {
  const gOf = (id) => nodes.find((n) => n.id === id)?.group;
  const rows = [[]];
  order.forEach((id, i) => {
    const g = gOf(id);
    const startsGroup = g && gOf(order[i - 1]) !== g;
    const size = g ? order.filter((o) => gOf(o) === g).length : 1;
    let row = rows[rows.length - 1];
    if (row.length && (row.length >= k || (startsGroup && size <= k && row.length + size > k))) rows.push((row = []));
    row.push(id);
  });
  const maxLabW = Math.max(0, ...edgeLabels.map((l) => l.m.w)), maxLabH = Math.max(0, ...edgeLabels.map((l) => l.m.h));
  const gapX = Math.max(100, maxLabW + 56), gapY = Math.max(70, maxLabH + 50) + (hasGroups ? 50 : 0);
  const colW = Math.max(...order.map((id) => nodeBox.get(id).w));
  const pos = new Map();
  let y = 0;
  rows.forEach((row, r) => {
    const rowH = Math.max(...row.map((id) => nodeBox.get(id).h));
    row.forEach((id, c) => {
      const b = nodeBox.get(id), col = r % 2 ? row.length - 1 - c + (k - row.length) : c;
      pos.set(id, { x: col * (colW + gapX) + (colW - b.w) / 2, y: y + (rowH - b.h) / 2, w: b.w, h: b.h });
    });
    y += rowH + gapY;
  });
  const rowOf = new Map(rows.flatMap((row, r) => row.map((id) => [id, r])));
  const routed = edges.map((e) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    if (rowOf.get(e.from) === rowOf.get(e.to)) {
      const right = bc.x > ac.x;
      return { points: [{ x: right ? a.x + a.w : a.x, y: ac.y }, { x: right ? b.x : b.x + b.w, y: ac.y }], x: 0, y: 0 };
    }
    const sy = a.y + a.h, ty = b.y, my = (sy + ty) / 2;
    return { points: ac.x === bc.x ? [{ x: ac.x, y: sy }, { x: bc.x, y: ty }] : [{ x: ac.x, y: sy }, { x: ac.x, y: my }, { x: bc.x, y: my }, { x: bc.x, y: ty }], x: 0, y: 0 };
  });
  return finish(`snake-${k}`, pos, routed);
}

// prefer canvases near a screen-like shape: penalise the longer side, then the area
const score = (c) => c.overlaps.length * 1e10 + (c.W > LIMITS.canvas || c.H > LIMITS.canvas ? 1e9 : 0) + Math.max(c.W, c.H * 1.4) * 1000 + c.W * c.H / 1000;
// Phase partitions: each group (or each ungrouped node) becomes one band of layers, ordered by flow depth,
// so a group's members end up side by side instead of interleaved with outsiders.
function phasePartition() {
  if (!hasGroups) return null;
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  const depth = new Map(), state = new Map();
  const dfs = (id, d) => { // longest path from the roots, ignoring back edges
    depth.set(id, Math.max(depth.get(id) ?? 0, d)); state.set(id, 1);
    for (const t of out.get(id)) if (state.get(t) !== 1) dfs(t, d + 1);
    state.set(id, 2);
  };
  const hasIn = new Set(edges.map((e) => e.to));
  for (const n of nodes) if (!hasIn.has(n.id)) dfs(n.id, 0);
  for (const n of nodes) if (!depth.has(n.id)) dfs(n.id, 0);
  const unitOf = (n) => n.group ?? '#' + n.id;
  const avg = new Map();
  for (const n of nodes) { const u = unitOf(n), a = avg.get(u) ?? []; a.push(depth.get(n.id)); avg.set(u, a); }
  const ranked = [...avg.entries()].map(([u, a]) => [u, a.reduce((x, y) => x + y, 0) / a.length]).sort((x, y) => x[1] - y[1]).map(([u]) => u);
  return new Map(nodes.map((n) => [n.id, ranked.indexOf(unitOf(n))]));
}
const cands = [];
const tryAdd = async (fn) => { try { cands.push(await fn()); } catch (e) { if (process.env.SKETCH_DEBUG) console.error('layout failed', e.message); } };
const order = chainOrder();
if (order && wantDir === 'auto') for (let k = 1; k <= order.length; k++) await tryAdd(async () => layoutSnake(order, k));
if (wantDir !== 'TB') await tryAdd(() => layoutElk({ dir: 'LR', wrapping: 'MULTI_EDGE' })), await tryAdd(() => layoutElk({ dir: 'LR', wrapping: 'OFF' }));
if (wantDir !== 'LR') await tryAdd(() => layoutElk({ dir: 'TB', wrapping: 'OFF' }));
const part = phasePartition();
if (part) {
  if (wantDir !== 'TB') await tryAdd(() => layoutElk({ dir: 'LR', wrapping: 'OFF', partition: part }));
  if (wantDir !== 'LR') await tryAdd(() => layoutElk({ dir: 'TB', wrapping: 'OFF', partition: part }));
}
if (!cands.length) fail('Layout failed', ['ELK could not lay this graph out; simplify the groups/edges.']);
if (process.env.SKETCH_DEBUG) console.error(cands.map((c) => `${c.name} ${c.W}x${c.H}`).join(' | '));
const layout = cands.sort((a, b) => score(a) - score(b))[0];
const { pos, groupBox, routed, W, H, offX, offY } = layout;
const warnings = [...layout.overlaps.map((o) => o + ' — the group is not one consecutive stretch of the flow; drop the group or reorder')];

// ---- quality metrics
function segInter(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
let crossings = 0;
for (let i = 0; i < routed.length; i++) for (let j = i + 1; j < routed.length; j++) {
  const A = routed[i].points, B = routed[j].points;
  let hit = false;
  for (let a = 0; a < A.length - 1 && !hit; a++) for (let b = 0; b < B.length - 1 && !hit; b++) if (segInter(A[a], A[a + 1], B[b], B[b + 1])) hit = true;
  if (hit) crossings++;
}
if (enforce) {
  if (W > LIMITS.canvas || H > LIMITS.canvas) fail('Diagram too big to stay readable', [`canvas would be ${W}×${H}px (max ${LIMITS.canvas})`, '', 'How to shrink it:', ...SHRINK_TIPS.map((t, i) => `${i + 1}. ${t}`), '', '(To see what it looks like anyway, rerun with --no-limits. That preview is for diagnosing only; never deliver it.)']);
  if (crossings > LIMITS.crossings) fail('Too many crossing arrows', [`${crossings} crossings (max ${LIMITS.crossings}) — spaghetti hides the story.`, '', 'Fix: remove arrows that do not carry the story, merge nodes that are always used together, or put them in a `group`.', '(To see what it looks like anyway, rerun with --no-limits. That preview is for diagnosing only; never deliver it.)']);
}
if (crossings) warnings.push(`${crossings} arrow crossing(s) — consider flipping direction or dropping an arrow`);
// an arrow that cuts through a group it neither starts nor ends in means the group is not contiguous in the flow
const nodeGroup = new Map(nodes.map((n) => [n.id, n.group]));
const segHitsRect = (p, q, r) => {
  const corners = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  const inside = (pt) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  return inside(p) || inside(q) || corners.some((c, i) => segInter(p, q, c, corners[(i + 1) % 4]));
};
edges.forEach((e, i) => {
  for (const [gid, box] of groupBox) {
    if (nodeGroup.get(e.from) === gid || nodeGroup.get(e.to) === gid) continue;
    const P = routed[i].points;
    if (P.some((pt, k) => k && segHitsRect(P[k - 1], pt, box))) { warnings.push(`arrow ${e.from}→${e.to} cuts through group "${gid}" — keep a group's nodes consecutive in the flow, or drop the group`); break; }
  }
});
// a group should be one connected stretch of the flow; members linked only through outsiders make a big empty box
for (const gr of groups) {
  const members = nodes.filter((n) => n.group === gr.id).map((n) => n.id);
  if (members.length < 2) continue;
  const seen = new Set([members[0]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) {
      if (members.includes(e.from) && members.includes(e.to) && seen.has(e.from) !== seen.has(e.to)) { seen.add(e.from); seen.add(e.to); grew = true; }
    }
  }
  if (seen.size < members.length) warnings.push(`group "${gr.id}": ${members.filter((m) => !seen.has(m)).join(', ')} not linked by arrows to the rest of the group — a group must be one consecutive stretch of the flow; to say "same file", put the file in the node's sub instead`);
}
const connected = new Set(edges.flatMap((e) => [e.from, e.to]));
for (const n of nodes) if (!connected.has(n.id) && nodes.length > 1) warnings.push(`"${n.id}" has no arrows (fine only if its group explains it)`);
if (!nodes.some((n) => n.focus)) warnings.push('no node has `focus: true` — mark the one thing the reader should remember');

// ───────────────────────────── build excalidraw elements ─────────────────────────────
const elements = [];
let seedN = 1;
function el(type, x, y, w, h, extra = {}) {
  const id = extra.id;
  const e = {
    id, type, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, width: Math.round(w * 10) / 10, height: Math.round(h * 10) / 10,
    angle: 0, strokeColor: INK, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: 1, opacity: 100, groupIds: [], frameId: null, index: fracIndex(elements.length), roundness: null,
    seed: hash(id) + seedN++, version: 1, versionNonce: hash(id + 'v'), isDeleted: false, boundElements: [], updated: 1, link: null, locked: false,
    ...extra,
  };
  elements.push(e);
  return e;
}
function text(id, str, cx, cy, fs, extra = {}) {
  const lines = str.split('\n');
  const m = measure(lines, fs);
  return el('text', cx - m.w / 2, cy - m.h / 2, m.w, m.h, {
    id, text: str, originalText: str, fontSize: fs, fontFamily: 5, textAlign: 'center', verticalAlign: 'middle',
    containerId: null, autoResize: true, lineHeight: LH, strokeColor: INK, ...extra,
  });
}

// header
const headX = MARGIN;
const tEl = text('title', title, 0, 0, 28, { textAlign: 'left' });
tEl.x = headX; tEl.y = MARGIN;
if (takeLines.length) {
  const k = text('takeaway', takeLines.join('\n'), 0, 0, 18, { textAlign: 'left', strokeColor: SUBINK });
  k.x = headX; k.y = MARGIN + titleM.h + 10;
}

// groups (drawn first = behind)
for (const gr of groups) {
  const b = groupBox.get(gr.id);
  const x = b.x + offX, y = b.y + offY;
  el('rectangle', x, y, b.w, b.h, { id: 'grp_' + gr.id, strokeColor: '#868e96', strokeStyle: 'dashed', strokeWidth: 1, backgroundColor: '#f8f9fa', roundness: { type: 3 } });
  const lbl = text('grp_lbl_' + gr.id, gr.label ?? gr.id, 0, 0, 16, { textAlign: 'left', strokeColor: SUBINK });
  // keep the label clear of arrows entering the box: try the left corner, then the right one
  const blocked = (lx) => routed.some((r) => r.points.some((pt, k) => k && segHitsRect({ x: r.points[k - 1].x + offX, y: r.points[k - 1].y + offY }, { x: pt.x + offX, y: pt.y + offY }, { x: lx - 6, y: y + 4, w: lbl.width + 12, h: lbl.height + 8 })));
  lbl.x = x + 14; lbl.y = y + 8;
  if (blocked(lbl.x)) { const alt = x + b.w - 14 - lbl.width; if (!blocked(alt)) lbl.x = alt; }
}

// nodes
const shapeIds = new Map();
for (const n of nodes) {
  const p = pos.get(n.id), b = nodeBox.get(n.id), kind = KINDS[n.kind ?? 'process'];
  const x = p.x + offX, y = p.y + offY;
  const gid = 'node_' + n.id;
  const shapeId = 'shape_' + n.id;
  shapeIds.set(n.id, shapeId);
  el(kind.diamond ? 'diamond' : 'rectangle', x, y, p.w, p.h, {
    id: shapeId, groupIds: [gid], backgroundColor: kind.bg, strokeColor: n.focus ? FOCUS : kind.stroke, strokeWidth: n.focus ? 4 : 2,
    strokeStyle: kind.dashed ? 'dashed' : 'solid', roundness: kind.diamond ? { type: 2 } : { type: 3 },
  });
  const blockH = b.lm.h + (b.subLines.length ? b.sm.h + 8 : 0);
  const top = y + (p.h - blockH) / 2;
  text('lbl_' + n.id, b.labelLines.join('\n'), x + p.w / 2, top + b.lm.h / 2, 20, { groupIds: [gid] });
  if (b.subLines.length) text('sub_' + n.id, b.subLines.join('\n'), x + p.w / 2, top + b.lm.h + 8 + b.sm.h / 2, 14, { groupIds: [gid], strokeColor: SUBINK });
}

// arrows (+ bound labels)
edges.forEach((e, i) => {
  const r = routed[i];
  const pts = r.points.map((q) => ({ x: q.x + offX, y: q.y + offY }));
  const id = `arrow_${i}`;
  const a = el('arrow', pts[0].x, pts[0].y, Math.max(...pts.map((q) => q.x)) - Math.min(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y)), {
    id, strokeColor: '#343a40', strokeStyle: e.dashed ? 'dashed' : 'solid',
    points: pts.map((q) => [Math.round((q.x - pts[0].x) * 10) / 10, Math.round((q.y - pts[0].y) * 10) / 10]),
    lastCommittedPoint: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
    startBinding: { elementId: shapeIds.get(e.from), focus: 0, gap: 2 },
    endBinding: { elementId: shapeIds.get(e.to), focus: 0, gap: 2 },
  });
  for (const [nid, which] of [[e.from, 'from'], [e.to, 'to']]) {
    const s = elements.find((x) => x.id === shapeIds.get(nid));
    s.boundElements.push({ id, type: 'arrow' });
  }
  const lb = edgeLabels[i];
  if (lb.lines.length) {
    const tid = `arrow_lbl_${i}`;
    text(tid, lb.lines.join('\n'), r.x + offX, r.y + offY, 16, { containerId: id, strokeColor: '#495057' });
    a.boundElements.push({ id: tid, type: 'text' });
  }
});

const scene = { type: 'excalidraw', version: 2, source: 'code-sketch', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };

// ───────────────────────────── svg preview (rendered from the real elements) ─────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toSvg(els) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>`];
  const dash = (e) => (e.strokeStyle === 'dashed' ? ' stroke-dasharray="8 6"' : '');
  const byId = new Map(els.map((e) => [e.id, e]));
  for (const e of els) {
    if (e.type === 'rectangle') out.push(`<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="12" fill="${e.backgroundColor}" stroke="${e.strokeColor}" stroke-width="${e.strokeWidth}"${dash(e)}/>`);
    else if (e.type === 'diamond') { const { x, y, width: w, height: h } = e; out.push(`<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${e.backgroundColor}" stroke="${e.strokeColor}" stroke-width="${e.strokeWidth}"/>`); }
    else if (e.type === 'arrow') {
      const P = e.points.map(([px, py]) => [e.x + px, e.y + py]);
      out.push(`<polyline points="${P.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${e.strokeColor}" stroke-width="2"${dash(e)}/>`);
      const [x2, y2] = P[P.length - 1], [x1, y1] = P[P.length - 2];
      const ang = Math.atan2(y2 - y1, x2 - x1);
      for (const s of [-1, 1]) out.push(`<line x1="${x2}" y1="${y2}" x2="${x2 - 13 * Math.cos(ang + s * 0.45)}" y2="${y2 - 13 * Math.sin(ang + s * 0.45)}" stroke="${e.strokeColor}" stroke-width="2"/>`);
    }
  }
  for (const e of els) if (e.type === 'text') {
    const lines = e.text.split('\n');
    const anchor = e.textAlign === 'left' ? 'start' : 'middle';
    const tx = e.textAlign === 'left' ? e.x : e.x + e.width / 2;
    if (e.containerId && byId.get(e.containerId)?.type === 'arrow') out.push(`<rect x="${e.x - 3}" y="${e.y - 1}" width="${e.width + 6}" height="${e.height + 2}" fill="#fff" fill-opacity="0.92"/>`);
    out.push(`<text font-family="'Segoe Print','Comic Sans MS','DejaVu Sans',sans-serif" font-size="${e.fontSize}" fill="${e.strokeColor}" text-anchor="${anchor}">` +
      lines.map((l, i) => `<tspan x="${tx}" y="${e.y + e.fontSize * 0.98 + i * e.fontSize * LH}">${esc(l)}</tspan>`).join('') + '</text>');
  }
  out.push('</svg>');
  return out.join('\n');
}

fs.mkdirSync(outDir, { recursive: true });
const excalPath = path.join(outDir, baseName + '.excalidraw');
const svgPath = path.join(outDir, baseName + '.svg');
const pngPath = path.join(outDir, baseName + '.png');
fs.writeFileSync(excalPath, JSON.stringify(scene, null, 2));
const svg = toSvg(elements);
fs.writeFileSync(svgPath, svg);
if (!flag('--no-png')) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: Math.min(Math.max(W, 1100), 1600) }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
  fs.writeFileSync(pngPath, png);
}

console.log(`✓ ${nodes.length} nodes, ${edges.length} arrows, ${groups.length} groups, ${crossings} crossing(s), canvas ${W}×${H}px`);
for (const w of warnings) console.log('  ! ' + w);
console.log(`  excalidraw: ${excalPath}`);
if (!flag('--no-png')) console.log(`  preview (LOOK AT THIS with the Read tool): ${pngPath}`);

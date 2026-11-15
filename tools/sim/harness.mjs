#!/usr/bin/env node
// Runs a CLEO Redux script outside the game, against a mock runtime, to find plain JavaScript mistakes in it.
//
//   node tools/sim/harness.mjs "game/CLEO/sa-coop[dll][mem].js"
//
// Options: --only=c,e (scenario ids)  --role=host|guest  --ticks=N (cap per scenario)  --dts=<path to sa.d.ts>
//          --strict-api (a method that is not in sa.d.ts is not a function, as in the game)  --coverage (every unreached line)
// Exit code 1 when anything failed. The script is read once per run and never changed.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Session } from 'node:inspector';
import { fileURLToPath } from 'node:url';
import { Sim, SimStop, SimExit, parseDts } from './mock.mjs';
import { scenarios } from './scenarios.mjs';

Error.stackTraceLimit = 50;
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`)); return a ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : true) : undefined; };
const file = path.resolve(argv.find((a) => !a.startsWith('--')) || path.join(here, '../../game/CLEO/sa-coop[dll][mem].js'));
const dtsPath = opt('dts') || 'C:/Program Files (x86)/Steam/steamapps/common/GTA San Andreas - The Definitive Edition/Gameface/Binaries/Win64/CLEO/.config/sa.d.ts';
const BAD = /ReferenceError|TypeError|is not defined|is not a function|Cannot (read|access)|before initialization|undefined/;

const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
let dts = null;
try { dts = parseDts(fs.readFileSync(dtsPath, 'utf8')); } catch (e) { console.log(`! sa.d.ts not read (${dtsPath}): method names are not checked, defaults go by name`); }

// Every exception thrown inside the script is seen here, also the ones a `catch (e) {}` of the script swallows.
const session = new Session();
session.connect();
const post = (method, params) => new Promise((ok, no) => session.post(method, params, (e, r) => (e ? no(e) : ok(r))));
// V8 names the script by a file URL; scripts are told apart by id in the pause events
const flat = (p) => p.replaceAll('\\', '/').toLowerCase();
const sameFile = (url) => { try { return flat(decodeURIComponent(url).replace(/^file:\/+/, '')) === flat(file); } catch (e) { return false; } };
const scriptIds = new Set();
session.on('Debugger.scriptParsed', ({ params }) => { if (sameFile(params.url)) scriptIds.add(params.scriptId); });
await post('Profiler.enable');
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
await post('Debugger.enable');
await post('Debugger.setPauseOnExceptions', { state: 'all' });
let cur = null;
session.on('Debugger.paused', ({ params }) => {
  try {
    const top = params.callFrames[0], d = params.data || {};
    if (cur && !cur.peeking && top && scriptIds.has(top.location.scriptId) && d.className !== 'SimStop' && d.className !== 'SimExit') {
      cur.thrown(top.location.lineNumber + 1, top.functionName || '(top level)', String(d.description ?? d.value).split('\n')[0]);
    }
  } finally { session.post('Debugger.resume'); }
});

try { new vm.Script(source, { filename: file }); } catch (e) {
  console.log(`FAIL: the script does not compile\n${String(e.stack).split('\n').slice(0, 5).join('\n')}`);
  process.exit(1);
}

const only = opt('only') ? String(opt('only')).split(',') : null;
const results = [];
for (const scn of scenarios) {
  if (only && !only.includes(scn.id)) continue;
  for (const role of scn.roles || ['host', 'guest']) {
    if (opt('role') && opt('role') !== role) continue;
    const sim = new Sim({ role, dts, file, maxTicks: Math.min(scn.ticks, Number(opt('ticks')) || Infinity), strictApi: !!opt('strict-api') });
    const ctx = sim.context();
    scn.build(sim, sim.on.bind(sim));
    let escaped = null;
    cur = sim;
    try { new vm.Script(source, { filename: file }).runInContext(ctx, { timeout: 120000 }); } catch (e) {
      if (e instanceof SimExit) sim.exited = e.reason; else if (!(e instanceof SimStop)) escaped = e;
    }
    cur = null;
    results.push(report(scn, role, sim, escaped));
  }
}

function report(scn, role, sim, escaped) {
  const fails = [], warns = [];
  if (escaped) {
    const at = /:(\d+)(?::\d+)?\)?$/m.exec(String(escaped.stack).split('\n').find((l) => l.includes(file)) || '');
    fails.push(`ESCAPED  ${at ? `L${at[1]} ` : ''}${escaped.name || ''}: ${escaped.message}`);
  }
  if (sim.exited !== null && !scn.expectExit) fails.push(`EXIT     the script called exit("${sim.exited}")`);
  for (const t of [...sim.throws.values()].sort((a, b) => a.line - b.line)) fails.push(`THROWN   L${t.line} in ${t.fn}: ${t.msg}  x${t.n}`);
  for (const l of sim.logs.values()) if (BAD.test(l.text)) fails.push(`LOG      ${l.text}  x${l.n}`);
  for (const f of sim.findings.values()) {
    const line = `${f.kind.padEnd(8)} ${f.line ? `L${f.line} ` : ''}${f.text}  x${f.n}`;
    if (f.kind === 'DEAD') warns.push(line); else fails.push(line);
  }
  console.log(`\n== (${scn.id}) ${scn.title} [${role}]  ticks ${Math.min(sim.tick, sim.maxTicks)}/${sim.maxTicks}  failures ${fails.length}`);
  for (const f of fails) console.log(`  FAIL ${f}`);
  for (const w of warns) console.log(`  warn ${w}`);
  const sent = [...sim.sent].sort((a, b) => a[0] - b[0]).map(([k, e]) => `${k}x${e.n}`).join(' ');
  console.log(`  events sent (kind x count): ${sent || '-'}`);
  console.log(`  log lines (${sim.logs.size} distinct):`);
  for (const l of sim.logs.values()) console.log(`    ${String(l.n).padStart(4)}x ${l.text}`);
  return { id: scn.id, role, fails, sim };
}

// ---- the whole run ---------------------------------------------------------------------------------------------------
const merged = (pick) => {
  const out = new Map();
  for (const r of results) for (const [k, v] of r.sim[pick]) { const o = out.get(k); if (o) o.n += v.n; else out.set(k, { ...v }); }
  return [...out].sort((a, b) => a[0].localeCompare(b[0]));
};
console.log('\n== game API: methods answered by a default (no behaviour behind them)');
const fb = merged('fallbacks');
console.log('  returned a made-up value (a wrong default can hide a problem here):');
for (const [k, v] of fb) if (!v.noop) console.log(`    ${k} -> ${v.value}  (L${v.line}, x${v.n})`);
console.log(`  did nothing (void or returns itself): ${fb.filter(([, v]) => v.noop).map(([k]) => k).join(', ') || '-'}`);
const calls = new Map();
for (const r of results) for (const [k, n] of r.sim.apiCalls) calls.set(k, (calls.get(k) || 0) + n);
const names = /for \(const name of \[([^\]]+)\]/.exec(source);
const never = names ? names[1].match(/coop_\w+/g).filter((n) => !calls.has(n)) : [];
console.log(`  DLL functions never called: ${never.join(', ') || '-'}`);

// ---- what the scenarios did not reach (V8 block coverage, merged over all runs)
const cov = (await post('Profiler.takePreciseCoverage')).result.filter((s) => sameFile(s.url));
const hit = new Uint8Array(source.length), fns = new Map();
for (const s of cov) {
  const local = new Uint8Array(source.length);
  const ranges = s.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) local.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
  for (let i = 0; i < hit.length; i++) hit[i] |= local[i];
  for (const f of s.functions) {
    if (!f.functionName) continue;
    const k = `${f.functionName}@${f.ranges[0].startOffset}`, o = fns.get(k) || { name: f.functionName, start: f.ranges[0].startOffset, end: f.ranges[0].endOffset, n: 0 };
    o.n += f.ranges[0].count; fns.set(k, o);
  }
}
const lineStart = [0];
for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStart.push(i + 1);
const lineOf = (off) => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStart[m] <= off) lo = m; else hi = m - 1; } return lo + 1; };
const fnAt = (off) => { let best = null; for (const f of fns.values()) if (f.start <= off && off < f.end && (!best || f.start > best.start)) best = f; return best ? best.name : '(top level)'; };
const dead = [], partial = [];
let catches = 0;
for (let n = 0; n < lineStart.length; n++) {
  const from = lineStart[n], to = n + 1 < lineStart.length ? lineStart[n + 1] : source.length, text = source.slice(from, to);
  if (!text.trim() || /^\s*(\/\/|\*|\/\*)/.test(text) || /^[\s{}();]*$/.test(text)) continue;
  let miss = 0, code = 0, first = -1;
  for (let i = from; i < to; i++) if (!/\s/.test(source[i])) { code++; if (!hit[i]) { miss++; if (first < 0) first = i; } }
  if (!miss) continue;
  if (/^}?\s*catch/.test(source.slice(first, to).trim())) catches++; // a catch that never had to run
  else if (miss === code) dead.push(n + 1);
  else if (miss > 3) partial.push({ line: n + 1, text: source.slice(first, to).trim().slice(0, 100) });
}
if (cov.length) {
  console.log('\n== not reached by any scenario');
  const uncalled = [...fns.values()].filter((f) => !f.n).sort((a, b) => a.start - b.start);
  console.log(`  functions never called: ${uncalled.map((f) => `${f.name} (L${lineOf(f.start)})`).join(', ') || '-'}`);
  const groups = [];
  for (const l of dead) { const g = groups.at(-1); if (g && l - g.to <= 2 && g.fn === fnAt(lineStart[l - 1] + source.slice(lineStart[l - 1]).search(/\S/))) g.to = l; else groups.push({ from: l, to: l, fn: fnAt(lineStart[l - 1] + source.slice(lineStart[l - 1]).search(/\S/)) }); }
  console.log(`  whole lines never run (${dead.length}): ${groups.map((g) => `${g.from === g.to ? `L${g.from}` : `L${g.from}-${g.to}`} ${g.fn}`).join('; ') || '-'}`);
  console.log(`  catch blocks never entered: ${catches}`);
  console.log(`  lines run only in part: ${partial.length}${opt('coverage') ? '' : ' (list them with --coverage)'}`);
  if (opt('coverage')) for (const p of partial) console.log(`    L${p.line}: ${p.text}`);
}

console.log('\n== summary');
for (const r of results) console.log(`  ${r.fails.length ? 'FAIL' : 'pass'}  (${r.id}) ${r.role.padEnd(5)}  ${r.fails.length} failure(s)`);
const all = new Map();
for (const r of results) for (const f of r.fails) { const k = f.replace(/\s+x\d+$/, ''); (all.get(k) || all.set(k, []).get(k)).push(`${r.id}/${r.role}`); }
if (all.size) {
  console.log('\n== every distinct failure, with the scenarios that showed it');
  for (const [k, where] of [...all].sort()) console.log(`  ${k}\n      in: ${where.join(' ')}`);
}
session.disconnect();
process.exit(all.size ? 1 : 0);

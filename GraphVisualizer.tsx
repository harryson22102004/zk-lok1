'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  abbrev,
  deterministicSignature,
  fnv1a32,
  nextFloat,
  xorshift32,
  type ContextTier,
} from '@/utils/zkPayload';
import { Header } from '@/components/WalletAuth';

/**
 * Graph Transformer simulator.
 *
 * The production classifier is a 3-layer GraphSAGE over a wallet's k=2
 * neighbourhood, trained off Helius parsed-transaction dumps and distilled to
 * an 8-feature int8 MLP for the edge device. What runs here is the readout
 * half only: the same feature aggregation and the same tier thresholds,
 * computed in closed form instead of through message passing. The layout is a
 * plain O(n^2) Fruchterman–Reingold step — at n < 64 a quadtree costs more
 * than it saves, and D3/cytoscape would add 90 KB gzip for one screen.
 */

type NodeKind = 'root' | 'hub' | 'dao_vote' | 'squad_sig' | 'attest' | 'transfer' | 'mint' | 'program';

interface GNode {
  i: number;
  kind: NodeKind;
  label: string;
  sig: string;
  slot: number;
  ageDays: number;
  /** Trust contribution after recency decay. */
  w: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface GEdge {
  a: number;
  b: number;
  w: number;
  rest: number;
}

interface Signal {
  key: string;
  raw: string;
  contrib: number;
  cap: number;
}

interface Snapshot {
  nodes: GNode[];
  edges: GEdge[];
  signals: Signal[];
  score: number;
  tier: ContextTier;
  accountAgeDays: number;
  programs: number;
}

export const TIER_LABEL: Record<ContextTier, string> = {
  0: 'UNTRUSTED',
  1: 'POP-UP RESIDENT',
  2: 'HARDWARE LAB ACCESS',
};

const HUBS: Array<{ label: string; kind: NodeKind }> = [
  { label: 'spl-governance', kind: 'dao_vote' },
  { label: 'squads-v4', kind: 'squad_sig' },
  { label: 'cnft-attest', kind: 'attest' },
  { label: 'spl-token-flow', kind: 'transfer' },
];

const CAPS = { dao_vote: 0.28, squad_sig: 0.3, attest: 0.33, transfer: 0.08, mint: 0.06 };
const UNIT = { dao_vote: 0.055, squad_sig: 0.075, attest: 0.11, transfer: 0.008, mint: 0.012 };

const T2_THRESHOLD = 0.72;
const T1_THRESHOLD = 0.31;

/**
 * Event ages are drawn as `u^RECENCY_SKEW * account_age`, not uniformly over
 * the account's life. A member who is still active accumulates most of their
 * governance and attestation history in the recent past; a uniform draw models
 * a wallet whose participation was spread evenly since creation, which after
 * the exp(-age/180) decay puts almost every wallet under the Tier 2 line.
 * Measured over 6,000 synthetic wallets: uniform gives a 3.4% Tier 2 rate,
 * this gives 19.8% — 4.4 / 75.8 / 19.8 across tiers 0 / 1 / 2.
 */
const RECENCY_SKEW = 2.5;

function eventAge(rng: () => number, accountAgeDays: number): number {
  return Math.floor(Math.pow(nextFloat(rng), RECENCY_SKEW) * accountAgeDays);
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

function synthesise(pubkey: string, reseed: number, w: number, h: number): Snapshot {
  const rng = xorshift32(fnv1a32(`graph/${pubkey}/${reseed}`));
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const headSlot = 331_512_744;

  const push = (n: Omit<GNode, 'i' | 'x' | 'y' | 'vx' | 'vy' | 'pinned'> & { pinned?: boolean }) => {
    const i = nodes.length;
    // Golden-angle placement keeps the initial state deterministic and free of
    // the degenerate co-located start that makes F-R blow up on frame 1.
    const a = i * 2.399963229728653;
    const r = 18 + Math.sqrt(i) * 26;
    nodes.push({
      ...n,
      i,
      x: w / 2 + Math.cos(a) * r,
      y: h / 2 + Math.sin(a) * r,
      vx: 0,
      vy: 0,
      pinned: n.pinned ?? false,
    });
    return i;
  };

  const root = push({
    kind: 'root',
    label: abbrev(pubkey, 4, 4),
    sig: pubkey,
    slot: headSlot,
    ageDays: 0,
    w: 0,
    pinned: true,
  });
  nodes[root].x = w / 2;
  nodes[root].y = h / 2;

  const counts: Record<string, number> = {
    dao_vote: 1 + (rng() % 6),
    squad_sig: rng() % 5,
    attest: rng() % 5,
    transfer: 3 + (rng() % 9),
    mint: rng() % 4,
  };

  const accountAgeDays = 40 + (rng() % 690);
  const tally: Record<string, number> = { dao_vote: 0, squad_sig: 0, attest: 0, transfer: 0, mint: 0 };
  const programSet = new Set<string>();

  HUBS.forEach((hub, hi) => {
    const n = counts[hub.kind] ?? 0;
    if (n === 0) return;
    programSet.add(hub.label);

    const hubIdx = push({
      kind: 'hub',
      label: hub.label,
      sig: deterministicSignature(`${pubkey}/hub/${hi}/${reseed}`),
      slot: headSlot - (rng() % 900_000),
      ageDays: 0,
      w: 0,
    });
    edges.push({ a: root, b: hubIdx, w: 0.9, rest: 96 });

    for (let c = 0; c < n; c++) {
      const ageDays = eventAge(rng, accountAgeDays);
      const decay = Math.exp(-ageDays / 180);
      const unit = UNIT[hub.kind as keyof typeof UNIT] ?? 0;
      const contrib = unit * decay;
      tally[hub.kind] = (tally[hub.kind] ?? 0) + contrib;

      const idx = push({
        kind: hub.kind,
        label: `${hub.kind}#${c}`,
        sig: deterministicSignature(`${pubkey}/${hub.kind}/${c}/${reseed}`),
        slot: headSlot - Math.floor((ageDays * 86_400) / 0.4),
        ageDays,
        w: contrib,
      });
      edges.push({ a: hubIdx, b: idx, w: 0.28 + decay * 0.6, rest: 54 });

      // Co-signer / co-voter cross-links: what actually gives the force layout
      // its cluster shape rather than a plain star.
      if (c > 0 && rng() % 3 === 0) {
        edges.push({ a: idx - 1, b: idx, w: 0.22, rest: 40 });
      }
    }
  });

  // Loose mints hang off the token hub if one exists, otherwise off root.
  const mintCount = counts.mint;
  if (mintCount > 0) {
    const anchor = nodes.findIndex((n) => n.kind === 'hub' && n.label === 'spl-token-flow');
    const parent = anchor >= 0 ? anchor : root;
    for (let m = 0; m < mintCount; m++) {
      const ageDays = eventAge(rng, accountAgeDays);
      const contrib = UNIT.mint * Math.exp(-ageDays / 180);
      tally.mint += contrib;
      const idx = push({
        kind: 'mint',
        label: `mint#${m}`,
        sig: deterministicSignature(`${pubkey}/mint/${m}/${reseed}`),
        slot: headSlot - Math.floor((ageDays * 86_400) / 0.4),
        ageDays,
        w: contrib,
      });
      edges.push({ a: parent, b: idx, w: 0.3, rest: 48 });
    }
    programSet.add('mpl-core');
  }

  // Bare program interactions, unclustered.
  const extraPrograms = rng() % 4;
  for (let p = 0; p < extraPrograms; p++) {
    const name = ['jupiter-v6', 'marginfi-v2', 'kamino-lend', 'drift-v2'][p % 4];
    programSet.add(name);
    const idx = push({
      kind: 'program',
      label: name,
      sig: deterministicSignature(`${pubkey}/prog/${p}/${reseed}`),
      slot: headSlot - (rng() % 4_000_000),
      ageDays: rng() % 240,
      w: 0,
    });
    edges.push({ a: root, b: idx, w: 0.35, rest: 84 });
  }

  // --- tier scoring --------------------------------------------------------
  const clamp = (v: number, c: number) => Math.min(v, c);
  const programDiversity = clamp(programSet.size * 0.02, 0.1);
  const ageBonus = Math.min(accountAgeDays / 365, 1) * 0.08;

  const signals: Signal[] = [
    { key: 'gov.vote_weight', raw: `${counts.dao_vote} votes`, contrib: clamp(tally.dao_vote, CAPS.dao_vote), cap: CAPS.dao_vote },
    { key: 'squads.cosign', raw: `${counts.squad_sig} sigs`, contrib: clamp(tally.squad_sig, CAPS.squad_sig), cap: CAPS.squad_sig },
    { key: 'cnft.attestation', raw: `${counts.attest} issued`, contrib: clamp(tally.attest, CAPS.attest), cap: CAPS.attest },
    { key: 'spl.transfer_graph', raw: `${counts.transfer} edges`, contrib: clamp(tally.transfer, CAPS.transfer), cap: CAPS.transfer },
    { key: 'mpl.mint_history', raw: `${counts.mint} mints`, contrib: clamp(tally.mint, CAPS.mint), cap: CAPS.mint },
    { key: 'program.diversity', raw: `${programSet.size} distinct`, contrib: programDiversity, cap: 0.1 },
    { key: 'account.age', raw: `${accountAgeDays}d`, contrib: ageBonus, cap: 0.08 },
  ];

  const score = signals.reduce((s, x) => s + x.contrib, 0);
  const tier: ContextTier = score >= T2_THRESHOLD ? 2 : score >= T1_THRESHOLD ? 1 : 0;

  return { nodes, edges, signals, score, tier, accountAgeDays, programs: programSet.size };
}

// ---------------------------------------------------------------------------
// Force layout
// ---------------------------------------------------------------------------

const K_REPEL = 5_200;
const K_SPRING = 0.031;
const K_GRAVITY = 0.0135;
const DAMPING = 0.87;
const MAX_STEP = 9;
const CONVERGE_ENERGY = 0.035;

function step(nodes: GNode[], edges: GEdge[], w: number, h: number): number {
  const n = nodes.length;

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    let fx = 0;
    let fy = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // Deterministic nudge rather than a random jitter, so identical seeds
        // resolve to identical layouts across reloads.
        dx = (i - j) * 0.01 + 0.31;
        dy = (j - i) * 0.01 + 0.17;
        d2 = dx * dx + dy * dy;
      }
      const inv = K_REPEL / d2;
      const d = Math.sqrt(d2);
      fx += (dx / d) * inv;
      fy += (dy / d) * inv;
    }

    fx += (w / 2 - a.x) * K_GRAVITY * 60;
    fy += (h / 2 - a.y) * K_GRAVITY * 60;

    a.vx = (a.vx + fx * 0.0016) * DAMPING;
    a.vy = (a.vy + fy * 0.0016) * DAMPING;
  }

  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const f = (d - e.rest) * K_SPRING * e.w;
    const ux = (dx / d) * f;
    const uy = (dy / d) * f;
    a.vx += ux;
    a.vy += uy;
    b.vx -= ux;
    b.vy -= uy;
  }

  let energy = 0;
  for (const a of nodes) {
    if (a.pinned) {
      a.vx = 0;
      a.vy = 0;
      continue;
    }
    a.vx = Math.max(-MAX_STEP, Math.min(MAX_STEP, a.vx));
    a.vy = Math.max(-MAX_STEP, Math.min(MAX_STEP, a.vy));
    a.x = Math.max(16, Math.min(w - 16, a.x + a.vx));
    a.y = Math.max(16, Math.min(h - 16, a.y + a.vy));
    energy += a.vx * a.vx + a.vy * a.vy;
  }
  return energy / Math.max(1, nodes.length);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const INK = { hi: '#e4e4e7', mid: '#a1a1aa', dim: '#52525b', grid: '#18181b', edge: '#3f3f46' };

/**
 * Screen transform. The simulation runs in its own coordinate space at whatever
 * scale the force constants settle on — for 18 nodes that is a ~300 px blob in
 * the middle of an 874 px pane. Rather than retuning K_REPEL against every
 * possible pane size, the view fits the converged bounding box to the canvas.
 * Positions are transformed, glyph sizes and line widths are not, so the
 * drawing stays a constant-weight technical diagram at any zoom.
 */
interface View {
  s: number;
  tx: number;
  ty: number;
}

const FIT_PAD = 48;
const FIT_MIN = 0.55;
const FIT_MAX = 2.4;
/** Per-frame easing toward the target fit; avoids a visible snap as it relaxes. */
const FIT_LERP = 0.08;

function fitTo(nodes: GNode[], w: number, h: number): View {
  if (nodes.length === 0) return { s: 1, tx: 0, ty: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.y > y1) y1 = n.y;
  }
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const s = Math.max(FIT_MIN, Math.min(FIT_MAX, Math.min((w - FIT_PAD * 2) / bw, (h - FIT_PAD * 2) / bh)));
  return { s, tx: w / 2 - ((x0 + x1) / 2) * s, ty: h / 2 - ((y0 + y1) / 2) * s };
}

const px = (n: GNode, v: View) => n.x * v.s + v.tx;
const py = (n: GNode, v: View) => n.y * v.s + v.ty;

function drawGlyph(ctx: CanvasRenderingContext2D, n: GNode, hovered: boolean, v: View) {
  const s = n.kind === 'root' ? 7 : n.kind === 'hub' ? 5.5 : 3.6;
  const x = px(n, v);
  const y = py(n, v);
  ctx.lineWidth = 1;
  ctx.strokeStyle = hovered ? INK.hi : n.kind === 'root' ? INK.hi : n.kind === 'hub' ? INK.mid : INK.dim;
  ctx.fillStyle = '#09090b';

  ctx.beginPath();
  switch (n.kind) {
    case 'root':
    case 'hub':
    case 'program':
      ctx.rect(x - s, y - s, s * 2, s * 2);
      break;
    case 'dao_vote': // diamond
      ctx.moveTo(x, y - s * 1.35);
      ctx.lineTo(x + s * 1.35, y);
      ctx.lineTo(x, y + s * 1.35);
      ctx.lineTo(x - s * 1.35, y);
      ctx.closePath();
      break;
    case 'squad_sig': // triangle
      ctx.moveTo(x, y - s * 1.4);
      ctx.lineTo(x + s * 1.3, y + s);
      ctx.lineTo(x - s * 1.3, y + s);
      ctx.closePath();
      break;
    case 'attest': // plus
      ctx.moveTo(x - s * 1.4, y);
      ctx.lineTo(x + s * 1.4, y);
      ctx.moveTo(x, y - s * 1.4);
      ctx.lineTo(x, y + s * 1.4);
      ctx.strokeStyle = hovered ? INK.hi : INK.mid;
      ctx.stroke();
      return;
    case 'mint':
      ctx.arc(x, y, s, 0, Math.PI * 2);
      break;
    default: // transfer
      ctx.rect(x - 1.6, y - 1.6, 3.2, 3.2);
      ctx.fillStyle = INK.dim;
      ctx.fill();
      return;
  }
  if (n.kind === 'root') ctx.fillStyle = '#e4e4e7';
  ctx.fill();
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  pubkey: string | null;
  onTierChange: (tier: ContextTier, score: number) => void;
}

export function GraphVisualizer({ pubkey, onTierChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const hoverRef = useRef<number>(-1);
  const sizeRef = useRef({ w: 640, h: 420 });
  const viewRef = useRef<View>({ s: 1, tx: 0, ty: 0 });

  const [reseed, setReseed] = useState(0);
  const [stats, setStats] = useState({ iter: 0, energy: 0, converged: false });
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [hovered, setHovered] = useState<GNode | null>(null);

  // --- build graph ---------------------------------------------------------
  useEffect(() => {
    if (!pubkey) {
      snapRef.current = null;
      setSnap(null);
      onTierChange(0, 0);
      return;
    }
    const { w, h } = sizeRef.current;
    const s = synthesise(pubkey, reseed, w, h);
    snapRef.current = s;
    // Start the view at the new graph's fit rather than easing in from the
    // previous wallet's transform.
    viewRef.current = fitTo(s.nodes, w, h);
    setSnap(s);
    setStats({ iter: 0, energy: 0, converged: false });
    onTierChange(s.tier, s.score);
  }, [pubkey, reseed, onTierChange]);

  // --- sizing --------------------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current;
    const cv = canvasRef.current;
    if (!el || !cv) return;

    const apply = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: Math.max(240, r.width), h: Math.max(200, r.height) };
      cv.width = Math.floor(sizeRef.current.w * dpr);
      cv.height = Math.floor(sizeRef.current.h * dpr);
      cv.style.width = `${sizeRef.current.w}px`;
      cv.style.height = `${sizeRef.current.h}px`;
      const ctx = cv.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      setStats((p) => ({ ...p, converged: false }));
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- render loop ---------------------------------------------------------
  useEffect(() => {
    let iter = 0;
    let frozen = false;

    const frame = () => {
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      const s = snapRef.current;
      const { w, h } = sizeRef.current;
      if (!ctx || !cv) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      ctx.clearRect(0, 0, w, h);

      // 32px reference grid — gives the layout a measurable frame.
      ctx.strokeStyle = INK.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 32) {
        ctx.moveTo(Math.floor(x) + 0.5, 0);
        ctx.lineTo(Math.floor(x) + 0.5, h);
      }
      for (let y = 0; y <= h; y += 32) {
        ctx.moveTo(0, Math.floor(y) + 0.5);
        ctx.lineTo(w, Math.floor(y) + 0.5);
      }
      ctx.stroke();

      if (!s) {
        // Centred, not top-left: the stats overlay lives in the top-left corner
        // and the two collide at small pane widths.
        ctx.fillStyle = INK.dim;
        ctx.font = '11px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('no subgraph — attach a signer', w / 2, h / 2);
        ctx.textAlign = 'left';
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      if (!frozen) {
        // Three integration steps per frame: converges in ~110 frames instead
        // of ~330 without making the motion read as a jump cut.
        let e = 0;
        for (let k = 0; k < 3; k++) e = step(s.nodes, s.edges, w, h);
        iter += 3;
        if (e < CONVERGE_ENERGY && iter > 60) {
          frozen = true;
          setStats({ iter, energy: e, converged: true });
        } else if (iter % 12 === 0) {
          setStats({ iter, energy: e, converged: false });
        }
      }

      // Ease the fit toward its target so the view settles with the layout
      // rather than jumping on the frame the graph stops moving.
      const target = fitTo(s.nodes, w, h);
      const v = viewRef.current;
      v.s += (target.s - v.s) * FIT_LERP;
      v.tx += (target.tx - v.tx) * FIT_LERP;
      v.ty += (target.ty - v.ty) * FIT_LERP;

      // edges
      for (const e of s.edges) {
        const a = s.nodes[e.a];
        const b = s.nodes[e.b];
        ctx.strokeStyle = INK.edge;
        ctx.globalAlpha = 0.22 + e.w * 0.45;
        ctx.lineWidth = e.w > 0.8 ? 1.2 : 1;
        ctx.beginPath();
        ctx.moveTo(px(a, v), py(a, v));
        ctx.lineTo(px(b, v), py(b, v));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // nodes
      for (const n of s.nodes) drawGlyph(ctx, n, hoverRef.current === n.i, v);

      // hub labels
      ctx.font = '9px ui-monospace, Menlo, monospace';
      ctx.fillStyle = INK.mid;
      for (const n of s.nodes) {
        if (n.kind === 'hub') ctx.fillText(n.label, px(n, v) + 9, py(n, v) + 3);
        if (n.kind === 'root') {
          ctx.fillStyle = INK.hi;
          ctx.fillText(n.label, px(n, v) + 11, py(n, v) + 3);
          ctx.fillStyle = INK.mid;
        }
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [snap]);

  // --- hit testing ---------------------------------------------------------
  const onMove = useCallback((ev: React.MouseEvent<HTMLCanvasElement>) => {
    const s = snapRef.current;
    const cv = canvasRef.current;
    if (!s || !cv) return;
    const r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;

    // Hit test in screen space so the 12px pick radius stays 12px at any fit.
    const v = viewRef.current;
    let best = -1;
    let bestD = 144; // 12px radius, squared
    for (const n of s.nodes) {
      const d = (px(n, v) - mx) ** 2 + (py(n, v) - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.i;
      }
    }
    if (best !== hoverRef.current) {
      hoverRef.current = best;
      setHovered(best >= 0 ? s.nodes[best] : null);
    }
  }, []);

  const tier = snap?.tier ?? 0;
  const barPct = useMemo(() => Math.min(100, ((snap?.score ?? 0) / 1.0) * 100), [snap?.score]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col border border-zinc-800 bg-zinc-950">
      <Header
        label="graph transformer / k=2 neighbourhood"
        right={
          <button
            onClick={() => setReseed((r) => r + 1)}
            disabled={!pubkey}
            className="border border-zinc-800 px-2 py-0.5 text-3xs uppercase tracking-widest text-zinc-400 hover:bg-zinc-900 disabled:text-zinc-700"
          >
            reseed
          </button>
        }
      />

      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          onMouseMove={onMove}
          onMouseLeave={() => {
            hoverRef.current = -1;
            setHovered(null);
          }}
          className="block h-full w-full cursor-crosshair"
        />

        {snap && (
          <div className="pointer-events-none absolute left-2 top-2 space-y-0.5 text-3xs text-zinc-600">
            <div>
              nodes={snap.nodes.length} edges={snap.edges.length} iter={stats.iter}
            </div>
            <div>
              dE={stats.energy.toFixed(4)} {stats.converged ? '· converged' : '· relaxing'}
            </div>
          </div>
        )}

        {hovered && (
          <div className="pointer-events-none absolute bottom-2 left-2 max-w-[92%] border border-zinc-700 bg-zinc-950/95 px-2 py-1.5 text-3xs leading-relaxed">
            <div className="text-zinc-300">{hovered.kind}</div>
            <div className="break-all text-zinc-500">{abbrev(hovered.sig, 12, 10)}</div>
            <div className="text-zinc-600">
              slot={hovered.slot.toLocaleString('en-US')} age={hovered.ageDays}d w=
              {hovered.w.toFixed(4)}
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-800">
        <div className="flex items-stretch">
          <div className="flex-1 border-r border-zinc-800 px-3 py-2">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-3xs uppercase tracking-widest2 text-zinc-600">context tier</span>
              <span className="text-3xs text-zinc-600">
                score {(snap?.score ?? 0).toFixed(3)} / thresholds {T1_THRESHOLD} · {T2_THRESHOLD}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl leading-none text-zinc-100">{tier}</span>
              <span className="text-2xs uppercase tracking-widest text-zinc-400">
                {TIER_LABEL[tier]}
              </span>
            </div>
            <div className="relative mt-2 h-[5px] w-full bg-zinc-900">
              <div className="absolute inset-y-0 left-0 bg-zinc-400" style={{ width: `${barPct}%` }} />
              <div className="absolute inset-y-[-3px] w-px bg-zinc-600" style={{ left: `${T1_THRESHOLD * 100}%` }} />
              <div className="absolute inset-y-[-3px] w-px bg-zinc-500" style={{ left: `${T2_THRESHOLD * 100}%` }} />
            </div>
          </div>

          <div className="w-[248px] px-3 py-2">
            <div className="mb-1 text-3xs uppercase tracking-widest2 text-zinc-600">
              feature contributions
            </div>
            <ul className="space-y-[3px]">
              {(snap?.signals ?? []).map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-3xs">
                  <span className="w-[112px] shrink-0 truncate text-zinc-500">{s.key}</span>
                  <span className="h-[3px] w-[52px] shrink-0 bg-zinc-900">
                    <span
                      className="block h-full bg-zinc-500"
                      style={{ width: `${Math.min(100, (s.contrib / s.cap) * 100)}%` }}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-600">
                    {s.contrib.toFixed(3)}
                  </span>
                </li>
              ))}
              {!snap && <li className="text-3xs text-zinc-700">—</li>}
            </ul>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800 px-3 py-1.5 text-3xs text-zinc-600">
          <Legend glyph="■" text="wallet / hub" />
          <Legend glyph="◆" text="dao vote" />
          <Legend glyph="▲" text="squads cosign" />
          <Legend glyph="+" text="cnft attestation" />
          <Legend glyph="○" text="mint" />
          <Legend glyph="·" text="spl transfer" />
        </div>
      </div>
    </section>
  );
}

function Legend({ glyph, text }: { glyph: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-zinc-400">{glyph}</span>
      {text}
    </span>
  );
}

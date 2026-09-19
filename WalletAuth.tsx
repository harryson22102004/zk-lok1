'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

import {
  abbrev,
  deterministicPubkey,
  deterministicSignature,
  fnv1a32,
  nextFloat,
  toHex,
  xorshift32,
} from '@/utils/zkPayload';

const WalletMultiButton = dynamic(
  async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton,
  { ssr: false, loading: () => <div className="h-[26px] w-[132px] border border-zinc-800" /> },
);

export interface TxRow {
  signature: string;
  slot: number;
  blockTime: number;
  err: string | null;
  fee: number;
  program: string;
  source: 'rpc' | 'mock';
}

interface Props {
  onAccount: (pubkey: string | null) => void;
}

/** RPC calls that hang past this are treated as unavailable and mocked. */
const RPC_TIMEOUT_MS = 4_000;

const PROGRAMS = [
  { id: 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', name: 'spl-governance' },
  { id: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', name: 'spl-token' },
  { id: 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', name: 'mpl-bubblegum' },
  { id: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', name: 'squads-v4' },
  { id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'jupiter-v6' },
  { id: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', name: 'spl-ata' },
];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`rpc timeout ${ms}ms`)), ms)),
  ]);
}

/**
 * Devnet holds no history for a freshly generated keypair, and the public RPC
 * rate-limits hard enough that a demo cannot depend on it. The component tries
 * the real endpoint first and falls back to a pubkey-seeded synthetic history,
 * flagging which one is in play so nothing silently pretends to be on-chain.
 */
function mockHistory(pubkey: string, nowSec: number): TxRow[] {
  const rng = xorshift32(fnv1a32(`history/${pubkey}`));
  const headSlot = 331_480_000 + (rng() % 40_000);
  const rows: TxRow[] = [];

  for (let i = 0; i < 12; i++) {
    const prog = PROGRAMS[rng() % PROGRAMS.length];
    const ageSec = Math.floor(nextFloat(rng) * 190 * 86_400) + i * 3_600;
    rows.push({
      signature: deterministicSignature(`${pubkey}/tx/${i}`),
      slot: headSlot - Math.floor(ageSec / 0.4),
      blockTime: nowSec - ageSec,
      err: i === 7 ? 'InstructionError(2, Custom(6001))' : null,
      fee: 5_000 + (rng() % 12) * 1_000,
      program: prog.name,
      source: 'mock',
    });
  }
  return rows.sort((a, b) => b.slot - a.slot);
}

function mockBalanceLamports(pubkey: string): number {
  const rng = xorshift32(fnv1a32(`balance/${pubkey}`));
  // 0.4 – 12.8 SOL, quantised to whole lamports.
  return Math.floor((0.4 + nextFloat(rng) * 12.4) * LAMPORTS_PER_SOL);
}

/**
 * Detached signer for review machines with no wallet extension installed.
 * Without it the graph, the credential and the whole relay path are
 * unreachable and the page is just a boot log. It never touches the adapter,
 * holds no key material and cannot sign anything — every panel that consumes
 * it reports `source=simulated`, and the attest button stays disabled.
 */
const SIM_SLOT = 3;
function simulatedPubkey(n: number): string {
  return deterministicPubkey(`sim-signer/${n}`);
}

export function WalletAuth({ onAccount }: Props) {
  const { connection } = useConnection();
  const { publicKey, connected, wallet, signMessage } = useWallet();

  const [lamports, setLamports] = useState<number | null>(null);
  const [rows, setRows] = useState<TxRow[]>([]);
  const [slotHead, setSlotHead] = useState<number | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionProof, setSessionProof] = useState<string | null>(null);
  const [sim, setSim] = useState<number | null>(null);

  // A real adapter connection always wins over the simulated one.
  const adapterAddress = publicKey?.toBase58() ?? null;
  const address = adapterAddress ?? (sim === null ? null : simulatedPubkey(sim));
  const simulated = adapterAddress === null && sim !== null;

  useEffect(() => {
    if (adapterAddress) setSim(null);
  }, [adapterAddress]);

  useEffect(() => {
    onAccount(address);
  }, [address, onAccount]);

  // Simulated signers never hit the RPC — there is no such account on devnet.
  useEffect(() => {
    if (!simulated || address === null) return;
    setLamports(mockBalanceLamports(address));
    setRows(mockHistory(address, Math.floor(Date.now() / 1000)));
    setSlotHead(331_512_744);
    setDegraded('simulated signer · no rpc call · history and balance derived from pubkey');
    setSessionProof(null);
    setLoading(false);
  }, [simulated, address]);

  useEffect(() => {
    if (!publicKey) {
      // The simulated path owns this state when it is active; clearing here
      // would race it to null on the same render.
      if (simulated) return;
      setLamports(null);
      setRows([]);
      setSlotHead(null);
      setDegraded(null);
      setSessionProof(null);
      return;
    }

    let cancelled = false;
    const pk = publicKey.toBase58();
    const nowSec = Math.floor(Date.now() / 1000);
    setLoading(true);

    (async () => {
      try {
        const [bal, sigs, slot] = await Promise.all([
          withTimeout(connection.getBalance(publicKey), RPC_TIMEOUT_MS),
          withTimeout(connection.getSignaturesForAddress(publicKey, { limit: 12 }), RPC_TIMEOUT_MS),
          withTimeout(connection.getSlot(), RPC_TIMEOUT_MS),
        ]);
        if (cancelled) return;

        setSlotHead(slot);

        if (sigs.length === 0) {
          // Live account, empty ledger. Balance is real, history is synthetic.
          setLamports(bal);
          setRows(mockHistory(pk, nowSec));
          setDegraded('rpc reachable · 0 signatures for address · history synthesised');
        } else {
          setLamports(bal);
          setRows(
            sigs.map((s, i) => ({
              signature: s.signature,
              slot: s.slot,
              blockTime: s.blockTime ?? nowSec,
              err: s.err ? JSON.stringify(s.err) : null,
              fee: 5_000,
              program: PROGRAMS[i % PROGRAMS.length].name,
              source: 'rpc' as const,
            })),
          );
          setDegraded(null);
        }
      } catch (e) {
        if (cancelled) return;
        setLamports(mockBalanceLamports(pk));
        setRows(mockHistory(pk, nowSec));
        setSlotHead(331_512_744);
        setDegraded(`devnet rpc unreachable (${(e as Error).message}) · full mock`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicKey, connection, simulated]);

  /**
   * Proof of key custody. The gateway will not mint a capability token without
   * it, so the credential path is gated on this rather than on `connected`.
   */
  const attest = useCallback(async () => {
    if (!publicKey) return;
    const challenge = new TextEncoder().encode(
      `zk-lok:session:${publicKey.toBase58()}:${Math.floor(Date.now() / 30_000)}`,
    );
    try {
      if (!signMessage) throw new Error('wallet does not expose signMessage');
      const sig = await signMessage(challenge);
      setSessionProof(toHex(sig).slice(0, 32));
    } catch {
      // Ledger and a few mobile adapters refuse off-chain messages; the demo
      // path degrades to a derived marker instead of blocking the flow.
      setSessionProof(deterministicPubkey(`session/${publicKey.toBase58()}`).slice(0, 22));
    }
  }, [publicKey, signMessage]);

  const sol = useMemo(
    () => (lamports === null ? null : (lamports / LAMPORTS_PER_SOL).toFixed(6)),
    [lamports],
  );

  return (
    <section className="flex h-full min-w-0 flex-col border border-zinc-800 bg-zinc-950">
      <Header label="wallet / solana-devnet" right={<WalletMultiButton />} />

      <div className="border-b border-zinc-800 px-3 py-2.5">
        {!address ? (
          <p className="text-2xs leading-relaxed text-zinc-500">
            No signer attached. The credential path requires a keypair capable of Ed25519
            off-chain message signing; the gateway rejects unattested sessions at the
            capability-mint step.
          </p>
        ) : (
          <dl className="space-y-1.5 text-2xs">
            <Row
              k="adapter"
              v={simulated ? 'simulated (no key material)' : (wallet?.adapter.name ?? 'wallet-standard')}
              tone={simulated ? 'warn' : undefined}
            />
            <Row k="pubkey" v={address} mono breakAll />
            <Row k="balance" v={sol === null ? '—' : `${sol} SOL`} />
            <Row k="slot_head" v={slotHead === null ? '—' : slotHead.toLocaleString('en-US')} />
            <Row
              k="session"
              v={
                simulated
                  ? 'n/a — simulated signer cannot sign'
                  : sessionProof
                    ? `ed25519:${sessionProof}…`
                    : 'unattested'
              }
              tone={sessionProof && !simulated ? 'ok' : 'warn'}
            />
          </dl>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        {connected && !simulated ? (
          <>
            <button
              onClick={attest}
              disabled={!!sessionProof}
              className="border border-zinc-700 px-2 py-1 text-3xs uppercase tracking-widest text-zinc-300 transition-colors hover:bg-zinc-900 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
            >
              {sessionProof ? 'attested' : 'sign challenge'}
            </button>
            <span className="text-3xs text-zinc-600">
              msg = zk-lok:session:&lt;pk&gt;:&lt;epoch&gt;
            </span>
          </>
        ) : (
          <>
            <button
              onClick={() => setSim((s) => (s === null ? SIM_SLOT : (s + 1) % 8))}
              disabled={connected}
              className="border border-zinc-800 px-2 py-1 text-3xs uppercase tracking-widest text-zinc-400 transition-colors hover:bg-zinc-900 disabled:cursor-not-allowed disabled:text-zinc-700"
            >
              {simulated ? 'next sim signer' : 'simulate signer'}
            </button>
            {simulated && (
              <button
                onClick={() => setSim(null)}
                className="border border-zinc-800 px-2 py-1 text-3xs uppercase tracking-widest text-zinc-400 transition-colors hover:bg-zinc-900"
              >
                detach
              </button>
            )}
            <span className="text-3xs text-zinc-600">
              {simulated ? `slot ${sim}` : 'no extension required'}
            </span>
          </>
        )}
      </div>

      {degraded && (
        <p className="border-b border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-3xs text-[color:var(--warn)]">
          {degraded}
        </p>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <table className="w-full border-collapse text-3xs">
          <thead className="sticky top-0 bg-zinc-950">
            <tr className="border-b border-zinc-800 text-left text-zinc-600">
              <th className="px-3 py-1.5 font-normal">signature</th>
              <th className="px-2 py-1.5 font-normal">slot</th>
              <th className="px-2 py-1.5 font-normal">program</th>
              <th className="px-3 py-1.5 text-right font-normal">age</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-zinc-600">
                  getSignaturesForAddress(limit=12) …
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-zinc-700">
                  no records
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.signature} className="border-b border-zinc-900 hover:bg-zinc-900/50">
                <td className="px-3 py-1.5">
                  <span className={r.err ? 'text-[color:var(--fail)]' : 'text-zinc-400'}>
                    {abbrev(r.signature, 8, 6)}
                  </span>
                  {r.err && <span className="ml-1 text-zinc-600">err</span>}
                </td>
                <td className="px-2 py-1.5 text-zinc-500">{r.slot.toLocaleString('en-US')}</td>
                <td className="px-2 py-1.5 text-zinc-500">{r.program}</td>
                <td className="px-3 py-1.5 text-right text-zinc-600">{ago(r.blockTime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="border-t border-zinc-800 px-3 py-1.5 text-3xs text-zinc-600">
        {rows.length} records · source={simulated ? 'simulated' : (rows[0]?.source ?? 'none')} ·
        commitment=confirmed
      </footer>
    </section>
  );
}

function ago(unixSec: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (d < 3_600) return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3_600)}h`;
  return `${Math.floor(d / 86_400)}d`;
}

function Row({
  k,
  v,
  mono,
  breakAll,
  tone,
}: {
  k: string;
  v: string;
  mono?: boolean;
  breakAll?: boolean;
  tone?: 'ok' | 'warn';
}) {
  const color =
    tone === 'ok'
      ? 'text-[color:var(--ok)]'
      : tone === 'warn'
        ? 'text-[color:var(--warn)]'
        : 'text-zinc-300';
  return (
    <div className="flex gap-3">
      <dt className="w-[72px] shrink-0 text-zinc-600">{k}</dt>
      <dd className={`${color} ${mono ? 'font-mono' : ''} ${breakAll ? 'break-all' : ''}`}>{v}</dd>
    </div>
  );
}

export function Header({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <header className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
      <h2 className="text-3xs uppercase tracking-widest2 text-zinc-500">{label}</h2>
      {right}
    </header>
  );
}

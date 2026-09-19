'use client';

import { useCallback, useMemo, useState } from 'react';

import { WalletAuth, Header } from '@/components/WalletAuth';
import { GraphVisualizer, TIER_LABEL } from '@/components/GraphVisualizer';
import { HardwareTerminal, type DeviceState } from '@/components/HardwareTerminal';
import {
  CIRCUIT,
  DOORS,
  FRAME_LAYOUT,
  buildZkPayload,
  hexdump,
  type ContextTier,
} from '@/utils/zkPayload';

type Inspect = 'struct' | 'hex' | 'json';

export default function Page() {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [tier, setTier] = useState<ContextTier>(0);
  const [score, setScore] = useState(0);
  const [doorKey, setDoorKey] = useState<string>('HW-LAB-04/MAGLOCK-A');
  const [relayOpen, setRelayOpen] = useState(false);
  const [device, setDevice] = useState<DeviceState>('BOOT');
  const [view, setView] = useState<Inspect>('struct');
  const [issuedAt] = useState(() => Date.now());

  const onTier = useCallback((t: ContextTier, s: number) => {
    setTier(t);
    setScore(s);
  }, []);

  const onAccount = useCallback((pk: string | null) => setPubkey(pk), []);

  const payload = useMemo(() => {
    if (!pubkey) return null;
    // issuedAt is frozen per session so the CRC in the inspector matches the
    // CRC the terminal prints; a live clock would desync them mid-stream.
    return buildZkPayload({ walletPubkey: pubkey, doorKey, tier, issuedAt });
  }, [pubkey, doorKey, tier, issuedAt]);

  return (
    <main className="flex h-screen flex-col overflow-hidden">
      {/* ------------------------------ top bar ------------------------------ */}
      <header className="flex h-10 shrink-0 items-center gap-4 border-b border-zinc-800 px-4">
        <h1 className="text-2xs uppercase tracking-widest2 text-zinc-200">
          zk-lok <span className="text-zinc-600">{'//'}</span>{' '}
          <span className="text-zinc-500">transient network state os</span>
        </h1>
        <span className="hidden text-3xs text-zinc-700 md:inline">
          {CIRCUIT.name} · {CIRCUIT.system}/{CIRCUIT.curve} · {CIRCUIT.constraints.toLocaleString('en-US')} constraints
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Chip k="cluster" v="devnet" />
          <Chip k="tier" v={`${tier} ${TIER_LABEL[tier]}`} tone={tier === 2 ? 'ok' : tier === 1 ? 'warn' : 'dim'} />
          <Chip k="device" v={device} tone={device === 'OPEN' ? 'ok' : device === 'DENIED' ? 'fail' : device === 'DEGRADED' ? 'warn' : 'dim'} />
          <Chip k="gpio4" v={relayOpen ? 'HIGH' : 'LOW'} tone={relayOpen ? 'ok' : 'dim'} />
        </div>
      </header>

      {/* ------------------------------ body -------------------------------- */}
      <div className="grid min-h-0 flex-1 gap-px overflow-auto bg-zinc-900 p-px lg:grid-cols-[340px_minmax(0,1fr)_460px] lg:overflow-hidden">
        {/* left: signer + credential inspector.
            min-w-0 is load-bearing on every rung of this ladder: grid and flex
            items default to min-width:auto, so the hexdump's `whitespace-pre`
            would size the track by its widest line and spill the panel over
            the centre column instead of scrolling inside it. */}
        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(280px,1fr)_minmax(300px,1.15fr)] gap-px">
          <WalletAuth onAccount={onAccount} />

          <section className="flex min-h-0 min-w-0 flex-col border border-zinc-800 bg-zinc-950">
            <Header
              label="credential / zkPayload"
              right={
                <div className="flex gap-1">
                  {(['struct', 'hex', 'json'] as Inspect[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`px-1.5 py-0.5 text-3xs uppercase tracking-widest ${
                        view === v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-600 hover:text-zinc-400'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              }
            />

            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
              <label className="text-3xs text-zinc-600">door</label>
              <select
                value={doorKey}
                onChange={(e) => setDoorKey(e.target.value)}
                className="flex-1 border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-3xs text-zinc-300 outline-none focus:border-zinc-600"
              >
                {Object.entries(DOORS).map(([k, d]) => (
                  <option key={k} value={k}>
                    {d.label} · min_tier={d.minTier}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-h-0 min-w-0 flex-1 overflow-auto px-3 py-2 text-3xs">
              {!payload && <p className="text-zinc-700">no credential — attach a signer</p>}

              {payload && view === 'struct' && (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="text-left text-zinc-600">
                      <th className="pb-1 font-normal">off</th>
                      <th className="pb-1 font-normal">len</th>
                      <th className="pb-1 font-normal">field</th>
                      <th className="pb-1 font-normal">type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FRAME_LAYOUT.map((f) => (
                      <tr key={f.name} className="border-t border-zinc-900">
                        <td className="py-[3px] pr-2 text-zinc-600">
                          0x{f.off.toString(16).padStart(3, '0')}
                        </td>
                        <td className="py-[3px] pr-2 text-zinc-600">{f.len}</td>
                        <td className="py-[3px] pr-2 text-zinc-300">{f.name}</td>
                        <td className="py-[3px] text-zinc-500">{f.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {payload && view === 'hex' && (
                <pre className="whitespace-pre text-[9px] leading-[1.5] text-zinc-400">
                  {hexdump(payload.frame.bytes, { maxRows: 14 }).join('\n')}
                </pre>
              )}

              {payload && view === 'json' && (
                <pre className="whitespace-pre-wrap break-all text-[9px] leading-[1.5] text-zinc-400">
                  {JSON.stringify(
                    {
                      protocol: payload.protocol,
                      epoch: payload.epoch,
                      expiresAt: new Date(payload.expiresAt).toISOString(),
                      door: { id: `0x${payload.door.id.toString(16)}`, minTier: payload.door.minTier },
                      tier: payload.tier,
                      nullifier: payload.nullifier,
                      merkleRoot: payload.merkleRoot,
                      nonce: payload.nonce,
                      publicSignals: payload.publicSignals,
                      proof: payload.proof,
                      gatewayEnvelope: payload.gatewayEnvelope,
                    },
                    null,
                    1,
                  )}
                </pre>
              )}
            </div>

            {payload && (
              <footer className="grid grid-cols-2 gap-x-3 border-t border-zinc-800 px-3 py-1.5 text-3xs text-zinc-600">
                <span>
                  frame {payload.frame.bytes.length}B · crc 0x
                  {payload.frame.crc16.toString(16).padStart(4, '0').toUpperCase()}
                </span>
                <span className="text-right">
                  {payload.frame.chunks} chunks @ mtu {payload.frame.mtu}
                </span>
                <span>witness {payload.timings.witnessMs}ms · prove {payload.timings.proveMs}ms</span>
                <span className="text-right">gw verify {payload.timings.gatewayVerifyMs}ms</span>
              </footer>
            )}
          </section>
        </div>

        {/* centre: graph */}
        <div className="min-h-[420px] min-w-0 lg:min-h-0">
          <GraphVisualizer pubkey={pubkey} onTierChange={onTier} />
        </div>

        {/* right: device */}
        <div className="min-h-[520px] min-w-0 lg:min-h-0">
          <HardwareTerminal payload={payload} tier={tier} onRelay={setRelayOpen} onState={setDevice} />
        </div>
      </div>

      {/* ------------------------------ status bar --------------------------- */}
      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-zinc-800 px-4 text-3xs text-zinc-600">
        <span>fw 0.4.1-rc2 · sha 7f3a91c</span>
        <span>vk {CIRCUIT.vkeyHash.slice(0, 14)}…</span>
        <span>score {score.toFixed(3)}</span>
        <span className="ml-auto">
          {pubkey ? `signer ${pubkey.slice(0, 6)}…${pubkey.slice(-4)}` : 'no signer'}
        </span>
      </footer>
    </main>
  );
}

function Chip({ k, v, tone = 'dim' }: { k: string; v: string; tone?: 'ok' | 'warn' | 'fail' | 'dim' }) {
  const color =
    tone === 'ok'
      ? 'text-[color:var(--ok)]'
      : tone === 'warn'
        ? 'text-[color:var(--warn)]'
        : tone === 'fail'
          ? 'text-[color:var(--fail)]'
          : 'text-zinc-400';
  return (
    <span className="flex items-center gap-1.5 border border-zinc-800 px-1.5 py-0.5 text-3xs">
      <span className="text-zinc-600">{k}</span>
      <span className={color}>{v}</span>
    </span>
  );
}

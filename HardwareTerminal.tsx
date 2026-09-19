'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { abbrev, type ContextTier, type ZkCredential } from '@/utils/zkPayload';
import { Header } from '@/components/WalletAuth';

/**
 * ESP32-S3 edge simulator.
 *
 * Mirrors the UART0 output of the `zklok` firmware at 115200 8N1: ROM loader
 * lines verbatim, then `esp_log` records in the `L (ts) TAG: msg` format. The
 * timestamps advance by the real per-stage cost of each operation, so the
 * elapsed figures in the log agree with the latency table in the README.
 * Render pacing is clamped separately — the boot ROM emits faster than a
 * display can usefully show.
 */

type Level = 'R' | 'I' | 'W' | 'E';
type Effect = 'relay_open' | 'relay_close' | 'deny' | 'degrade';

interface Entry {
  lvl: Level;
  tag?: string;
  msg: string;
  /** Device-clock advance, ms. */
  dt: number;
  /** Render delay override, ms. */
  hold?: number;
  fx?: Effect;
}

interface Line extends Entry {
  id: number;
  ts: number;
}

export type DeviceState = 'BOOT' | 'IDLE' | 'BUSY' | 'OPEN' | 'DENIED' | 'DEGRADED';

interface Props {
  payload: ZkCredential | null;
  tier: ContextTier;
  onRelay: (open: boolean) => void;
  onState: (s: DeviceState) => void;
}

const MAX_LINES = 420;

// ---------------------------------------------------------------------------
// Log scripts
// ---------------------------------------------------------------------------

const BOOT: Entry[] = [
  { lvl: 'R', msg: 'ESP-ROM:esp32s3-20210327', dt: 0 },
  { lvl: 'R', msg: 'Build:Mar 27 2021', dt: 3 },
  { lvl: 'R', msg: 'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)', dt: 4 },
  { lvl: 'R', msg: 'SPIWP:0xee', dt: 2 },
  { lvl: 'R', msg: 'mode:DIO, clock div:1', dt: 2 },
  { lvl: 'R', msg: 'load:0x3fce3810,len:0x178c', dt: 5 },
  { lvl: 'R', msg: 'load:0x403c9700,len:0x4', dt: 2 },
  { lvl: 'R', msg: 'load:0x403c9704,len:0xcac', dt: 2 },
  { lvl: 'R', msg: 'load:0x403cc700,len:0x2938', dt: 3 },
  { lvl: 'R', msg: 'entry 0x403c98d4', dt: 6 },
  { lvl: 'I', tag: 'boot', msg: 'ESP-IDF v5.2.1 2nd stage bootloader', dt: 21 },
  { lvl: 'I', tag: 'boot', msg: 'compile time Sep 12 2026 04:18:11', dt: 1 },
  { lvl: 'I', tag: 'boot.esp32s3', msg: 'SPI Speed 80MHz / Mode DIO / Flash 8MB', dt: 4 },
  { lvl: 'I', tag: 'boot', msg: 'Partition Table:', dt: 3 },
  { lvl: 'I', tag: 'boot', msg: ' 0 nvs      WiFi data 01 02 00009000 00006000', dt: 1 },
  { lvl: 'I', tag: 'boot', msg: ' 1 otadata  OTA data  01 00 0000f000 00002000', dt: 1 },
  { lvl: 'I', tag: 'boot', msg: ' 2 phy_init RF data   01 01 00011000 00001000', dt: 1 },
  { lvl: 'I', tag: 'boot', msg: ' 3 ota_0    OTA app   00 10 00020000 001e0000', dt: 1 },
  { lvl: 'I', tag: 'boot', msg: ' 4 ota_1    OTA app   00 11 00200000 001e0000', dt: 1 },
  { lvl: 'I', tag: 'boot', msg: ' 5 model    Unknown   01 40 003e0000 00020000', dt: 1 },
  { lvl: 'I', tag: 'boot', msg: ' 6 audit    Unknown   01 41 00400000 00100000', dt: 1 },
  { lvl: 'I', tag: 'esp_image', msg: 'segment 0: paddr=00020020 vaddr=3c0d0020 size=3a1e8h (237544) map', dt: 48 },
  { lvl: 'I', tag: 'esp_image', msg: 'segment 1: paddr=0005a210 vaddr=3fc9a100 size=04b1ch ( 19228) load', dt: 9 },
  { lvl: 'I', tag: 'esp_image', msg: 'segment 2: paddr=0005ed34 vaddr=40374000 size=0b2a0h ( 45728) load', dt: 14 },
  { lvl: 'I', tag: 'boot', msg: 'Loaded app from partition at offset 0x20000', dt: 6 },
  { lvl: 'I', tag: 'cpu_start', msg: 'Pro cpu up. chip revision v0.2, cpu freq 240000000 Hz', dt: 118 },
  { lvl: 'I', tag: 'heap_init', msg: 'At 3FCA1B48 len 00047BC8 (286 KiB): RAM', dt: 7 },
  { lvl: 'I', tag: 'heap_init', msg: 'At 3FCE9710 len 00005724 ( 21 KiB): RAM', dt: 1 },
  { lvl: 'I', tag: 'esp_psram', msg: 'Found 8MB PSRAM device, mapped at 0x3C000000', dt: 62 },
  { lvl: 'I', tag: 'zklok', msg: 'fw 0.4.1-rc2 sha=7f3a91c idf=v5.2.1 heap_free=274512B', dt: 19 },
  { lvl: 'I', tag: 'zklok', msg: 'UART0 115200 8N1 tx=GPIO43 rx=GPIO44 flowctl=none', dt: 2 },
  { lvl: 'I', tag: 'zklok', msg: 'relay GPIO4 -> ULN2003A ch1 -> G5LE-1-VD coil 12V/33mA', dt: 3 },
  { lvl: 'I', tag: 'reed', msg: 'GPIO5 pullup, door=CLOSED, debounce=25ms', dt: 4 },
  { lvl: 'I', tag: 'rtc', msg: 'DS3231SN @0x68 ok, drift=-1.8ppm aging_reg=+2', dt: 11 },
  { lvl: 'I', tag: 'nvs', msg: 'ns=zk opened, 41/504 entries used', dt: 8 },
  { lvl: 'I', tag: 'tflm', msg: 'model anomaly_model.tflite v7 crc32=0x9C2E41B3 size=44112B (part:model)', dt: 13 },
  { lvl: 'I', tag: 'tflm', msg: 'arena reserved 131072B @0x3FCA4000..0x3FCC4000 (internal DRAM)', dt: 3 },
  { lvl: 'I', tag: 'ble', msg: 'gatt svc 0x1810 char 0x2A35 write+notify, mtu=247', dt: 26 },
  { lvl: 'W', tag: 'groth16', msg: 'on-chip pairing compiled out (CONFIG_ZKLOK_ONCHIP_PAIRING=n)', dt: 2 },
  { lvl: 'I', tag: 'zklok', msg: 'ready. awaiting frame magic 0xA55A on UART0 / GATT', dt: 5, hold: 140 },
];

interface Ctx {
  pk: string;
  gw: string;
  epoch: number;
  crc: string;
  nullifier: string;
  tier: ContextTier;
  minTier: ContextTier;
  door: string;
  doorId: string;
  dwell: number;
  chunks: number;
  frameLen: number;
  payloadLen: number;
}

function ingest(c: Ctx): Entry[] {
  const last = c.frameLen - (c.chunks - 1) * 244;
  const head: Entry[] = [
    { lvl: 'I', tag: 'ble', msg: `rx notify 1/${c.chunks} len=244 handle=0x002B`, dt: 4, hold: 60 },
  ];
  for (let i = 2; i <= c.chunks; i++) {
    head.push({
      lvl: 'I',
      tag: 'ble',
      msg: `rx notify ${i}/${c.chunks} len=${i === c.chunks ? last : 244}`,
      dt: 27,
      hold: 60,
    });
  }
  return [
    ...head,
    { lvl: 'I', tag: 'frame', msg: `A5 5A ver=01 type=02 len=0x${c.payloadLen.toString(16).padStart(4, '0').toUpperCase()} crc=${c.crc} -> OK`, dt: 2 },
    { lvl: 'I', tag: 'frame', msg: `${c.payloadLen}B payload in ${c.frameLen}B frame, ${c.chunks} ATT chunks`, dt: 1 },
    { lvl: 'I', tag: 'sec', msg: `door=${c.doorId} "${c.door}" min_tier=${c.minTier}`, dt: 1 },
    { lvl: 'I', tag: 'sec', msg: `pubkey=${c.pk}`, dt: 1 },
  ];
}

function grant(c: Ctx): Entry[] {
  if (c.tier < c.minTier) {
    return [
      ...ingest(c),
      { lvl: 'I', tag: 'sec', msg: `epoch=${c.epoch} rtc_skew=+38ms window=±150ms -> ACCEPT`, dt: 2 },
      { lvl: 'I', tag: 'ed25519', msg: `verify gateway_sig signer=${c.gw}`, dt: 1 },
      { lvl: 'I', tag: 'ed25519', msg: 'OK 24.8ms (sw libsodium, no ed25519 accel on S3)', dt: 25 },
      { lvl: 'I', tag: 'tflm', msg: 'AllocateTensors() -> kTfLiteOk', dt: 3 },
      { lvl: 'I', tag: 'tflm', msg: `Invoke() latency=14.1ms confidence=0.91 class=BENIGN`, dt: 15 },
      { lvl: 'W', tag: 'policy', msg: `tier=${c.tier} required=${c.minTier} -> DENY reason=TIER_INSUFFICIENT`, dt: 1, fx: 'deny' },
      { lvl: 'E', tag: 'gpio', msg: 'GPIO_PIN_4 held LOW', dt: 1 },
      { lvl: 'W', tag: 'audit', msg: `ring[44/256] evt=DENY_TIER pk=${c.pk} flushed`, dt: 4, hold: 180 },
    ];
  }

  return [
    ...ingest(c),
    { lvl: 'I', tag: 'sec', msg: `epoch=${c.epoch} rtc_skew=+38ms window=±150ms -> ACCEPT`, dt: 2 },
    { lvl: 'I', tag: 'sec', msg: 'nonce unseen (bloom k=4 m=8192 n=41 fp=6.1e-03)', dt: 1 },
    { lvl: 'I', tag: 'sec', msg: `nullifier ${c.nullifier} not burned (nvs key=nf_${c.epoch})`, dt: 2 },
    { lvl: 'I', tag: 'ed25519', msg: `verify gateway_sig signer=${c.gw}`, dt: 1 },
    { lvl: 'I', tag: 'ed25519', msg: 'OK 24.8ms (sw libsodium, no ed25519 accel on S3)', dt: 25, hold: 120 },
    { lvl: 'I', tag: 'tflm', msg: 'MicroAllocator init, arena=131072B', dt: 2 },
    { lvl: 'I', tag: 'tflm', msg: 'Loading weights for anomaly_model.tflite (44112B, part:model)', dt: 6 },
    { lvl: 'I', tag: 'tflm', msg: 'AllocateTensors() -> kTfLiteOk', dt: 3 },
    { lvl: 'I', tag: 'tflm', msg: 'arena_used=98304B head=0x3FCA4000 tail=0x3FCBC000 (75.0%)', dt: 1 },
    { lvl: 'I', tag: 'tflm', msg: 'input0  int8[1,8] scale=0.00784314 zp=-1', dt: 1 },
    { lvl: 'I', tag: 'tflm', msg: 'output0 int8[1,2] scale=0.00390625 zp=-128', dt: 1 },
    { lvl: 'I', tag: 'tflm', msg: 'ops 4/4 [FULLY_CONNECTED, LOGISTIC, QUANTIZE, DEQUANTIZE]', dt: 2 },
    { lvl: 'I', tag: 'feat', msg: `dt_ms=3184 rssi=-58 skew=38 nonceH=7.81 tier=${c.tier} hod=0.87 vel=0.14 geo=1`, dt: 2 },
    { lvl: 'I', tag: 'tflm', msg: 'Invoke() latency=14.2ms confidence=0.94 class=BENIGN', dt: 15, hold: 200 },
    { lvl: 'I', tag: 'policy', msg: `tier=${c.tier} required=${c.minTier} anomaly=BENIGN -> GRANT`, dt: 1 },
    { lvl: 'I', tag: 'gpio', msg: 'GPIO_PIN_4 -> HIGH (RELAY_OPEN)', dt: 1, fx: 'relay_open' },
    { lvl: 'I', tag: 'relay', msg: 'coil energized Ibus=412mA Vbus=11.86V t_on=2.1ms', dt: 3 },
    { lvl: 'I', tag: 'audit', msg: `burn nullifier -> nvs zk/nf_${c.epoch} (commit 3.4ms)`, dt: 4 },
    { lvl: 'I', tag: 'audit', msg: 'ring[42/256] evt=GRANT flushed to audit@0x400000', dt: 2 },
    { lvl: 'W', tag: 'gpio', msg: `GPIO_PIN_4 -> LOW (RELAY_CLOSED) dwell=${c.dwell}ms`, dt: c.dwell, hold: c.dwell, fx: 'relay_close' },
    { lvl: 'I', tag: 'reed', msg: 'GPIO5 CLOSED, latch re-armed', dt: 31, hold: 120 },
  ];
}

function spoof(c: Ctx): Entry[] {
  return [
    ...ingest(c),
    { lvl: 'W', tag: 'sec', msg: `epoch=${c.epoch} rtc_skew=+412ms window=±150ms -> OUT OF WINDOW`, dt: 2 },
    { lvl: 'W', tag: 'sec', msg: 'DS3231 drift -1.8ppm cannot account for 412ms over 97s since sync', dt: 3 },
    { lvl: 'W', tag: 'uwb', msg: 'DW3000 ToF range 11.42m (sigma 0.09m, 4 ranging rounds)', dt: 46, hold: 220 },
    { lvl: 'W', tag: 'uwb', msg: 'BLE RSSI -31dBm implies <1.0m at 1m-ref -59dBm', dt: 2 },
    { lvl: 'W', tag: 'sec', msg: 'rssi/tof divergence 10.4m -> relay-attack heuristic armed', dt: 2 },
    { lvl: 'I', tag: 'tflm', msg: 'AllocateTensors() -> kTfLiteOk', dt: 4 },
    { lvl: 'I', tag: 'feat', msg: `dt_ms=88 rssi=-31 skew=412 nonceH=7.79 tier=${c.tier} hod=0.87 vel=0.91 geo=0`, dt: 2 },
    { lvl: 'E', tag: 'tflm', msg: 'Invoke() latency=14.6ms confidence=0.97 class=SPOOF_SPATIAL', dt: 15, hold: 240 },
    { lvl: 'E', tag: 'policy', msg: 'DENY reason=RELAY_ATTACK_SUSPECTED', dt: 1, fx: 'deny' },
    { lvl: 'E', tag: 'gpio', msg: 'GPIO_PIN_4 held LOW', dt: 1 },
    { lvl: 'W', tag: 'sec', msg: 'nullifier NOT burned — deny path preserves the credential', dt: 2 },
    { lvl: 'W', tag: 'audit', msg: 'ring[43/256] evt=DENY_SPOOF flushed to audit@0x400000', dt: 5 },
    { lvl: 'W', tag: 'zklok', msg: `backoff 8000ms for pk=${c.pk} (3 strikes -> 300s)`, dt: 2, hold: 200 },
  ];
}

function degraded(c: Ctx): Entry[] {
  return [
    ...ingest(c),
    { lvl: 'I', tag: 'sec', msg: `epoch=${c.epoch} rtc_skew=+41ms window=±150ms -> ACCEPT`, dt: 2 },
    { lvl: 'I', tag: 'tflm', msg: 'MicroAllocator init, arena=131072B', dt: 2 },
    { lvl: 'E', tag: 'tflm', msg: 'AllocateTensors() -> kTfLiteError', dt: 7 },
    { lvl: 'E', tag: 'tflm', msg: 'arena exhausted: need 141312B > 131072B at op 3 FULLY_CONNECTED', dt: 1 },
    { lvl: 'W', tag: 'health', msg: 'tflm subsystem -> DEGRADED (strike 1/3, window 600s)', dt: 2, fx: 'degrade' },
    { lvl: 'W', tag: 'policy', msg: 'fallback ED25519_ONLY (P0 loop), anomaly gate bypassed', dt: 1, hold: 260 },
    { lvl: 'I', tag: 'ed25519', msg: `verify gateway_sig signer=${c.gw}`, dt: 1 },
    { lvl: 'I', tag: 'ed25519', msg: 'OK 24.9ms (sw libsodium)', dt: 25, hold: 150 },
    { lvl: 'I', tag: 'sec', msg: `nullifier ${c.nullifier} not burned (nvs key=nf_${c.epoch})`, dt: 2 },
    { lvl: 'I', tag: 'policy', msg: `tier=${c.tier} required=${c.minTier} -> GRANT (degraded)`, dt: 1 },
    { lvl: 'I', tag: 'gpio', msg: 'GPIO_PIN_4 -> HIGH (RELAY_OPEN)', dt: 1, fx: 'relay_open' },
    { lvl: 'I', tag: 'relay', msg: 'coil energized Ibus=409mA Vbus=11.84V t_on=2.2ms', dt: 3 },
    { lvl: 'W', tag: 'health', msg: 'model slot dirty, OTA re-flash queued for 04:00 window', dt: 4 },
    { lvl: 'W', tag: 'gpio', msg: `GPIO_PIN_4 -> LOW (RELAY_CLOSED) dwell=${c.dwell}ms`, dt: c.dwell, hold: c.dwell, fx: 'relay_close' },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HardwareTerminal({ payload, tier, onRelay, onState }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [rxBytes, setRxBytes] = useState(0);
  const [follow, setFollow] = useState(true);
  const [degradedMode, setDegradedMode] = useState(false);

  const idRef = useRef(0);
  const clockRef = useRef(0);
  const queueRef = useRef<Entry[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const degradedRef = useRef(false);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const pump = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      setBusy(false);
      timerRef.current = null;
      return;
    }

    clockRef.current += next.dt;
    const line: Line = { ...next, id: idRef.current++, ts: clockRef.current };

    setLines((prev) => {
      const out = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
      out.push(line);
      return out;
    });
    setRxBytes((b) => b + next.msg.length + (next.tag?.length ?? 0) + 12);

    if (next.fx === 'relay_open') {
      onRelay(true);
      onState('OPEN');
    } else if (next.fx === 'relay_close') {
      onRelay(false);
      onState(degradedRef.current ? 'DEGRADED' : 'IDLE');
    } else if (next.fx === 'deny') {
      onRelay(false);
      onState('DENIED');
    } else if (next.fx === 'degrade') {
      degradedRef.current = true;
      setDegradedMode(true);
    }

    // `hold` is the wall-clock delay BEFORE a line appears, not after it, so it
    // is read from the line about to be emitted rather than the one just
    // emitted. With the delay trailing, `GPIO_PIN_4 -> LOW` printed ~64 ms
    // after the HIGH regardless of the door's dwell: the relay chip flickered
    // through HIGH inside a single frame and the operator never saw it open.
    // Leading delay also reads better for the slow stages — the pause sits
    // where the work happens, then the result prints.
    const upcoming = queueRef.current[0];
    const delay = upcoming ? (upcoming.hold ?? Math.max(16, Math.min(upcoming.dt, 220))) : 0;
    timerRef.current = setTimeout(pump, delay);
  }, [onRelay, onState]);

  const enqueue = useCallback(
    (entries: Entry[]) => {
      queueRef.current.push(...entries);
      if (timerRef.current === null) {
        setBusy(true);
        timerRef.current = setTimeout(pump, 0);
      }
    },
    [pump],
  );

  // Boot once on mount.
  useEffect(() => {
    onState('BOOT');
    enqueue(BOOT);
    const t = setTimeout(() => onState('IDLE'), 2_600);
    return () => {
      clearTimeout(t);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      queueRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow tail unless the operator has scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const ctx: Ctx | null = useMemo(() => {
    if (!payload) return null;
    return {
      pk: abbrev(payload.walletPubkey, 6, 6),
      gw: abbrev(payload.gatewayEnvelope.signerPubkey, 6, 4),
      epoch: payload.epoch,
      crc: `0x${payload.frame.crc16.toString(16).padStart(4, '0').toUpperCase()}`,
      nullifier: `${payload.nullifier.slice(0, 10)}\u2026`,
      tier: payload.tier,
      minTier: payload.door.minTier,
      door: payload.door.label,
      doorId: `0x${payload.door.id.toString(16).padStart(8, '0').toUpperCase()}`,
      dwell: payload.door.dwellMs,
      chunks: payload.frame.chunks,
      frameLen: payload.frame.bytes.length,
      payloadLen: payload.frame.header.payloadLen,
    };
  }, [payload]);

  const noCred: Entry[] = [
    { lvl: 'E', tag: 'frame', msg: 'no credential staged — attach a signer and build a payload', dt: 2, hold: 140 },
  ];

  const run = (build: (c: Ctx) => Entry[]) => {
    if (busy) return;
    onState('BUSY');
    enqueue(ctx ? build(ctx) : noCred);
  };

  const clear = () => {
    setLines([]);
    setRxBytes(0);
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col border border-zinc-800 bg-zinc-950">
      <Header
        label="uart0 / esp32-s3-wroom-1-n8r8"
        right={
          <span className="text-3xs text-zinc-600">
            115200 8N1 · rts=0 dtr=0 · rx={rxBytes.toLocaleString('en-US')}B
          </span>
        }
      />

      <div
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-[#09090b] px-3 py-2 text-3xs leading-[1.55]"
      >
        {lines.map((l) => (
          <div key={l.id} className="whitespace-pre-wrap break-words">
            {l.lvl === 'R' ? (
              <span className="text-zinc-500">{l.msg}</span>
            ) : (
              <>
                <span className={LVL_COLOR[l.lvl]}>{l.lvl}</span>
                <span className="text-zinc-700">
                  {' ('}
                  {l.ts}
                  {') '}
                </span>
                <span className="text-zinc-500">{l.tag}:</span>{' '}
                <span className={l.lvl === 'E' ? 'text-[color:var(--fail)]' : l.lvl === 'W' ? 'text-[color:var(--warn)]' : 'text-zinc-300'}>
                  {l.msg}
                </span>
              </>
            )}
          </div>
        ))}
        <div className="text-zinc-600">
          {busy ? '' : '> '}
          <span className="animate-blink text-zinc-400">_</span>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-zinc-800 px-3 py-2">
        <Btn onClick={() => run(grant)} disabled={busy} primary>
          submit pass
        </Btn>
        <Btn onClick={() => run(spoof)} disabled={busy}>
          inject spoof
        </Btn>
        <Btn onClick={() => run(degraded)} disabled={busy}>
          fault: tflm arena
        </Btn>
        <Btn onClick={clear} disabled={busy}>
          clear
        </Btn>
        <span className="ml-auto text-3xs text-zinc-600">
          tier={tier} · {degradedMode ? 'health=DEGRADED' : 'health=OK'} · t={clockRef.current}ms
          {!follow && ' · tail paused'}
        </span>
      </div>
    </section>
  );
}

const LVL_COLOR: Record<Level, string> = {
  R: 'text-zinc-600',
  I: 'text-zinc-500',
  W: 'text-[color:var(--warn)]',
  E: 'text-[color:var(--fail)]',
};

function Btn({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'border px-2 py-1 text-3xs uppercase tracking-widest transition-colors',
        primary
          ? 'border-zinc-600 text-zinc-100 hover:bg-zinc-800'
          : 'border-zinc-800 text-zinc-400 hover:bg-zinc-900',
        'disabled:cursor-not-allowed disabled:border-zinc-900 disabled:text-zinc-700 disabled:hover:bg-transparent',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

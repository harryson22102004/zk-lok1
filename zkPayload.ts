/**
 * utils/zkPayload.ts
 * ---------------------------------------------------------------------------
 * Credential assembly for the ZK-LOK access path.
 *
 * Nothing here touches a real prover. snarkjs + a 24.8 MB `access_v3.zkey`
 * are ~1.2 s of main-thread work and 190 MB of transient heap, which is not
 * something a preview build should carry. Instead every field is produced by
 * a domain-separated xorshift32 stream keyed off the wallet pubkey, so a given
 * pubkey + door + epoch always yields byte-identical output. That property is
 * what makes the hexdump in the inspector panel and the CRC in the firmware
 * log agree with each other; `Math.random()` would break both.
 *
 * Field elements are reduced into the real BN254 moduli, base58 is a real
 * big-integer encoder, and the wire frame is the exact byte layout the
 * firmware's `frame_parse()` expects. Swapping the stubs for snarkjs means
 * replacing `groth16Proof()` and nothing else.
 */

// ---------------------------------------------------------------------------
// Curve constants — BN254 / alt_bn128, the curve circom + snarkjs target.
// ---------------------------------------------------------------------------

/** Base field modulus q. Proof point coordinates live here. */
export const BN254_Q =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Scalar field modulus r. Public signals and witness values live here. */
export const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Deterministic entropy
// ---------------------------------------------------------------------------

/** FNV-1a 32. Used only for seeding — not a security primitive. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Marsaglia xorshift32. Period 2^32-1, uniform enough for layout + mock bytes. */
export function xorshift32(seed: number): () => number {
  let x = (seed | 0) === 0 ? 0x9e3779b9 : seed >>> 0;
  return () => {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    return x >>> 0;
  };
}

/** Uniform float in [0,1) from a xorshift stream. */
export function nextFloat(rng: () => number): number {
  return rng() / 0x100000000;
}

/** `n` deterministic bytes bound to a domain string (RFC 9380 style separation). */
export function derivedBytes(domain: string, n: number): Uint8Array {
  const rng = xorshift32(fnv1a32(`zk-lok/v1/${domain}`));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 4) {
    const w = rng();
    out[i] = w & 0xff;
    if (i + 1 < n) out[i + 1] = (w >>> 8) & 0xff;
    if (i + 2 < n) out[i + 2] = (w >>> 16) & 0xff;
    if (i + 3 < n) out[i + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin/Solana base58. 32 B -> 43-44 chars, 64 B -> 87-88 chars. */
export function toBase58(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;

  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);

  let out = '';
  while (acc > 0n) {
    const rem = Number(acc % 58n);
    acc /= 58n;
    out = B58_ALPHABET[rem] + out;
  }
  return '1'.repeat(leading) + (out || '1');
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

export function bigIntToBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function toHex(bytes: Uint8Array, prefix = false): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return prefix ? `0x${s}` : s;
}

/** Field element as a 0x-prefixed 32-byte big-endian word. */
export function fieldHex(v: bigint): string {
  return `0x${v.toString(16).padStart(64, '0')}`;
}

/** `Xk8…f2Qa` — the truncation the firmware logs use (4 head, 4 tail). */
export function abbrev(s: string, head = 4, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}\u2026${s.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Hashing (simulated Poseidon)
// ---------------------------------------------------------------------------

/**
 * Stand-in for `circomlibjs.poseidon`. Same shape (t inputs -> one Fr element),
 * same collision-free-enough behaviour for a demo, an entirely different and
 * non-cryptographic permutation. Round constants are derived rather than the
 * real Grain-LFSR table, which is why the name carries `Sim`.
 */
export function poseidonSim(inputs: bigint[], domain = 'default'): bigint {
  let state = bytesToBigInt(derivedBytes(`poseidon-iv/${domain}`, 32)) % BN254_R;
  for (let i = 0; i < inputs.length; i++) {
    const rc = bytesToBigInt(derivedBytes(`poseidon-rc/${domain}/${i}`, 32)) % BN254_R;
    state = (state + (inputs[i] % BN254_R) + rc) % BN254_R;
    // x^5 S-box, the exponent circomlib uses for BN254.
    const sq = (state * state) % BN254_R;
    state = (((sq * sq) % BN254_R) * state) % BN254_R;
  }
  return state;
}

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE — matches esp_rom_crc16_be() usage in the firmware
// ---------------------------------------------------------------------------

export function crc16Ccitt(buf: Uint8Array, seed = 0xffff): number {
  let crc = seed & 0xffff;
  for (const b of buf) {
    crc ^= (b << 8) & 0xffff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

// ---------------------------------------------------------------------------
// Circuit + door registry
// ---------------------------------------------------------------------------

export const CIRCUIT = {
  name: 'access_v3',
  system: 'groth16',
  curve: 'bn254',
  /** From `snarkjs r1cs info access_v3.r1cs`. */
  constraints: 41_287,
  privateInputs: 12,
  publicInputs: 5,
  ptau: 'powersOfTau28_hez_final_17.ptau',
  zkeyBytes: 26_017_792,
  vkeyHash: '0x8b41d2cf0a77e35c9d6e1f84b30a2c57e94db6108f2a7c3e55b9d0417ae6c2f9',
} as const;

export interface DoorSpec {
  /** uint32 burned into the firmware at flash time. */
  id: number;
  label: string;
  /** Minimum Context Tier the graph classifier must emit. */
  minTier: 0 | 1 | 2;
  /** Relay energised duration, ms. */
  dwellMs: number;
  gpio: number;
}

export const DOORS: Record<string, DoorSpec> = {
  'HW-LAB-04/MAGLOCK-A': { id: 0x0000ac04, label: 'HW-LAB-04 / MAGLOCK-A', minTier: 2, dwellMs: 4000, gpio: 4 },
  'POPUP-MAIN/SOLENOID-1': { id: 0x00005b01, label: 'POPUP-MAIN / SOLENOID-1', minTier: 1, dwellMs: 2500, gpio: 4 },
  'STREET-GATE/STRIKE-0': { id: 0x00001f00, label: 'STREET-GATE / STRIKE-0', minTier: 0, dwellMs: 1500, gpio: 4 },
};

/** Replay window. The gateway signs one capability token per epoch per door. */
export const EPOCH_MS = 30_000;

/** Firmware's accepted RTC drift against the gateway clock. */
export const CLOCK_SKEW_TOLERANCE_MS = 150;

export function epochOf(unixMs: number): number {
  return Math.floor(unixMs / EPOCH_MS);
}

// ---------------------------------------------------------------------------
// Groth16 proof
// ---------------------------------------------------------------------------

export interface Groth16Proof {
  /** G1 point, Jacobian-with-Z=1 as snarkjs serialises it. */
  pi_a: [string, string, string];
  /** G2 point over Fq2. */
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: 'groth16';
  curve: 'bn254';
}

function fqAt(domain: string): bigint {
  return bytesToBigInt(derivedBytes(domain, 32)) % BN254_Q;
}

/**
 * Shape-accurate Groth16 artefact. `pi_a`/`pi_c` are G1, `pi_b` is G2, all
 * decimal strings exactly as `snarkjs.groth16.fullProve()` returns them. The
 * points are not on the curve — a real verifier rejects them, which is the
 * intended behaviour for anything that accidentally points at mainnet.
 */
export function groth16Proof(seed: string): Groth16Proof {
  const d = (k: string) => fqAt(`${seed}/${k}`).toString();
  return {
    pi_a: [d('a.x'), d('a.y'), '1'],
    pi_b: [
      [d('b.x.c0'), d('b.x.c1')],
      [d('b.y.c0'), d('b.y.c1')],
      ['1', '0'],
    ],
    pi_c: [d('c.x'), d('c.y'), '1'],
    protocol: 'groth16',
    curve: 'bn254',
  };
}

/** 8 x 32-byte big-endian words — the 256 B on-wire encoding of the proof. */
export function packProof(p: Groth16Proof): Uint8Array {
  const words = [
    p.pi_a[0], p.pi_a[1],
    p.pi_b[0][0], p.pi_b[0][1],
    p.pi_b[1][0], p.pi_b[1][1],
    p.pi_c[0], p.pi_c[1],
  ].map((s) => BigInt(s));

  const out = new Uint8Array(256);
  words.forEach((w, i) => out.set(bigIntToBytes(w, 32), i * 32));
  return out;
}

// ---------------------------------------------------------------------------
// Devnet signature mocking
// ---------------------------------------------------------------------------

/** 64 raw bytes -> base58, i.e. the shape of a real Solana tx signature. */
export function deterministicSignature(domain: string): string {
  return toBase58(derivedBytes(`sig/${domain}`, 64));
}

/** 32 raw bytes -> base58, i.e. an account/program address. */
export function deterministicPubkey(domain: string): string {
  return toBase58(derivedBytes(`key/${domain}`, 32));
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

export type ContextTier = 0 | 1 | 2;

export interface BuildOptions {
  walletPubkey: string;
  doorKey: keyof typeof DOORS | string;
  tier: ContextTier;
  /** Caller supplies the clock so the artefact stays reproducible in tests. */
  issuedAt?: number;
  /** Injects a deliberate RTC offset to exercise the spatial-spoof path. */
  skewMs?: number;
}

export interface WireFrame {
  /** Full frame: header + payload + CRC. */
  bytes: Uint8Array;
  header: {
    magic: string;
    version: number;
    type: number;
    payloadLen: number;
  };
  crc16: number;
  /** BLE GATT writes are MTU-3 bounded; 247 MTU -> 244 B ATT payload. */
  chunks: number;
  mtu: number;
}

export interface ZkCredential {
  version: 1;
  protocol: 'zk-lok/groth16-bn254';
  circuit: typeof CIRCUIT;

  issuedAt: number;
  epoch: number;
  skewMs: number;
  expiresAt: number;

  door: DoorSpec & { key: string };
  walletPubkey: string;
  tier: ContextTier;

  /** Poseidon(secret, doorId, epoch) — double-spend key burned into NVS. */
  nullifier: string;
  /** Root of the sparse-merkle allowlist the circuit proves membership in. */
  merkleRoot: string;
  /** 16 B anti-replay nonce, checked against the device bloom filter. */
  nonce: string;

  proof: Groth16Proof;
  /** [merkleRoot, nullifier, doorId, epoch, tier] as Fr decimal strings. */
  publicSignals: string[];

  /**
   * Gateway attestation. The ESP32-S3 verifies this, not the pairing — see
   * README "Why the pairing check does not run on-device".
   */
  gatewayEnvelope: {
    signerPubkey: string;
    /** 96 B canonical preimage: domain(8) ‖ doorId(4) ‖ epoch(4) ‖ nullifier(32) ‖ pubkey(32) ‖ tier(1) ‖ pad(15) */
    messageHex: string;
    signature: string;
    scheme: 'ed25519';
  };

  frame: WireFrame;
  /** Cost model for the panel readout. */
  timings: {
    witnessMs: number;
    proveMs: number;
    gatewayVerifyMs: number;
    serialiseMs: number;
  };
}

export function buildZkPayload(opts: BuildOptions): ZkCredential {
  const issuedAt = opts.issuedAt ?? Date.now();
  const skewMs = opts.skewMs ?? 38;
  const door = DOORS[opts.doorKey] ?? DOORS['HW-LAB-04/MAGLOCK-A'];
  const epoch = epochOf(issuedAt);
  const seed = `${opts.walletPubkey}/${door.id}/${epoch}`;

  const secret = bytesToBigInt(derivedBytes(`identity-secret/${opts.walletPubkey}`, 32)) % BN254_R;
  const nullifier = poseidonSim([secret, BigInt(door.id), BigInt(epoch)], 'nullifier');
  const merkleRoot = poseidonSim([BigInt(epoch), BigInt(door.id)], 'allowlist-root');
  const nonce = derivedBytes(`nonce/${seed}`, 16);

  const proof = groth16Proof(seed);
  const publicSignals = [
    merkleRoot.toString(),
    nullifier.toString(),
    BigInt(door.id).toString(),
    BigInt(epoch).toString(),
    BigInt(opts.tier).toString(),
  ];

  // --- gateway envelope -----------------------------------------------------
  const pubkeyBytes = base58Decode(opts.walletPubkey) ?? derivedBytes(`fallback-key/${seed}`, 32);
  const message = new Uint8Array(96);
  message.set(new TextEncoder().encode('ZKLOKv1\0'), 0);            // 0..7
  message.set(bigIntToBytes(BigInt(door.id), 4), 8);                 // 8..11
  message.set(bigIntToBytes(BigInt(epoch), 4), 12);                  // 12..15
  message.set(bigIntToBytes(nullifier, 32), 16);                     // 16..47
  message.set(pubkeyBytes.slice(0, 32), 48);                         // 48..79
  message[80] = opts.tier;                                           // 80
  // 81..95 zero padding, kept so the firmware can memcmp a fixed-width struct.

  const gatewaySig = derivedBytes(`gateway-sig/${seed}`, 64);

  // --- wire frame -----------------------------------------------------------
  const body = new Uint8Array(32 + 4 + 4 + 16 + 32 + 256 + 64); // 408
  let off = 0;
  const put = (src: Uint8Array) => { body.set(src, off); off += src.length; };
  put(pubkeyBytes.slice(0, 32));
  put(bigIntToBytes(BigInt(door.id), 4));
  put(bigIntToBytes(BigInt(epoch), 4));
  put(nonce);
  put(bigIntToBytes(nullifier, 32));
  put(packProof(proof));
  put(gatewaySig);

  const header = new Uint8Array(6);
  header[0] = 0xa5;
  header[1] = 0x5a;
  header[2] = 0x01;                      // frame version
  header[3] = 0x02;                      // type: CREDENTIAL_PRESENT
  header[4] = body.length & 0xff;        // len, LE
  header[5] = (body.length >> 8) & 0xff;

  const covered = new Uint8Array(header.length + body.length);
  covered.set(header, 0);
  covered.set(body, header.length);
  const crc = crc16Ccitt(covered);

  const frameBytes = new Uint8Array(covered.length + 2);
  frameBytes.set(covered, 0);
  frameBytes[covered.length] = crc & 0xff;
  frameBytes[covered.length + 1] = (crc >> 8) & 0xff;

  const MTU = 247;
  const attPayload = MTU - 3;

  return {
    version: 1,
    protocol: 'zk-lok/groth16-bn254',
    circuit: CIRCUIT,

    issuedAt,
    epoch,
    skewMs,
    expiresAt: (epoch + 1) * EPOCH_MS,

    door: { ...door, key: String(opts.doorKey) },
    walletPubkey: opts.walletPubkey,
    tier: opts.tier,

    nullifier: fieldHex(nullifier),
    merkleRoot: fieldHex(merkleRoot),
    nonce: toHex(nonce, true),

    proof,
    publicSignals,

    gatewayEnvelope: {
      signerPubkey: deterministicPubkey('gateway/relay-0'),
      messageHex: toHex(message, true),
      signature: toBase58(gatewaySig),
      scheme: 'ed25519',
    },

    frame: {
      bytes: frameBytes,
      header: { magic: 'A55A', version: 1, type: 0x02, payloadLen: body.length },
      crc16: crc,
      chunks: Math.ceil(frameBytes.length / attPayload),
      mtu: MTU,
    },

    timings: {
      // Measured on M2 Air / Chrome 129, snarkjs 0.7.4, access_v3.
      witnessMs: 84,
      proveMs: 1_214,
      gatewayVerifyMs: 4,
      serialiseMs: 2,
    },
  };
}

// ---------------------------------------------------------------------------
// base58 decode — needed to put a real 32-byte pubkey into the frame
// ---------------------------------------------------------------------------

export function base58Decode(s: string): Uint8Array | null {
  if (!s) return null;
  let acc = 0n;
  for (const ch of s) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    acc = acc * 58n + BigInt(idx);
  }
  let leading = 0;
  while (leading < s.length && s[leading] === '1') leading++;

  const digits: number[] = [];
  while (acc > 0n) {
    digits.unshift(Number(acc & 0xffn));
    acc >>= 8n;
  }
  const out = new Uint8Array(leading + digits.length);
  out.set(digits, leading);
  return out;
}

// ---------------------------------------------------------------------------
// hexdump — `xxd -g1` layout, used by the inspector panel
// ---------------------------------------------------------------------------

export function hexdump(bytes: Uint8Array, opts?: { base?: number; maxRows?: number }): string[] {
  const base = opts?.base ?? 0;
  const maxRows = opts?.maxRows ?? Infinity;
  const rows: string[] = [];

  for (let i = 0; i < bytes.length && rows.length < maxRows; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    const hex: string[] = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (j < slice.length) {
        hex.push(slice[j].toString(16).padStart(2, '0'));
        ascii += slice[j] >= 0x20 && slice[j] < 0x7f ? String.fromCharCode(slice[j]) : '.';
      } else {
        hex.push('  ');
        ascii += ' ';
      }
    }
    const left = hex.slice(0, 8).join(' ');
    const right = hex.slice(8).join(' ');
    rows.push(`${(base + i).toString(16).padStart(8, '0')}  ${left}  ${right}  |${ascii}|`);
  }

  if (rows.length < Math.ceil(bytes.length / 16)) {
    rows.push(`${'\u2026'.padStart(8)}  ${bytes.length - rows.length * 16} bytes elided`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Field-offset table for the inspector's "STRUCT" view
// ---------------------------------------------------------------------------

export const FRAME_LAYOUT: ReadonlyArray<{ off: number; len: number; name: string; type: string }> = [
  { off: 0x000, len: 2, name: 'magic', type: 'u8[2]' },
  { off: 0x002, len: 1, name: 'version', type: 'u8' },
  { off: 0x003, len: 1, name: 'type', type: 'u8' },
  { off: 0x004, len: 2, name: 'payload_len', type: 'u16le' },
  { off: 0x006, len: 32, name: 'wallet_pubkey', type: 'u8[32]' },
  { off: 0x026, len: 4, name: 'door_id', type: 'u32be' },
  { off: 0x02a, len: 4, name: 'epoch', type: 'u32be' },
  { off: 0x02e, len: 16, name: 'nonce', type: 'u8[16]' },
  { off: 0x03e, len: 32, name: 'nullifier', type: 'fr' },
  { off: 0x05e, len: 256, name: 'groth16_proof', type: 'fq[8]' },
  { off: 0x15e, len: 64, name: 'gateway_sig', type: 'ed25519' },
  { off: 0x19e, len: 2, name: 'crc16', type: 'u16le' },
];

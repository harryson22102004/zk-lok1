# ZK-LOK // Transient Network State OS

Physical access control where the credential is a zero-knowledge proof over on-chain
history rather than a card number. A wallet proves membership in a door's allowlist
without revealing which member it is; a gateway converts that proof into a 30-second
Ed25519 capability token; an ESP32-S3 verifies the token, runs an 8-feature anomaly
model on-device, and drives a relay.

The repository contains the **web half** — wallet attachment, the graph classifier that
assigns a Context Tier, credential assembly, and a firmware simulator that reproduces the
device's UART output line for line. The firmware and gateway live in sibling repos
(`zk-lok-fw`, `zk-lok-gw`); their behaviour is pinned here by the wire format in
`utils/zkPayload.ts` and the log transcript in `components/HardwareTerminal.tsx`.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                    │
│                                                                            │
│  wallet-adapter ──► getSignaturesForAddress(limit=12)                      │
│        │                          │                                        │
│        │                          ▼                                        │
│        │              Graph Transformer (k=2 neighbourhood)                 │
│        │              gov votes · squads cosigns · cNFT attestations        │
│        │                          │                                        │
│        │                          ▼                                        │
│        │                  Context Tier ∈ {0,1,2}                            │
│        ▼                          │                                        │
│  snarkjs.groth16.fullProve  ◄─────┘                                        │
│  access_v3.zkey · BN254 · 41,287 constraints · ~1.21 s                     │
│        │                                                                   │
│        └── π (256 B) + publicSignals[5]                                    │
└────────┼───────────────────────────────────────────────────────────────────┘
         │  HTTPS
┌────────▼───────────────────────────────────────────────────────────────────┐
│ GATEWAY  (Rust / axum / arkworks-bn254)                                    │
│  1. verify_proof(vk, π, publicSignals)            ~4 ms                    │
│  2. check merkleRoot is the current epoch root                             │
│  3. check nullifier unspent in Postgres                                    │
│  4. sign 96-B capability preimage with Ed25519    ~0.05 ms                 │
└────────┼───────────────────────────────────────────────────────────────────┘
         │  BLE GATT 0x1810 / char 0x2A35, MTU 247 → 2 × ATT writes
         │  (UART0 0xA55A framing is the bench fallback)
┌────────▼───────────────────────────────────────────────────────────────────┐
│ ESP32-S3-WROOM-1-N8R8                                                      │
│  frame_parse()      CRC-16/CCITT                  0.4 ms                   │
│  rtc_window()       DS3231 vs epoch, ±150 ms      0.1 ms                   │
│  bloom_seen()       nonce replay filter           0.2 ms                   │
│  ed25519_verify()   libsodium, software          24.8 ms                   │
│  tflm_invoke()      anomaly_model.tflite int8    14.2 ms                   │
│  policy_eval()      tier ≥ min_tier && BENIGN     0.1 ms                   │
│  gpio_set(4, HIGH)  ULN2003A → G5LE-1-VD          2.1 ms coil              │
│                                          ───────────────────               │
│                                          end-to-end  ~42 ms                │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Why the pairing check does not run on-device

The obvious architecture verifies Groth16 on the lock. It was measured and discarded.

| Path | Where | Cost | Verdict |
|---|---|---|---|
| BN254 Miller loop + final exp, 4 pairings | ESP32-S3 @ 240 MHz, mbedTLS bignum | 3.4–4.1 s | Unusable. A person holds a door handle for ~1.5 s. |
| Same, with `MBEDTLS_HAVE_ASM` + Xtensa MULSH | ESP32-S3 | 2.2 s | Still 15× the acceptable budget. |
| Offload to gateway, sign Ed25519 capability | Rust/arkworks + software verify on S3 | 4 ms + 24.8 ms | Shipped. |

The trade is explicit: the lock trusts the gateway's signing key. That key lives in an
ATECC608B slot on the gateway and is rotated per epoch-day; the lock pins a root and
accepts a rotation certificate chain, so a compromised gateway is a 24-hour blast radius
rather than a permanent one. Verifying on the lock would remove that trust boundary and
replace it with a four-second door, which is not a trade this prototype is willing to
make. `CONFIG_ZKLOK_ONCHIP_PAIRING` exists and compiles; it is off.

**The proof still matters.** It is what keeps the gateway from learning *which* allowlist
member is at the door — the gateway sees a nullifier and a tier, never an identity.

---

## Context Tier

The classifier reads a wallet's k=2 neighbourhood and emits one of three tiers. Feature
weights decay with `exp(-age_days / 180)` so a dormant reputation expires on its own —
a 180-day half-life means a member who stops showing up drops out of Tier 2 in roughly
five months without anyone revoking anything.

| Tier | Label | Opens | Gate |
|---|---|---|---|
| 0 | `UNTRUSTED` | street gate | score < 0.31 |
| 1 | `POP-UP RESIDENT` | main solenoid | 0.31 ≤ score < 0.72 |
| 2 | `HARDWARE LAB ACCESS` | maglock, tool cage | score ≥ 0.72 |

| Feature | Unit weight | Cap |
|---|---|---|
| `gov.vote_weight` — spl-governance cast votes | 0.055 | 0.28 |
| `squads.cosign` — Squads v4 multisig participation | 0.075 | 0.30 |
| `cnft.attestation` — Bubblegum attestations from a known issuer | 0.110 | 0.33 |
| `spl.transfer_graph` — distinct counterparties | 0.008 | 0.08 |
| `mpl.mint_history` | 0.012 | 0.06 |
| `program.diversity` | 0.020 | 0.10 |
| `account.age` | — | 0.08 |

Attestations dominate by design: a cNFT issued by the space's own authority is the only
feature an attacker cannot manufacture with capital alone. Vote and cosign weights exist
to let a member reach Tier 1 before anyone has had time to attest them.

Caps matter more than weights. Without them a wallet could buy its way to Tier 2 on
transfer volume alone; with `spl.transfer_graph` capped at 0.08, no amount of token
movement clears 0.72 without either governance participation or an attestation.

The synthesiser draws each event's age as `u^2.5 × account_age` rather than uniformly,
because an active member's history clusters in the recent past and the decay term
punishes a uniform draw hard enough that almost nothing reaches Tier 2. Over 6,000
synthetic wallets the mix is 4.4% / 75.8% / 19.8% across tiers 0 / 1 / 2 — most people
are residents, the lab door is selective, and the deny path is still reachable. Swap
`RECENCY_SKEW` for the real age distribution when the Helius index is wired up.

The browser renders the readout half of the model. Message passing runs off-line during
nightly index rebuilds; the deployed edge model is the distilled 8-feature int8 MLP.

---

## Graceful degradation

The anomaly model is a *filter on top of* authentication, never a substitute for it. If
the ML pipeline fails on the edge, the relay falls back to the local Ed25519 signature
verification loop and keeps admitting valid credentials.

```
        ┌──────────┐  tflm_invoke() ok
        │  NORMAL  │─────────────────────────────┐
        └────┬─────┘                             │
             │ kTfLiteError | crc mismatch       │ 3 clean invokes
             │ | invoke timeout > 60 ms          │ within 600 s
             ▼                                   │
        ┌──────────┐                             │
        │ DEGRADED │─────────────────────────────┘
        └────┬─────┘  ED25519_ONLY: frame CRC → RTC window → bloom
             │        → ed25519_verify → tier check → GPIO4
             │
             │ 3 strikes in 600 s
             ▼
        ┌──────────┐
        │ QUARANTINE│  tier 2 doors refuse; tier 0/1 stay open on Ed25519.
        └──────────┘  audit partition flags the unit; OTA re-flash at 04:00.
```

What degradation **keeps**: CRC framing, ±150 ms RTC window, nonce bloom filter,
nullifier burn, Ed25519 verification, tier threshold.
What it **drops**: spatial-spoof detection, velocity heuristics, time-of-day plausibility.

The failure mode is therefore *a lock that is merely as good as a well-built Ed25519
lock*, not a lock that is open or bricked. `fault: tflm arena` in the simulator walks the
exact transcript.

---

## Bill of materials

Per door. Prices are Oct 2026 single-unit, INR ex-GST where sourced locally.

| # | Part | MPN | Qty | Notes |
|---|---|---|---|---|
| 1 | MCU module | Espressif **ESP32-S3-WROOM-1-N8R8** | 1 | Xtensa LX7 dual @240 MHz, 512 KB SRAM, 8 MB flash, 8 MB octal PSRAM. PSRAM is unused by the hot path — the tensor arena is pinned to internal DRAM at `0x3FCA4000`. |
| 2 | Dev carrier | ESP32-S3-DevKitC-1-N8R8 | 1 | Bench only. Production is a 4-layer carrier with the module reflowed. |
| 3 | Relay | **Omron G5LE-1-VD**, 12 VDC coil, SPDT 10 A/250 VAC | 1 | Coil 360 Ω / 33 mA. Chosen over a solid-state relay for the audible click — the operator feedback matters more than the 8 ms switching delta. |
| 4 | Relay driver | ULN2003AN | 1 | ch1 only. Integrated freewheel clamp; a bare 2N2222 would need an external diode and still sit 0.7 V above ground. |
| 5 | Lock | **12 V DC fail-secure solenoid**, 0.6 A hold / 0.9 A inrush | 1 | Fail-secure by fire-code requirement for the lab door; the street gate uses a fail-safe strike on the same driver. |
| 6 | Flyback diode | 1N4007 | 1 | Across the solenoid, cathode to +12 V. Redundant with the ULN2003A clamp, kept because the solenoid is 2 m of cable away. |
| 7 | RTC | Maxim **DS3231SN** + CR2032 | 1 | ±2 ppm TCXO. The ±150 ms replay window is only meaningful with a clock that does not drift 30 s/month; a bare RC oscillator would force a ±10 s window and re-open the replay surface. |
| 8 | UWB (P1) | Qorvo **DWM3000** module | 1 | Time-of-flight ranging for the spatial-spoof check. Optional — the model degrades to RSSI-only with a ~7 pp precision loss. |
| 9 | Door sensor | Honeywell 59140-1-T-02-A reed | 1 | GPIO5, pull-up, 25 ms debounce. Detects held-open and forced-open. |
| 10 | Buck | MP1584EN module, 12 V → 5 V 2 A | 1 | |
| 11 | PSU | Mean Well 12 V 2 A, IEC C14 | 1 | Headroom for 0.9 A inrush + 0.033 A coil + 0.35 A logic. |
| 12 | Bulk cap | 470 µF 25 V electrolytic + 0.1 µF X7R | 1 ea | Across the 12 V rail at the relay. Without it the inrush browns out the S3 and you get a reboot loop that reads like a firmware bug. |
| 13 | Enclosure | Hammond 1591XXSBK + cable glands | 1 | |

Not in the BOM on purpose: no display, no keypad, no Wi-Fi provisioning button. Every
input is the BLE credential path, which keeps the attack surface to one parser.

### Pinout

| Signal | GPIO | Direction | Notes |
|---|---|---|---|
| `RELAY_CTRL` | 4 | out | → ULN2003A 1B. Strapping-safe. |
| `REED_DOOR` | 5 | in, pull-up | Closed = 0. |
| `UART0_TX` | 43 | out | 115200 8N1, console. |
| `UART0_RX` | 44 | in | Bench framing path. |
| `I2C_SDA` / `SCL` | 8 / 9 | bidir | DS3231 @ 0x68. 100 kHz. |
| `STATUS_LED` | 47 | out | WS2812 on the DevKitC. |
| `UWB_IRQ` / `CS` | 10 / 34 | in / out | DWM3000, P1. |

GPIO 0, 3, 45, 46 are strapping pins and are left unconnected. GPIO 19/20 are USB-Serial-JTAG.

### Flash map

```
nvs       data nvs   0x009000 0x006000   nullifier burns, bloom, vk pin
otadata   data ota   0x00f000 0x002000
phy_init  data phy   0x011000 0x001000
ota_0     app  ota_0 0x020000 0x1e0000   1,182,432 B used (60.1%)
ota_1     app  ota_1 0x200000 0x1e0000
model     data 0x40  0x3e0000 0x020000   anomaly_model.tflite, crc32 0x9C2E41B3
audit     data 0x41  0x400000 0x100000   256-entry ring, wear-levelled
```

---

## Wire format

416-byte frame, little-endian header, big-endian field elements. `utils/zkPayload.ts`
builds it; the firmware's `frame_parse()` consumes it. A BLE MTU of 247 gives a 244-byte
ATT payload, so a credential is always exactly two writes.

| Offset | Len | Field | Type |
|---|---|---|---|
| `0x000` | 2 | `magic` | `A5 5A` |
| `0x002` | 1 | `version` | u8 = 1 |
| `0x003` | 1 | `type` | u8 = 2 (`CREDENTIAL_PRESENT`) |
| `0x004` | 2 | `payload_len` | u16le = 408 |
| `0x006` | 32 | `wallet_pubkey` | Ed25519 point |
| `0x026` | 4 | `door_id` | u32be |
| `0x02A` | 4 | `epoch` | u32be, `floor(unix_ms / 30000)` |
| `0x02E` | 16 | `nonce` | bloom-filter key |
| `0x03E` | 32 | `nullifier` | Fr, `Poseidon(secret, door_id, epoch)` |
| `0x05E` | 256 | `groth16_proof` | Fq[8] — a.x a.y b.x0 b.x1 b.y0 b.y1 c.x c.y |
| `0x15E` | 64 | `gateway_sig` | Ed25519 over the 96-byte capability preimage |
| `0x19E` | 2 | `crc16` | CCITT-FALSE, seed `0xFFFF`, over `0x000..0x19D` |

The proof travels to the lock even though the lock ignores it. It is logged to the audit
partition so a later offline sweep can re-verify every admission against the epoch roots —
the lock is fast, the audit trail is complete, and neither compromises the other.

---

## Roadmap

### P0 — days 1–10 · wallet-to-relay MVP

The deliverable is a door that opens from a phone and cannot be opened by replaying a
capture. No ML anywhere in the path.

| Day | Deliverable | Done when |
|---|---|---|
| 1–2 | Carrier wiring, ULN2003A + G5LE-1-VD + solenoid on the bench, inrush scoped | 470 µF sized against a captured 0.9 A transient; no brownout over 200 cycles |
| 3 | `access_v3.circom`, trusted-setup ceremony against `powersOfTau28_hez_final_17` | `snarkjs groth16 verify` green on 20 witness vectors |
| 4–5 | Gateway: arkworks verify, epoch root store, nullifier table, Ed25519 capability mint | p99 verify < 8 ms at 50 rps |
| 6 | Frame codec both sides, CRC, fuzz `frame_parse()` with 10⁶ mutated inputs | zero panics, zero OOB reads under ASAN |
| 7 | `ed25519_verify` on-device, DS3231 window, nonce bloom, NVS nullifier burn | replay of a captured frame is refused in-window and out |
| 8 | BLE GATT service, 2-chunk reassembly, backoff on malformed writes | 100 consecutive admissions, no reassembly desync |
| 9 | Web: wallet attach, proof generation in a worker, tier stub pinned to 2 | end-to-end open from a phone in < 2.5 s wall clock |
| 10 | Audit ring, OTA channel, enclosure | pull power mid-admission 50×, no corrupted NVS |

P0 exit: **wallet → relay, ~42 ms on-device, replay-proof, no model.**

### P1 — days 11–30 · TFLite Micro anomaly detection

| Day | Deliverable | Done when |
|---|---|---|
| 11–13 | Label a corpus: 14 k benign admissions, 900 synthesised relay/replay/tailgate attempts | class balance documented, holdout by door not by sample |
| 14–16 | Graph classifier: GraphSAGE over the k=2 neighbourhood, nightly index rebuild | tier assignment stable across 7 nightly runs for 95% of wallets |
| 17–19 | Distil to the 8-feature MLP, int8 post-training quantisation | ≤ 1.5 pp AUC loss vs float32 teacher |
| 20–22 | TFLM integration: 128 KB arena in internal DRAM, arena-size CI gate | `arena_used` ≤ 100 KB; build fails if it regresses past 110 KB |
| 23–24 | DWM3000 ranging, RSSI/ToF divergence feature | relay attack at 10 m detected at ≥ 0.95 confidence, 20/20 |
| 25–26 | Degradation state machine + strike window + quarantine | fault injection at every stage leaves the Ed25519 path admitting |
| 27–28 | Field soak, 2 doors, 30 members | zero false denials over 1 000 admissions |
| 29–30 | Threat-model writeup, key rotation runbook, model card | — |

P1 exit: **14.2 ms inference inside the 42 ms budget, and a documented failure path that
does not lock anyone out.**

---

## Threat model

| Attack | Mitigation | Residual |
|---|---|---|
| Replay a captured frame | 30 s epoch, ±150 ms RTC window, 16 B nonce bloom, nullifier burn | Attacker with the frame *and* sub-150 ms latency inside the same epoch. UWB ranging closes this in P1. |
| BLE relay (attacker near door, credential far away) | RSSI/ToF divergence feature, `SPOOF_SPATIAL` class | Degraded mode drops this check — accepted, documented. |
| Gateway key compromise | Per-day rotation, lock pins a root, audit re-verification offline | 24 h window. |
| Wallet drains its own reputation to a fresh key | Attestations are issuer-bound and non-transferable; transfer features are capped at 0.08 | Sybil with genuine governance participation. Cost is the point. |
| Physical: cut the solenoid line | Reed sensor reports forced-open to the audit ring | A determined attacker with a drill. Out of scope. |
| Model poisoning via crafted on-chain history | Features are capped individually; attestation weight requires an issuer signature | — |
| Firmware parser | `frame_parse()` fuzzed; fixed-size struct, no heap allocation in the parse path | — |

---

## Repository layout

```
app/
  layout.tsx           wallet provider mount
  page.tsx             three-pane operator view, credential inspector
  globals.css          zinc tokens, wallet-adapter overrides
components/
  WalletProvider.tsx   ConnectionProvider + Wallet Standard discovery
  WalletAuth.tsx       signer attach, devnet balance + signatures, session challenge
  GraphVisualizer.tsx  canvas force layout, fit transform, feature aggregation, tier readout
  HardwareTerminal.tsx UART0 transcript: boot, grant, spoof, degraded
utils/
  zkPayload.ts         BN254 field math, Poseidon stub, Groth16 shape, CRC, wire frame
```

Three details in here are load-bearing and easy to undo by accident:

- **`min-w-0` on every grid and flex rung of the three-column layout.** Grid items
  default to `min-width: auto`, so the hexdump's `whitespace-pre` sizes the 340 px track
  by its widest line and the panel physically overlaps the centre column. Drop a
  `min-w-0` and the inspector's tabs end up underneath the canvas.
- **`hold` in `HardwareTerminal` is the delay *before* a line, not after it.** With it
  trailing, `GPIO_PIN_4 -> LOW` printed ~64 ms after the HIGH whatever the door's dwell
  was, so the relay chip flickered through `HIGH` inside one frame.
- **`RECENCY_SKEW` in `GraphVisualizer`.** See the Context Tier section; a uniform event
  age draw puts 96.6% of wallets under Tier 2 and the lab door never opens.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run lint
```

857 packages. `@solana/wallet-adapter-wallets` is deliberately **not** a dependency:
it is a meta-package that pulls Ledger, Torus and WalletConnect transitively — 702
extra packages, 44% of the tree — and nothing imports it, because wallets are
discovered through the Wallet Standard. `components/WalletProvider.tsx` says what to
add if a legacy-only adapter is ever needed.

No `.env` is required. Set `NEXT_PUBLIC_RPC_ENDPOINT` to point at a private devnet RPC;
without it the app uses `clusterApiUrl('devnet')`, which rate-limits and will fall back to
synthetic history — the wallet panel says so explicitly when it does.

**Without a wallet extension**, use `simulate signer` in the wallet panel. It attaches a
pubkey-derived identity so the graph, the credential and the relay path are all
reachable on a clean machine; it holds no key material, never calls the RPC, cannot
sign, and every panel that consumes it reports `simulated` rather than pretending to be
a wallet. `next sim signer` walks eight fixed identities — slots 3–5 land on Tier 2,
slot 6 on Tier 1, which is the fastest way to see both the grant and the
`DENY reason=TIER_INSUFFICIENT` paths. A real adapter connection always takes
precedence over it.

Three buttons drive the device pane:

| Button | Path |
|---|---|
| `submit pass` | Full admission. Grants if `tier ≥ min_tier`, otherwise `DENY_TIER`. |
| `inject spoof` | 412 ms RTC skew + RSSI/ToF divergence → `SPOOF_SPATIAL`, relay stays shut, nullifier preserved. |
| `fault: tflm arena` | `kTfLiteError` on `AllocateTensors()` → `ED25519_ONLY` fallback, still admits. |

### What is real and what is not

| Component | Status |
|---|---|
| Wallet attach, `getBalance`, `getSignaturesForAddress`, `signMessage` | Real. Live devnet calls with a 4 s timeout. |
| Transaction history for an empty devnet account | Synthetic, pubkey-seeded, flagged in the UI. |
| Simulated signer | Not a wallet. No key material, no RPC, cannot sign. Labelled everywhere it appears. |
| Force layout, feature aggregation, tier thresholds | Real implementation of the deployed logic. |
| Groth16 proof | Correct shape, correct fields, **not on the curve**. `groth16Proof()` is the single swap point for snarkjs. |
| Poseidon | `poseidonSim()` — an x⁵ sponge over Fr with derived round constants. Not circomlib's permutation. |
| CRC-16, base58, BN254 reduction, wire frame | Real. The CRC in the inspector is the CRC the simulator prints. |
| ESP32 transcript | Replayed from captured device output; timings match the latency table. |

Everything synthetic is derived from a seeded xorshift32 keyed on the wallet pubkey, so a
given wallet produces byte-identical output on every load. There is no `Math.random()` in
the codebase — the inspector's hexdump and the firmware log's CRC would not agree if there
were.

---

## Known gaps

- Proof generation is not wired to snarkjs; the 1.21 s figure is measured on the real
  circuit but nothing in this repo produces it.
- The graph classifier's message-passing half is not here — only the readout.
- No test suite. `npm run typecheck` and `npm run lint` are the only gates; the frame
  layout, CRC and tier distribution were verified out-of-band rather than in CI, which
  is exactly the kind of thing that should be a test file.
- BLE is simulated end to end; the browser side would need Web Bluetooth and a Chromium
  target, which rules out iOS Safari and is why the gateway is HTTPS rather than direct.

'use client';

import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider as AdapterProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import type { Adapter } from '@solana/wallet-adapter-base';
import { clusterApiUrl } from '@solana/web3.js';

import '@solana/wallet-adapter-react-ui/styles.css';

export const CLUSTER = 'devnet' as const;

/**
 * Wallets are discovered through the Wallet Standard (`window.navigator.wallets`),
 * which every current Solana wallet registers into. Hard-coding adapters from
 * `@solana/wallet-adapter-wallets` would double-list Phantom/Solflare/Backpack,
 * so the array stays empty on purpose and that package is not a dependency —
 * it is a meta-package that pulls Ledger, Torus and WalletConnect transitively
 * and costs 702 of the 1,595 packages in the tree for code nothing imports.
 *
 * Legacy-only wallets that never registered with the Wallet Standard (Ledger
 * over HID is the one that still matters) need an explicit adapter. Add
 * `@solana/wallet-adapter-ledger` — the single package, not the meta-package —
 * and push `new LedgerWalletAdapter()` into the array below.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(
    () => process.env.NEXT_PUBLIC_RPC_ENDPOINT ?? clusterApiUrl(CLUSTER),
    [],
  );
  const wallets = useMemo<Adapter[]>(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <AdapterProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </AdapterProvider>
    </ConnectionProvider>
  );
}

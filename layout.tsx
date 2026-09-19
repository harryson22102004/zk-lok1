import type { Metadata, Viewport } from 'next';
import './globals.css';
import { WalletProvider } from '@/components/WalletProvider';

export const metadata: Metadata = {
  title: 'ZK-LOK // Transient Network State OS',
  description:
    'Groth16 access credentials bridged from Solana to an ESP32-S3 relay controller with on-device TFLite Micro anomaly gating.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-zinc-950 font-mono text-zinc-200 antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}

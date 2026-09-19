/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The wallet-adapter dependency tree pulls Node-only transports through
  // `cross-fetch` / `node-fetch`. Webpack resolves them at build time even
  // though they are unreachable in the browser bundle; stubbing avoids the
  // "Module not found: fs" class of failure without shipping polyfills.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
      };
    }
    // Optional peer deps of pino (transitive via @solana/web3.js logging).
    config.externals.push('pino-pretty', 'encoding', 'bufferutil', 'utf-8-validate');
    return config;
  },
};

export default nextConfig;

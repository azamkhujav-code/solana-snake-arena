import bundleAnalyzer from '@next/bundle-analyzer';
import type { NextConfig } from 'next';

const withBundleAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === 'true' });

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Emits a minimal server bundle so the runtime image stays small.
  output: 'standalone',

  // @arena/ui ships TypeScript source rather than a build step; the rest of the
  // workspace packages ship compiled dist and do not need transpiling.
  transpilePackages: ['@arena/ui'],

  experimental: {
    optimizePackageImports: ['@arena/ui', '@tanstack/react-query'],
  },

  eslint: {
    // Linting is a separate CI job; running it again here doubles build time.
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },

  webpack: (webpackConfig) => {
    // Some Solana dependencies still reference Node core modules; there is no
    // browser equivalent and nothing in our path calls them.
    webpackConfig.resolve.fallback = {
      ...webpackConfig.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return webpackConfig;
  },
};

export default withBundleAnalyzer(nextConfig);

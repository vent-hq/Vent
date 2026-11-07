import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/backend/:path*",
        destination: "https://api.venthq.dev/:path*",
      },
    ];
  },
};

export default nextConfig;

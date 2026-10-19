import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "ioredis"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;

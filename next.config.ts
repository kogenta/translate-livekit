import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@livekit/rtc-node", "ws"],
  // LiveKitRoom's connect/disconnect lifecycle isn't idempotent under Strict
  // Mode's dev-only double-invoke of effects — mounting, unmounting, and
  // remounting in quick succession races a connect against an in-flight
  // leave and logs "Received leave request while trying to (re)connect".
  // "local-origin.dev",
  // "*.local-origin.dev",
  reactStrictMode: false,
  allowedDevOrigins: ["192.168.201.153"],
};

export default nextConfig;

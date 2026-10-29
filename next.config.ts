import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its binary path at runtime; keep it out of the bundle.
  serverExternalPackages: ["ffmpeg-static"],
  // Ship the ffmpeg binary and the Comfy workflow with the serverless functions on Vercel.
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/ffmpeg-static/ffmpeg", "./workflows/*.json"],
  },
};

export default nextConfig;

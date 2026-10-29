import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its binary path at runtime; keep it out of the bundle.
  serverExternalPackages: ["ffmpeg-static"],
  // Make sure the ffmpeg binary is shipped with the serverless functions on Vercel.
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;

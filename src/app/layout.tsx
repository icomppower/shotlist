import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shotlist",
  description: "Open-source AI shot-list studio: one image, a list of director moves, one stitched video. Powered by LTX on the Comfy Developer Platform.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d0d0f" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

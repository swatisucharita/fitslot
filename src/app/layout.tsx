import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "FitSlot",
  description: "Demo booking app for small fitness studios",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

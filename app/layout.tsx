import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Label Verification",
  description: "QA label-to-part QR verification",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

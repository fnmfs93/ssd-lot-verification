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
      <head>
        {/*
          Defensive polyfill for browsers older than the feature it shims.
          Object.hasOwn (Chrome 93+) is called unconditionally by Next.js's
          own internal runtime (its searchParams proxy handling), and this
          app needs to keep working on an older embedded Chromium (Chrome
          84, an industrial handheld's built-in browser) that predates it.
          Placed here, un-deferred, so it runs before any other script on
          the page — including Next's earliest framework chunks.
        */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html:
              "if(typeof Object.hasOwn!=='function'){Object.hasOwn=function(o,p){return Object.prototype.hasOwnProperty.call(o,p);};}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

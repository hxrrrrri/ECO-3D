import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ECO-3D | Architecting the Future of Earth",
  description:
    "AI-powered spatial intelligence to optimize sustainable land development across the globe.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      </head>
      <body className="bg-background-dark text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}

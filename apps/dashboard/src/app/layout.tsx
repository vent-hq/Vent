import type { Metadata } from "next";
import { Inter, DM_Serif_Display, Space_Grotesk } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });
const dmSerif = DM_Serif_Display({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const spaceGrotesk = Space_Grotesk({ weight: ["300", "400", "600"], subsets: ["latin"], variable: "--font-heading" });

export const metadata: Metadata = {
  title: "Vent",
  description: "CI/CD testing for voice AI agents. Test from your coding agent via the Vent CLI.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} ${dmSerif.variable} ${spaceGrotesk.variable} antialiased bg-background`}>
        <div className="min-h-screen bg-background">
          <main>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

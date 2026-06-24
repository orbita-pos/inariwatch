import { InitCapture } from "./init-capture";

export const metadata = {
  title: "Inari Visual Report — Demo",
  description: "Test the @inariwatch/capture visual-report integration end-to-end.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{
        margin: 0,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        background: "#0a0a0c",
        color: "#ECE8DF",
        minHeight: "100vh",
      }}>
        <InitCapture />
        {children}
      </body>
    </html>
  );
}

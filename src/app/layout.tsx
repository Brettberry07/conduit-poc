import "./style.css";
export const metadata = {
  title: "Orchestrator POC",
  description: "Simulated task queue",
  icons: { icon: "/icon.svg" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

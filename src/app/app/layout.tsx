import { Suspense } from "react";
import { Shell } from "../../gui/client";
import "./gui.css";
export const metadata = { title: "Conduit / Work console" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div
          className="console"
          aria-busy="true"
          aria-label="Loading console"
        />
      }
    >
      <Shell>{children}</Shell>
    </Suspense>
  );
}

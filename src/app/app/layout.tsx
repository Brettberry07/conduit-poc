import { Shell } from "../../gui/client";
import "./gui.css";
export const metadata = { title: "Conduit · Work console" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}

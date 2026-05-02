import VerifyPage from "../../page";

// Sesión 29 — `/verify/r/<base64>` shareable URL route. The client
// component on `/verify` reads the segment off `window.location.pathname`
// at hydration and decodes the receipt JSON; this dynamic route exists
// only so Next.js doesn't 404 the URL before that handoff. Server
// renders the same shell as `/verify` — empty state with the drop zone
// + paste box. The segment never leaves the client.
export default function VerifyShareablePage() {
  return <VerifyPage />;
}

/**
 * Demo page for the visual-report integration. Renders a few intentionally
 * "buggy-looking" UI elements so when you click the report button, the
 * captured screenshot has something interesting to analyse.
 *
 * The actual feature surface is the floating button in the bottom-right
 * corner (injected by visualReportIntegration's setup). The page content
 * is just visual fodder for the AI to look at.
 */

export default function Page() {
  return (
    <main style={{
      maxWidth: 760,
      margin: "0 auto",
      padding: "64px 24px",
      lineHeight: 1.5,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 8 }}>
        Visual report demo
      </h1>
      <p style={{ color: "#888690", marginBottom: 32 }}>
        Click the floating <strong style={{ color: "#D8A66E" }}>Report visual bug</strong> button
        in the bottom-right corner. The widget will:
      </p>

      <ol style={{ color: "#B5B2AB", fontSize: 14, marginBottom: 40 }}>
        <li>Prompt for a description of what looks wrong.</li>
        <li>Ask permission to capture the screen (browser-native dialog).</li>
        <li>Bundle DOM + console + network + perf + screenshot.</li>
        <li>POST to <code style={{ color: "#9CC3E8" }}>/api/capture/user-report/[projectId]</code>.</li>
        <li>Inari runs the diagnosis pipeline (Qwen3.5-397B-A17B) and ships a structured root-cause.</li>
        <li>Open Inari Live desktop → press <kbd>Cmd+\</kbd> on the new alert → see the diagnosis.</li>
      </ol>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 32 }}>
        Things to try reporting (intentionally weird UI below):
      </h2>

      {/* Misaligned button */}
      <section style={{ marginTop: 24, padding: 16, border: "1px solid #1a1a20", borderRadius: 8 }}>
        <h3 style={{ fontSize: 14, color: "#D3D0CA", marginBottom: 12 }}>
          1. Submit button floating outside its container
        </h3>
        <div style={{
          position: "relative",
          padding: 24,
          background: "#13131a",
          borderRadius: 4,
          minHeight: 80,
        }}>
          <p style={{ color: "#888690", fontSize: 13 }}>Form goes here.</p>
          <button style={{
            position: "absolute",
            top: -8,
            right: -32,
            background: "#D8A66E",
            color: "#0a0a0c",
            padding: "6px 14px",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}>
            Submit (broken)
          </button>
        </div>
      </section>

      {/* Inconsistent state */}
      <section style={{ marginTop: 16, padding: 16, border: "1px solid #1a1a20", borderRadius: 8 }}>
        <h3 style={{ fontSize: 14, color: "#D3D0CA", marginBottom: 12 }}>
          2. Counter shows mismatched values
        </h3>
        <div style={{
          padding: 16,
          background: "#13131a",
          borderRadius: 4,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}>
          <span style={{
            background: "#9CC3E8",
            color: "#0a0a0c",
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
          }}>3 items</span>
          <ul style={{ margin: 0, paddingLeft: 20, color: "#B5B2AB", fontSize: 13 }}>
            <li>Item A</li>
            <li>Item B</li>
            <li>Item C</li>
            <li>Item D</li>
            <li>Item E</li>
          </ul>
        </div>
      </section>

      {/* Modal that won't close */}
      <section style={{ marginTop: 16, padding: 16, border: "1px solid #1a1a20", borderRadius: 8 }}>
        <h3 style={{ fontSize: 14, color: "#D3D0CA", marginBottom: 12 }}>
          3. Pretend modal stuck in the corner
        </h3>
        <div style={{
          position: "fixed",
          top: 200,
          right: 24,
          background: "#1a1a20",
          padding: 16,
          border: "1px solid #2a2a30",
          borderRadius: 8,
          maxWidth: 240,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          zIndex: 10,
        }}>
          <div style={{ fontSize: 13, color: "#ECE8DF", marginBottom: 8 }}>
            <strong>Stuck modal</strong>
          </div>
          <p style={{ fontSize: 12, color: "#888690", margin: 0 }}>
            Clicking the X doesn't close this. Try reporting it.
          </p>
          <button style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "transparent",
            color: "#888690",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
          }}>✕</button>
        </div>
      </section>

      <p style={{ color: "#56565e", fontSize: 12, marginTop: 80 }}>
        Open DevTools console for capture init logs and upload acknowledgements.
      </p>
    </main>
  );
}

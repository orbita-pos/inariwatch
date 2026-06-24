import * as vscode from "vscode"
import type { ApiConfig } from "./types.js"

interface PredictionItem {
  error: string
  file: string
  line: number
  confidence: number
  reason: string
  suggestedFix: string
}

interface PredictionResponse {
  result: {
    predictions: PredictionItem[]
    overallRisk: string
    summary: string
  }
}

const predictionDiagnostics = vscode.languages.createDiagnosticCollection("inariwatch-prediction")

/**
 * Check for predictions when a file is saved.
 * Shows warning diagnostics on lines predicted to break.
 */
export function registerPredictionProvider(
  context: vscode.ExtensionContext,
  getApiConfig: () => Promise<ApiConfig | null>,
): void {
  // Listen for file saves — check for predictions
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const config = await getApiConfig()
      if (!config) return

      // Only check files in the workspace
      if (doc.uri.scheme !== "file") return

      await checkFilePredictions(doc, config)
    }),
  )

  context.subscriptions.push({ dispose: () => predictionDiagnostics.dispose() })
}

async function checkFilePredictions(
  doc: vscode.TextDocument,
  config: ApiConfig,
): Promise<void> {
  try {
    // Get git diff for the current file
    const relativePath = vscode.workspace.asRelativePath(doc.uri)

    // Fetch predictions from InariWatch API
    const res = await fetch(`${config.baseUrl}/api/prediction/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: relativePath }),
    })

    if (!res.ok) return

    const data = (await res.json()) as PredictionResponse
    if (!data?.result?.predictions?.length) {
      predictionDiagnostics.delete(doc.uri)
      return
    }

    // Create diagnostics for predicted errors
    const diagnostics: vscode.Diagnostic[] = []

    for (const pred of data.result.predictions) {
      // Match predictions to this file
      if (!relativePath.includes(pred.file) && !pred.file.includes(relativePath)) continue

      const line = Math.max(0, pred.line - 1)
      const range = new vscode.Range(line, 0, line, 200)

      const diagnostic = new vscode.Diagnostic(
        range,
        `Prediction: ${pred.error} (${pred.confidence}% confidence)\n${pred.reason}`,
        pred.confidence >= 80
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information,
      )
      diagnostic.source = "InariWatch Prediction"
      diagnostic.code = pred.suggestedFix ? { value: "fix-available", target: doc.uri } : undefined

      diagnostics.push(diagnostic)
    }

    predictionDiagnostics.set(doc.uri, diagnostics)
  } catch {
    // Non-blocking
  }
}

import * as vscode from "vscode"

const TOKEN_KEY = "inariwatch.apiToken"

let secrets: vscode.SecretStorage

export function initAuth(context: vscode.ExtensionContext) {
  secrets = context.secrets
}

export async function getToken(): Promise<string | undefined> {
  return secrets.get(TOKEN_KEY)
}

export async function setToken(token: string): Promise<void> {
  await secrets.store(TOKEN_KEY, token)
}

export async function deleteToken(): Promise<void> {
  await secrets.delete(TOKEN_KEY)
}

export async function promptForToken(): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    prompt: "Enter your InariWatch API token",
    placeHolder: "Paste token from app.inariwatch.com → Settings → API Keys",
    password: true,
    ignoreFocusOut: true,
  })

  if (token) {
    await setToken(token)
  }
  return token
}

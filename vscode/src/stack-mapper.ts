import * as vscode from "vscode"
import type { AlertLocation } from "./types.js"

/** Common deployment path prefixes to strip */
const DEPLOY_PREFIXES = [
  "/app/", "/var/task/", "/opt/", "/home/runner/work/",
  "/vercel/path0/", "/vercel/path1/",
  ".next/server/app/", ".next/server/",
]

/** Extract file:line locations from a Node.js stack trace */
const STACK_FRAME_RE = /at\s+(?:.+?\s+)?\(?((?:\/|[A-Za-z]:)[^:)]+):(\d+)(?::(\d+))?\)?/g

export async function mapStackToWorkspace(body: string): Promise<AlertLocation[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) return []

  const frames = parseStackFrames(body)
  const locations: AlertLocation[] = []

  for (const frame of frames) {
    const resolved = await resolveToWorkspace(frame, workspaceFolders)
    if (resolved) {
      locations.push(resolved)
    }
  }

  return locations
}

interface RawFrame {
  path: string
  line: number
  column: number
  raw: string
}

function parseStackFrames(body: string): RawFrame[] {
  const frames: RawFrame[] = []
  let match: RegExpExecArray | null

  STACK_FRAME_RE.lastIndex = 0
  while ((match = STACK_FRAME_RE.exec(body)) !== null) {
    const path = match[1]
    // Skip node_modules and internal frames
    if (path.includes("node_modules") || path.includes("node:")) continue

    frames.push({
      path,
      line: parseInt(match[2], 10),
      column: parseInt(match[3] || "1", 10),
      raw: match[0],
    })
  }

  return frames
}

async function resolveToWorkspace(
  frame: RawFrame,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<AlertLocation | null> {
  // Try stripping deploy prefixes
  for (const prefix of DEPLOY_PREFIXES) {
    const idx = frame.path.indexOf(prefix)
    if (idx !== -1) {
      const relative = frame.path.slice(idx + prefix.length)
      const found = await findInWorkspace(relative, folders)
      if (found) {
        return { filePath: found, line: frame.line, column: frame.column, frame: frame.raw }
      }
    }
  }

  // Try using the path as-is (might be relative already)
  const found = await findInWorkspace(frame.path, folders)
  if (found) {
    return { filePath: found, line: frame.line, column: frame.column, frame: frame.raw }
  }

  // Fuzzy fallback: match by filename + parent directory
  const parts = frame.path.replace(/\\/g, "/").split("/")
  if (parts.length >= 2) {
    const fuzzyPattern = `**/${parts.slice(-2).join("/")}`
    const matches = await vscode.workspace.findFiles(fuzzyPattern, "**/node_modules/**", 1)
    if (matches.length > 0) {
      // Verify resolved path is inside a workspace folder
      const resolved = matches[0].fsPath
      const inWorkspace = folders.some((f) => resolved.startsWith(f.uri.fsPath))
      if (inWorkspace) {
        return {
          filePath: resolved,
          line: frame.line,
          column: frame.column,
          frame: frame.raw,
        }
      }
    }
  }

  return null
}

async function findInWorkspace(
  relative: string,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<string | null> {
  const normalized = relative.replace(/\\/g, "/")

  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, normalized)
    try {
      await vscode.workspace.fs.stat(uri)
      return uri.fsPath
    } catch {
      // file doesn't exist in this folder
    }
  }

  // Try without leading src/ or app/ prefix
  for (const strip of ["src/", "app/"]) {
    if (normalized.startsWith(strip)) {
      const stripped = normalized.slice(strip.length)
      for (const folder of folders) {
        const uri = vscode.Uri.joinPath(folder.uri, stripped)
        try {
          await vscode.workspace.fs.stat(uri)
          return uri.fsPath
        } catch {
          // continue
        }
      }
    }
  }

  return null
}

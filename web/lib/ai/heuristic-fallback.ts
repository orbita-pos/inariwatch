/**
 * Heuristic fallback for auto-analyze when all AI providers are unavailable.
 *
 * Returns a basic diagnosis using regex pattern matching on the error title
 * and body. No AI call needed — pure string matching.
 *
 * Quality: ~60% as good as AI analysis. Good enough for dashboard display
 * while waiting for providers to recover.
 */

interface HeuristicDiagnosis {
  reasoning: string;
  source: "heuristic";
}

const PATTERNS: { pattern: RegExp; reasoning: string }[] = [
  {
    pattern: /Cannot read propert(?:y|ies) of (?:null|undefined).*(?:reading '(\w+)')?/i,
    reasoning: "Null/undefined reference error. A variable expected to hold an object is null or undefined. Check the call stack to find where the value should be initialized — likely a missing database result, API response, or uninitialized state.",
  },
  {
    pattern: /TypeError:.*is not a function/i,
    reasoning: "Calling a value that is not a function. Common causes: wrong import (default vs named), accessing a method on the wrong type, or a dependency version mismatch where the API changed.",
  },
  {
    pattern: /ReferenceError:\s*(\w+) is not defined/i,
    reasoning: "Accessing a variable that doesn't exist in the current scope. Usually a missing import statement or a typo in the variable name.",
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,
    reasoning: "Network connection failure. The application couldn't reach an external service (database, API, cache). Check if the target service is running and the connection string/URL is correct.",
  },
  {
    pattern: /ENOMEM|out of memory|heap.*exceeded|JavaScript heap/i,
    reasoning: "Memory limit exceeded. The process ran out of available memory. Look for: unbounded data loading, memory leaks in long-running processes, or large file processing without streaming.",
  },
  {
    pattern: /Module not found|Cannot find module/i,
    reasoning: "Missing module or wrong import path. Either a dependency is not installed (run npm install) or the import path has a typo. Check package.json and the import statement.",
  },
  {
    pattern: /ENOENT.*no such file or directory/i,
    reasoning: "File or directory not found. The code is trying to access a path that doesn't exist. Check for: hardcoded paths, missing build artifacts, or environment-specific file locations.",
  },
  {
    pattern: /syntax error|Unexpected token|SyntaxError/i,
    reasoning: "Syntax error in code or configuration. The parser found invalid syntax. Check for: unclosed brackets, missing commas, invalid JSON, or incompatible language features.",
  },
  {
    pattern: /403|Forbidden|Access Denied|Unauthorized|401/i,
    reasoning: "Authentication or authorization failure. The request was rejected due to missing or invalid credentials. Check API keys, tokens, IAM roles, or CORS configuration.",
  },
  {
    pattern: /429|Too Many Requests|rate.limit/i,
    reasoning: "Rate limit exceeded. The service is rejecting requests due to too many calls in a short period. Implement backoff/retry logic or request a higher rate limit.",
  },
  {
    pattern: /deadlock|lock wait timeout/i,
    reasoning: "Database deadlock or lock contention. Two or more transactions are waiting on each other. Review the transaction isolation level and query order to prevent circular waits.",
  },
  {
    pattern: /duplicate key|unique.*violation|already exists/i,
    reasoning: "Duplicate key constraint violation. An insert or update tried to create a record that conflicts with a unique index. Add an upsert (ON CONFLICT) or check-before-insert pattern.",
  },
];

export function heuristicAnalyze(title: string, body: string): HeuristicDiagnosis | null {
  const text = `${title}\n${body}`;

  for (const { pattern, reasoning } of PATTERNS) {
    if (pattern.test(text)) {
      return { reasoning, source: "heuristic" };
    }
  }

  return null;
}

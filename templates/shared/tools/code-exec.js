#!/usr/bin/env node
/**
 * Code Execution Tool
 *
 * Execute code snippets in a sandboxed subprocess.
 * Supports: JavaScript (Node.js), Python, Bash.
 * Security: timeout, output limits, temp directory cleanup.
 */
"use strict";

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 10 * 1024;

const definition = {
  type: "function",
  function: {
    name: "execute_code",
    description:
      "Execute a code snippet and return stdout/stderr output. " +
      "Supports JavaScript (Node.js), Python, and Bash. " +
      "Code runs in a sandboxed subprocess with a 30-second timeout.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The code to execute",
        },
        language: {
          type: "string",
          enum: ["javascript", "python", "bash"],
          description: "Programming language (default: javascript)",
        },
      },
      required: ["code"],
    },
  },
};

function isAvailable(env) {
  if (env.ENABLE_CODE_EXEC === "false" || env.ENABLE_CODE_EXEC === "0") {
    return false;
  }
  return env.ENABLE_CODE_EXEC === "true" || env.ENABLE_CODE_EXEC === "1";
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n...(output truncated at 10KB)";
}

function resolveRuntime(language) {
  switch (language) {
    case "python":
      return { cmd: "python3", ext: ".py" };
    case "bash":
      return { cmd: "bash", ext: ".sh" };
    case "javascript":
    default:
      return { cmd: "node", ext: ".js" };
  }
}

async function execute(_name, args, _context) {
  const code = (args.code || "").trim();
  if (!code) return { error: "code is required" };

  const language = args.language || "javascript";
  if (!["javascript", "python", "bash"].includes(language)) {
    return { error: `Unsupported language: ${language}. Use javascript, python, or bash.` };
  }

  const runtime = resolveRuntime(language);
  const tmpId = crypto.randomBytes(8).toString("hex");
  const tmpDir = path.join(os.tmpdir(), `1claw-exec-${tmpId}`);
  const tmpFile = path.join(tmpDir, `script${runtime.ext}`);

  try {
    fs.mkdirSync(tmpDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(tmpFile, code, { mode: 0o600 });

    const result = await new Promise((resolve) => {
      const proc = spawn(runtime.cmd, [tmpFile], {
        cwd: tmpDir,
        timeout: TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          HOME: tmpDir,
          TMPDIR: tmpDir,
          LANG: "en_US.UTF-8",
          NODE_OPTIONS: "--max-old-space-size=128",
        },
        stdio: ["ignore", "pipe", "pipe"],
        uid: process.getuid ? process.getuid() : undefined,
      });

      let stdout = "";
      let stderr = "";
      let stdoutLen = 0;
      let stderrLen = 0;

      proc.stdout.on("data", (chunk) => {
        if (stdoutLen < MAX_OUTPUT_BYTES) {
          stdout += chunk.toString("utf8");
          stdoutLen += chunk.length;
        }
      });

      proc.stderr.on("data", (chunk) => {
        if (stderrLen < MAX_OUTPUT_BYTES) {
          stderr += chunk.toString("utf8");
          stderrLen += chunk.length;
        }
      });

      proc.on("close", (exitCode, signal) => {
        resolve({
          exit_code: exitCode,
          signal: signal || null,
          stdout: truncate(stdout, MAX_OUTPUT_BYTES),
          stderr: truncate(stderr, MAX_OUTPUT_BYTES),
          timed_out: false,
        });
      });

      proc.on("error", (err) => {
        if (err.code === "ETIMEDOUT" || err.killed) {
          resolve({
            exit_code: null,
            signal: "SIGTERM",
            stdout: truncate(stdout, MAX_OUTPUT_BYTES),
            stderr: truncate(stderr, MAX_OUTPUT_BYTES),
            timed_out: true,
            error: "Execution timed out after 30 seconds",
          });
        } else {
          resolve({
            exit_code: null,
            signal: null,
            stdout: "",
            stderr: "",
            timed_out: false,
            error: `Process error: ${err.message}`,
          });
        }
      });
    });

    return { ...result, language };
  } catch (e) {
    return { error: `Code execution setup failed: ${e.message}`, language };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  }
}

module.exports = {
  definition,
  definitions: [definition],
  isAvailable,
  execute,
};

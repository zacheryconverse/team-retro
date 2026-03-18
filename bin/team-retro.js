#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const pkg = require("../package.json");

const ROOT_DIR = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT_DIR, "server.js");
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const SESSION_BASE_DIR = path.join(os.tmpdir(), "team-retro-sessions");

function printUsage() {
  console.log(`team-retro v${pkg.version}

Usage:
  team-retro [--local-only] [--no-open] [--port <port>] [--host <host>]

Options:
  --local-only   Skip the temporary public tunnel
  --no-open      Do not open the board in a local browser
  --port <port>  Use a specific local port
  --host <host>  Bind the HTTP server to a specific host
  --help         Show this help text
  --version      Print the current package version`);
}

function parseArgs(argv) {
  const options = {
    host: process.env.RETRO_HOST || DEFAULT_HOST,
    port: process.env.RETRO_PORT ? Number(process.env.RETRO_PORT) : null,
    localOnly: process.env.LOCAL_ONLY === "1",
    noOpen: process.env.NO_OPEN === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--local-only") {
      options.localOnly = true;
      continue;
    }

    if (arg === "--no-open") {
      options.noOpen = true;
      continue;
    }

    if (arg === "--host") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --host.");
      }
      options.host = value;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error("Port must be an integer between 1 and 65535.");
      }
      options.port = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      options.version = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.port !== null && (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535)) {
    throw new Error("Port must be an integer between 1 and 65535.");
  }

  return options;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function portIsAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findFreePort(startPort, host) {
  let port = startPort;
  while (!(await portIsAvailable(port, host))) {
    port += 1;
  }
  return port;
}

async function pruneStaleSessions(baseDir) {
  await fsp.mkdir(baseDir, { recursive: true });
  const entries = await fsp.readdir(baseDir, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const entryPath = path.join(baseDir, entry.name);
        try {
          const stats = await fsp.stat(entryPath);
          if (now - stats.mtimeMs > SESSION_RETENTION_MS) {
            await fsp.rm(entryPath, { recursive: true, force: true });
          }
        } catch (_error) {
          // Ignore stale cleanup failures.
        }
      }),
  );
}

async function createRuntimeDir(baseDir) {
  const sessionId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const runtimeDir = path.join(baseDir, sessionId);
  await fsp.mkdir(runtimeDir, { recursive: true });
  return runtimeDir;
}

async function waitForHealth(localUrl, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${localUrl}/health`, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // Keep polling until the timeout.
    }

    await delay(1000);
  }

  throw new Error(`Server failed to start. Timed out waiting for ${localUrl}/health`);
}

function pipeToLog(stream, logStream, onText) {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logStream.write(text);
    onText(text);
  });
}

async function startServer({ runtimeDir, host, port, serverLogPath }) {
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      RETRO_DATA_DIR: runtimeDir,
      RETRO_HOST: host,
      RETRO_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  pipeToLog(child.stdout, serverLogStream, () => {});
  pipeToLog(child.stderr, serverLogStream, () => {});

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
    return { child, logStream: serverLogStream };
  } catch (error) {
    child.kill("SIGTERM");
    serverLogStream.end();
    throw error;
  }
}

function extractShareUrl(text) {
  const matches = text.match(/https:\/\/[^\s]+/g) || [];
  return matches.find((value) => !value.includes("/docs/")) || null;
}

async function startTunnel({ command, args, logPath }) {
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      logStream.end();
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      reject(error);
    };

    const finishResolve = (url) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve({ child, logStream, url });
    };

    const onText = (text) => {
      const shareUrl = extractShareUrl(text);
      if (shareUrl) {
        finishResolve(shareUrl);
      }
    };

    pipeToLog(child.stdout, logStream, onText);
    pipeToLog(child.stderr, logStream, onText);

    child.once("error", (error) => {
      finishReject(error);
    });

    child.once("exit", (code, signal) => {
      if (!settled) {
        finishReject(new Error(`${command} exited before a public URL was ready (code: ${code ?? "null"}, signal: ${signal ?? "none"})`));
      }
    });

    const timeoutId = setTimeout(() => {
      finishReject(new Error(`Timed out waiting for ${command} to produce a public URL.`));
    }, 60000);
  });
}

async function writeShareUrl(filePath, value) {
  if (!value) {
    await fsp.rm(filePath, { force: true });
    return;
  }

  await fsp.writeFile(filePath, value, "utf8");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function removeRuntimeDir(runtimeDir) {
  if (!runtimeDir) {
    return;
  }
  await fsp.rm(runtimeDir, { recursive: true, force: true });
}

function trySpawn(command, args, options = {}) {
  return spawn(command, args, {
    stdio: options.stdio || ["ignore", "ignore", "ignore"],
    detached: false,
    windowsHide: true,
  });
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      const child = trySpawn("open", [url]);
      child.once("error", () => {});
      return;
    }

    if (process.platform === "win32") {
      const child = trySpawn("cmd", ["/c", "start", "", url]);
      child.once("error", () => {});
      return;
    }

    const child = trySpawn("xdg-open", [url]);
    child.once("error", () => {});
  } catch (_error) {
    // Ignore browser-open failures.
  }
}

function copyToClipboard(value) {
  const candidates =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];

  for (const [command, args] of candidates) {
    try {
      const result = spawnSync(command, args, {
        input: value,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });

      if (!result.error && result.status === 0) {
        return true;
      }
    } catch (_error) {
      // Try the next clipboard command.
    }
  }

  return false;
}

function printHeader(localUrl, runtimeDir) {
  console.log("");
  console.log("Team Retro");
  console.log("==========");
  console.log(`Local URL: ${localUrl}`);
  console.log(`Session: ${runtimeDir}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (options.version) {
    console.log(pkg.version);
    return;
  }

  await pruneStaleSessions(SESSION_BASE_DIR);

  const port =
    options.port !== null
      ? options.port
      : await findFreePort(DEFAULT_PORT, options.host);

  if (options.port !== null && !(await portIsAvailable(port, options.host))) {
    throw new Error(`Port ${port} is already in use. Pick another port or stop the other process.`);
  }

  const runtimeDir = await createRuntimeDir(SESSION_BASE_DIR);
  const serverLogPath = path.join(runtimeDir, "server.log");
  const tunnelLogPath = path.join(runtimeDir, "tunnel.log");
  const shareUrlPath = path.join(runtimeDir, "share-url.txt");
  const localUrl = `http://127.0.0.1:${port}`;

  let keepRuntimeDir = false;
  let shuttingDown = false;
  let serverProcess;
  let tunnelProcess;
  let serverLogStream;
  let tunnelLogStream;

  const cleanup = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    await Promise.allSettled([stopChild(tunnelProcess), stopChild(serverProcess)]);
    serverLogStream?.end();
    tunnelLogStream?.end();

    if (!keepRuntimeDir) {
      await removeRuntimeDir(runtimeDir);
    }

    process.exit(exitCode);
  };

  process.once("SIGINT", () => {
    void cleanup(0);
  });
  process.once("SIGTERM", () => {
    void cleanup(0);
  });

  try {
    const server = await startServer({
      runtimeDir,
      host: options.host,
      port,
      serverLogPath,
    });
    serverProcess = server.child;
    serverLogStream = server.logStream;

    serverProcess.once("exit", () => {
      if (!shuttingDown) {
        keepRuntimeDir = true;
        console.error(`Server exited unexpectedly. Check ${serverLogPath}`);
        void cleanup(1);
      }
    });

    await writeShareUrl(shareUrlPath, "");
    printHeader(localUrl, runtimeDir);

    if (!options.noOpen) {
      openBrowser(localUrl);
    }

    if (!options.localOnly) {
      console.log("Creating temporary public URL...");

      const tunnelCandidates = [
        {
          command: "ssh",
          args: [
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "LogLevel=ERROR",
            "-R",
            `80:127.0.0.1:${port}`,
            "nokey@localhost.run",
          ],
        },
        {
          command: process.platform === "win32" ? "npx.cmd" : "npx",
          args: ["--yes", "localtunnel", "--port", String(port)],
        },
      ];

      let shareUrl = null;

      for (const candidate of tunnelCandidates) {
        try {
          const tunnel = await startTunnel({
            command: candidate.command,
            args: candidate.args,
            logPath: tunnelLogPath,
          });
          tunnelProcess = tunnel.child;
          tunnelLogStream = tunnel.logStream;
          shareUrl = tunnel.url;
          break;
        } catch (_error) {
          // Try the next tunnel option.
        }
      }

      if (tunnelProcess) {
        tunnelProcess.once("exit", () => {
          if (!shuttingDown) {
            keepRuntimeDir = true;
            console.error(`Tunnel exited unexpectedly. Check ${tunnelLogPath}`);
            void cleanup(1);
          }
        });
      }

      if (shareUrl) {
        await writeShareUrl(shareUrlPath, shareUrl);
        console.log(`Share URL: ${shareUrl}`);
        if (copyToClipboard(shareUrl)) {
          console.log("Copied share URL to clipboard.");
        }
      } else {
        await writeShareUrl(shareUrlPath, "");
        keepRuntimeDir = true;
        console.error(`Tunnel setup failed. The board is still available locally at ${localUrl}`);
        console.error(`Tunnel log: ${tunnelLogPath}`);
      }
    } else {
      console.log("Running in local-only mode.");
    }

    console.log("Press Ctrl+C when the meeting is over.");
    await new Promise(() => {});
  } catch (error) {
    keepRuntimeDir = true;
    console.error(error.message);
    await cleanup(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

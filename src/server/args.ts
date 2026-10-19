import { parseArgs } from "node:util";

export interface CliArgs {
  port: number;
  open: boolean;
  dev: boolean;
  herdr: boolean;
  /** Also raise the terminal window when focusing a herdr pane (Hyprland/Sway). */
  raise: boolean;
  stateDir: string | undefined;
  claudeDir: string | undefined;
  help: boolean;
  version: boolean;
}

export const USAGE = `Usage: excaliagent [options]

A spatial Excalidraw board for your Claude Code sessions.

Options:
  --port <n>          Port on 127.0.0.1 (default: random free port)
  --no-open           Do not open the browser, just print the URL
  --state-dir <dir>   Where scene.json lives (default: $XDG_STATE_HOME/excaliagent)
  --claude-dir <dir>  Claude Code home (default: ~/.claude)
  --no-herdr          Do not link sessions to herdr panes
  --no-raise          Focus the herdr pane but do not raise its terminal window
                      (raising supports Hyprland, Sway and macOS)
  --dev               Serve the frontend through Vite with hot reload
  -h, --help          Show this help
  -v, --version       Show the version
`;

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowNegative: true,
    options: {
      port: { type: "string" },
      open: { type: "boolean", default: true },
      dev: { type: "boolean", default: false },
      herdr: { type: "boolean", default: true },
      raise: { type: "boolean", default: true },
      "state-dir": { type: "string" },
      "claude-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  let port = 0;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${values.port}`);
  }
  return {
    port,
    open: values.open,
    dev: values.dev,
    herdr: values.herdr,
    raise: values.raise,
    stateDir: values["state-dir"],
    claudeDir: values["claude-dir"],
    help: values.help,
    version: values.version,
  };
}

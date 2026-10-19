/**
 * Opt-in: EXCALIAGENT_E2E_HERDR=1 npx vitest run src/server/panes
 * Starts a throwaway herdr server (temp HOME + socket), runs a dummy process
 * in a pane, and checks pid → pane matching. Never touches a real session.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHerdrLink } from "./herdr.ts";
import { herdrRequest } from "./herdr-client.ts";
import { startIsolatedHerdr, type IsolatedHerdr } from "./__fixtures__/isolated-herdr.ts";
import { waitFor } from "./__fixtures__/test-util.ts";

const enabled = process.env.EXCALIAGENT_E2E_HERDR === "1";

describe.skipIf(!enabled)("herdr e2e (isolated server)", () => {
  let herdr: IsolatedHerdr;
  beforeAll(async () => {
    herdr = await startIsolatedHerdr();
  });
  afterAll(async () => {
    await herdr?.stop();
  });

  it("maps a dummy foreground process to its pane, and follows a new pane", async () => {
    const link = createHerdrLink({ socketPath: herdr.socketPath, resyncMs: 200, retryMinMs: 20 });
    try {
      await waitFor(() => link.available(), 5000, "link connected");
      const ws = (await herdrRequest(herdr.socketPath, "workspace.create", { cwd: herdr.dir, focus: false })) as {
        root_pane?: { pane_id: string };
      };
      const paneId = ws.root_pane?.pane_id ?? "w1:p1";

      // A child sh records its own pid, then execs sleep: the sleep process
      // keeps that pid and is the pane's foreground process.
      const pidFile = join(herdr.dir, "dummy.pid");
      await herdrRequest(herdr.socketPath, "pane.send_text", {
        pane_id: paneId,
        text: `sh -c 'echo $$ > ${pidFile}; exec sleep 300'\n`,
      });
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 5000, "pid file");
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      await link.refresh();
      await waitFor(() => link.match(pid) !== undefined, 5000, "pid matched");
      expect(link.match(pid)).toEqual({ paneId, workspaceId: paneId.split(":")[0] });

      // A new pane (event-driven rebuild) with its own dummy process.
      const split = (await herdrRequest(herdr.socketPath, "pane.split", {
        target_pane_id: paneId,
        direction: "right",
        focus: false,
      })) as { pane: { pane_id: string } };
      const pidFile2 = join(herdr.dir, "dummy2.pid");
      await herdrRequest(herdr.socketPath, "pane.send_text", {
        pane_id: split.pane.pane_id,
        text: `sh -c 'echo $$ > ${pidFile2}; exec sleep 300'\n`,
      });
      await waitFor(() => existsSync(pidFile2) && readFileSync(pidFile2, "utf8").trim() !== "", 5000, "pid file 2");
      const pid2 = Number(readFileSync(pidFile2, "utf8").trim());
      await waitFor(() => link.match(pid2)?.paneId === split.pane.pane_id, 5000, "second pid matched");

      await link.focus(split.pane.pane_id); // isolated server only
    } finally {
      link.close();
    }
  }, 30_000);
});
